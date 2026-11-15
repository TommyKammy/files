import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import {
  type FileRow,
  type FileVersionRow,
  FileUploadError,
  finalizeUploadedVersion,
  initializePendingUpload,
} from '../services/file-upload-common';
import {
  abortMultipartUpload,
  type CompletedPartInput,
  completeMultipartUpload,
  computeMultipartPlan,
  INITIAL_SIGNED_PARTS_LIMIT,
  initiateMultipartUpload,
  MAX_MULTIPART_PARTS,
  PART_URLS_BATCH_MAX,
} from '../services/multipart-storage-provider';
import { issueSignedMultipartPartUrl } from '../services/storage-url-provider';
import { emitTenantSyncSignal } from '../services/sync-notifier';
import type { ClassificationLabel } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { VALID_CLASSIFICATIONS } from '../utils/classification';

const MIN_MULTIPART_INIT_BYTES = 5 * 1024 * 1024; // R2/S3 5 MiB minimum non-final part size

function handleMultipartError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 413) => Response },
  err: unknown
): Response {
  if (err instanceof FileUploadError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

export const filesMultipartUploadRoutes = new Hono<OidcHonoEnv>();

filesMultipartUploadRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** POST /api/files/multipart/init — start multipart upload & issue up to 50 initial part URLs */
filesMultipartUploadRoutes.post('/init', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    folderId?: string | null;
    fileName?: unknown;
    mimeType?: string;
    sizeBytes?: number;
    classification?: ClassificationLabel;
    conflictPolicy?: 'fail' | 'new_version';
  } | null;

  if (!body || typeof body.sizeBytes !== 'number') {
    return c.json({ error: 'fileName and numeric sizeBytes are required' }, 400);
  }
  if (body.sizeBytes < MIN_MULTIPART_INIT_BYTES) {
    return c.json(
      {
        error: 'Files smaller than 5 MiB must use single upload (/api/files/upload-init)',
        code: 'USE_SINGLE_UPLOAD',
      },
      400
    );
  }
  if (body.classification !== undefined && !VALID_CLASSIFICATIONS.has(body.classification)) {
    return c.json({ error: 'Invalid classification value' }, 400);
  }

  const mimeType =
    typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim()
      : 'application/octet-stream';

  try {
    const initialized = await initializePendingUpload(c.env.DB, user, {
      folderId: body.folderId ?? null,
      fileName: body.fileName,
      mimeType,
      sizeBytes: body.sizeBytes,
      requestedClassification: body.classification,
      conflictPolicy: body.conflictPolicy === 'new_version' ? 'new_version' : 'fail',
      multipart: true,
    });

    let uploadId: string;
    try {
      uploadId = await initiateMultipartUpload(c.env, initialized.r2ObjectKey, mimeType);
      await c.env.DB.prepare('UPDATE file_versions SET r2_upload_id = ? WHERE id = ?')
        .bind(uploadId, initialized.versionId)
        .run();
    } catch (initErr) {
      // Clean up pending DB rows so abandoned init leaves zero dangling pending state
      const cleanupStmts: D1PreparedStatement[] = [
        c.env.DB.prepare('DELETE FROM file_versions WHERE id = ?').bind(initialized.versionId),
      ];
      if (!initialized.isNewVersion) {
        cleanupStmts.push(
          c.env.DB.prepare("DELETE FROM permissions WHERE target_type = 'file' AND target_id = ?").bind(
            initialized.fileId
          ),
          c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(initialized.fileId)
        );
      }
      await c.env.DB.batch(cleanupStmts);
      throw initErr;
    }

    const plan = computeMultipartPlan(body.sizeBytes);
    const initialCount = Math.min(plan.totalParts, INITIAL_SIGNED_PARTS_LIMIT);
    const signedParts = await Promise.all(
      Array.from({ length: initialCount }, (_, idx) =>
        issueSignedMultipartPartUrl(c.env, {
          objectKey: initialized.r2ObjectKey,
          tenantId: user.tenantId,
          uploadId,
          partNumber: idx + 1,
          maxSizeBytes: plan.partSizeBytes,
          expiresInSeconds: 3600,
        })
      )
    );

    return c.json(
      {
        fileId: initialized.fileId,
        versionId: initialized.versionId,
        versionNum: initialized.versionNum,
        uploadId,
        r2ObjectKey: initialized.r2ObjectKey,
        classification: initialized.classification,
        partSizeBytes: plan.partSizeBytes,
        totalParts: plan.totalParts,
        parts: signedParts,
      },
      201
    );
  } catch (err) {
    return handleMultipartError(c, err);
  }
});

