import type { AuthUser } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import { buildSyncChangeStmt } from '../sync-changes';
import type { DirectPermissionRow, OffboardingTargetRow } from './shared';
import type {
  AdminOffboardingFileRequestsAction,
  AdminOffboardingPreview,
  AdminOffboardingSharedLinksAction,
  AdminOffboardingSummary,
  AdminOffboardingTransferCandidate,
  AdminOffboardingUserAction,
} from './types';

export function buildOffboardingStatements(input: {
  db: D1Database;
  tenantId: string;
  userId: string;
  actor: AuthUser;
  target: OffboardingTargetRow;
  preview: AdminOffboardingPreview;
  transferTarget: AdminOffboardingTransferCandidate | null;
  directPermissionRows: readonly DirectPermissionRow[];
  sharedLinksAction: AdminOffboardingSharedLinksAction;
  fileRequestsAction: AdminOffboardingFileRequestsAction;
  userAction: AdminOffboardingUserAction;
  revokeDirectPermissions: boolean;
  removeGroupMemberships: boolean;
  releaseHeldLockFlag: boolean;
  nowIso: string;
}): { statements: D1PreparedStatement[]; summary: AdminOffboardingSummary } {
  const {
    db,
    tenantId,
    userId,
    actor,
    target,
    preview,
    transferTarget,
    directPermissionRows,
    sharedLinksAction,
    fileRequestsAction,
    userAction,
    revokeDirectPermissions,
    removeGroupMemberships,
    releaseHeldLockFlag,
    nowIso,
  } = input;

  const statements: D1PreparedStatement[] = [];

  // Phase 1: grant the successor BEFORE any leaver permission is removed.
  if (transferTarget) {
    for (const folder of preview.ownedFolders) {
      statements.push(
        db
          .prepare(
            `INSERT INTO permissions (
               id, tenant_id, target_type, target_id, grantee_type,
               grantee_id, role, granted_by, created_at
             ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)
             ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
             DO UPDATE SET role = 'owner', granted_by = excluded.granted_by`
          )
          .bind(
            crypto.randomUUID(),
            tenantId,
            folder.id,
            transferTarget.id,
            actor.id,
            nowIso
          )
      );
      statements.push(
        buildSyncChangeStmt(db, {
          tenantId,
          entityType: 'permission',
          entityId: `${folder.id}:user:${transferTarget.id}`,
          folderId: folder.id,
          action: 'permission.grant',
          payload: {
            targetType: 'folder',
            targetId: folder.id,
            granteeType: 'user',
            granteeId: transferTarget.id,
            role: 'owner',
            reason: 'admin_offboarding',
          },
          nowIso,
        })
      );
    }
  }

  // Phase 2: remove the leaver's direct grants (owner grants now duplicated).
  if (revokeDirectPermissions) {
    statements.push(
      db
        .prepare(
          `DELETE FROM permissions
            WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?`
        )
        .bind(tenantId, userId)
    );
    for (const permission of directPermissionRows) {
      statements.push(
        buildSyncChangeStmt(db, {
          tenantId,
          entityType: 'permission',
          entityId: `${permission.target_type}:${permission.target_id}:user:${userId}`,
          folderId: permission.folder_id,
          targetUserId: userId,
          action: 'permission.revoke',
          payload: {
            targetType: permission.target_type,
            targetId: permission.target_id,
            granteeType: 'user',
            granteeId: userId,
            reason: 'admin_offboarding',
          },
          nowIso,
        })
      );
    }
  }

  // Phase 3: shared links.
  if (sharedLinksAction === 'transfer_owner' && transferTarget) {
    statements.push(
      db
        .prepare(
          `UPDATE shared_links
              SET created_by = ?
            WHERE tenant_id = ? AND created_by = ? AND revoked_at IS NULL`
        )
        .bind(transferTarget.id, tenantId, userId)
    );
    for (const link of preview.activeSharedLinks) {
      statements.push(
        buildSyncChangeStmt(db, {
          tenantId,
          entityType: 'shared_link',
          entityId: link.id,
          folderId: link.targetType === 'folder' ? link.targetId : null,
          action: 'shared_link.transfer_owner',
          payload: {
            targetType: link.targetType,
            targetId: link.targetId,
            previousOwnerId: userId,
            newOwnerId: transferTarget.id,
          },
          nowIso,
        })
      );
    }
  } else if (sharedLinksAction === 'revoke_all') {
    statements.push(
      db
        .prepare(
          `UPDATE shared_links
              SET revoked_at = ?, revoked_by = ?
            WHERE tenant_id = ? AND created_by = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, actor.id, tenantId, userId)
    );
    for (const link of preview.activeSharedLinks) {
      statements.push(
        buildSyncChangeStmt(db, {
          tenantId,
          entityType: 'shared_link',
          entityId: link.id,
          folderId: link.targetType === 'folder' ? link.targetId : null,
          action: 'shared_link.revoke',
          payload: {
            targetType: link.targetType,
            targetId: link.targetId,
            revokedBy: actor.id,
            reason: 'admin_offboarding',
          },
          nowIso,
        })
      );
    }
  }

  // Phase 4: file requests. `sync_changes` has no file_request entity type,
  // so these events are scoped to the destination folder for invalidation.
  if (fileRequestsAction === 'transfer_owner' && transferTarget) {
    statements.push(
      db
        .prepare(
          `UPDATE file_requests
              SET created_by = ?
            WHERE tenant_id = ? AND created_by = ? AND is_active = 1`
        )
        .bind(transferTarget.id, tenantId, userId)
    );
    for (const request of preview.activeFileRequests) {
      statements.push(
        buildSyncChangeStmt(db, {
          tenantId,
          entityType: 'folder',
          entityId: request.folderId,
          folderId: request.folderId,
          action: 'file_request.transfer_owner',
          payload: {
            fileRequestId: request.id,
            previousOwnerId: userId,
            newOwnerId: transferTarget.id,
          },
          nowIso,
        })
      );
    }
  } else if (fileRequestsAction === 'deactivate_all') {
    statements.push(
      db
        .prepare(
          `UPDATE file_requests
              SET is_active = 0
            WHERE tenant_id = ? AND created_by = ? AND is_active = 1`
        )
        .bind(tenantId, userId)
    );
    for (const request of preview.activeFileRequests) {
      statements.push(
        buildSyncChangeStmt(db, {
          tenantId,
          entityType: 'folder',
          entityId: request.folderId,
          folderId: request.folderId,
          action: 'file_request.deactivate',
          payload: {
            fileRequestId: request.id,
            reason: 'admin_offboarding',
          },
          nowIso,
        })
      );
    }
  }

  // Phase 5: sessions / WOPI locks / group memberships.
  statements.push(
    db
      .prepare(
        `UPDATE sessions
            SET revoked_at = ?
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(nowIso, tenantId, userId)
  );
  if (releaseHeldLockFlag) {
    statements.push(
      db
        .prepare(
          `UPDATE wopi_sessions
              SET is_active = 0, revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND is_active = 1`
        )
        .bind(nowIso, tenantId, userId)
    );
  }
  if (removeGroupMemberships) {
    // Deliberate tenant-wide cleanup: offboarding removes every membership in
    // this tenant (manual and SCIM-backed). Cross-tenant memberships cannot
    // exist because `groups` is tenant-scoped.
    statements.push(
      db
        .prepare(
          `DELETE FROM group_members
            WHERE user_id = ?
              AND group_id IN (
                SELECT id FROM groups WHERE tenant_id = ?
              )`
        )
        .bind(userId, tenantId)
    );
  }

  // Phase 6: account state. `keep_status` still records the offboarding for
  // auditability but leaves the account usable after a fresh login.
  if (userAction === 'suspend') {
    statements.push(
      db
        .prepare(
          `UPDATE users
              SET status = 'suspended',
                  offboarded_at = ?,
                  offboarded_by = ?,
                  updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
        )
        .bind(nowIso, actor.id, nowIso, tenantId, userId)
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE users
              SET offboarded_at = ?,
                  offboarded_by = ?,
                  updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
        )
        .bind(nowIso, actor.id, nowIso, tenantId, userId)
    );
  }

  const summary: AdminOffboardingSummary = {
    ownedFolderCount: preview.ownedFolders.length,
    transferredFolderCount: transferTarget ? preview.ownedFolders.length : 0,
    soleOwnerFolderCount: preview.soleOwnerCount,
    directPermissionsRevoked: revokeDirectPermissions
      ? directPermissionRows.length
      : 0,
    groupMembershipsRemoved: removeGroupMemberships
      ? preview.groupMembershipCount
      : 0,
    sharedLinksTransferred:
      sharedLinksAction === 'transfer_owner'
        ? preview.activeSharedLinks.length
        : 0,
    sharedLinksRevoked:
      sharedLinksAction === 'revoke_all'
        ? preview.activeSharedLinks.length
        : 0,
    fileRequestsTransferred:
      fileRequestsAction === 'transfer_owner'
        ? preview.activeFileRequests.length
        : 0,
    fileRequestsDeactivated:
      fileRequestsAction === 'deactivate_all'
        ? preview.activeFileRequests.length
        : 0,
    sessionsRevoked: preview.activeSessionCount,
    wopiSessionsRevoked: releaseHeldLockFlag
      ? preview.activeWopiSessionCount
      : 0,
    locksReleased: 0,
    statusChanged: userAction === 'suspend' && target.status !== 'suspended',
  };

  statements.push(
    buildAuditLogStmt(db, {
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: actor.ipAddress,
      action: 'admin.user.offboard',
      targetType: 'user',
      targetId: target.id,
      metadata: {
        userId: target.id,
        email: target.email,
        role: target.role,
        previousStatus: target.status,
        transferToUserId: transferTarget?.id ?? null,
        options: {
          sharedLinksAction,
          fileRequestsAction,
          userAction,
          revokeDirectPermissions,
          removeGroupMemberships,
          releaseHeldLocks: releaseHeldLockFlag,
        },
        counts: { ...summary, locksReleased: undefined },
        affectedFolderIds: preview.ownedFolders.map((folder) => folder.id),
        offboardedAt: nowIso,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId,
      entityType: 'user',
      entityId: target.id,
      targetUserId: target.id,
      action: userAction === 'suspend' ? 'user.suspended' : 'admin.user.offboard',
      payload: {
        email: target.email,
        status: userAction === 'suspend' ? 'suspended' : target.status,
        reason: 'admin_offboard',
        offboardedAt: nowIso,
        transferToUserId: transferTarget?.id ?? null,
      },
      nowIso,
    })
  );

  return { statements, summary };
}
