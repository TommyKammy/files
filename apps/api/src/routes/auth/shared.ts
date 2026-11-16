import { deleteCookie, setCookie } from 'hono/cookie';
import { getSessionCookieName, shouldUseSecureHostCookie } from '../../middleware/session-auth';
import { generateRandomToken, sha256Hex } from '../../services/crypto-utils';
import type { UserRole } from '../../types/api';
import type { IdpProviderConfig, OidcEnv, OidcHonoEnv } from '../../types/oidc';

export interface OidcStatePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  idp: 'okta' | 'entra_id';
  tenantId: string;
  returnTo: string;
  exp: number;
}

export interface DevAccountRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: UserRole;
}

export const DEFAULT_SESSION_HOURS = 12;
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
export const DEV_ACCOUNT_ROLES: readonly UserRole[] = ['sys_admin', 'sec_admin', 'member'];

export function sanitizeReturnTo(raw?: string): string {
  if (!raw) return '/workspace';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.includes('\\')) {
    return '/workspace';
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return '/workspace';
  }
  try {
    const parsed = new URL(trimmed, 'https://files.invalid');
    if (parsed.origin !== 'https://files.invalid') {
      return '/workspace';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/workspace';
  }
}

export function getCallbackBaseOrigin(env: OidcEnv, requestUrl: string): string {
  const configured = env.APP_ORIGIN?.trim().replace(/\/$/, '');
  if (configured) return configured;
  return new URL(requestUrl).origin;
}

export function resolveProviderById(
  providers: IdpProviderConfig[],
  idpParam?: string
): IdpProviderConfig | null {
  if (!idpParam) return providers[0] ?? null;
  if (idpParam !== 'okta' && idpParam !== 'entra_id') return null;
  return providers.find((p) => p.provider === idpParam) ?? null;
}

export function getClientSecretForProvider(
  env: OidcEnv,
  provider: 'okta' | 'entra_id'
): string | undefined {
  return provider === 'okta' ? env.OKTA_CLIENT_SECRET : env.ENTRA_CLIENT_SECRET;
}

export function clearHostOrLocalCookies(
  c: import('hono').Context<OidcHonoEnv>,
  hostCookieName: string,
  localCookieName: string
): void {
  const useSecure = shouldUseSecureHostCookie(c.env, c.req.url);
  deleteCookie(c, hostCookieName, { path: '/', secure: true });
  if (!useSecure) {
    deleteCookie(c, localCookieName, { path: '/' });
  }
}

export async function recordAuthAudit(
  db: D1Database,
  params: {
    tenantId: string;
    actorId: string | null;
    actorEmail: string | null;
    actorIp: string;
    action: string;
    targetId: string;
    status: 'allowed' | 'blocked';
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action,
         target_type, target_id, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'auth', ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      params.tenantId,
      params.actorId,
      params.actorEmail,
      params.actorIp,
      params.action,
      params.targetId,
      params.status,
      JSON.stringify(params.metadata),
      new Date().toISOString()
    )
    .run();
}

export async function issueSessionForUser(
  c: import('hono').Context<OidcHonoEnv>,
  params: {
    tenantId: string;
    userId: string;
    email: string;
    ipAddress: string;
    auditAction: 'auth.login' | 'auth.dev_login';
    auditMetadata: Record<string, unknown>;
  }
): Promise<void> {
  const policy = await c.env.DB.prepare(
    'SELECT session_max_hours FROM tenant_policies WHERE tenant_id = ?'
  )
    .bind(params.tenantId)
    .first<{ session_max_hours: number }>();

  const sessionHours = policy?.session_max_hours ?? DEFAULT_SESSION_HOURS;
  const maxAgeSec = sessionHours * 3600;
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + maxAgeSec * 1000).toISOString();
  const sessionToken = generateRandomToken(32);
  const tokenHash = await sha256Hex(sessionToken);
  const sessionId = crypto.randomUUID();
  const userAgent = c.req.header('User-Agent')?.slice(0, 512) ?? null;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO sessions (
         id, tenant_id, user_id, token_hash, ip_address, user_agent, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sessionId,
      params.tenantId,
      params.userId,
      tokenHash,
      params.ipAddress,
      userAgent,
      expiresAtIso,
      nowIso
    ),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action,
         target_type, target_id, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'session', ?, 'allowed', ?, ?)`
    ).bind(
      crypto.randomUUID(),
      params.tenantId,
      params.userId,
      params.email,
      params.ipAddress,
      params.auditAction,
      sessionId,
      JSON.stringify(params.auditMetadata),
      nowIso
    ),
  ]);

  const useSecure = shouldUseSecureHostCookie(c.env, c.req.url);
  setCookie(c, getSessionCookieName(c.env, c.req.url), sessionToken, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: useSecure,
    maxAge: maxAgeSec,
  });
}

export async function pickRepresentativeDevAccount(
  db: D1Database,
  tenantId: string,
  role: UserRole
): Promise<DevAccountRow | null> {
  return db
    .prepare(
      `SELECT u.id, u.tenant_id, u.email, u.display_name, u.role
         FROM users u
        WHERE u.tenant_id = ?
          AND u.status = 'active'
          AND u.role = ?
        ORDER BY CASE
          WHEN EXISTS (
            SELECT 1
              FROM permissions p
              JOIN folders f ON f.id = p.target_id
             WHERE p.tenant_id = u.tenant_id
               AND p.target_type = 'folder'
               AND f.parent_id IS NULL
               AND f.deleted_at IS NULL
               AND (
                 (p.grantee_type = 'user' AND p.grantee_id = u.id)
                 OR (
                   p.grantee_type = 'group'
                   AND EXISTS (
                     SELECT 1 FROM group_members gm
                      WHERE gm.group_id = p.grantee_id AND gm.user_id = u.id
                   )
                 )
               )
          ) THEN 0 ELSE 1
        END ASC, u.id ASC
        LIMIT 1`
    )
    .bind(tenantId, role)
    .first<DevAccountRow>();
}

