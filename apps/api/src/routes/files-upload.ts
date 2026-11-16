import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import { assertFileNotLocked, FileLockedError } from '../services/file-lock';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import {
  type FileRow,
  FileUploadError,
  finalizeUploadedVersion,
  initializePendingUpload,
  SINGLE_UPLOAD_MAX_BYTES,
} from '../services/file-upload-common';
import {
  issueSignedStorageUrl,
  resolveSafeDisposition,
} from '../services/storage-url-provider';
import { buildSyncChangeStmt, parseExpectedVersionInput } from '../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../services/sync-notifier';
import type { ClassificationLabel } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { VALID_CLASSIFICATIONS } from '../utils/classification';

function handleFileError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 413) => Response },
  err: unknown
): Response {
  if (err instanceof FileLockedError) {
    return c.json(
      { error: 'File is locked', code: err.code, lock: err.lock },
      409
    );
  }
  if (err instanceof FileUploadError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

export const filesUploadRoutes = new Hono<OidcHonoEnv>();

filesUploadRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** POST /api/files/upload-init — initialize single-part upload (<100 MiB) */
filesUploadRoutes.post('/upload-init', async (c) => {
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
  if (body.classification !== undefined && !VALID_CLASSIFICATIONS.has(body.classification)) {
    return c.json({ error: 'Invalid classification value' }, 400);
  }

  try {
    const initialized = await initializePendingUpload(c.env.DB, user, {
      folderId: body.folderId ?? null,
      fileName: body.fileName,
      mimeType: typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream',
      sizeBytes: body.sizeBytes,
      requestedClassification: body.classification,
      conflictPolicy: body.conflictPolicy === 'new_version' ? 'new_version' : 'fail',
      multipart: false,
    });

    const signedPut = await issueSignedStorageUrl(c.env, {
      method: 'PUT',
      objectKey: initialized.r2ObjectKey,
      tenantId: user.tenantId,
      expiresInSeconds: 900,
      maxSizeBytes: Math.max(body.sizeBytes, 1),
      contentType: typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream',
    });

    return c.json(
      {
        fileId: initialized.fileId,
        versionId: initialized.versionId,
        versionNum: initialized.versionNum,
        r2ObjectKey: initialized.r2ObjectKey,
        classification: initialized.classification,
        isNewVersion: initialized.isNewVersion,
        uploadUrl: signedPut.url,
        method: signedPut.method,
        expiresAt: signedPut.expiresAt,
        requiredHeaders: signedPut.requiredHeaders,
      },
      201
    );
  } catch (err) {
    return handleFileError(c, err);
  }
});

/** POST /api/files/upload-complete — verify R2 object & quota, commit D1 + FTS5 + enqueue AI */
filesUploadRoutes.post('/upload-complete', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    fileId?: string;
    versionId?: string;
  } | null;

  if (!body?.fileId || !body?.versionId) {
    return c.json({ error: 'fileId and versionId are required' }, 400);
  }

  try {
    const result = await finalizeUploadedVersion(
      c.env.DB,
      c.env.BUCKET,
      c.env.JOBS_QUEUE,
      user,
      {
        fileId: body.fileId,
        versionId: body.versionId,
        maxAllowedBytes: SINGLE_UPLOAD_MAX_BYTES,
      }
    );
    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      eventKind: 'file.upload_complete',
      scopeFolderIds: [result.file.folder_id],
    });
    return c.json(result);
  } catch (err) {
    return handleFileError(c, err);
  }
});

/** GET /api/files/:id — file metadata & version history */
filesUploadRoutes.get('/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');

  const access = await resolveTargetAccess(c.env.DB, user, 'file', fileId);
  if (!access || access.deletedAt !== null || access.uploadState !== 'active') {
    return c.json({ error: 'File not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'previewer')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const [file, versions] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
    c.env.DB.prepare(
      `SELECT id, version_num, size_bytes, mime_type, upload_status, uploaded_by, created_at
         FROM file_versions
        WHERE tenant_id = ? AND file_id = ? AND upload_status = 'completed'
        ORDER BY version_num DESC`
    )
      .bind(user.tenantId, fileId)
      .all(),
  ]);

  return c.json({
    file,
    effectiveRole: access.effectiveRole,
    canDownload: hasAtLeastRole(access.effectiveRole, 'viewer'),
    versions: versions.results,
  });
});

