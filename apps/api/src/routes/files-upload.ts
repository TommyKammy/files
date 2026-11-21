import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import { buildRootFolderDeltaByFolderStmts } from '../services/root-folder-stats';
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
  buildR2ObjectKey,
  type FileRow,
  FileUploadError,
  finalizeUploadedVersion,
  getTenantQuotaStatus,
  initializePendingUpload,
  SINGLE_UPLOAD_MAX_BYTES,
  validateFileNameAndExt,
} from '../services/file-upload-common';
import {
  buildMinimalOfficeDocument,
  type OfficeDocumentKind,
} from '../services/ooxml-templates';
import { extractOoxmlText } from '../services/ooxml-text-extractor';
import {
  buildUserStorageDeltaStmt,
  getUserStorageQuotaStatus,
} from '../services/user-storage-stats';
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
import {
  pickStricterClassification,
  VALID_CLASSIFICATIONS,
} from '../utils/classification';
import { normalizeVersionComment } from './file-versions/shared';

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
    comment?: unknown;
  } | null;

  if (!body || typeof body.sizeBytes !== 'number') {
    return c.json({ error: 'fileName and numeric sizeBytes are required' }, 400);
  }
  if (body.classification !== undefined && !VALID_CLASSIFICATIONS.has(body.classification)) {
    return c.json({ error: 'Invalid classification value' }, 400);
  }
  const parsedComment = normalizeVersionComment(body.comment);
  if (!parsedComment.ok) {
    return c.json({ error: parsedComment.error }, 400);
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

    if (parsedComment.value !== null) {
      await c.env.DB.prepare(
        'UPDATE file_versions SET comment = ? WHERE tenant_id = ? AND id = ?'
      )
        .bind(parsedComment.value, user.tenantId, initialized.versionId)
        .run();
    }

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
    comment?: unknown;
  } | null;

  if (!body?.fileId || !body?.versionId) {
    return c.json({ error: 'fileId and versionId are required' }, 400);
  }
  const parsedComment = normalizeVersionComment(body.comment);
  if (!parsedComment.ok) {
    return c.json({ error: parsedComment.error }, 400);
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
    if (parsedComment.value !== null) {
      await c.env.DB.prepare(
        'UPDATE file_versions SET comment = ? WHERE tenant_id = ? AND id = ?'
      )
        .bind(parsedComment.value, user.tenantId, body.versionId)
        .run();
    }
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

const VALID_OFFICE_KINDS = new Set<OfficeDocumentKind>(['docx', 'xlsx', 'pptx']);

/** POST /api/files/create-office — create a new minimal Office document (.docx/.xlsx/.pptx) */
filesUploadRoutes.post('/create-office', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    folderId?: unknown;
    name?: unknown;
    kind?: unknown;
  } | null;

  if (!body || typeof body.folderId !== 'string' || !body.folderId.trim()) {
    return c.json(
      { error: 'Target folderId is required', code: 'FOLDER_ID_REQUIRED' },
      400
    );
  }
  const folderId = body.folderId.trim();

  if (
    typeof body.kind !== 'string' ||
    !VALID_OFFICE_KINDS.has(body.kind as OfficeDocumentKind)
  ) {
    return c.json(
      { error: 'kind must be one of docx, xlsx, pptx', code: 'INVALID_KIND' },
      400
    );
  }
  const kind = body.kind as OfficeDocumentKind;

  try {
    const validated = validateFileNameAndExt(body.name);
    const normalizedName = validated.name.toLowerCase().endsWith(`.${kind}`)
      ? validated.name
      : `${validated.name}.${kind}`;
    const { name, extension } = validateFileNameAndExt(normalizedName);

    const folderAccess = await resolveTargetAccess(
      c.env.DB,
      user,
      'folder',
      folderId
    );
    if (!folderAccess || folderAccess.deletedAt !== null) {
      return c.json({ error: 'Target folder not found', code: 'FOLDER_NOT_FOUND' }, 404);
    }
    if (!can(folderAccess.capabilities, 'item.upload_new')) {
      return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
    }

    // Inherit strictest classification across folder and all ancestors
    let classification: ClassificationLabel = folderAccess.classification;
    const ancClassRow = await c.env.DB.prepare(
      `SELECT MAX(CASE f.classification
         WHEN 'confidential' THEN 3
         WHEN 'internal' THEN 2
         WHEN 'public' THEN 1
         ELSE 0
       END) AS max_cls
         FROM folder_closures fc
         JOIN folders f ON f.id = fc.ancestor_id
        WHERE fc.tenant_id = ? AND fc.descendant_id = ?`
    )
      .bind(user.tenantId, folderId)
      .first<{ max_cls: number | null }>();
    const mapCls: Record<number, ClassificationLabel> = {
      0: 'unset',
      1: 'public',
      2: 'internal',
      3: 'confidential',
    };
    const ancLabel = ancClassRow?.max_cls
      ? (mapCls[ancClassRow.max_cls] ?? 'unset')
      : 'unset';
    classification = pickStricterClassification(classification, ancLabel);

    const existing = await c.env.DB.prepare(
      `SELECT id
         FROM files
        WHERE tenant_id = ?
          AND folder_id = ?
          AND name = ?
          AND deleted_at IS NULL
          AND upload_state = 'active'`
    )
      .bind(user.tenantId, folderId, name)
      .first<{ id: string }>();

    if (existing) {
      return c.json(
        {
          error: `File "${name}" already exists in this folder`,
          code: 'NAME_CONFLICT',
        },
        409
      );
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const doc = buildMinimalOfficeDocument(kind, now);
    const sizeBytes = doc.bytes.byteLength;

    const quota = await getTenantQuotaStatus(c.env.DB, user.tenantId);
    if (quota.usedBytes + sizeBytes > quota.quotaBytes) {
      return c.json(
        {
          error: `Tenant storage quota exceeded (remaining ${quota.remainingBytes} bytes)`,
          code: 'QUOTA_EXCEEDED',
        },
        413
      );
    }

    const userQuota = await getUserStorageQuotaStatus(
      c.env.DB,
      user.tenantId,
      user.id
    );
    if (
      userQuota.quotaBytes !== null &&
      userQuota.usedBytes + sizeBytes > userQuota.quotaBytes
    ) {
      const remainingBytes = Math.max(
        0,
        userQuota.quotaBytes - userQuota.usedBytes
      );
      return c.json(
        {
          error: `Personal storage quota exceeded (remaining ${remainingBytes} bytes)`,
          code: 'USER_QUOTA_EXCEEDED',
        },
        413
      );
    }

    const fileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const r2ObjectKey = buildR2ObjectKey(user.tenantId, fileId, 1);

    await c.env.BUCKET.put(r2ObjectKey, doc.bytes, {
      httpMetadata: { contentType: doc.mimeType },
    });

    const contentExcerpt = await extractOoxmlText(doc.bytes, kind).catch(() => null);

    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           content_excerpt, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?, ?, ?, ?, ?)`
      ).bind(
        fileId,
        user.tenantId,
        folderId,
        name,
        extension,
        doc.mimeType,
        sizeBytes,
        versionId,
        classification,
        contentExcerpt,
        user.id,
        user.id,
        nowIso,
        nowIso
      ),
      c.env.DB.prepare(
        `INSERT INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, r2_upload_id,
           size_bytes, mime_type, upload_status, uploaded_by, created_at
         ) VALUES (?, ?, ?, 1, ?, NULL, ?, ?, 'completed', ?, ?)`
      ).bind(
        versionId,
        user.tenantId,
        fileId,
        r2ObjectKey,
        sizeBytes,
        doc.mimeType,
        user.id,
        nowIso
      ),
      c.env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason, content_excerpt)
         VALUES (?, ?, ?, ?, ?, '', ?)`
      ).bind(fileId, user.tenantId, classification, name, extension ?? '', contentExcerpt ?? ''),
      c.env.DB.prepare(
        `INSERT INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT (tenant_id, classification)
         DO UPDATE SET file_count = file_count + 1,
                       total_bytes = total_bytes + ?,
                       updated_at = excluded.updated_at`
      ).bind(user.tenantId, classification, sizeBytes, nowIso, sizeBytes),
      buildUserStorageDeltaStmt(c.env.DB, {
        tenantId: user.tenantId,
        userId: user.id,
        countDelta: 1,
        bytesDelta: sizeBytes,
        nowIso,
      }),
      ...buildRootFolderDeltaByFolderStmts(c.env.DB, {
        tenantId: user.tenantId,
        folderId,
        countDelta: 1,
        bytesDelta: sizeBytes,
        nowIso,
      }),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'file.create_office',
        targetType: 'file',
        targetId: fileId,
        classificationSnapshot: classification,
        metadata: {
          kind,
          name,
          folderId,
          sizeBytes,
        },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'file',
        entityId: fileId,
        folderId,
        action: 'file.create_office',
        payload: {
          name,
          extension,
          folderId,
          sizeBytes,
          mimeType: doc.mimeType,
          currentVersionNum: 1,
          metaVersion: 1,
          classification,
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ];

    let batchResults: D1Result[];
    try {
      batchResults = await c.env.DB.batch(statements);
    } catch (err) {
      await c.env.BUCKET.delete(r2ObjectKey).catch(() => {});
      if (((err as Error).message ?? '').includes('UNIQUE constraint failed')) {
        return c.json(
          {
            error: `File "${name}" already exists in this folder`,
            code: 'NAME_CONFLICT',
          },
          409
        );
      }
      throw err;
    }

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'file.create_office',
      scopeFolderIds: [folderId],
    });
    await recordGuestAccess(c.env.DB, user, 'create_office', 'file', fileId);

    const file = await c.env.DB.prepare(
      'SELECT * FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, fileId)
      .first<FileRow>();

    return c.json({ file }, 201);
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
    ...buildRootFolderDeltaByFolderStmts(c.env.DB, {
      tenantId: user.tenantId,
      folderId: currentFile.folder_id,
      countDelta: -1,
      bytesDelta: -currentFile.size_bytes,
      nowIso,
    }),
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
