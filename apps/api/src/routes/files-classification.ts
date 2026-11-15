import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import {
  buildClassificationChangeStatements,
  buildClassificationPolicyStatements,
  resolveFolderClassificationFloor,
} from '../services/classification-updater';
import {
  type FileRow,
  FileUploadError,
  validateFileNameAndExt,
} from '../services/file-upload-common';
import { buildSyncChangeStmt, parseExpectedVersionInput } from '../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../services/sync-notifier';
import type { ClassificationLabel } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { isClassificationStricter, pickStricterClassification } from '../utils/classification';

const ASSIGNABLE_CLASSIFICATIONS = new Set<ClassificationLabel>([
  'confidential',
  'internal',
  'public',
]);

async function findActiveFileNameConflict(
  db: D1Database,
  tenantId: string,
  folderId: string | null,
  name: string,
  excludeFileId?: string
): Promise<boolean> {
  const excludeClause = excludeFileId ? 'AND id != ?' : '';
  const query =
    folderId === null
      ? `SELECT id FROM files
          WHERE tenant_id = ? AND folder_id IS NULL AND name = ?
            AND deleted_at IS NULL AND upload_state != 'failed' ${excludeClause}
          LIMIT 1`
      : `SELECT id FROM files
          WHERE tenant_id = ? AND folder_id = ? AND name = ?
            AND deleted_at IS NULL AND upload_state != 'failed' ${excludeClause}
          LIMIT 1`;
  const binds =
    folderId === null
      ? excludeFileId
        ? [tenantId, name, excludeFileId]
        : [tenantId, name]
      : excludeFileId
        ? [tenantId, folderId, name, excludeFileId]
        : [tenantId, folderId, name];
  const hit = await db.prepare(query).bind(...binds).first<{ id: string }>();
  return Boolean(hit);
}

export const filesClassificationRoutes = new Hono<OidcHonoEnv>();
filesClassificationRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** PATCH /api/files/:id/classification — approve AI suggestion or manually update label */
filesClassificationRoutes.patch('/:id/classification', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    classification?: unknown;
    acceptSuggestion?: unknown;
    expectedVersion?: unknown;
  } | null;

  const [access, file] = await Promise.all([
    resolveTargetAccess(c.env.DB, user, 'file', fileId),
    c.env.DB.prepare(
      'SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
    )
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);

  if (!access || !file || file.upload_state !== 'active') {
    return c.json({ error: 'File not found' }, 404);
  }

  const isPrivilegedAdmin = user.role === 'sec_admin' || user.role === 'sys_admin';
  if (!isPrivilegedAdmin && !hasAtLeastRole(access.effectiveRole, 'editor')) {
    return c.json({ error: 'Forbidden: editor or admin role required' }, 403);
  }

  const expectedVersion = parseExpectedVersionInput(undefined, body);
  if (expectedVersion !== undefined && file.meta_version !== expectedVersion) {
    return c.json({ error: 'Version conflict', code: 'VERSION_CONFLICT', latest: file }, 409);
  }

  let targetLabel: ClassificationLabel;
  if (body?.acceptSuggestion === true) {
    if (!file.ai_suggested_label || !ASSIGNABLE_CLASSIFICATIONS.has(file.ai_suggested_label)) {
      return c.json({ error: 'File does not have an active AI suggestion to approve' }, 400);
    }
    targetLabel = file.ai_suggested_label;
  } else {
    if (
      typeof body?.classification !== 'string' ||
      !ASSIGNABLE_CLASSIFICATIONS.has(body.classification as ClassificationLabel)
    ) {
      return c.json(
        { error: 'classification must be one of confidential, internal, or public' },
        400
      );
    }
    targetLabel = body.classification as ClassificationLabel;
  }

  // Enforce ancestor folder classification floor (cannot weaken beneath confidential folder)
  if (file.folder_id) {
    const strictestAncestor = await resolveFolderClassificationFloor(
      c.env.DB,
      user.tenantId,
      file.folder_id
    );

    if (
      strictestAncestor === 'confidential' &&
      isClassificationStricter(strictestAncestor, targetLabel)
    ) {
      return c.json(
        {
          error: 'Cannot lower classification beneath a confidential parent folder',
          code: 'CLASSIFICATION_DOWNGRADE_FORBIDDEN',
        },
        403
      );
    }
  }

  const nowIso = new Date().toISOString();
  const stmts = buildClassificationChangeStatements(c.env.DB, {
    tenantId: user.tenantId,
    fileId: file.id,
    folderId: file.folder_id,
    fromClassification: file.classification,
    toClassification: targetLabel,
    sizeBytes: file.size_bytes,
    clearSuggestion: true,
    actorId: user.id,
    actorEmail: user.email,
    actorIp: user.ipAddress,
    auditAction:
      body?.acceptSuggestion === true
        ? 'ai.classification_approved'
        : 'file.classification_updated',
    auditMetadata:
      body?.acceptSuggestion === true
        ? { acceptedAiConfidence: file.ai_confidence }
        : undefined,
    nowIso,
  });

  const batchResults = await c.env.DB.batch(stmts);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind:
      body?.acceptSuggestion === true
        ? 'ai.classification_approved'
        : 'file.classification_updated',
    scopeFolderIds: [file.folder_id],
  });

  const updated = await c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, file.id)
    .first<FileRow>();

  return c.json({ file: updated });
});

