import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import { assertFileNotLocked, FileLockedError } from '../services/file-lock';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../services/authorization';
import { can } from '../services/capabilities';
import {
  computeEffectivePermissionsCapabilities,
  resolveEffectiveInvitePolicy,
} from '../services/invite-policy';
import {
  authorizeFileContentAccess,
  contentIntentFromQuery,
  deliverFileContent,
} from '../services/file-content-access';
import {
  type FileRow,
  FileUploadError,
  finalizeUploadedVersion,
  initializePendingUpload,
  SINGLE_UPLOAD_MAX_BYTES,
} from '../services/file-upload-common';
import { issueSignedStorageUrl } from '../services/storage-url-provider';
import {
  getShareLinkPolicyFlags,
  projectViewerShareLinkCapability,
} from '../services/shared-link-permissions';
import { recordGuestAccess } from '../services/guest-access-audit';
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
    await recordGuestAccess(
      c.env.DB,
      user,
      'upload_complete',
      'file',
      result.file.id
    );
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
  if (!can(access.capabilities, 'item.preview')) {
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
  const [resolvedInvitePolicy, shareLinkPolicy] = await Promise.all([
    resolveEffectiveInvitePolicy(
      c.env.DB,
      user.tenantId,
      access.folderId
    ),
    getShareLinkPolicyFlags(c.env.DB, user.tenantId),
  ]);
  const effectiveCapabilities = projectViewerShareLinkCapability(
    computeEffectivePermissionsCapabilities(
      access.capabilities,
      access.effectiveRole,
      resolvedInvitePolicy.effectivePolicy,
      user.role
    ),
    access.effectiveRole,
    shareLinkPolicy.allow_viewer_share_links
  );

  await recordGuestAccess(c.env.DB, user, 'read_file_metadata', 'file', fileId);

  return c.json({
    file,
    effectiveRole: access.effectiveRole,
    capabilities: effectiveCapabilities,
    effectiveCapabilities,
    invitePolicy: {
      tenantPolicy: resolvedInvitePolicy.tenantPolicy,
      folderOwnPolicy: resolvedInvitePolicy.ownPolicy,
      effectivePolicy: resolvedInvitePolicy.effectivePolicy,
      inheritedFloor: resolvedInvitePolicy.parentFloor,
      sourceFolderId: resolvedInvitePolicy.sourceFolderId,
      sourceFolderName: resolvedInvitePolicy.sourceFolderName,
    },
    canDownload: can(access.capabilities, 'item.download'),
    versions: versions.results,
  });
});

/** GET /api/files/:id/content-url?intent=preview|download — RBAC-guarded signed GET URL */
filesUploadRoutes.get('/:id/content-url', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const intent = contentIntentFromQuery(c.req.query('intent'));

  const authorized = await authorizeFileContentAccess(c.env.DB, user, fileId, intent);
  if (!authorized.ok) {
    return c.json(authorized.body, authorized.status);
  }

  const delivered = await deliverFileContent({
    env: c.env,
    user,
    fileId,
    intent,
    versionId: null,
    forceWatermark: !can(authorized.access.capabilities, 'item.download'),
    canDownload: can(authorized.access.capabilities, 'item.download'),
  });
  if (!delivered.ok) {
    return c.json(delivered.body, delivered.status);
  }

  await recordGuestAccess(
    c.env.DB,
    user,
    intent === 'download' ? 'download_url' : 'preview_url',
    'file',
    fileId
  );

  return c.json(delivered.body);
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
  if (!can(access.capabilities, 'item.delete')) {
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
          SET deleted_at = ?, deleted_by = ?, meta_version = meta_version + 1, updated_by = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    ).bind(nowIso, user.id, user.id, nowIso, user.tenantId, fileId),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file.soft_delete',
      targetType: 'file',
      targetId: fileId,
      classificationSnapshot: access.classification,
      metadata: { deletedAt: nowIso, deletedBy: user.id },
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
        deletedBy: user.id,
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
