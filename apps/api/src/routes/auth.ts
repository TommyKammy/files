import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  getOidcStateCookieName,
  getSessionCookieName,
  isLocalDevBypassAllowed,
  LOCAL_DEV_OIDC_STATE_COOKIE,
  LOCAL_DEV_SESSION_COOKIE,
  OIDC_STATE_COOKIE,
  readSessionTokenFromRequest,
  SESSION_COOKIE,
  sessionAuthMiddleware,
  shouldUseSecureHostCookie,
  verifyRequestOriginForCsrf,
} from '../middleware/session-auth';
import {
  decryptCookiePayload,
  encryptCookiePayload,
  generateRandomToken,
  sha256Base64Url,
  sha256Hex,
  timingSafeEqual,
} from '../services/crypto-utils';
import {
  buildConfiguredIdpProviders,
  fetchOidcDiscovery,
  OidcVerificationError,
  verifyOidcIdToken,
} from '../services/oidc-verifier';
import { AccountLinkConflictError, syncUserWithD1 } from '../services/user-sync';
import type { UserRole } from '../types/api';
import type { IdpProviderConfig, OidcEnv, OidcHonoEnv } from '../types/oidc';

interface OidcStatePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  idp: 'okta' | 'entra_id';
  tenantId: string;
  returnTo: string;
  exp: number;
}

interface DevAccountRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  role: UserRole;
}

const DEFAULT_SESSION_HOURS = 12;
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const DEV_ACCOUNT_ROLES: readonly UserRole[] = ['sys_admin', 'sec_admin', 'member'];

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

function getCallbackBaseOrigin(env: OidcEnv, requestUrl: string): string {
  const configured = env.APP_ORIGIN?.trim().replace(/\/$/, '');
  if (configured) return configured;
  return new URL(requestUrl).origin;
}

function resolveProviderById(
  providers: IdpProviderConfig[],
  idpParam?: string
): IdpProviderConfig | null {
  if (!idpParam) return providers[0] ?? null;
  if (idpParam !== 'okta' && idpParam !== 'entra_id') return null;
  return providers.find((p) => p.provider === idpParam) ?? null;
}

function getClientSecretForProvider(
  env: OidcEnv,
  provider: 'okta' | 'entra_id'
): string | undefined {
  return provider === 'okta' ? env.OKTA_CLIENT_SECRET : env.ENTRA_CLIENT_SECRET;
}

