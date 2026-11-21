import type { AuthUser } from '../../types/api';
import type { OidcEnv } from '../../types/oidc';
import { chunkArray } from '../../utils/batch';
import { buildAuditLogStmt } from '../audit';
import { FileLockedError, getFileLockState } from '../file-lock';
import { restoreFolderWithOptions } from '../folder-closure/restore-options';
import { buildRootFolderResetStmt } from '../root-folder-stats';
import { buildSyncChangeStmt } from '../sync-changes';
import { extractLastSyncSeq } from '../sync-notifier';
import { loadRecordById } from './queries';
import {
  AdminRootFolderError,
  FILE_LOCK_CHECK_CHUNK,
  type AdminRootFolderRecord,
  type RootFolderRow,
} from './types';
import { loadRootFolderRow } from './validation';

/**
 * Archive preflight shared by the single-folder API and bulk dry-run previews.
 * It validates root state and rejects desktop-exclusive file locks without
 * mutating anything.
 */
export async function assertAdminRootFolderArchivable(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  folderId: string
): Promise<RootFolderRow> {
  const db = env.DB;
  const folder = await loadRootFolderRow(db, tenantId, folderId, {
    allowDeleted: true,
  });
  if (folder.deleted_at !== null) {
    throw new AdminRootFolderError(
      409,
      'ALREADY_ARCHIVED',
      'Root folder is already archived'
    );
  }

  const activeFiles = await db
    .prepare(
      `SELECT fl.id
         FROM files fl
        WHERE fl.tenant_id = ?
          AND fl.deleted_at IS NULL
          AND fl.upload_state = 'active'
          AND fl.folder_id IN (
            SELECT fc.descendant_id
              FROM folder_closures fc
             WHERE fc.tenant_id = ? AND fc.ancestor_id = ?
          )`
    )
    .bind(tenantId, tenantId, folderId)
    .all<{ id: string }>();

  for (const chunk of chunkArray(
    activeFiles.results.map((row) => row.id),
    FILE_LOCK_CHECK_CHUNK
  )) {
    const locks = await Promise.all(
      chunk.map((fileId) => getFileLockState(env, fileId))
    );
    const desktopLock = locks.find(
      (lock) => lock !== null && lock.mode === 'desktop_exclusive'
    );
    if (desktopLock) {
      throw new FileLockedError(desktopLock);
    }
  }

  return folder;
}

export async function archiveAdminRootFolder(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  folderId: string
): Promise<{ deletedAt: string; syncSeq: number | null }> {
  const db = env.DB;
  const folder = await assertAdminRootFolderArchivable(
    env,
    user.tenantId,
    folderId
  );
  const nowIso = new Date().toISOString();
  const batchResults = await db.batch([
    db
      .prepare(
        `DELETE FROM files_fts
          WHERE file_id IN (
            SELECT fl.id FROM files fl
             WHERE fl.tenant_id = ?
               AND fl.deleted_at IS NULL
               AND fl.folder_id IN (
                 SELECT descendant_id FROM folder_closures
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
              SELECT descendant_id FROM folder_closures
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
              SELECT descendant_id FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, user.id, nowIso, user.tenantId, user.tenantId, folderId),
    buildRootFolderResetStmt(db, user.tenantId, folderId, nowIso),
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.root_folder.archive',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folder.classification,
      metadata: { archivedAt: nowIso, archivedBy: user.id, name: folder.name },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: null,
      action: 'folder.soft_delete',
      payload: {
        parentId: null,
        deletedAt: nowIso,
        deletedBy: user.id,
        version: folder.version + 1,
        adminArchive: true,
      },
      nowIso,
    }),
  ]);

  return { deletedAt: nowIso, syncSeq: extractLastSyncSeq(batchResults) };
}

/**
 * Restore preflight shared by the single-folder API and bulk dry-run previews.
 */
export async function assertAdminRootFolderRestorable(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<RootFolderRow> {
  const folder = await loadRootFolderRow(db, tenantId, folderId, {
    allowDeleted: true,
  });
  if (folder.deleted_at === null) {
    throw new AdminRootFolderError(
      409,
      'NOT_ARCHIVED',
      'Root folder is not archived'
    );
  }

  const duplicate = await db
    .prepare(
      `SELECT id FROM folders
        WHERE tenant_id = ?
          AND parent_id IS NULL
          AND name = ?
          AND deleted_at IS NULL
          AND id != ?
        LIMIT 1`
    )
    .bind(tenantId, folder.name, folderId)
    .first<{ id: string }>();
  if (duplicate) {
    throw new AdminRootFolderError(
      409,
      'NAME_CONFLICT',
      `A root folder named "${folder.name}" already exists`
    );
  }
  return folder;
}

export async function restoreAdminRootFolder(
  db: D1Database,
  user: AuthUser,
  folderId: string
): Promise<{ root: AdminRootFolderRecord; syncSeq: number | null }> {
  const folder = await assertAdminRootFolderRestorable(
    db,
    user.tenantId,
    folderId
  );

  const restored = await restoreFolderWithOptions(db, user, folderId, {
    conflictPolicy: 'fail',
    adminDelegation: {
      onBehalfOfUserId: user.id,
      ownerId: user.id,
      ownerName: user.email,
      ownerEmail: user.email,
    },
  });

  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action, target_type,
         target_id, classification_snapshot, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, 'admin.root_folder.restore', 'folder', ?, ?, 'allowed', ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      user.tenantId,
      user.id,
      user.email,
      user.ipAddress,
      folderId,
      folder.classification,
      JSON.stringify({
        name: folder.name,
        restoredAt: restored.restoredAt,
        restoredAncestorIds: restored.restoredAncestorIds,
      }),
      nowIso
    )
    .run();

  return {
    root: await loadRecordById(db, user.tenantId, folderId),
    syncSeq: restored.syncSeq,
  };
}
