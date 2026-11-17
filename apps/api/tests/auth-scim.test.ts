import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { bytesToBase64Url, sha256Hex } from '../src/services/crypto-utils';
import {
  clearOidcKeyCacheForTests,
  verifyOidcIdToken,
} from '../src/services/oidc-verifier';
import type { OidcEnv } from '../src/types/oidc';

const OKTA_ISSUER = 'https://okta.example.com/oauth2/default';
const ENTRA_TENANT_ID = 'entra-tenant-1111';
const ENTRA_ISSUER = `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0`;

interface ExportedJwk extends JsonWebKey {
  kid?: string;
  use?: string;
  alg?: string;
}

interface SigningMaterial {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: ExportedJwk;
}

let rsaKey: SigningMaterial;
let ecKey: SigningMaterial;

async function generateRsaMaterial(kid: string): Promise<SigningMaterial> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as ExportedJwk;
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';
  return { kid, privateKey: pair.privateKey, publicJwk };
}

async function generateEcMaterial(kid: string): Promise<SigningMaterial> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as ExportedJwk;
  publicJwk.kid = kid;
  publicJwk.use = 'sig';
  publicJwk.alg = 'ES256';
  return { kid, privateKey: pair.privateKey, publicJwk };
}

async function signJwt(
  material: SigningMaterial,
  alg: 'RS256' | 'ES256',
  payload: Record<string, unknown>
): Promise<string> {
  const enc = new TextEncoder();
  const headerB64 = bytesToBase64Url(
    enc.encode(JSON.stringify({ alg, typ: 'JWT', kid: material.kid }))
  );
  const payloadB64 = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const signingInput = enc.encode(`${headerB64}.${payloadB64}`);
  const sigBuf = await crypto.subtle.sign(
    alg === 'RS256'
      ? { name: 'RSASSA-PKCS1-v1_5' }
      : { name: 'ECDSA', hash: 'SHA-256' },
    material.privateKey,
    signingInput
  );
  const sigB64 = bytesToBase64Url(new Uint8Array(sigBuf));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function buildTestEnv(overrides: Partial<OidcEnv> = {}): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    APP_ORIGIN: 'https://files.example.com',
    DEFAULT_TENANT_ID: 'tenant-default',
    ALLOW_DEV_AUTH: 'true',
    OIDC_STATE_COOKIE_KEY: 'test-oidc-cookie-key-32-bytes-minimum',
    OKTA_ISSUER,
    OKTA_CLIENT_ID: 'okta-client-id',
    OKTA_CLIENT_SECRET: 'okta-secret',
    ENTRA_TENANT_ID,
    ENTRA_CLIENT_ID: 'entra-client-id',
    ENTRA_CLIENT_SECRET: 'entra-secret',
    ADMIN_GROUPS: 'Files-Admins',
    SEC_ADMIN_GROUPS: 'Files-SecAdmins',
    ...overrides,
  };
}

