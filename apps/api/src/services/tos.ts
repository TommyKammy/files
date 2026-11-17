import type { AuthUser, UserType } from '../types/api';
import { loadTenantBranding, type TenantBranding } from './branding';

/** Audience selector for the tenant custom Terms of Service. */
export type TosTargetAudience = 'all_users' | 'guests_only' | 'members_only';

export const DEFAULT_TOS_TITLE = '利用規約';
export const DEFAULT_TOS_BODY = '';
export const TOS_TARGET_AUDIENCES: readonly TosTargetAudience[] = [
  'all_users',
  'guests_only',
  'members_only',
];

export interface TenantTosPolicyRow {
  tenant_id: string;
  enabled: number;
  version: number;
  target_audience: TosTargetAudience;
  title: string;
  body_markdown: string;
  updated_by: string | null;
  updated_at: string;
}

export interface TosStatus {
  enabled: boolean;
  applicable: boolean;
  targetAudience: TosTargetAudience;
  version: number;
  title: string;
  bodyMarkdown: string;
  requiresAcceptance: boolean;
  accepted: boolean;
  acceptedVersion: number | null;
  acceptedAt: string | null;
  updatedAt: string | null;
}

export interface TosStatusWithBranding {
  tos: TosStatus;
  branding: TenantBranding;
}

export function isTosTargetAudience(value: unknown): value is TosTargetAudience {
  return (
    value === 'all_users' ||
    value === 'guests_only' ||
    value === 'members_only'
  );
}

/**
 * A guest-only policy never applies to members and a members-only policy never
 * applies to guests. `all_users` covers both identities.
 */
export function isTosAudienceApplicable(
  audience: TosTargetAudience,
  userType: UserType
): boolean {
  if (audience === 'guests_only') return userType === 'guest';
  if (audience === 'members_only') return userType === 'member';
  return true;
}

/**
 * TOS enforcement is intentionally scoped to workspace/share data APIs.
 * Authentication, admin settings, bootstrap, and public share/file-request
 * entry points stay reachable so a tenant can never lock itself out and users
 * can always read and accept the terms.
 */
const TOS_EXEMPT_EXACT = new Set(['/api/sync/bootstrap']);
const TOS_EXEMPT_PREFIXES = ['/api/auth', '/auth', '/api/admin', '/api/s', '/api/fr'];
const TOS_PROTECTED_PREFIXES = [
  '/api/workspace',
  '/api/folders',
  '/api/files',
  '/api/shared-links',
  '/api/shared-items',
  '/api/file-requests',
  '/api/trash',
  '/api/permissions',
  '/api/search',
  '/api/guests',
  '/api/sync/delta',
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isTosProtectedPath(pathname: string): boolean {
  if (!pathname || !pathname.startsWith('/api')) return false;
  if (TOS_EXEMPT_EXACT.has(pathname)) return false;
  if (TOS_EXEMPT_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    return false;
  }
  return TOS_PROTECTED_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

function projectStatus(
  row: TenantTosPolicyRow | null,
  userType: UserType,
  acceptedVersion: number | null,
  acceptedAt: string | null
): TosStatus {
  const targetAudience = isTosTargetAudience(row?.target_audience)
    ? row.target_audience
    : 'all_users';
  const enabled = row?.enabled === 1;
  const version = row?.version ?? 1;
  const applicable = enabled && isTosAudienceApplicable(targetAudience, userType);
  const accepted = acceptedVersion !== null && acceptedVersion >= version;
  return {
    enabled,
    applicable,
    targetAudience,
    version,
    title: row?.title ?? DEFAULT_TOS_TITLE,
    bodyMarkdown: row?.body_markdown ?? DEFAULT_TOS_BODY,
    requiresAcceptance: applicable && !accepted,
    accepted,
    acceptedVersion,
    acceptedAt,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * Read the tenant TOS policy and the user's acceptance for its *current*
 * version. Two indexed point reads keep this cheap enough for the per-request
 * guard.
 */
export async function loadTosStatus(
  db: D1Database,
  tenantId: string,
  userId: string,
  userType: UserType
): Promise<TosStatus> {
  const [policy, acceptance] = await Promise.all([
    db
      .prepare('SELECT * FROM tenant_tos_policies WHERE tenant_id = ?')
      .bind(tenantId)
      .first<TenantTosPolicyRow>(),
    db
      .prepare(
        `SELECT version, accepted_at
           FROM user_tos_acceptances
          WHERE tenant_id = ? AND user_id = ?
          ORDER BY version DESC
          LIMIT 1`
      )
      .bind(tenantId, userId)
      .first<{ version: number; accepted_at: string }>(),
  ]);
  return projectStatus(
    policy,
    userType,
    acceptance?.version ?? null,
    acceptance?.accepted_at ?? null
  );
}

export async function loadTosStatusWithBranding(
  db: D1Database,
  tenantId: string,
  userId: string,
  userType: UserType
): Promise<TosStatusWithBranding> {
  const [tos, branding] = await Promise.all([
    loadTosStatus(db, tenantId, userId, userType),
    loadTenantBranding(db, tenantId),
  ]);
  return { tos, branding };
}

export function tosAcceptanceRequiredResponse(status: TosStatus): Response {
  return new Response(
    JSON.stringify({
      error: 'Tenant terms of service acceptance is required',
      code: 'TOS_ACCEPTANCE_REQUIRED',
      version: status.version,
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    }
  );
}

/** Request guard used by `sessionAuthMiddleware` for workspace data APIs. */
export async function enforceTosAcceptanceForPath(
  db: D1Database,
  user: AuthUser,
  pathname: string
): Promise<Response | null> {
  if (!isTosProtectedPath(pathname)) return null;
  const status = await loadTosStatus(
    db,
    user.tenantId,
    user.id,
    user.userType
  );
  if (!status.requiresAcceptance) return null;
  return tosAcceptanceRequiredResponse(status);
}

export function formatTosAudienceLabel(audience: TosTargetAudience): string {
  if (audience === 'guests_only') return '外部ゲストのみ';
  if (audience === 'members_only') return '社内メンバーのみ';
  return 'すべてのユーザー';
}
