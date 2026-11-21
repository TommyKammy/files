import type { AuthUser } from '../../types/api';
import type { OidcEnv } from '../../types/oidc';
import { executeBatchChunks } from '../../utils/batch';
import { beginAdminBulkOperation } from '../admin-bulk-idempotency';
import { loadMemberRowStrict } from '../admin-users';
import { extractLastSyncSeq } from '../sync-notifier';
import { loadAdminOffboardingPreview } from './preview';
import {
  FILE_REQUEST_ACTIONS,
  SHARED_LINK_ACTIONS,
  USER_ACTIONS,
  assertConfirmation,
  countActiveSysAdminsExcluding,
  loadTarget,
  loadTransferCandidate,
  normalizeTransferToUserId,
  parseBooleanOption,
  parseEnum,
  releaseHeldLocks,
  type DirectPermissionRow,
} from './shared';
import { buildOffboardingStatements } from './statements';
import {
  AdminOffboardingError,
  type AdminOffboardingResult,
} from './types';

/**
 * Execute an offboarding. Callers must already have restricted this endpoint to
 * `sys_admin`; the role check below is a defence-in-depth assertion.
 */
export async function offboardAdminMember(
  input: {
    env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>;
    tenantId: string;
    userId: string;
    actor: AuthUser;
    transferToUserId?: unknown;
    sharedLinksAction?: unknown;
    fileRequestsAction?: unknown;
    userAction?: unknown;
    suspendOrRemoveUser?: unknown;
    revokeDirectPermissions?: unknown;
    removeGroupMemberships?: unknown;
    releaseHeldLocks?: unknown;
    confirmation?: unknown;
    idempotencyKey?: string | null;
  }
): Promise<AdminOffboardingResult> {
  const { env, tenantId, userId, actor } = input;
  const db = env.DB;

  if (actor.role !== 'sys_admin') {
    throw new AdminOffboardingError(
      403,
      'SYS_ADMIN_REQUIRED',
      'Only sys_admin can offboard internal members'
    );
  }

  const target = await loadTarget(db, tenantId, userId);
  if (target.id === actor.id) {
    throw new AdminOffboardingError(
      409,
      'CANNOT_SELF_OFFBOARD',
      'You cannot offboard your own account'
    );
  }
  if (target.role === 'sys_admin' && target.status === 'active') {
    const remaining = await countActiveSysAdminsExcluding(db, tenantId, target.id);
    if (remaining === 0) {
      throw new AdminOffboardingError(
        409,
        'LAST_SYS_ADMIN_REQUIRED',
        'At least one active sys_admin must remain'
      );
    }
  }

  const transferToUserId = normalizeTransferToUserId(input.transferToUserId);
  const sharedLinksAction = parseEnum(
    input.sharedLinksAction,
    'sharedLinksAction',
    SHARED_LINK_ACTIONS,
    transferToUserId ? 'transfer_owner' : 'revoke_all'
  );
  const fileRequestsAction = parseEnum(
    input.fileRequestsAction,
    'fileRequestsAction',
    FILE_REQUEST_ACTIONS,
    transferToUserId ? 'transfer_owner' : 'deactivate_all'
  );
  const userAction = parseEnum(
    input.userAction ?? input.suspendOrRemoveUser,
    'userAction',
    USER_ACTIONS,
    'suspend'
  );
  const revokeDirectPermissions = parseBooleanOption(
    input.revokeDirectPermissions,
    'revokeDirectPermissions',
    true
  );
  const removeGroupMemberships = parseBooleanOption(
    input.removeGroupMemberships,
    'removeGroupMemberships',
    true
  );
  const releaseHeldLockFlag = parseBooleanOption(
    input.releaseHeldLocks,
    'releaseHeldLocks',
    true
  );
  assertConfirmation(input.confirmation, target);

  if (transferToUserId === target.id) {
    throw new AdminOffboardingError(
      400,
      'INVALID_TRANSFER_TARGET',
      'The transfer target must be a different member'
    );
  }

  const preview = await loadAdminOffboardingPreview(env, tenantId, userId);
  const needsTransfer =
    preview.ownedFolders.length > 0 ||
    sharedLinksAction === 'transfer_owner' ||
    fileRequestsAction === 'transfer_owner';
  if (needsTransfer && !transferToUserId) {
    throw new AdminOffboardingError(
      400,
      'TRANSFER_TARGET_REQUIRED',
      'transferToUserId is required when folders, shared links or file requests are transferred'
    );
  }

  const transferTarget = transferToUserId
    ? await loadTransferCandidate(db, tenantId, transferToUserId)
    : null;

  const payload = {
    userId,
    transferToUserId,
    sharedLinksAction,
    fileRequestsAction,
    userAction,
    revokeDirectPermissions,
    removeGroupMemberships,
    releaseHeldLocks: releaseHeldLockFlag,
  };

  const session = await beginAdminBulkOperation<AdminOffboardingResult>({
    db,
    tenantId,
    operation: 'admin.user.offboard',
    idempotencyKey: input.idempotencyKey ?? null,
    payload,
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const directPermissionRows = revokeDirectPermissions
      ? await db
          .prepare(
            `SELECT p.id, p.target_type, p.target_id,
                    CASE
                      WHEN p.target_type = 'folder' THEN p.target_id
                      ELSE fl.folder_id
                    END AS folder_id
               FROM permissions p
               LEFT JOIN files fl
                 ON p.target_type = 'file'
                AND fl.tenant_id = p.tenant_id
                AND fl.id = p.target_id
              WHERE p.tenant_id = ?
                AND p.grantee_type = 'user'
                AND p.grantee_id = ?`
          )
          .bind(tenantId, userId)
          .all<DirectPermissionRow>()
      : { results: [] as DirectPermissionRow[] };

    const { statements, summary } = buildOffboardingStatements({
      db,
      tenantId,
      userId,
      actor,
      target,
      preview,
      transferTarget,
      directPermissionRows: directPermissionRows.results,
      sharedLinksAction,
      fileRequestsAction,
      userAction,
      revokeDirectPermissions,
      removeGroupMemberships,
      releaseHeldLockFlag,
      nowIso,
    });

    const results = await executeBatchChunks(db, statements);
    summary.locksReleased = releaseHeldLockFlag
      ? await releaseHeldLocks(env, tenantId, userId, preview.heldLocks)
      : 0;

    const response: AdminOffboardingResult = {
      ok: true,
      replayed: false,
      user: await loadMemberRowStrict(db, tenantId, target.id),
      transferTarget,
      options: {
        sharedLinksAction,
        fileRequestsAction,
        userAction,
        revokeDirectPermissions,
        removeGroupMemberships,
        releaseHeldLocks: releaseHeldLockFlag,
      },
      summary,
      syncSeq: extractLastSyncSeq(results),
      notice: `${
        target.email
      } をオフボーディングしました。フォルダ ${summary.transferredFolderCount} 件を移管、共有リンク ${summary.sharedLinksTransferred} 件を移管 / ${summary.sharedLinksRevoked} 件を失効、ファイルリクエスト ${summary.fileRequestsTransferred} 件を移管 / ${summary.fileRequestsDeactivated} 件を停止、有効セッション ${summary.sessionsRevoked} 件を失効させました。`,
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}