/** GET /api/files/:id/content-url?intent=preview|download — RBAC-guarded signed GET URL */
filesUploadRoutes.get('/:id/content-url', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const intent = c.req.query('intent') === 'download' ? 'download' : 'preview';

  const access = await resolveTargetAccess(c.env.DB, user, 'file', fileId);
  if (!access || access.deletedAt !== null || access.uploadState !== 'active') {
    return c.json({ error: 'File not found' }, 404);
  }

  const requiredRole = intent === 'download' ? 'viewer' : 'previewer';
  if (!hasAtLeastRole(access.effectiveRole, requiredRole)) {
    const nowIso = new Date().toISOString();
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action,
         target_type, target_id, classification_snapshot, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, 'file.content_access_denied', 'file', ?, ?, 'blocked', ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        user.tenantId,
        user.id,
        user.email,
        user.ipAddress,
        fileId,
        access.classification,
        JSON.stringify({ intent, effectiveRole: access.effectiveRole }),
        nowIso
      )
      .run();
    return c.json({ error: 'Forbidden' }, 403);
  }

  const row = await c.env.DB.prepare(
    `SELECT fl.name, fl.mime_type, fl.classification, fv.r2_object_key,
            COALESCE(tp.require_watermark_confidential, 1) AS require_wm
       FROM files fl
       JOIN file_versions fv ON fv.id = fl.current_version_id
       LEFT JOIN tenant_policies tp ON tp.tenant_id = fl.tenant_id
      WHERE fl.tenant_id = ? AND fl.id = ?`
  )
    .bind(user.tenantId, fileId)
    .first<{
      name: string;
      mime_type: string;
      classification: ClassificationLabel;
      r2_object_key: string;
      require_wm: number;
    }>();

  if (!row) {
    return c.json({ error: 'File version not found' }, 404);
  }

  const disposition = resolveSafeDisposition(
    intent === 'download' ? 'attachment' : 'inline',
    row.name,
    row.mime_type
  );

  const signedGet = await issueSignedStorageUrl(c.env, {
    method: 'GET',
    objectKey: row.r2_object_key,
    tenantId: user.tenantId,
    expiresInSeconds: 300,
    disposition,
    filename: row.name,
    contentType: row.mime_type,
  });

  const requireWatermark = row.classification === 'confidential' && row.require_wm === 1;
  const nowIso = new Date().toISOString();

  await c.env.DB.batch([
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: intent === 'download' ? 'file.download' : 'file.preview',
      targetType: 'file',
      targetId: fileId,
      classificationSnapshot: row.classification,
      metadata: { disposition, requireWatermark },
      nowIso,
    }),
  ]);

  return c.json({
    url: signedGet.url,
    expiresAt: signedGet.expiresAt,
    disposition,
    requireWatermark,
    watermarkText: requireWatermark ? `${user.email} • ${nowIso}` : null,
  });
});

/** DELETE /api/files/:id — soft delete single file & sync FTS5 */
filesUploadRoutes.delete('/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { expectedVersion?: unknown } | null;
  const expectedVersion = parseExpectedVersionInput(c.req.query('expectedVersion'), body);

  const [access, currentFile] = await Promise.all([
    resolveTargetAccess(c.env.DB, user, 'file', fileId),
    c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);
  if (!access || !currentFile || access.deletedAt !== null || access.uploadState !== 'active') {
    return c.json({ error: 'File not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  try {
    await assertFileNotLocked(c.env, fileId);
  } catch (err) {
    return handleFileError(c, err);
  }
  if (expectedVersion !== undefined && currentFile.meta_version !== expectedVersion) {
    return c.json(
      { error: 'Version conflict', code: 'VERSION_CONFLICT', latest: currentFile },
      409
    );
  }

  const nowIso = new Date().toISOString();
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(fileId),
    c.env.DB.prepare(
      `UPDATE files
          SET deleted_at = ?, meta_version = meta_version + 1, updated_by = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    ).bind(nowIso, user.id, nowIso, user.tenantId, fileId),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file.soft_delete',
      targetType: 'file',
      targetId: fileId,
      classificationSnapshot: access.classification,
      metadata: { deletedAt: nowIso },
      nowIso,
    }),
    buildSyncChangeStmt(c.env.DB, {
      tenantId: user.tenantId,
      entityType: 'file',
      entityId: fileId,
      folderId: currentFile.folder_id,
      action: 'file.soft_delete',
      payload: {
        deletedAt: nowIso,
        metaVersion: currentFile.meta_version + 1,
        updatedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: 'file.soft_delete',
    scopeFolderIds: [currentFile.folder_id],
  });

  return c.json({ ok: true, deletedAt: nowIso });
});
