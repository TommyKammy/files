import type { AuthUser } from '../../types/api';
import { beginAdminBulkOperation } from '../admin-bulk-idempotency';
import { buildAuditLogStmt } from '../audit';
import { buildSyncChangeStmt } from '../sync-changes';
import { extractLastSyncSeq } from '../sync-notifier';
import {
  AdminUserError,
  assertActorCanManageTarget,
  loadMemberRowStrict,
  loadTargetUser,
  normalizeDepartment,
  normalizeDisplayName,
  normalizeEmail,
  normalizeRole,
  normalizeStorageQuotaBytes,
  requireMemberTarget,
} from './shared';
import type { AdminUserMutationResult } from './types';

export async function createAdminUser(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  email: unknown;
  displayName: unknown;
  department?: unknown;
  role?: unknown;
  storageQuotaBytes?: unknown;
}): Promise<AdminUserMutationResult> {
  const { db, tenantId, actor } = input;
  const email = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(input.displayName);
  const department = normalizeDepartment(input.department);
  const role = normalizeRole(input.role, 'member');
  const storageQuotaBytes =
    normalizeStorageQuotaBytes(input.storageQuotaBytes, {
      allowUndefined: true,
    }) ?? null;

  const duplicate = await db
    .prepare(
      `SELECT id, user_type FROM users
        WHERE tenant_id = ? AND lower(email) = lower(?) LIMIT 1`
    )
    .bind(tenantId, email)
    .first<{ id: string; user_type: 'member' | 'guest' }>();
  if (duplicate) {
    throw new AdminUserError(
      409,
      'EMAIL_ALREADY_EXISTS',
      'A member or guest account already uses this email address'
    );
  }

  const userId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO users (
             id, tenant_id, email, display_name, department, role, status,
             user_type, storage_quota_bytes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'member', ?, ?, ?)`
        )
        .bind(
          userId,
          tenantId,
          email,
          displayName,
          department,
          role,
          storageQuotaBytes,
          nowIso,
          nowIso
        ),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.create',
        targetType: 'user',
        targetId: userId,
        metadata: {
          userId,
          email,
          displayName,
          department,
          role,
          storageQuotaBytes,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: userId,
        targetUserId: userId,
        action: 'admin.user.create',
        payload: { email, displayName, department, role, status: 'active' },
        nowIso,
      }),
    ]);
  } catch (err) {
    if (((err as Error).message ?? '').includes('UNIQUE constraint failed')) {
      throw new AdminUserError(
        409,
        'EMAIL_ALREADY_EXISTS',
        'A member or guest account already uses this email address'
      );
    }
    throw err;
  }

  return {
    ok: true,
    user: await loadMemberRowStrict(db, tenantId, userId),
    syncSeq: extractLastSyncSeq(results),
    notice: `${email} を社内メンバーとして登録しました。`,
  };
}

export async function updateAdminUser(input: {
  db: D1Database;
  tenantId: string;
  userId: string;
  actor: AuthUser;
  displayName?: unknown;
  department?: unknown;
  role?: unknown;
  storageQuotaBytes?: unknown;
}): Promise<AdminUserMutationResult> {
  const { db, tenantId, userId, actor } = input;
  const target = requireMemberTarget(
    await loadTargetUser(db, tenantId, userId)
  );

  const nextDisplayName =
    input.displayName === undefined
      ? target.display_name
      : normalizeDisplayName(input.displayName);
  const nextDepartment =
    input.department === undefined
      ? target.department
      : normalizeDepartment(input.department);
  const nextRole = normalizeRole(input.role, target.role);
  const quotaInput = normalizeStorageQuotaBytes(input.storageQuotaBytes, {
    allowUndefined: true,
  });
  const nextQuota =
    quotaInput === undefined ? target.storage_quota_bytes : quotaInput;

  const roleChanged = nextRole !== target.role;
  const displayNameChanged = nextDisplayName !== target.display_name;
  const departmentChanged = nextDepartment !== target.department;
  const quotaChanged = nextQuota !== target.storage_quota_bytes;

  if (
    !roleChanged &&
    !displayNameChanged &&
    !departmentChanged &&
    !quotaChanged
  ) {
    return {
      ok: true,
      user: await loadMemberRowStrict(db, tenantId, userId),
      syncSeq: null,
      notice: '変更はありません。',
    };
  }

  if (roleChanged) {
    if (target.id === actor.id) {
      throw new AdminUserError(
        409,
        'CANNOT_SELF_MODIFY_PRIVILEGE',
        'You cannot change your own administrative role'
      );
    }
    if (
      target.role === 'sys_admin' &&
      target.status === 'active' &&
      nextRole !== 'sys_admin'
    ) {
      const otherAdmins = await db
        .prepare(
          `SELECT COUNT(*) AS count FROM users
            WHERE tenant_id = ? AND user_type = 'member'
              AND role = 'sys_admin' AND status = 'active' AND id <> ?`
        )
        .bind(tenantId, target.id)
        .first<{ count: number }>();
      if ((otherAdmins?.count ?? 0) === 0) {
        throw new AdminUserError(
          409,
          'LAST_SYS_ADMIN_REQUIRED',
          'At least one active sys_admin must remain'
        );
      }
    }
  }

  const nowIso = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users
            SET display_name = ?, department = ?, role = ?,
                storage_quota_bytes = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
      )
      .bind(
        nextDisplayName,
        nextDepartment,
        nextRole,
        nextQuota,
        nowIso,
        tenantId,
        target.id
      ),
    buildAuditLogStmt(db, {
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: actor.ipAddress,
      action: 'admin.user.update',
      targetType: 'user',
      targetId: target.id,
      metadata: {
        userId: target.id,
        email: target.email,
        previous: {
          displayName: target.display_name,
          department: target.department,
          role: target.role,
          storageQuotaBytes: target.storage_quota_bytes,
        },
        next: {
          displayName: nextDisplayName,
          department: nextDepartment,
          role: nextRole,
          storageQuotaBytes: nextQuota,
        },
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId,
      entityType: 'user',
      entityId: target.id,
      targetUserId: target.id,
      action: 'admin.user.update',
      payload: {
        email: target.email,
        displayName: nextDisplayName,
        department: nextDepartment,
        role: nextRole,
        storageQuotaBytes: nextQuota,
      },
      nowIso,
    }),
  ]);

  return {
    ok: true,
    user: await loadMemberRowStrict(db, tenantId, target.id),
    syncSeq: extractLastSyncSeq(results),
    notice: `${target.email} のメンバー情報を更新しました。`,
  };
}

export async function suspendAdminUser(input: {
  db: D1Database;
  tenantId: string;
  userId: string;
  actor: AuthUser;
  idempotencyKey?: string | null;
}): Promise<AdminUserMutationResult> {
  const { db, tenantId, userId, actor } = input;
  const target = requireMemberTarget(
    await loadTargetUser(db, tenantId, userId)
  );

  if (target.id === actor.id) {
    throw new AdminUserError(
      409,
      'CANNOT_SELF_MODIFY_PRIVILEGE',
      'You cannot suspend your own account'
    );
  }
  assertActorCanManageTarget(actor, target);

  const session = await beginAdminBulkOperation<AdminUserMutationResult>({
    db,
    tenantId,
    operation: 'admin.user.suspend',
    idempotencyKey: input.idempotencyKey ?? null,
    payload: { userId },
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    if (target.role === 'sys_admin' && target.status === 'active') {
      const otherAdmins = await db
        .prepare(
          `SELECT COUNT(*) AS count FROM users
            WHERE tenant_id = ? AND user_type = 'member'
              AND role = 'sys_admin' AND status = 'active' AND id <> ?`
        )
        .bind(tenantId, target.id)
        .first<{ count: number }>();
      if ((otherAdmins?.count ?? 0) === 0) {
        throw new AdminUserError(
          409,
          'LAST_SYS_ADMIN_REQUIRED',
          'At least one active sys_admin must remain'
        );
      }
    }

    const nowIso = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = 'suspended', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
        )
        .bind(nowIso, tenantId, target.id),
      db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, tenantId, target.id),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.suspend',
        targetType: 'user',
        targetId: target.id,
        metadata: {
          userId: target.id,
          email: target.email,
          role: target.role,
          previousStatus: target.status,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: target.id,
        targetUserId: target.id,
        action: 'user.suspended',
        payload: {
          email: target.email,
          status: 'suspended',
          reason: 'admin_suspend',
        },
        nowIso,
      }),
    ]);

    const sessionsRevoked = results[1]?.meta.changes ?? 0;
    const response: AdminUserMutationResult = {
      ok: true,
      user: await loadMemberRowStrict(db, tenantId, target.id),
      sessionsRevoked,
      syncSeq: extractLastSyncSeq(results),
      notice: `メンバーを停止し、有効セッション ${sessionsRevoked} 件を失効させました。`,
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

/**
 * `sessionsRevoked` in the audit row cannot include the final count because the
 * `UPDATE sessions` result is only available after the batch runs. The
 * authoritative count is returned in the API response and sync event.
 */

export async function resumeAdminUser(input: {
  db: D1Database;
  tenantId: string;
  userId: string;
  actor: AuthUser;
  idempotencyKey?: string | null;
}): Promise<AdminUserMutationResult> {
  const { db, tenantId, userId, actor } = input;
  const target = requireMemberTarget(
    await loadTargetUser(db, tenantId, userId)
  );
  assertActorCanManageTarget(actor, target);

  const session = await beginAdminBulkOperation<AdminUserMutationResult>({
    db,
    tenantId,
    operation: 'admin.user.resume',
    idempotencyKey: input.idempotencyKey ?? null,
    payload: { userId },
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = 'active', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
        )
        .bind(nowIso, tenantId, target.id),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.resume',
        targetType: 'user',
        targetId: target.id,
        metadata: {
          userId: target.id,
          email: target.email,
          role: target.role,
          previousStatus: target.status,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: target.id,
        targetUserId: target.id,
        action: 'admin.user.resume',
        payload: { email: target.email, status: 'active' },
        nowIso,
      }),
    ]);

    const response: AdminUserMutationResult = {
      ok: true,
      user: await loadMemberRowStrict(db, tenantId, target.id),
      syncSeq: extractLastSyncSeq(results),
      notice: 'メンバーアカウントを再開しました。',
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}