/** POST /api/files/:id/restore — restore soft-deleted single file & reindex FTS5 */
filesClassificationRoutes.post('/:id/restore', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { newName?: unknown } | null;

  const [access, file] = await Promise.all([
    resolveTargetAccess(c.env.DB, user, 'file', fileId),
    c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);

  if (!access || !file) {
    return c.json({ error: 'File not found' }, 404);
  }
  if (file.deleted_at === null) {
    return c.json({ error: 'File is not in trash' }, 409);
  }

  const isPrivilegedAdmin = user.role === 'sec_admin' || user.role === 'sys_admin';
  if (!isPrivilegedAdmin && !hasAtLeastRole(access.effectiveRole, 'editor')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (file.folder_id) {
    const parent = await c.env.DB.prepare(
      'SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, file.folder_id)
      .first<{ deleted_at: string | null }>();
    if (!parent || parent.deleted_at !== null) {
      return c.json(
        { error: 'Parent folder is deleted; restore parent folder first', code: 'PARENT_FOLDER_DELETED' },
        409
      );
    }
  }

  let restoredName = file.name;
  let restoredExt = file.extension;
  if (body?.newName !== undefined) {
    try {
      const parsed = validateFileNameAndExt(body.newName);
      restoredName = parsed.name;
      restoredExt = parsed.extension;
    } catch (err) {
      if (err instanceof FileUploadError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }
  }

  const conflict = await findActiveFileNameConflict(
    c.env.DB,
    user.tenantId,
    file.folder_id,
    restoredName
  );

  if (conflict) {
    return c.json(
      { error: `An active file named "${restoredName}" already exists in destination folder`, code: 'NAME_CONFLICT' },
      409
    );
  }

  const nowIso = new Date().toISOString();
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE files
       SET deleted_at = NULL, name = ?, extension = ?, meta_version = meta_version + 1, updated_by = ?, updated_at = ?
       WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`
    ).bind(restoredName, restoredExt, user.id, nowIso, user.tenantId, file.id),
    c.env.DB.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(file.id),
    c.env.DB.prepare(
      `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(file.id, user.tenantId, file.classification, restoredName, restoredExt ?? '', file.ai_reason ?? ''),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file.restore',
      targetType: 'file',
      targetId: file.id,
      classificationSnapshot: file.classification,
      metadata: { restoredName },
      nowIso,
    }),
    buildSyncChangeStmt(c.env.DB, {
      tenantId: user.tenantId,
      entityType: 'file',
      entityId: file.id,
      folderId: file.folder_id,
      action: 'file.restore',
      payload: {
        name: restoredName,
        extension: restoredExt,
        folderId: file.folder_id,
        metaVersion: file.meta_version + 1,
        updatedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: 'file.restore',
    scopeFolderIds: [file.folder_id],
  });

  const restored = await c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, file.id)
    .first<FileRow>();

  return c.json({ ok: true, file: restored });
});

/** PATCH /api/files/:id — rename or move file across folders with optimistic lock */
filesClassificationRoutes.patch('/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    folderId?: unknown;
    expectedVersion?: unknown;
  } | null;

  if (!body || (body.name === undefined && body.folderId === undefined)) {
    return c.json({ error: 'At least one of name or folderId is required' }, 400);
  }

  let requestedFolderId: string | null | undefined = undefined;
  if (body.folderId !== undefined) {
    if (body.folderId === null) {
      requestedFolderId = null;
    } else if (typeof body.folderId === 'string' && body.folderId.trim().length > 0) {
      requestedFolderId = body.folderId.trim();
    } else {
      return c.json({ error: 'folderId must be a non-empty string or null' }, 400);
    }
  }

  const [access, file] = await Promise.all([
    resolveTargetAccess(c.env.DB, user, 'file', fileId),
    c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);

  if (!access || !file || file.upload_state !== 'active') {
    return c.json({ error: 'File not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const expectedVersion = parseExpectedVersionInput(undefined, body);
  if (expectedVersion !== undefined && file.meta_version !== expectedVersion) {
    return c.json({ error: 'Version conflict', code: 'VERSION_CONFLICT', latest: file }, 409);
  }

  let nextName = file.name;
  let nextExt = file.extension;
  if (body.name !== undefined) {
    try {
      const parsed = validateFileNameAndExt(body.name);
      nextName = parsed.name;
      nextExt = parsed.extension;
    } catch (err) {
      if (err instanceof FileUploadError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }
  }

  const targetFolderId = requestedFolderId !== undefined ? requestedFolderId : file.folder_id;
  const isMoving = targetFolderId !== file.folder_id;
  let nextClassification = file.classification;

  if (isMoving && targetFolderId !== null) {
    const destAccess = await resolveTargetAccess(c.env.DB, user, 'folder', targetFolderId);
    if (!destAccess || destAccess.deletedAt !== null) {
      return c.json({ error: 'Destination folder not found' }, 404);
    }
    if (!hasAtLeastRole(destAccess.effectiveRole, 'editor')) {
      return c.json({ error: 'Forbidden: editor role required on destination folder' }, 403);
    }

    const destFloor = await resolveFolderClassificationFloor(
      c.env.DB,
      user.tenantId,
      targetFolderId
    );
    nextClassification = pickStricterClassification(file.classification, destFloor);
  }

  if (nextName !== file.name || isMoving) {
    const conflict = await findActiveFileNameConflict(
      c.env.DB,
      user.tenantId,
      targetFolderId,
      nextName,
      file.id
    );
    if (conflict) {
      return c.json(
        { error: `An active file named "${nextName}" already exists in destination folder`, code: 'NAME_CONFLICT' },
        409
      );
    }
  }

  const nowIso = new Date().toISOString();
  const nextMetaVersion = file.meta_version + 1;
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `UPDATE files
          SET folder_id = ?, name = ?, extension = ?, classification = ?,
              meta_version = meta_version + 1, updated_by = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
    ).bind(
      targetFolderId,
      nextName,
      nextExt,
      nextClassification,
      user.id,
      nowIso,
      user.tenantId,
      file.id
    ),
    c.env.DB.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(file.id),
    c.env.DB.prepare(
      `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      file.id,
      user.tenantId,
      nextClassification,
      nextName,
      nextExt ?? '',
      file.ai_reason ?? ''
    ),
    ...buildClassificationPolicyStatements(c.env.DB, {
      tenantId: user.tenantId,
      fileId: file.id,
      fromClassification: file.classification,
      toClassification: nextClassification,
      sizeBytes: file.size_bytes,
      actorId: user.id,
      nowIso,
    }),
  ];

  // Ensure a file moved out of a folder to root keeps explicit ACL ownership/access
  if (isMoving && targetFolderId === null && access.effectiveRole) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
         ) VALUES (?, ?, 'file', ?, 'user', ?, ?, ?, ?)
         ON CONFLICT (target_type, target_id, grantee_type, grantee_id) DO NOTHING`
      ).bind(
        crypto.randomUUID(),
        user.tenantId,
        file.id,
        user.id,
        access.effectiveRole,
        user.id,
        nowIso
      )
    );
  }

  stmts.push(
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: isMoving ? 'file.move' : 'file.rename',
      targetType: 'file',
      targetId: file.id,
      classificationSnapshot: nextClassification,
      metadata: {
        fromName: file.name,
        toName: nextName,
        fromFolderId: file.folder_id,
        toFolderId: targetFolderId,
        fromClassification: file.classification,
        toClassification: nextClassification,
      },
      nowIso,
    }),
    buildSyncChangeStmt(c.env.DB, {
      tenantId: user.tenantId,
      entityType: 'file',
      entityId: file.id,
      folderId: targetFolderId,
      action: 'file.update',
      payload: {
        name: nextName,
        extension: nextExt,
        folderId: targetFolderId,
        previousFolderId: file.folder_id,
        classification: nextClassification,
        metaVersion: nextMetaVersion,
        updatedAt: nowIso,
      },
      nowIso,
    })
  );

  if (isMoving && file.folder_id !== null) {
    stmts.push(
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'file',
        entityId: file.id,
        folderId: file.folder_id,
        action: 'file.moved_out',
        payload: {
          toFolderId: targetFolderId,
          metaVersion: nextMetaVersion,
          updatedAt: nowIso,
        },
        nowIso,
      })
    );
  }

  const batchResults = await c.env.DB.batch(stmts);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: isMoving ? 'file.moved_out' : 'file.update',
    scopeFolderIds: isMoving ? [file.folder_id, targetFolderId] : [targetFolderId],
  });

  const updated = await c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, file.id)
    .first<FileRow>();

  return c.json({ file: updated });
});
