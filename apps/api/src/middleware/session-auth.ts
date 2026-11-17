import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { recordAuthControlAudit } from '../services/auth-audit';
import { sha256Hex } from '../services/crypto-utils';
import {
  enforceSessionIpAllowlist,
  resolveClientIp,
} from '../services/ip-allowlist';
import { loadSsoPolicy } from '../services/sso-policy';
import { enforceTosAcceptanceForPath } from '../services/tos';
import type { AuthUser, UserRole, UserType } from '../types/api';
import type { OidcEnv, OidcHonoEnv } from '../types/oidc';

export const SESSION_COOKIE = '__Host-files_session';
export const LOCAL_DEV_SESSION_COOKIE = 'files_session_local';
export const OIDC_STATE_COOKIE = '__Host-files_oidc';
export const LOCAL_DEV_OIDC_STATE_COOKIE = 'files_oidc_local';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_ROLES = new Set<UserRole>(['sys_admin', 'sec_admin', 'member']);
const VALID_USER_TYPES = new Set<UserType>(['member', 'guest']);
const LOCAL_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

interface SessionRow {
  session_id: string;
  session_expires_at: string;
  revoked_at: string | null;
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: UserRole;
  status: 'active' | 'suspended';
  user_type: UserType;
  external_org: string | null;
  user_expires_at: string | null;
}

export function shouldUseSecureHostCookie(env: Pick<OidcEnv, 'ENVIRONMENT'>, requestUrl: string): boolean {
  if (env.ENVIRONMENT !== 'local') return true;
  return new URL(requestUrl).protocol === 'https:';
}

export function getSessionCookieName(env: Pick<OidcEnv, 'ENVIRONMENT'>, requestUrl: string): string {
  return shouldUseSecureHostCookie(env, requestUrl) ? SESSION_COOKIE : LOCAL_DEV_SESSION_COOKIE;
}

export function getOidcStateCookieName(env: Pick<OidcEnv, 'ENVIRONMENT'>, requestUrl: string): string {
  return shouldUseSecureHostCookie(env, requestUrl)
    ? OIDC_STATE_COOKIE
    : LOCAL_DEV_OIDC_STATE_COOKIE;
}

export function readSessionTokenFromRequest(c: Context<OidcHonoEnv>): string | undefined {
  const hostToken = getCookie(c, SESSION_COOKIE);
  if (hostToken) return hostToken;
  if (!shouldUseSecureHostCookie(c.env, c.req.url)) {
    return getCookie(c, LOCAL_DEV_SESSION_COOKIE);
  }
  return undefined;
}

