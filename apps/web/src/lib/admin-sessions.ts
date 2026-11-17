import type {
  AdminCapability,
  AdminSessionListQuery,
  AdminSessionUserTypeFilter,
  UserRole,
  UserType,
} from '@/types/files';

/**
 * P12-2 / TOM-71 session console rules shared by `/admin/users` and
 * `/admin/settings`. Keeping them pure makes the RBAC matrix unit-testable.
 */

export type AdminSessionRevocationKind =
  | 'session.revoked'
  | 'tenant.sessions_revoked';

export const ADMIN_SESSION_USER_TYPE_LABELS: Record<UserType, string> = {
  member: '社内メンバー',
  guest: '外部ゲスト',
};

export const ADMIN_SESSION_USER_TYPE_FILTER_LABELS: Record<
  AdminSessionUserTypeFilter,
  string
> = {
  all: 'すべて',
  member: '社内メンバー',
  guest: '外部ゲスト',
};

export const ADMIN_SESSION_STATUS_LABELS = {
  active: '有効',
  suspended: '停止中',
} as const;

export const ADMIN_SESSION_REVOKE_REASON_MAX = 300;

function hasSessionCapability(
  capabilities: readonly AdminCapability[] | null | undefined,
  capability: AdminCapability
): boolean {
  return (capabilities ?? []).includes(capability);
}

export function canViewAdminSessions(
  role: UserRole | null | undefined,
  capabilities?: readonly AdminCapability[] | null
): boolean {
  return (
    role === 'sys_admin' ||
    role === 'sec_admin' ||
    (role === 'member' && hasSessionCapability(capabilities, 'admin.users.read'))
  );
}

export function canRevokeAllAdminSessions(
  role: UserRole | null | undefined
): boolean {
  return role === 'sys_admin';
}

/**
 * `sec_admin` may force-sign-out members, guests and other `sec_admin`
 * accounts, but never a tenant owner.
 */
export function adminSessionTargetGuardReason(
  actorRole: UserRole | null | undefined,
  targetRole: UserRole,
  capabilities?: readonly AdminCapability[] | null
): string | null {
  if (actorRole === 'sec_admin' && targetRole === 'sys_admin') {
    return 'セキュリティ管理者 (sec_admin) はシステム管理者 (sys_admin) のセッションを失効できません。';
  }
  if (
    actorRole === 'member' &&
    (!hasSessionCapability(capabilities, 'admin.users.suspend') ||
      targetRole !== 'member')
  ) {
    return 'Co-Admin は委任された一般メンバーのセッションのみ失効できます。';
  }
  return null;
}

export function canRevokeAdminSession(
  actorRole: UserRole | null | undefined,
  targetRole: UserRole,
  capabilities?: readonly AdminCapability[] | null
): boolean {
  if (!canViewAdminSessions(actorRole, capabilities)) return false;
  return (
    adminSessionTargetGuardReason(actorRole, targetRole, capabilities) === null
  );
}

/** Trims and enforces the API's 1–300 character optional reason contract. */
export function validateAdminSessionReasonInput(
  raw: string
): { ok: true; reason: string | null } | { ok: false; error: string } {
  const reason = raw.trim();
  if (!reason) return { ok: true, reason: null };
  if (reason.length > ADMIN_SESSION_REVOKE_REASON_MAX) {
    return {
      ok: false,
      error: `理由は ${ADMIN_SESSION_REVOKE_REASON_MAX} 文字以内で入力してください。`,
    };
  }
  return { ok: true, reason };
}

export function buildAdminSessionQuery(
  query: AdminSessionListQuery = {}
): string {
  const qs = new URLSearchParams();
  if (query.userId) qs.set('userId', query.userId);
  if (query.userType && query.userType !== 'all') {
    qs.set('userType', query.userType);
  }
  if (query.ip?.trim()) qs.set('ip', query.ip.trim());
  if (query.q?.trim()) qs.set('q', query.q.trim());
  if (query.limit) qs.set('limit', String(query.limit));
  if (query.cursor) qs.set('cursor', query.cursor);
  const suffix = qs.toString();
  return suffix ? `?${suffix}` : '';
}

export function shortAdminSessionId(sessionId: string): string {
  return sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId;
}

export function isAdminSessionRevocationKind(
  kind: string
): kind is AdminSessionRevocationKind {
  return kind === 'session.revoked' || kind === 'tenant.sessions_revoked';
}

export function adminSessionRevocationMessage(
  kind: AdminSessionRevocationKind
): string {
  return kind === 'tenant.sessions_revoked'
    ? '管理者がテナント内の全セッションを緊急失効しました。安全のため再度サインインしてください。'
    : '管理者がこのセッションを強制サインアウトしました。安全のため再度サインインしてください。';
}
