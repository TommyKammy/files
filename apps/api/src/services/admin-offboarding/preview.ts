import type { OidcEnv } from '../../types/oidc';
import { chunkArray } from '../../utils/batch';
import { countEffectiveOwners } from '../authorization';
import {
  OWNER_COUNT_CHUNK,
  TRANSFER_CANDIDATE_LIMIT,
  loadHeldLocks,
  loadTarget,
  type FileRequestRow,
  type OwnedFolderRow,
  type SharedLinkRow,
  type TransferCandidateRow,
} from './shared';
import type {
  AdminOffboardingOwnedFolder,
  AdminOffboardingPreview,
} from './types';

/**
 * Read-only inventory. `soleOwner` intentionally uses the shared
 * `countEffectiveOwners` definition (direct + inherited owner assignments), so
 * the preview and the transfer guard agree on which folders need a successor.
 */
export async function loadAdminOffboardingPreview(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  userId: string
): Promise<AdminOffboardingPreview> {
  const db = env.DB;
  const target = await loadTarget(db, tenantId, userId);
  const nowIso = new Date().toISOString();

  const [
    ownedFolderRows,
    directPermissionCounts,
    sharedLinkRows,
    fileRequestRows,
    activeSessionRow,
    activeWopiSessionRow,
    groupMembershipRow,
    candidateRows,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT f.id, f.name, f.classification, f.parent_id, f.created_at
           FROM permissions p
           JOIN folders f
             ON f.tenant_id = p.tenant_id AND f.id = p.target_id
          WHERE p.tenant_id = ?
            AND p.target_type = 'folder'
            AND p.grantee_type = 'user'
            AND p.grantee_id = ?
            AND p.role = 'owner'
            AND f.deleted_at IS NULL
          ORDER BY f.name ASC, f.id ASC`
      )
      .bind(tenantId, userId)
      .all<OwnedFolderRow>(),
    db
      .prepare(
        `SELECT target_type, COUNT(*) AS count
           FROM permissions
          WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?
          GROUP BY target_type`
      )
      .bind(tenantId, userId)
      .all<{ target_type: 'folder' | 'file'; count: number }>(),
    db
      .prepare(
        `SELECT sl.id, sl.target_type, sl.target_id,
                COALESCE(f.name, fl.name) AS target_name,
                sl.access_scope, sl.can_download, sl.require_watermark,
                sl.expires_at, sl.created_at
           FROM shared_links sl
           LEFT JOIN folders f
             ON sl.target_type = 'folder'
            AND f.tenant_id = sl.tenant_id
            AND f.id = sl.target_id
           LEFT JOIN files fl
             ON sl.target_type = 'file'
            AND fl.tenant_id = sl.tenant_id
            AND fl.id = sl.target_id
          WHERE sl.tenant_id = ?
            AND sl.created_by = ?
            AND sl.revoked_at IS NULL
          ORDER BY sl.created_at DESC, sl.id ASC`
      )
      .bind(tenantId, userId)
      .all<SharedLinkRow>(),
    db
      .prepare(
        `SELECT fr.id, fr.folder_id, f.name AS folder_name, fr.title,
                fr.submission_count, fr.expires_at, fr.created_at
           FROM file_requests fr
           LEFT JOIN folders f
             ON f.tenant_id = fr.tenant_id AND f.id = fr.folder_id
          WHERE fr.tenant_id = ?
            AND fr.created_by = ?
            AND fr.is_active = 1
          ORDER BY fr.created_at DESC, fr.id ASC`
      )
      .bind(tenantId, userId)
      .all<FileRequestRow>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE tenant_id = ? AND user_id = ?
            AND revoked_at IS NULL AND expires_at > ?`
      )
      .bind(tenantId, userId, nowIso)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM wopi_sessions
          WHERE tenant_id = ? AND user_id = ?
            AND is_active = 1 AND expires_at > ?`
      )
      .bind(tenantId, userId, nowIso)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM group_members gm
           JOIN groups g ON g.id = gm.group_id
          WHERE g.tenant_id = ? AND gm.user_id = ?`
      )
      .bind(tenantId, userId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT id, email, display_name, role
           FROM users
          WHERE tenant_id = ?
            AND user_type = 'member'
            AND status = 'active'
            AND id <> ?
          ORDER BY display_name ASC, email ASC
          LIMIT ${TRANSFER_CANDIDATE_LIMIT}`
      )
      .bind(tenantId, userId)
      .all<TransferCandidateRow>(),
  ]);

  const folderCounts: number[] = [];
  for (const chunk of chunkArray(ownedFolderRows.results, OWNER_COUNT_CHUNK)) {
    const counts = await Promise.all(
      chunk.map((folder) =>
        countEffectiveOwners(db, tenantId, 'folder', folder.id, null)
      )
    );
    folderCounts.push(...counts);
  }
  const ownedFolders: AdminOffboardingOwnedFolder[] = ownedFolderRows.results.map(
    (folder, index) => {
      const effectiveOwnerCount = folderCounts[index] ?? 0;
      return {
        id: folder.id,
        name: folder.name,
        classification: folder.classification,
        parentId: folder.parent_id,
        isRoot: folder.parent_id === null,
        soleOwner: effectiveOwnerCount <= 1,
        effectiveOwnerCount,
        createdAt: folder.created_at,
      };
    }
  );

  let folderPermissionCount = 0;
  let filePermissionCount = 0;
  for (const row of directPermissionCounts.results) {
    if (row.target_type === 'folder') folderPermissionCount = row.count;
    if (row.target_type === 'file') filePermissionCount = row.count;
  }

  return {
    user: {
      id: target.id,
      email: target.email,
      displayName: target.display_name,
      role: target.role,
      status: target.status,
      userType: target.user_type,
      offboardedAt: target.offboarded_at,
    },
    ownedFolders,
    ownedFolderCount: ownedFolders.length,
    soleOwnerCount: ownedFolders.filter((folder) => folder.soleOwner).length,
    directPermissions: {
      total: folderPermissionCount + filePermissionCount,
      folder: folderPermissionCount,
      file: filePermissionCount,
      folderCount: folderPermissionCount,
      fileCount: filePermissionCount,
    },
    activeSharedLinks: sharedLinkRows.results.map((row) => ({
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      targetName: row.target_name,
      accessScope: row.access_scope,
      canDownload: row.can_download === 1,
      requireWatermark: row.require_watermark === 1,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
    activeFileRequests: fileRequestRows.results.map((row) => ({
      id: row.id,
      folderId: row.folder_id,
      folderName: row.folder_name,
      title: row.title,
      submissionCount: row.submission_count,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
    heldLocks: await loadHeldLocks(env, tenantId, userId, nowIso),
    activeSessionCount: activeSessionRow?.count ?? 0,
    activeWopiSessionCount: activeWopiSessionRow?.count ?? 0,
    groupMembershipCount: groupMembershipRow?.count ?? 0,
    transferCandidates: candidateRows.results.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    })),
    generatedAt: nowIso,
  };
}