function clearHostOrLocalCookies(
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

async function recordAuthAudit(
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

async function issueSessionForUser(
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

async function pickRepresentativeDevAccount(
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

export const authRoutes = new Hono<OidcHonoEnv>();

authRoutes.get('/auth/login', async (c) => {
  const cookieKey = c.env.OIDC_STATE_COOKIE_KEY;
  if (!cookieKey || cookieKey.length < 16) {
    return c.json({ error: 'OIDC_STATE_COOKIE_KEY is not configured' }, 500);
  }

  const providers = buildConfiguredIdpProviders(c.env);
  const requestedIdp = c.req.query('idp');
  const provider = resolveProviderById(providers, requestedIdp);
  if (!provider) {
    if (!requestedIdp && isLocalDevBypassAllowed(c)) {
      return c.redirect(sanitizeReturnTo(c.req.query('returnTo')), 302);
    }
    return c.json({ error: 'Requested OIDC provider is not configured' }, 400);
  }

  const tenantId = (c.req.query('tenant') ?? c.env.DEFAULT_TENANT_ID ?? 'tenant-default').trim();
  const tenantRow = await c.env.DB.prepare('SELECT id FROM tenants WHERE id = ?')
    .bind(tenantId)
    .first<{ id: string }>();
  if (!tenantRow) {
    return c.json({ error: 'Unknown tenant' }, 400);
  }

  const discovery = await fetchOidcDiscovery(provider.issuer);
  if (!discovery.authorization_endpoint) {
    return c.json({ error: 'OIDC authorization_endpoint is missing in discovery' }, 502);
  }

  const state = generateRandomToken(32);
  const nonce = generateRandomToken(32);
  const codeVerifier = generateRandomToken(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const returnTo = sanitizeReturnTo(c.req.query('returnTo'));

  const sealedState = await encryptCookiePayload(cookieKey, {
    state,
    nonce,
    codeVerifier,
    idp: provider.provider,
    tenantId: tenantRow.id,
    returnTo,
    exp: Date.now() + OIDC_STATE_TTL_MS,
  } satisfies OidcStatePayload);

  const useSecure = shouldUseSecureHostCookie(c.env, c.req.url);
  setCookie(c, getOidcStateCookieName(c.env, c.req.url), sealedState, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: useSecure,
    maxAge: Math.floor(OIDC_STATE_TTL_MS / 1000),
  });

  const redirectUri = `${getCallbackBaseOrigin(c.env, c.req.url)}/auth/callback`;
  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', provider.audience);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'openid profile email');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return c.redirect(authUrl.toString(), 302);
});

authRoutes.get('/auth/callback', async (c) => {
  const ipAddress = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
  const stateCookieName = getOidcStateCookieName(c.env, c.req.url);
  const sealedState = getCookie(c, stateCookieName);
  clearHostOrLocalCookies(c, OIDC_STATE_COOKIE, LOCAL_DEV_OIDC_STATE_COOKIE);

  const idpError = c.req.query('error');
  if (idpError) {
    return c.json({ error: 'OIDC authentication denied', code: idpError }, 401);
  }

  const code = c.req.query('code');
  const state = c.req.query('state');
  const cookieKey = c.env.OIDC_STATE_COOKIE_KEY;
  if (!code || !state || !sealedState || !cookieKey) {
    return c.json({ error: 'Invalid OIDC callback state' }, 400);
  }

  const statePayload = await decryptCookiePayload<OidcStatePayload>(cookieKey, sealedState);
  if (
    !statePayload ||
    Date.now() > statePayload.exp ||
    !timingSafeEqual(state, statePayload.state)
  ) {
    return c.json({ error: 'Expired or mismatched OIDC state' }, 400);
  }

  const providers = buildConfiguredIdpProviders(c.env);
  const provider = resolveProviderById(providers, statePayload.idp);
  if (!provider) {
    return c.json({ error: 'OIDC provider configuration not found' }, 400);
  }

  const discovery = await fetchOidcDiscovery(provider.issuer);
  if (!discovery.token_endpoint) {
    return c.json({ error: 'OIDC token_endpoint is missing in discovery' }, 502);
  }

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${getCallbackBaseOrigin(c.env, c.req.url)}/auth/callback`,
    client_id: provider.audience,
    code_verifier: statePayload.codeVerifier,
  });
  const clientSecret = getClientSecretForProvider(c.env, provider.provider);
  if (clientSecret) {
    form.set('client_secret', clientSecret);
  }

  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });

  if (!tokenRes.ok) {
    await recordAuthAudit(c.env.DB, {
      tenantId: statePayload.tenantId,
      actorId: null,
      actorEmail: null,
      actorIp: ipAddress,
      action: 'auth.token_exchange_failed',
      targetId: provider.provider,
      status: 'blocked',
      metadata: { httpStatus: tokenRes.status },
    });
    return c.json({ error: 'Failed to exchange authorization code' }, 401);
  }

  const tokenBody = (await tokenRes.json()) as { id_token?: string };
  if (!tokenBody.id_token) {
    return c.json({ error: 'ID token missing in token response' }, 401);
  }

  let claims;
  try {
    claims = await verifyOidcIdToken(tokenBody.id_token, c.env, statePayload.nonce);
  } catch (err) {
    if (err instanceof OidcVerificationError) {
      await recordAuthAudit(c.env.DB, {
        tenantId: statePayload.tenantId,
        actorId: null,
        actorEmail: null,
        actorIp: ipAddress,
        action: 'auth.oidc_verification_failed',
        targetId: err.code,
        status: 'blocked',
        metadata: { code: err.code, message: err.message },
      });
      return c.json({ error: err.message, code: err.code }, 401);
    }
    throw err;
  }

  let syncedUser;
  try {
    syncedUser = await syncUserWithD1(c.env.DB, statePayload.tenantId, claims, ipAddress);
  } catch (err) {
    if (err instanceof AccountLinkConflictError) {
      await recordAuthAudit(c.env.DB, {
        tenantId: statePayload.tenantId,
        actorId: null,
        actorEmail: claims.email,
        actorIp: ipAddress,
        action: 'auth.account_link_conflict',
        targetId: claims.email,
        status: 'blocked',
        metadata: { issuer: claims.issuer, provider: claims.provider },
      });
      return c.json({ error: err.message }, 409);
    }
    throw err;
  }

  if (syncedUser.status !== 'active') {
    await recordAuthAudit(c.env.DB, {
      tenantId: statePayload.tenantId,
      actorId: syncedUser.id,
      actorEmail: syncedUser.email,
      actorIp: ipAddress,
      action: 'auth.suspended_user_login',
      targetId: syncedUser.id,
      status: 'blocked',
      metadata: { issuer: claims.issuer },
    });
    return c.json({ error: 'Account is suspended' }, 403);
  }

  await issueSessionForUser(c, {
    tenantId: statePayload.tenantId,
    userId: syncedUser.id,
    email: syncedUser.email,
    ipAddress,
    auditAction: 'auth.login',
    auditMetadata: { provider: claims.provider, issuer: claims.issuer },
  });

  return c.redirect(sanitizeReturnTo(statePayload.returnTo), 302);
});

authRoutes.post('/auth/logout', async (c) => {
  const csrfError = verifyRequestOriginForCsrf(c);
  if (csrfError) return csrfError;

  const ipAddress = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
  const token = readSessionTokenFromRequest(c);

  if (token) {
    const nowIso = new Date().toISOString();
    const revoked = await c.env.DB.prepare(
      `UPDATE sessions
          SET revoked_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL
      RETURNING id, tenant_id, user_id`
    )
      .bind(nowIso, await sha256Hex(token))
      .first<{ id: string; tenant_id: string; user_id: string }>();

    if (revoked) {
      await recordAuthAudit(c.env.DB, {
        tenantId: revoked.tenant_id,
        actorId: revoked.user_id,
        actorEmail: null,
        actorIp: ipAddress,
        action: 'auth.logout',
        targetId: revoked.id,
        status: 'allowed',
        metadata: {},
      });
    }
  }

  clearHostOrLocalCookies(c, SESSION_COOKIE, LOCAL_DEV_SESSION_COOKIE);

  return c.json({ ok: true });
});

authRoutes.get('/api/auth/me', sessionAuthMiddleware(), (c) => {
  return c.json({ user: c.get('user') });
});

/** GET /auth/dev-accounts — list sample active accounts for local localhost dev login only */
authRoutes.get('/auth/dev-accounts', async (c) => {
  if (!isLocalDevBypassAllowed(c)) {
    return c.json({ error: 'Not Found' }, 404);
  }

  const tenantId = (c.req.query('tenant') ?? c.env.DEFAULT_TENANT_ID ?? 'tenant-default').trim();
  const found = await Promise.all(
    DEV_ACCOUNT_ROLES.map((role) => pickRepresentativeDevAccount(c.env.DB, tenantId, role))
  );

  const accounts = found
    .filter((row): row is DevAccountRow => row !== null)
    .map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    }));

  return c.json({ enabled: true, tenantId, accounts });
});

/** GET /auth/dev-login — redirect accidental browser GET navigation back to home quick-login */
authRoutes.get('/auth/dev-login', (c) => {
  if (!isLocalDevBypassAllowed(c)) {
    return c.json({ error: 'Not Found' }, 404);
  }
  return c.redirect('/', 302);
});

/** POST /auth/dev-login — issue a standard D1 session cookie for localhost dev testing only */
authRoutes.post('/auth/dev-login', async (c) => {
  if (!isLocalDevBypassAllowed(c)) {
    return c.json({ error: 'Not Found' }, 404);
  }

  const csrfError = verifyRequestOriginForCsrf(c);
  if (csrfError) return csrfError;

  const body = (await c.req.json().catch(() => null)) as {
    userId?: string;
    role?: UserRole;
    tenantId?: string;
  } | null;

  const tenantId = (body?.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'tenant-default').trim();
  let target: DevAccountRow | null = null;

  if (typeof body?.userId === 'string' && body.userId.trim()) {
    target = await c.env.DB.prepare(
      `SELECT id, tenant_id, email, display_name, role
         FROM users
        WHERE tenant_id = ? AND id = ? AND status = 'active'`
    )
      .bind(tenantId, body.userId.trim())
      .first<DevAccountRow>();
  } else if (body?.role && DEV_ACCOUNT_ROLES.includes(body.role)) {
    target = await pickRepresentativeDevAccount(c.env.DB, tenantId, body.role);
  } else {
    target = await pickRepresentativeDevAccount(c.env.DB, tenantId, 'sys_admin');
  }

  if (!target) {
    return c.json({ error: 'Active local development account not found' }, 404);
  }

  const ipAddress = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
  await issueSessionForUser(c, {
    tenantId: target.tenant_id,
    userId: target.id,
    email: target.email,
    ipAddress,
    auditAction: 'auth.dev_login',
    auditMetadata: { role: target.role, mode: 'local_dev_login' },
  });

  return c.json({
    ok: true,
    user: {
      id: target.id,
      tenantId: target.tenant_id,
      email: target.email,
      displayName: target.display_name,
      role: target.role,
    },
  });
});