function extractCookiePair(res: Response, cookieName: string): string {
  const headers = res.headers.getSetCookie();
  for (const h of headers) {
    const firstPart = h.split(';')[0];
    if (firstPart.startsWith(`${cookieName}=`)) {
      return firstPart;
    }
  }
  throw new Error(`Cookie ${cookieName} not found in Set-Cookie headers`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('OIDC SSO, BFF Session Auth & Dev Bypass Isolation', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-default', 'Default Org', 'default')"),
      env.DB.prepare("INSERT OR IGNORE INTO tenant_policies (tenant_id, session_max_hours) VALUES ('tenant-default', 12)"),
    ]);
    rsaKey = await generateRsaMaterial('rsa-key-1');
    ecKey = await generateEcMaterial('ec-key-1');
  });

  beforeEach(() => {
    clearOidcKeyCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects mismatched nonce, expired token, and wrong Entra tid', async () => {
    const testEnv = buildTestEnv();
    const now = Math.floor(Date.now() / 1000);

    // 1. Mismatched nonce
    const badNonceJwt = await signJwt(rsaKey, 'RS256', {
      iss: OKTA_ISSUER,
      sub: 'okta-user-1',
      aud: 'okta-client-id',
      nonce: 'attacker-nonce',
      email: 'alice@example.com',
      email_verified: true,
      exp: now + 300,
    });
    await expect(
      verifyOidcIdToken(badNonceJwt, testEnv, 'expected-nonce')
    ).rejects.toMatchObject({ code: 'INVALID_NONCE' });

    // 2. Expired token
    const expiredJwt = await signJwt(rsaKey, 'RS256', {
      iss: OKTA_ISSUER,
      sub: 'okta-user-1',
      aud: 'okta-client-id',
      nonce: 'expected-nonce',
      email: 'alice@example.com',
      exp: now - 120,
    });
    await expect(
      verifyOidcIdToken(expiredJwt, testEnv, 'expected-nonce')
    ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });

    // 3. Wrong Entra ID tid
    const wrongTidJwt = await signJwt(ecKey, 'ES256', {
      iss: ENTRA_ISSUER,
      oid: 'entra-oid-1',
      sub: 'pairwise-sub',
      tid: 'wrong-tenant-id',
      aud: 'entra-client-id',
      nonce: 'expected-nonce',
      email: 'bob@example.com',
      exp: now + 300,
    });
    await expect(
      verifyOidcIdToken(wrongTidJwt, testEnv, 'expected-nonce')
    ).rejects.toMatchObject({ code: 'INVALID_ENTRA_TENANT' });
  });

  it('completes Okta PKCE login -> __Host-files_session cookie -> /api/auth/me -> logout with CSRF check', async () => {
    const testEnv = buildTestEnv();
    let currentOktaIdToken = '';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url === 'https://okta.example.com/oauth2/default/.well-known/openid-configuration') {
        return jsonResponse({
          authorization_endpoint: 'https://okta.example.com/oauth2/default/v1/authorize',
          token_endpoint: 'https://okta.example.com/oauth2/default/v1/token',
          jwks_uri: 'https://okta.example.com/oauth2/default/v1/keys',
        });
      }
      if (url === 'https://okta.example.com/oauth2/default/v1/keys') {
        return jsonResponse({ keys: [rsaKey.publicJwk] });
      }
      if (url === 'https://okta.example.com/oauth2/default/v1/token') {
        return jsonResponse({ id_token: currentOktaIdToken, token_type: 'Bearer' });
      }
      throw new Error(`Unexpected outbound fetch URL in Okta test: ${url}`);
    });

    // Step 1: GET /auth/login (also verify open redirect is sanitized to /workspace)
    const loginRes = await app.fetch(
      new Request(
        'https://files.example.com/auth/login?idp=okta&returnTo=https://evil.example.com/phish',
        { method: 'GET' }
      ),
      testEnv
    );
    expect(loginRes.status).toBe(302);
    const redirectLocation = loginRes.headers.get('Location');
    expect(redirectLocation).toBeTruthy();
    const authRedirectUrl = new URL(redirectLocation!);
    expect(authRedirectUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authRedirectUrl.searchParams.get('state')!;
    const nonce = authRedirectUrl.searchParams.get('nonce')!;
    expect(state.length).toBeGreaterThan(20);

    const oidcCookie = extractCookiePair(loginRes, '__Host-files_oidc');

    // Mock token endpoint using the exact nonce from login redirect
    const now = Math.floor(Date.now() / 1000);
    currentOktaIdToken = await signJwt(rsaKey, 'RS256', {
      iss: OKTA_ISSUER,
      sub: 'okta-sub-alice',
      aud: 'okta-client-id',
      nonce,
      email: 'alice@example.com',
      email_verified: true,
      name: 'Alice Okta',
      department: 'Security',
      groups: ['Files-Admins'],
      exp: now + 300,
    });

    // Step 2: GET /auth/callback
    const callbackRes = await app.fetch(
      new Request(
        `https://files.example.com/auth/callback?code=auth-code-123&state=${encodeURIComponent(state)}`,
        {
          method: 'GET',
          headers: { Cookie: oidcCookie },
        }
      ),
      testEnv
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('Location')).toBe('/workspace');

    const sessionCookie = extractCookiePair(callbackRes, '__Host-files_session');

    // Step 3: GET /api/auth/me with session cookie
    const meRes = await app.fetch(
      new Request('https://files.example.com/api/auth/me', {
        method: 'GET',
        headers: { Cookie: sessionCookie },
      }),
      testEnv
    );
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      user: { email: string; role: string; tenantId: string };
    };
    expect(meBody.user.email).toBe('alice@example.com');
    expect(meBody.user.role).toBe('sys_admin');
    expect(meBody.user.tenantId).toBe('tenant-default');

    // Step 4: CSRF blocks POST /auth/logout with mismatched Origin
    const badCsrfRes = await app.fetch(
      new Request('https://files.example.com/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          Origin: 'https://evil.example.com',
        },
      }),
      testEnv
    );
    expect(badCsrfRes.status).toBe(403);

    // Step 5: Valid POST /auth/logout revokes session in D1
    const logoutRes = await app.fetch(
      new Request('https://files.example.com/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: sessionCookie,
          Origin: 'https://files.example.com',
        },
      }),
      testEnv
    );
    expect(logoutRes.status).toBe(200);

    // Revoked session is rejected immediately
    const meAfterLogout = await app.fetch(
      new Request('https://files.example.com/api/auth/me', {
        method: 'GET',
        headers: { Cookie: sessionCookie },
      }),
      testEnv
    );
    expect(meAfterLogout.status).toBe(401);
  });

  it('blocks unverified Entra nOAuth account takeover and handles role demotion vs group overage', async () => {
    const testEnv = buildTestEnv();
    const now = Math.floor(Date.now() / 1000);

    // Pre-existing user with no external_idp_id bound yet
    await env.DB.prepare(
      `INSERT INTO users (id, tenant_id, email, display_name, role, status)
       VALUES ('pre-existing-u1', 'tenant-default', 'target@example.com', 'Target User', 'sys_admin', 'active')`
    ).run();

    let currentEntraIdToken = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = getRequestUrl(input);
      if (url === `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0/.well-known/openid-configuration`) {
        return jsonResponse({
          authorization_endpoint: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/authorize`,
          token_endpoint: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`,
          jwks_uri: `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/discovery/v2.0/keys`,
        });
      }
      if (url === `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/discovery/v2.0/keys`) {
        return jsonResponse({ keys: [ecKey.publicJwk] });
      }
      if (url === `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/oauth2/v2.0/token`) {
        return jsonResponse({ id_token: currentEntraIdToken });
      }
      throw new Error(`Unexpected outbound fetch URL in Entra test: ${url}`);
    });

    // Helper to perform login callback against Entra mock
    const runEntraLogin = async (claimsOverride: Record<string, unknown>) => {
      const loginRes = await app.fetch(
        new Request('https://files.example.com/auth/login?idp=entra_id', { method: 'GET' }),
        testEnv
      );
      const authUrl = new URL(loginRes.headers.get('Location')!);
      const state = authUrl.searchParams.get('state')!;
      const nonce = authUrl.searchParams.get('nonce')!;
      const oidcCookie = extractCookiePair(loginRes, '__Host-files_oidc');

      currentEntraIdToken = await signJwt(ecKey, 'ES256', {
        iss: ENTRA_ISSUER,
        oid: 'attacker-entra-oid',
        sub: 'pairwise-sub',
        tid: ENTRA_TENANT_ID,
        aud: 'entra-client-id',
        nonce,
        email: 'target@example.com',
        exp: now + 300,
        ...claimsOverride,
      });

      return app.fetch(
        new Request(
          `https://files.example.com/auth/callback?code=c1&state=${encodeURIComponent(state)}`,
          { headers: { Cookie: oidcCookie } }
        ),
        testEnv
      );
    };

    // 1. nOAuth block: Entra ID claim with matching email must NOT auto-link pre-existing user -> 409
    const conflictRes = await runEntraLogin({ oid: 'attacker-oid-99', email: 'target@example.com' });
    expect(conflictRes.status).toBe(409);

    // 2. Role demotion vs overage on legitimate Entra user
    const firstOkRes = await runEntraLogin({
      oid: 'legit-entra-oid',
      email: 'carol@example.com',
      groups: ['Files-Admins'],
    });
    expect(firstOkRes.status).toBe(302);
    const carolBefore = await env.DB.prepare(
      "SELECT role FROM users WHERE tenant_id = 'tenant-default' AND email = 'carol@example.com'"
    ).first<{ role: string }>();
    expect(carolBefore?.role).toBe('sys_admin');

    // Group overage preserves sys_admin
    const overageRes = await runEntraLogin({
      oid: 'legit-entra-oid',
      email: 'carol@example.com',
      _claim_names: { groups: 'src1' },
    });
    expect(overageRes.status).toBe(302);
    const carolOverage = await env.DB.prepare(
      "SELECT role FROM users WHERE tenant_id = 'tenant-default' AND email = 'carol@example.com'"
    ).first<{ role: string }>();
    expect(carolOverage?.role).toBe('sys_admin');

    // Explicit empty groups claim demotes sys_admin -> member
    const demoteRes = await runEntraLogin({
      oid: 'legit-entra-oid',
      email: 'carol@example.com',
      groups: [],
    });
    expect(demoteRes.status).toBe(302);
    const carolDemoted = await env.DB.prepare(
      "SELECT role FROM users WHERE tenant_id = 'tenant-default' AND email = 'carol@example.com'"
    ).first<{ role: string }>();
    expect(carolDemoted?.role).toBe('member');
  });

  it('enforces 3-condition AND restriction on X-Dev-User-Id header bypass', async () => {
    // Allowed only on ENVIRONMENT=local, ALLOW_DEV_AUTH='true', and localhost/127.0.0.1
    const okRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/auth/me', {
        headers: { 'X-Dev-User-Id': 'dev-admin-001' },
      }),
      buildTestEnv({ ENVIRONMENT: 'local', ALLOW_DEV_AUTH: 'true' })
    );
    expect(okRes.status).toBe(200);

    // Blocked on non-localhost hostname
    const nonLocalhostRes = await app.fetch(
      new Request('https://files.example.com/api/auth/me', {
        headers: { 'X-Dev-User-Id': 'dev-admin-001' },
      }),
      buildTestEnv({ ENVIRONMENT: 'local', ALLOW_DEV_AUTH: 'true' })
    );
    expect(nonLocalhostRes.status).toBe(401);

    // Blocked when ENVIRONMENT != 'local'
    const stagingRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/auth/me', {
        headers: { 'X-Dev-User-Id': 'dev-admin-001' },
      }),
      buildTestEnv({ ENVIRONMENT: 'staging', ALLOW_DEV_AUTH: 'true' })
    );
    expect(stagingRes.status).toBe(401);

    // Blocked when ALLOW_DEV_AUTH != 'true'
    const disabledBypassRes = await app.fetch(
      new Request('http://localhost:8787/api/auth/me', {
        headers: { 'X-Dev-User-Id': 'dev-admin-001' },
      }),
      buildTestEnv({ ENVIRONMENT: 'local', ALLOW_DEV_AUTH: 'false' })
    );
    expect(disabledBypassRes.status).toBe(401);
  });

  it('issues D1 session cookies via /auth/dev-login strictly in local dev on localhost with CSRF protection', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES ('dev-admin-001', 'tenant-default', 'dev-admin@example.com', 'Dev Admin', 'sys_admin', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES ('dev-member-001', 'tenant-default', 'dev-member@example.com', 'Dev Member', 'member', 'active')`
      ),
    ]);

    const localEnv = buildTestEnv({
      ENVIRONMENT: 'local',
      ALLOW_DEV_AUTH: 'true',
      APP_ORIGIN: 'http://localhost:3000',
    });

    // 1. Blocked outside ENVIRONMENT='local' / ALLOW_DEV_AUTH='true' / localhost
    const blockedStaging = await app.fetch(
      new Request('http://localhost:8787/auth/dev-accounts'),
      buildTestEnv({ ENVIRONMENT: 'staging', ALLOW_DEV_AUTH: 'true' })
    );
    expect(blockedStaging.status).toBe(404);

    const blockedHost = await app.fetch(
      new Request('https://files.example.com/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://files.example.com' },
        body: JSON.stringify({ role: 'sys_admin' }),
      }),
      localEnv
    );
    expect(blockedHost.status).toBe(404);

    // 2. CSRF protection rejects mismatched Origin on POST /auth/dev-login
    const csrfBlocked = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/dev-login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example.com',
        },
        body: JSON.stringify({ role: 'sys_admin' }),
      }),
      localEnv
    );
    expect(csrfBlocked.status).toBe(403);

    // 3. Discovery returns active roles & login issues HttpOnly files_session_local cookie
    const accountsRes = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/dev-accounts'),
      localEnv
    );
    expect(accountsRes.status).toBe(200);
    const accountsBody = (await accountsRes.json()) as {
      enabled: boolean;
      accounts: Array<{ id: string; role: string }>;
    };
    expect(accountsBody.enabled).toBe(true);
    expect(accountsBody.accounts.some((a) => a.role === 'sys_admin')).toBe(true);
    expect(accountsBody.accounts.some((a) => a.role === 'member')).toBe(true);

    const loginRes = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/dev-login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3000',
        },
        body: JSON.stringify({ userId: 'dev-admin-001' }),
      }),
      localEnv
    );
    expect(loginRes.status).toBe(200);
    const sessionCookie = extractCookiePair(loginRes, 'files_session_local');

    // 4. Subsequent /api/auth/me works with cookie alone (no X-Dev-User-Id header)
    const meRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/auth/me', {
        headers: { Cookie: sessionCookie },
      }),
      localEnv
    );
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { user: { id: string; role: string } };
    expect(meBody.user.id).toBe('dev-admin-001');
    expect(meBody.user.role).toBe('sys_admin');

    // 5. Audit log recorded auth.dev_login & logout revokes session
    const auditRow = await env.DB.prepare(
      "SELECT action, status FROM audit_logs WHERE actor_id = 'dev-admin-001' AND action = 'auth.dev_login' ORDER BY created_at DESC LIMIT 1"
    ).first<{ action: string; status: string }>();
    expect(auditRow?.action).toBe('auth.dev_login');
    expect(auditRow?.status).toBe('allowed');

    const logoutRes = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/logout', {
        method: 'POST',
        headers: { Origin: 'http://localhost:3000', Cookie: sessionCookie },
      }),
      localEnv
    );
    expect(logoutRes.status).toBe(200);

    const afterLogoutMe = await app.fetch(
      new Request('http://127.0.0.1:8787/api/auth/me', {
        headers: { Cookie: sessionCookie },
      }),
      localEnv
    );
    expect(afterLogoutMe.status).toBe(401);

    // 6. IPv6 loopback ([::1]) is accepted in local dev for accounts & dev-login CSRF
    const ipv6AccountsRes = await app.fetch(
      new Request('http://[::1]:8787/auth/dev-accounts'),
      localEnv
    );
    expect(ipv6AccountsRes.status).toBe(200);
    const ipv6AccountsBody = (await ipv6AccountsRes.json()) as { enabled: boolean };
    expect(ipv6AccountsBody.enabled).toBe(true);

    const ipv6LoginRes = await app.fetch(
      new Request('http://[::1]:8787/auth/dev-login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://[::1]:3000',
        },
        body: JSON.stringify({ userId: 'dev-admin-001' }),
      }),
      localEnv
    );
    expect(ipv6LoginRes.status).toBe(200);
    expect(extractCookiePair(ipv6LoginRes, 'files_session_local')).toContain('files_session_local=');

    // 7. GET /auth/dev-login redirects locally and returns 404 outside local dev
    const stagingEnv = { ...env, ENVIRONMENT: 'staging', ALLOW_DEV_AUTH: 'true' };
    const localGetDevLoginRes = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/dev-login'),
      localEnv
    );
    expect(localGetDevLoginRes.status).toBe(302);
    expect(localGetDevLoginRes.headers.get('Location')).toBe('/');

    const stagingGetDevLoginRes = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/dev-login'),
      stagingEnv
    );
    expect(stagingGetDevLoginRes.status).toBe(404);

    // 8. GET /auth/login without configured IdP falls back to local redirect, 400 in staging
    const noIdpOverrides = {
      OKTA_ISSUER: undefined,
      OKTA_CLIENT_ID: undefined,
      OKTA_CLIENT_SECRET: undefined,
      ENTRA_TENANT_ID: undefined,
      ENTRA_CLIENT_ID: undefined,
      ENTRA_CLIENT_SECRET: undefined,
    };
    const localLoginFallbackRes = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/login?returnTo=/admin'),
      { ...localEnv, ...noIdpOverrides }
    );
    expect(localLoginFallbackRes.status).toBe(302);
    expect(localLoginFallbackRes.headers.get('Location')).toBe('/admin');

    const stagingLoginRes = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/login?returnTo=/admin'),
      { ...stagingEnv, ...noIdpOverrides }
    );
    expect(stagingLoginRes.status).toBe(400);

    // 9. Canonical seeded dev accounts stay representative even if a newly promoted sec_admin sorts earlier by UUID
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, user_type, created_at)
         VALUES ('dev-sec-001', 'tenant-default', 'dev-sec@example.com', 'Dev Sec', 'sec_admin', 'active', 'member', '2026-01-01T00:00:00Z')`
      ),
      env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, role, status, user_type, created_at)
         VALUES ('00000000-0000-0000-0000-000000000001', 'tenant-default', 'uuid-sec@example.com', 'UUID Sec', 'sec_admin', 'active', 'member', '2026-11-17T00:00:00Z')`
      ),
    ]);
    const seededAccountsRes = await app.fetch(
      new Request('http://127.0.0.1:8787/auth/dev-accounts'),
      localEnv
    );
    expect(seededAccountsRes.status).toBe(200);
    const seededBody = (await seededAccountsRes.json()) as {
      accounts: Array<{ id: string; role: string }>;
    };
    expect(seededBody.accounts.find((a) => a.role === 'sec_admin')?.id).toBe(
      'dev-sec-001'
    );
  });
});

describe('SCIM 2.0 Tenant-Isolated Provisioning (/Users, /Groups)', () => {
  const TOKEN_TENANT_A = 'scim-secret-tenant-default';
  const TOKEN_TENANT_B = 'scim-secret-tenant-beta';
  const TOKEN_REVOKED = 'scim-secret-revoked';

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const futureUsedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-default', 'Default Org', 'default')"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, session_max_hours) VALUES ('tenant-default', 12)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-beta', 'Beta Corp', 'beta')"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, session_max_hours) VALUES ('tenant-beta', 12)"
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO scim_tokens (id, tenant_id, idp_issuer, name, token_hash, last_used_at, revoked_at)
         VALUES ('tok-a', 'tenant-default', ?, 'Okta Default SCIM', ?, NULL, NULL)`
      ).bind(OKTA_ISSUER, await sha256Hex(TOKEN_TENANT_A)),
      env.DB.prepare(
        `INSERT OR REPLACE INTO scim_tokens (id, tenant_id, idp_issuer, name, token_hash, last_used_at, revoked_at)
         VALUES ('tok-b', 'tenant-beta', ?, 'Entra Beta SCIM', ?, ?, NULL)`
      ).bind(ENTRA_ISSUER, await sha256Hex(TOKEN_TENANT_B), futureUsedAt),
      env.DB.prepare(
        `INSERT OR REPLACE INTO scim_tokens (id, tenant_id, idp_issuer, name, token_hash, last_used_at, revoked_at)
         VALUES ('tok-revoked', 'tenant-default', ?, 'Revoked SCIM', ?, NULL, '2026-01-01T00:00:00Z')`
      ).bind(OKTA_ISSUER, await sha256Hex(TOKEN_REVOKED)),
    ]);
  });

  it('resolves tenant strictly from scim_tokens hash and ignores spoofed X-Tenant-Id headers', async () => {
    const testEnv = buildTestEnv();

    // Missing or revoked tokens are rejected with 401
    const noAuthRes = await app.fetch(
      new Request('https://files.example.com/scim/v2/Users'),
      testEnv
    );
    expect(noAuthRes.status).toBe(401);

    const revokedRes = await app.fetch(
      new Request('https://files.example.com/scim/v2/Users', {
        headers: { Authorization: `Bearer ${TOKEN_REVOKED}` },
      }),
      testEnv
    );
    expect(revokedRes.status).toBe(401);

    // Create user in tenant-default even though attacker sends X-Tenant-Id: tenant-beta
    const createRes = await app.fetch(
      new Request('https://files.example.com/scim/v2/Users', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_TENANT_A}`,
          'Content-Type': 'application/scim+json',
          'X-Tenant-Id': 'tenant-beta',
        },
        body: JSON.stringify({
          userName: 'scim-alice@default.example.com',
          displayName: 'SCIM Alice',
          externalId: 'okta-ext-001',
          active: true,
          'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
            department: 'Finance',
          },
        }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const createdUser = (await createRes.json()) as { id: string; userName: string };

    // Token A should now have last_used_at populated
    const tokARow = await env.DB.prepare('SELECT last_used_at FROM scim_tokens WHERE id = ?')
      .bind('tok-a')
      .first<{ last_used_at: string | null }>();
    expect(tokARow?.last_used_at).toBeTruthy();

    // Token B (tenant-beta) cannot read or see tenant-default user even with X-Tenant-Id spoof
    const getByTenantB = await app.fetch(
      new Request(`https://files.example.com/scim/v2/Users/${createdUser.id}`, {
        headers: {
          Authorization: `Bearer ${TOKEN_TENANT_B}`,
          'X-Tenant-Id': 'tenant-default',
        },
      }),
      testEnv
    );
    expect(getByTenantB.status).toBe(404);

    // Token A filter lookup by externalId works
    const filterRes = await app.fetch(
      new Request(
        'https://files.example.com/scim/v2/Users?filter=externalId%20eq%20%22okta-ext-001%22',
        { headers: { Authorization: `Bearer ${TOKEN_TENANT_A}` } }
      ),
      testEnv
    );
    expect(filterRes.status).toBe(200);
    const filterBody = (await filterRes.json()) as {
      totalResults: number;
      Resources: Array<{ id: string }>;
    };
    expect(filterBody.totalResults).toBe(1);
    expect(filterBody.Resources[0].id).toBe(createdUser.id);
  });

  it('normalizes Entra "False" and Okta pathless PATCH and revokes active sessions immediately', async () => {
    const testEnv = buildTestEnv();

    // Provision active user in tenant-beta (Entra issuer)
    const createRes = await app.fetch(
      new Request('https://files.example.com/scim/v2/Users', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_TENANT_B}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userName: 'entra-bob@beta.example.com',
          displayName: 'Entra Bob',
          externalId: 'entra-oid-bob-999',
          active: true,
        }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string };

    // Insert an active BFF session for Bob
    const rawSessionToken = 'bob-live-session-secret-token';
    await env.DB.prepare(
      `INSERT INTO sessions (id, tenant_id, user_id, token_hash, ip_address, expires_at)
       VALUES ('sess-bob-1', 'tenant-beta', ?, ?, '127.0.0.1', '2099-01-01T00:00:00Z')`
    )
      .bind(created.id, await sha256Hex(rawSessionToken))
      .run();

    // Session is valid prior to suspension
    const meBefore = await app.fetch(
      new Request('https://files.example.com/api/auth/me', {
        headers: { Cookie: `__Host-files_session=${rawSessionToken}` },
      }),
      testEnv
    );
    expect(meBefore.status).toBe(200);

    // Entra ID PATCH: op "Replace" (mixed case), flattened department, string "False" active
    const patchRes = await app.fetch(
      new Request(`https://files.example.com/scim/v2/Users/${created.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TOKEN_TENANT_B}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [
            {
              op: 'Replace',
              path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department',
              value: 'Legal',
            },
            {
              op: 'Replace',
              path: 'active',
              value: 'False',
            },
          ],
        }),
      }),
      testEnv
    );
    expect(patchRes.status).toBe(200);
    const patchedBody = (await patchRes.json()) as {
      active: boolean;
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'?: { department?: string };
    };
    expect(patchedBody.active).toBe(false);
    expect(
      patchedBody['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']?.department
    ).toBe('Legal');

    // Verify D1 sessions row was immediately stamped with revoked_at
    const sessRow = await env.DB.prepare('SELECT revoked_at FROM sessions WHERE id = ?')
      .bind('sess-bob-1')
      .first<{ revoked_at: string | null }>();
    expect(sessRow?.revoked_at).toBeTruthy();

    // Immediate rejection on /api/auth/me
    const meAfter = await app.fetch(
      new Request('https://files.example.com/api/auth/me', {
        headers: { Cookie: `__Host-files_session=${rawSessionToken}` },
      }),
      testEnv
    );
    expect(meAfter.status).toBe(401);

    // Okta path-omitted PATCH re-activates user
    const reactivateRes = await app.fetch(
      new Request(`https://files.example.com/scim/v2/Users/${created.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TOKEN_TENANT_B}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          Operations: [
            {
              op: 'replace',
              value: { active: true, displayName: 'Entra Bob Reactivated' },
            },
          ],
        }),
      }),
      testEnv
    );
    expect(reactivateRes.status).toBe(200);
    const reactivated = (await reactivateRes.json()) as { active: boolean; displayName: string };
    expect(reactivated.active).toBe(true);
    expect(reactivated.displayName).toBe('Entra Bob Reactivated');
  });

  it('syncs /Groups with 30-item D1 batch chunks, handles members[value eq "..."] PATCH, and blocks cross-tenant members', async () => {
    const testEnv = buildTestEnv();
    const userIds: string[] = [];

    // Seed 35 users directly in tenant-default so we exceed a single 30-item chunk
    const insertStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 35; i++) {
      const uid = `bulk-user-${i}`;
      userIds.push(uid);
      insertStmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
           VALUES (?, 'tenant-default', ?, ?, 'member', 'active')`
        ).bind(uid, `bulk-${i}@default.example.com`, `Bulk User ${i}`)
      );
    }
    await env.DB.batch(insertStmts.slice(0, 20));
    await env.DB.batch(insertStmts.slice(20));

    // POST /Groups with 34 members
    const createGroupRes = await app.fetch(
      new Request('https://files.example.com/scim/v2/Groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_TENANT_A}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          displayName: 'All Engineering',
          externalId: 'grp-eng-01',
          members: userIds.slice(0, 34).map((id) => ({ value: id })),
        }),
      }),
      testEnv
    );
    expect(createGroupRes.status).toBe(201);
    const createdGroup = (await createGroupRes.json()) as {
      id: string;
      displayName: string;
      members: Array<{ value: string }>;
    };
    expect(createdGroup.members).toHaveLength(34);

    // PATCH Group: remove bulk-user-0 using bracket filter path, add bulk-user-34, rename group
    const patchGroupRes = await app.fetch(
      new Request(`https://files.example.com/scim/v2/Groups/${createdGroup.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${TOKEN_TENANT_A}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          Operations: [
            {
              op: 'Remove',
              path: 'members[value eq "bulk-user-0"]',
            },
            {
              op: 'Add',
              path: 'members',
              value: [{ value: 'bulk-user-34' }],
            },
            {
              op: 'replace',
              value: { displayName: 'Core Engineering' },
            },
          ],
        }),
      }),
      testEnv
    );
    expect(patchGroupRes.status).toBe(200);
    const patchedGroup = (await patchGroupRes.json()) as {
      displayName: string;
      members: Array<{ value: string }>;
    };
    expect(patchedGroup.displayName).toBe('Core Engineering');
    expect(patchedGroup.members).toHaveLength(34);
    const memberIdSet = new Set(patchedGroup.members.map((m) => m.value));
    expect(memberIdSet.has('bulk-user-0')).toBe(false);
    expect(memberIdSet.has('bulk-user-34')).toBe(true);

    // Cross-tenant user insertion into a tenant-beta group must fail with 400
    const crossTenantGroupRes = await app.fetch(
      new Request('https://files.example.com/scim/v2/Groups', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TOKEN_TENANT_B}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          displayName: 'Beta Sneak Group',
          members: [{ value: 'bulk-user-1' }], // belongs to tenant-default!
        }),
      }),
      testEnv
    );
    expect(crossTenantGroupRes.status).toBe(400);
  });
});
