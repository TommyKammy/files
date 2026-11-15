import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { sha256Hex } from '../services/crypto-utils';
import type { AuthUser, UserRole } from '../types/api';
import type { OidcEnv, OidcHonoEnv } from '../types/oidc';

export const SESSION_COOKIE = '__Host-files_session';
export const LOCAL_DEV_SESSION_COOKIE = 'files_session_local';
export const OIDC_STATE_COOKIE = '__Host-files_oidc';
export const LOCAL_DEV_OIDC_STATE_COOKIE = 'files_oidc_local';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VALID_ROLES = new Set<UserRole>(['sys_admin', 'sec_admin', 'member']);
const LOCAL_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

interface SessionRow {
  expires_at: string;
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: UserRole;
  status: 'active' | 'suspended';
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

export function sessionAuthMiddleware(options: { required?: boolean } = {}) {
  const isRequired = options.required ?? true;

  return createMiddleware<OidcHonoEnv>(async (c, next) => {
    const ipAddress = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';

    const csrfError = verifyRequestOriginForCsrf(c);
    if (csrfError) return csrfError;

    if (isLocalDevBypassAllowed(c)) {
      const devUserId = c.req.header('X-Dev-User-Id');
      if (devUserId) {
        const rawRole = c.req.header('X-Dev-User-Role') as UserRole | undefined;
        const role: UserRole = rawRole && VALID_ROLES.has(rawRole) ? rawRole : 'sys_admin';
        c.set('user', {
          id: devUserId,
          tenantId: c.req.header('X-Dev-Tenant-Id') ?? c.env.DEFAULT_TENANT_ID ?? 'tenant-default',
          email: c.req.header('X-Dev-User-Email') ?? 'dev-admin@example.com',
          displayName: c.req.header('X-Dev-User-Name') ?? 'Dev Admin',
          role,
          ipAddress,
        });
        await next();
        return;
      }
    }

    const token = readSessionTokenFromRequest(c);
    if (!token) {
      c.set('user', null);
      if (isRequired) return c.json({ error: 'Authentication required' }, 401);
      await next();
      return;
    }

    const row = await c.env.DB.prepare(
      `SELECT s.expires_at, u.id, u.tenant_id, u.email, u.display_name, u.role, u.status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL`
    )
      .bind(await sha256Hex(token))
      .first<SessionRow>();

    if (!row || row.expires_at <= new Date().toISOString() || row.status !== 'active') {
      c.set('user', null);
      if (isRequired) return c.json({ error: 'Session expired or revoked' }, 401);
      await next();
      return;
    }

    c.set('user', {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      ipAddress,
    } satisfies AuthUser);

    await next();
  });
}
