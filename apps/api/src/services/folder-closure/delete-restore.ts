import type { AuthUser } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import { buildSyncChangeStmt } from '../sync-changes';
import { restoreFolderWithOptions } from './restore-options';
import { FolderRow, FolderServiceError } from './shared';

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
            SET deleted_at = ?, deleted_by = ?, meta_version = meta_version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at IS NULL
            AND folder_id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, user.id, nowIso, user.tenantId, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE folders
            SET deleted_at = ?, deleted_by = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at IS NULL
            AND id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, user.id, nowIso, user.tenantId, user.tenantId, folderId),
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.soft_delete',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: access.classification,
      metadata: { deletedAt: nowIso, deletedBy: user.id },
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
        deletedBy: user.id,
        version: existing.version + 1,
      },
      nowIso,
    }),
  ]);

  return { deletedAt: nowIso, version: existing.version + 1 };
}

/**
 * Backwards-compatible entry point for callers that only need the original
 * in-place restore contract. All behavior (parent checks, same-batch subtree
 * boundary, rename suffix, classification floor, audit, sync) is implemented by
 * `restoreFolderWithOptions`, so there is exactly one restore rule in the API.
 */
export async function restoreFolderSubtree(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  conflictPolicy: 'fail' | 'rename' = 'fail'
): Promise<{ folder: FolderRow; restoredAt: string }> {
  const result = await restoreFolderWithOptions(db, user, folderId, {
    conflictPolicy,
  });
  return { folder: result.folder, restoredAt: result.restoredAt };
}