export function isOriginAllowed(
  env: Pick<OidcEnv, 'ENVIRONMENT' | 'APP_ORIGIN'>,
  origin: string | undefined
): boolean {
  if (!env.APP_ORIGIN) return true;
  if (origin === env.APP_ORIGIN) return true;
  if (env.ENVIRONMENT === 'local' && origin) {
    try {
      const expectedUrl = new URL(env.APP_ORIGIN);
      const actualUrl = new URL(origin);
      if (
        LOCAL_LOOPBACK_HOSTS.has(expectedUrl.hostname) &&
        LOCAL_LOOPBACK_HOSTS.has(actualUrl.hostname) &&
        actualUrl.protocol === expectedUrl.protocol &&
        actualUrl.port === expectedUrl.port
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export function verifyRequestOriginForCsrf(c: Context<OidcHonoEnv>): Response | null {
  if (!UNSAFE_METHODS.has(c.req.method)) return null;

  const origin = c.req.header('Origin');
  if (!c.env.APP_ORIGIN && c.env.ENVIRONMENT !== 'local') {
    return c.json({ error: 'APP_ORIGIN is not configured' }, 500);
  }
  if (c.env.APP_ORIGIN && (origin !== undefined || c.env.ENVIRONMENT !== 'local')) {
    if (!isOriginAllowed(c.env, origin)) {
      return c.json({ error: 'Invalid origin' }, 403);
    }
  }
  return null;
}

/** ローカル開発専用バイパス: 3 条件すべてを満たす場合のみ有効（誤デプロイ時のなりすまし防止） */
export function isLocalDevBypassAllowed(c: Context<OidcHonoEnv>): boolean {
  if (c.env.ENVIRONMENT !== 'local' || c.env.ALLOW_DEV_AUTH !== 'true') return false;
  const host = new URL(c.req.url).hostname;
  return LOCAL_LOOPBACK_HOSTS.has(host);
}

function isGuestUserExpired(
  userType: UserType,
  expiresAt: string | null | undefined,
  nowIso: string
): boolean {
  if (userType !== 'guest') return false;
  return Boolean(expiresAt) && expiresAt! <= nowIso;
}

/**
 * P10-2: give the web client an actionable reason for a rejected guest
 * session. Members keep the generic message so existing sign-in flows and
 * tests are unchanged (the `code` is additive).
 */
function sessionFailure(
  row: Pick<
    SessionRow,
    'user_type' | 'status' | 'user_expires_at' | 'session_expires_at' | 'revoked_at'
  >,
  nowIso: string
): { code: string; error: string } {
  if (row.user_type === 'guest') {
    if (row.status !== 'active') {
      return {
        code: 'GUEST_ACCOUNT_SUSPENDED',
        error: 'Guest account is suspended',
      };
    }
    if (isGuestUserExpired('guest', row.user_expires_at, nowIso)) {
      return {
        code: 'GUEST_ACCOUNT_EXPIRED',
        error: 'Guest account has expired',
      };
    }
    return {
      code: 'SESSION_EXPIRED_OR_REVOKED',
      error: 'Guest session expired or was revoked',
    };
  }
  if (row.status !== 'active') {
    return {
      code: 'ACCOUNT_SUSPENDED',
      error: 'Account is suspended',
    };
  }
  return {
    code: 'SESSION_EXPIRED_OR_REVOKED',
    error: 'Session expired or revoked',
  };
}

export function sessionAuthMiddleware(options: { required?: boolean } = {}) {
  const isRequired = options.required ?? true;

  return createMiddleware<OidcHonoEnv>(async (c, next) => {
    const ipAddress = resolveClientIp(c);

    const csrfError = verifyRequestOriginForCsrf(c);
    if (csrfError) return csrfError;

    if (isLocalDevBypassAllowed(c)) {
      const devUserId = c.req.header('X-Dev-User-Id');
      if (devUserId) {
        const devTenantId =
          c.req.header('X-Dev-Tenant-Id') ??
          c.env.DEFAULT_TENANT_ID ??
          'tenant-default';

        // TOM-66: a tenant that requires SSO must not accept the raw local
        // header bypass. Existing D1 session cookies are intentionally still
        // accepted so administrators can disable the policy or sign out.
        const ssoPolicy = await loadSsoPolicy(c.env.DB, devTenantId);
        if (ssoPolicy.requireSsoLogin) {
          await recordAuthControlAudit(c.env.DB, {
            tenantId: devTenantId,
            actorId: devUserId,
            actorEmail:
              c.req.header('X-Dev-User-Email') ?? 'dev-admin@example.com',
            actorIp: ipAddress,
            action: 'auth.sso_required_blocked',
            targetId: new URL(c.req.url).pathname,
            status: 'blocked',
            metadata: {
              source: 'dev_header_bypass',
              path: new URL(c.req.url).pathname,
            },
          });
          return c.json(
            {
              error: 'SSO login is required for this tenant',
              code: 'SSO_LOGIN_REQUIRED',
            },
            403
          );
        }

        const rawRole = c.req.header('X-Dev-User-Role') as UserRole | undefined;
        const role: UserRole = rawRole && VALID_ROLES.has(rawRole) ? rawRole : 'sys_admin';
        const rawUserType = c.req.header('X-Dev-User-Type');
        const userType: UserType =
          rawUserType && VALID_USER_TYPES.has(rawUserType as UserType)
            ? (rawUserType as UserType)
            : 'member';
        const expiresAt = c.req.header('X-Dev-User-Expires-At') ?? null;
        if (
          isGuestUserExpired(userType, expiresAt, new Date().toISOString())
        ) {
          c.set('user', null);
          if (isRequired) {
            return c.json(
              {
                error: 'Guest account has expired',
                code: 'GUEST_ACCOUNT_EXPIRED',
              },
              401
            );
          }
          await next();
          return;
        }
        const devUser = {
          id: devUserId,
          tenantId: devTenantId,
          email: c.req.header('X-Dev-User-Email') ?? 'dev-admin@example.com',
          displayName: c.req.header('X-Dev-User-Name') ?? 'Dev Admin',
          role,
          ipAddress,
          userType,
          externalOrg: c.req.header('X-Dev-External-Org') ?? null,
          expiresAt,
          sessionId: c.req.header('X-Dev-Session-Id') ?? null,
        } satisfies AuthUser;
        c.set('user', devUser);

        const ipBlocked = await enforceSessionIpAllowlist(c, devUser);
        if (ipBlocked) return ipBlocked;

        // TOM-72: custom ToS acceptance gate for workspace data APIs. Admin,
        // auth, bootstrap and public share/file-request paths are exempt.
        const tosBlocked = await enforceTosAcceptanceForPath(
          c.env.DB,
          devUser,
          c.req.path
        );
        if (tosBlocked) return tosBlocked;

        await next();
        return;
      }
    }

    const token = readSessionTokenFromRequest(c);
    if (!token) {
      c.set('user', null);
      if (isRequired) {
        return c.json(
          {
            error: 'Authentication required',
            code: 'AUTHENTICATION_REQUIRED',
          },
          401
        );
      }
      await next();
      return;
    }

    const tokenHash = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      `SELECT s.id AS session_id,
              s.expires_at AS session_expires_at,
              s.revoked_at,
              u.id, u.tenant_id, u.email, u.display_name, u.role, u.status,
              u.user_type, u.external_org, u.expires_at AS user_expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL`
    )
      .bind(tokenHash)
      .first<SessionRow>();

    const nowIso = new Date().toISOString();
    if (row) {
      const expired =
        row.session_expires_at <= nowIso ||
        row.status !== 'active' ||
        isGuestUserExpired(row.user_type, row.user_expires_at, nowIso);
      if (expired) {
        c.set('user', null);
        if (isRequired) {
          const failure = sessionFailure(row, nowIso);
          return c.json({ error: failure.error, code: failure.code }, 401);
        }
        await next();
        return;
      }
    }

    if (!row) {
      // The active-session lookup intentionally excludes revoked rows. Read the
      // most recent matching session once more so a revoked/expired guest gets
      // a precise reason instead of a generic authentication error.
      const stale = await c.env.DB.prepare(
        `SELECT s.id AS session_id,
                s.expires_at AS session_expires_at,
                s.revoked_at,
                u.id, u.tenant_id, u.email, u.display_name, u.role, u.status,
                u.user_type, u.external_org, u.expires_at AS user_expires_at
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?
          ORDER BY s.created_at DESC
          LIMIT 1`
      )
        .bind(tokenHash)
        .first<SessionRow>();
      c.set('user', null);
      if (isRequired) {
        const failure = stale
          ? sessionFailure(stale, nowIso)
          : {
              code: 'SESSION_EXPIRED_OR_REVOKED',
              error: 'Session expired or revoked',
            };
        return c.json({ error: failure.error, code: failure.code }, 401);
      }
      await next();
      return;
    }

    const authenticatedUser = {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      ipAddress,
      userType: row.user_type,
      externalOrg: row.external_org,
      expiresAt: row.user_expires_at,
      sessionId: row.session_id,
    } satisfies AuthUser;
    c.set('user', authenticatedUser);

    const ipBlocked = await enforceSessionIpAllowlist(c, authenticatedUser);
    if (ipBlocked) return ipBlocked;

    const tosBlocked = await enforceTosAcceptanceForPath(
      c.env.DB,
      authenticatedUser,
      c.req.path
    );
    if (tosBlocked) return tosBlocked;

    await next();
  });
}
