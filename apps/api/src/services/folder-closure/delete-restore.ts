import type { AuthUser, ClassificationLabel, ResourceRole } from '../../types/api';
import {
  CLASSIFICATION_STRICTNESS,
  isClassificationStricter,
  pickStricterClassification,
} from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import { buildSyncChangeStmt } from '../sync-changes';
import {
  FolderRow,
  FolderServiceError,
  hasDuplicateFolderName,
  resolveUniqueRestoredName,
} from './shared';

export async function softDeleteFolderSubtree(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  options?: { expectedVersion?: number }
): Promise<{ deletedAt: string; version: number }> {
  const access = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!access || access.deletedAt !== null) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Editor permission required to delete folder');
  }

  const existing = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!existing) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (
    options?.expectedVersion !== undefined &&
    existing.version !== options.expectedVersion
  ) {
    throw new FolderServiceError(
      409,
      'VERSION_CONFLICT',
      `Folder version mismatch (expected ${options.expectedVersion}, actual ${existing.version})`,
      existing
    );
  }

  const nowIso = new Date().toISOString();

  // Order matters inside batch: remove active files from FTS5 before stamping deleted_at
  await db.batch([
    db
      .prepare(
        `DELETE FROM files_fts
          WHERE file_id IN (
            SELECT id FROM files
             WHERE tenant_id = ?
               AND deleted_at IS NULL
               AND folder_id IN (
                 SELECT descendant_id
                   FROM folder_closures
                  WHERE tenant_id = ? AND ancestor_id = ?
               )
          )`
      )
      .bind(user.tenantId, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE files
            SET deleted_at = ?, meta_version = meta_version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at IS NULL
            AND folder_id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, nowIso, user.tenantId, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE folders
            SET deleted_at = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at IS NULL
            AND id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, nowIso, user.tenantId, user.tenantId, folderId),
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.soft_delete',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: access.classification,
      metadata: { deletedAt: nowIso },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: existing.parent_id,
      action: 'folder.soft_delete',
      payload: {
        parentId: existing.parent_id,
        deletedAt: nowIso,
        version: existing.version + 1,
      },
      nowIso,
    }),
  ]);

  return { deletedAt: nowIso, version: existing.version + 1 };
}

export async function restoreFolderSubtree(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  conflictPolicy: 'fail' | 'rename' = 'fail'
): Promise<{ folder: FolderRow; restoredAt: string }> {
  const access = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!access) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (access.deletedAt === null) {
    throw new FolderServiceError(400, 'NOT_IN_TRASH', 'Folder is not in Trash');
  }
  if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Editor permission required to restore folder');
  }

  const folder = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!folder || !folder.deleted_at) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }

  if (folder.parent_id !== null) {
    const parent = await db
      .prepare('SELECT id, deleted_at FROM folders WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, folder.parent_id)
      .first<{ id: string; deleted_at: string | null }>();
    if (!parent || parent.deleted_at !== null) {
      throw new FolderServiceError(
        409,
        'PARENT_IN_TRASH',
        'Parent folder must be restored before restoring this folder'
      );
    }
  }

  let nextName = folder.name;
  const hasConflict = await hasDuplicateFolderName(
    db,
    user.tenantId,
    folder.parent_id,
    folder.name,
    folder.id
  );
  if (hasConflict) {
    if (conflictPolicy !== 'rename') {
      throw new FolderServiceError(
        409,
        'NAME_CONFLICT',
        `An active folder named "${folder.name}" already exists in this location`
      );
    }
    nextName = await resolveUniqueRestoredName(
      db,
      user.tenantId,
      folder.parent_id,
      folder.name
    );
  }

  const batchDeletedAt = folder.deleted_at;
  const nowIso = new Date().toISOString();

  const statements: D1PreparedStatement[] = [
    // Re-index active restored files matching exact deleted_at BEFORE clearing deleted_at
    db
      .prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         SELECT id, tenant_id, classification, name, COALESCE(extension, ''), COALESCE(ai_reason, '')
           FROM files
          WHERE tenant_id = ?
            AND upload_state = 'active'
            AND deleted_at = ?
            AND folder_id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(user.tenantId, batchDeletedAt, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE files
            SET deleted_at = NULL, meta_version = meta_version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at = ?
            AND folder_id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, user.tenantId, batchDeletedAt, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE folders
            SET deleted_at = NULL,
                name = CASE WHEN id = ? THEN ? ELSE name END,
                version = version + 1,
                updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at = ?
            AND id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(folderId, nextName, nowIso, user.tenantId, batchDeletedAt, user.tenantId, folderId),
  ];

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.restore',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folder.classification,
      metadata: {
        restoredBatchDeletedAt: batchDeletedAt,
        renamedTo: nextName !== folder.name ? nextName : null,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: folder.parent_id,
      action: 'folder.restore',
      payload: {
        folder: {
          ...folder,
          name: nextName,
          deleted_at: null,
          version: folder.version + 1,
          updated_at: nowIso,
        },
      },
      nowIso,
    })
  );

  await db.batch(statements);

  const restored = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();

  return { folder: restored!, restoredAt: nowIso };
}