/** POST /api/files/multipart/part-urls — issue signed PUT URLs (max 100 parts per call) */
filesMultipartUploadRoutes.post('/part-urls', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    fileId?: string;
    versionId?: string;
    partNumbers?: number[];
  } | null;

  if (!body?.fileId || !body?.versionId || !Array.isArray(body.partNumbers)) {
    return c.json({ error: 'fileId, versionId, and partNumbers[] are required' }, 400);
  }
  if (body.partNumbers.length === 0 || body.partNumbers.length > PART_URLS_BATCH_MAX) {
    return c.json(
      { error: `partNumbers must contain between 1 and ${PART_URLS_BATCH_MAX} entries` },
      400
    );
  }

  const version = await c.env.DB.prepare(
    'SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ? AND id = ?'
  )
    .bind(user.tenantId, body.fileId, body.versionId)
    .first<FileVersionRow>();
  if (!version || version.upload_status !== 'pending' || !version.r2_upload_id) {
    return c.json({ error: 'Active pending multipart upload not found' }, 404);
  }

  if (version.uploaded_by !== user.id) {
    const access = await resolveTargetAccess(c.env.DB, user, 'file', body.fileId);
    if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const plan = computeMultipartPlan(version.size_bytes);
  const uniqueParts = [...new Set(body.partNumbers)];
  for (const partNum of uniqueParts) {
    if (!Number.isInteger(partNum) || partNum < 1 || partNum > plan.totalParts || partNum > MAX_MULTIPART_PARTS) {
      return c.json(
        { error: `Invalid partNumber ${partNum} (valid range: 1..${plan.totalParts})` },
        400
      );
    }
  }

  const parts = await Promise.all(
    uniqueParts.map((partNumber) =>
      issueSignedMultipartPartUrl(c.env, {
        objectKey: version.r2_object_key,
        tenantId: user.tenantId,
        uploadId: version.r2_upload_id!,
        partNumber,
        maxSizeBytes: plan.partSizeBytes,
        expiresInSeconds: 3600,
      })
    )
  );

  return c.json({
    fileId: body.fileId,
    versionId: body.versionId,
    uploadId: version.r2_upload_id,
    parts,
  });
});

/** POST /api/files/multipart/complete — combine parts, head()-verify size & quota, commit D1 + AI queue */
filesMultipartUploadRoutes.post('/complete', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    fileId?: string;
    versionId?: string;
    parts?: CompletedPartInput[];
  } | null;

  if (!body?.fileId || !body?.versionId || !Array.isArray(body.parts) || body.parts.length === 0) {
    return c.json({ error: 'fileId, versionId, and non-empty parts[] are required' }, 400);
  }

  for (const part of body.parts) {
    if (
      !Number.isInteger(part?.partNumber) ||
      part.partNumber < 1 ||
      typeof part.etag !== 'string' ||
      !part.etag.trim()
    ) {
      return c.json({ error: 'Each part requires integer partNumber and etag' }, 400);
    }
  }

  const version = await c.env.DB.prepare(
    'SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ? AND id = ?'
  )
    .bind(user.tenantId, body.fileId, body.versionId)
    .first<FileVersionRow>();
  if (!version) {
    return c.json({ error: 'File version not found' }, 404);
  }
  if (version.upload_status !== 'pending' || !version.r2_upload_id) {
    return c.json({ error: 'Multipart upload is not in pending state' }, 409);
  }

  if (version.uploaded_by !== user.id) {
    const access = await resolveTargetAccess(c.env.DB, user, 'file', body.fileId);
    if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  try {
    await completeMultipartUpload(
      c.env,
      version.r2_object_key,
      version.r2_upload_id,
      body.parts
    );
  } catch (err) {
    return c.json(
      { error: `Failed to assemble multipart upload: ${(err as Error).message}`, code: 'MULTIPART_COMPLETE_FAILED' },
      400
    );
  }

  try {
    const result = await finalizeUploadedVersion(
      c.env.DB,
      c.env.BUCKET,
      c.env.JOBS_QUEUE,
      user,
      { fileId: body.fileId, versionId: body.versionId }
    );
    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      eventKind: 'file.upload_complete',
      scopeFolderIds: [result.file.folder_id],
    });
    return c.json(result);
  } catch (err) {
    return handleMultipartError(c, err);
  }
});

/** POST /api/files/multipart/abort — abort R2 multipart upload & clean pending DB state */
filesMultipartUploadRoutes.post('/abort', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    fileId?: string;
    versionId?: string;
  } | null;

  if (!body?.fileId || !body?.versionId) {
    return c.json({ error: 'fileId and versionId are required' }, 400);
  }

  const [file, version] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, body.fileId)
      .first<FileRow>(),
    c.env.DB.prepare(
      'SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ? AND id = ?'
    )
      .bind(user.tenantId, body.fileId, body.versionId)
      .first<FileVersionRow>(),
  ]);

  if (!file || !version) {
    return c.json({ error: 'Pending upload not found' }, 404);
  }
  if (version.upload_status !== 'pending') {
    return c.json({ error: 'Upload is already finalized or aborted' }, 409);
  }
  if (version.uploaded_by !== user.id) {
    const access = await resolveTargetAccess(c.env.DB, user, 'file', file.id);
    if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  if (version.r2_upload_id) {
    await abortMultipartUpload(c.env, version.r2_object_key, version.r2_upload_id);
  }
  await c.env.BUCKET.delete(version.r2_object_key).catch(() => {});

  const nowIso = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM file_versions WHERE tenant_id = ? AND id = ?').bind(
      user.tenantId,
      version.id
    ),
  ];

  if (file.upload_state === 'pending') {
    stmts.push(
      c.env.DB.prepare("DELETE FROM permissions WHERE tenant_id = ? AND target_type = 'file' AND target_id = ?").bind(
        user.tenantId,
        file.id
      ),
      c.env.DB.prepare('DELETE FROM files WHERE tenant_id = ? AND id = ?').bind(
        user.tenantId,
        file.id
      )
    );
  }

  stmts.push(
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file.multipart_abort',
      targetType: 'file',
      targetId: file.id,
      classificationSnapshot: file.classification,
      metadata: { versionId: version.id, uploadId: version.r2_upload_id },
      nowIso,
    })
  );

  await c.env.DB.batch(stmts);
  return c.json({ ok: true, abortedVersionId: version.id });
});
