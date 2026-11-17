import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { encryptCookiePayload, sha256Hex } from '../src/services/crypto-utils';
import {
  IP_ALLOWLIST_MAX_ENTRIES,
  isIpAllowed,
  normalizeIpAllowlistInput,
  parseIpAllowlistEntry,
  resolveClientIp,
} from '../src/services/ip-allowlist';
import {
  isSsoEmailDomainAllowed,
  maskOidcClientId,
  normalizeSsoAllowedDomainsInput,
} from '../src/services/sso-policy';
import type { OidcEnv } from '../src/types/oidc';

// The callback flow is exercised without contacting a real IdP: discovery and
// ID-token verification are stubbed, while the SSO domain policy and audit
// writes remain the production code path.
vi.mock('../src/services/oidc-verifier', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/services/oidc-verifier')>();
  return {
    ...actual,
    fetchOidcDiscovery: vi.fn(async () => ({
      token_endpoint: 'https://idp.example/token',
      authorization_endpoint: 'https://idp.example/authorize',
      jwks_uri: 'https://idp.example/keys',
    })),
    verifyOidcIdToken: vi.fn(async () => ({
      provider: 'okta',
      issuer: 'https://example.okta.com',
      externalIdpId: 'idp-user-1',
      email: 'outside@blocked.example',
      emailVerified: true,
      displayName: 'Blocked User',
      department: null,
      groups: [],
      resolvedRole: undefined,
    })),
  };
});

const TENANT = 'tenant-ip-sso';
const APP_ORIGIN = 'http://127.0.0.1:8787';

const SYS = 'ip-sso-sys';
const SEC = 'ip-sso-sec';
const MEMBER = 'ip-sso-member';
const GUEST = 'ip-sso-guest';
const COOKIE_USER = 'ip-sso-cookie';

const SHARE_TOKEN = 'ip-sso-shared-link-token-0001';
const FILE_REQUEST_TOKEN = 'ip-sso-file-request-token-0001';
const GUEST_TOKEN = 'ip-sso-guest-invitation-token-01';
const COOKIE_SESSION_TOKEN = 'ip-sso-cookie-session-token-01';
const OIDC_STATE_COOKIE_KEY = 'test-oidc-state-cookie-key-32-bytes-minimum';

const ALLOWED_IP = '198.51.100.5';
const BLOCKED_IP = '203.0.113.99';

type UserRole = 'sys_admin' | 'sec_admin' | 'member';
type UserType = 'member' | 'guest';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN,
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-ip-sso-secret',
    DEFAULT_TENANT_ID: TENANT,
    OIDC_STATE_COOKIE_KEY,
    OKTA_ISSUER: 'https://example.okta.com',
    OKTA_CLIENT_ID: 'okta-client-id-super-secret-value',
    OKTA_CLIENT_SECRET: 'okta-client-secret-never-returned',
  } as unknown as OidcEnv;
}

function headers(
  userId?: string,
  role: UserRole = 'member',
  options: {
    tenantId?: string;
    userType?: UserType;
    ip?: string;
    cookie?: string;
    extra?: Record<string, string>;
  } = {}
): Record<string, string> {
  return {
    ...(userId
      ? {
          'X-Dev-User-Id': userId,
          'X-Dev-User-Role': role,
          'X-Dev-Tenant-Id': options.tenantId ?? TENANT,
          'X-Dev-User-Email': `${userId}@example.com`,
          'X-Dev-User-Type': options.userType ?? 'member',
        }
      : {}),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    'CF-Connecting-IP': options.ip ?? ALLOWED_IP,
    'Content-Type': 'application/json',
    Origin: APP_ORIGIN,
    ...options.extra,
  };
}

async function call<T = Record<string, unknown>>(
  path: string,
  options: {
    method?: string;
    userId?: string;
    role?: UserRole;
    userType?: UserType;
    body?: unknown;
    ip?: string;
    cookie?: string;
    extraHeaders?: Record<string, string>;
  } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers: headers(options.userId, options.role ?? 'member', {
        userType: options.userType,
        ip: options.ip,
        cookie: options.cookie,
        extra: options.extraHeaders,
      }),
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }),
    buildTestEnv()
  );
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

async function setIpPolicy(
  enabled: boolean,
  scope: 'admin_only' | 'internal_users' | 'all_access',
  entries: string[]
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tenant_policies
        SET ip_allowlist_enabled = ?, ip_allowlist_scope = ?, ip_allowlist_json = ?
      WHERE tenant_id = ?`
  )
    .bind(enabled ? 1 : 0, scope, JSON.stringify(entries), TENANT)
    .run();
}

async function resetPolicies(): Promise<void> {
  await env.DB.prepare(
    `UPDATE tenant_policies
        SET ip_allowlist_enabled = 0,
            ip_allowlist_scope = 'admin_only',
            ip_allowlist_json = '[]',
            require_sso_login = 0,
            sso_allowed_domains_json = '[]'
      WHERE tenant_id = ?`
  )
    .bind(TENANT)
    .run();
  await env.DB.prepare('DELETE FROM audit_logs WHERE tenant_id = ?')
    .bind(TENANT)
    .run();
}

async function blockedIpAudits(): Promise<
  Array<{ action: string; status: string; metadata_json: string | null }>
> {
  const rows = await env.DB.prepare(
    `SELECT action, status, metadata_json FROM audit_logs
      WHERE tenant_id = ? AND action = 'auth.ip_blocked'
      ORDER BY created_at ASC`
  )
    .bind(TENANT)
    .all<{ action: string; status: string; metadata_json: string | null }>();
  return rows.results;
}

async function auditActions(): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT action FROM audit_logs WHERE tenant_id = ? ORDER BY created_at ASC`
  )
    .bind(TENANT)
    .all<{ action: string }>();
  return rows.results.map((row) => row.action);
}

describe('IP allowlist engine & SSO auth controls (P12-3 / TOM-66)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const [shareHash, fileRequestHash, guestHash, cookieHash] =
      await Promise.all([
        sha256Hex(SHARE_TOKEN),
        sha256Hex(FILE_REQUEST_TOKEN),
        sha256Hex(GUEST_TOKEN),
        sha256Hex(COOKIE_SESSION_TOKEN),
      ]);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug)
         VALUES (?, 'IP SSO Tenant', 'ip-sso-tenant')`
      ).bind(TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (
           tenant_id, allow_external_collaborators,
           external_domain_allowlist_json
         ) VALUES (?, 1, '["partner.example"]')`
      ).bind(TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (
           id, tenant_id, email, display_name, role, status, user_type, external_org
         ) VALUES
           (?, ?, 'ip-sso-sys@example.com', 'IP SSO Sys', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'ip-sso-sec@example.com', 'IP SSO Sec', 'sec_admin', 'active', 'member', NULL),
           (?, ?, 'ip-sso-member@example.com', 'IP SSO Member', 'member', 'active', 'member', NULL),
           (?, ?, 'guest@partner.example', 'IP SSO Guest', 'member', 'active', 'guest', 'Partner'),
           (?, ?, 'ip-sso-cookie@example.com', 'IP SSO Cookie', 'sys_admin', 'active', 'member', NULL)`
      ).bind(
        SYS,
        TENANT,
        SEC,
        TENANT,
        MEMBER,
        TENANT,
        GUEST,
        TENANT,
        COOKIE_USER,
        TENANT
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification, created_by
         ) VALUES ('ip-sso-folder', ?, NULL, 'Shared', 0, 1, 'internal', ?)`
      ).bind(TENANT, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, require_watermark, created_by
         ) VALUES ('ip-sso-link', ?, ?, 'folder', 'ip-sso-folder', 'public',
                   1, 0, ?)`
      ).bind(TENANT, shareHash, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_requests (
           id, tenant_id, folder_id, token_hash, title, description,
           require_submitter_email, is_active, created_by
         ) VALUES ('ip-sso-request', ?, 'ip-sso-folder', ?, 'Upload here',
                   NULL, 0, 1, ?)`
      ).bind(TENANT, fileRequestHash, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO guest_invitations (
           id, tenant_id, user_id, email, display_name, external_org,
           invited_by, token_hash, target_type, target_id, role, status,
           expires_at, created_at, updated_at
         ) VALUES ('ip-sso-invite', ?, ?, 'guest@partner.example',
                   'IP SSO Guest', 'Partner', ?, ?, 'folder', 'ip-sso-folder',
                   'viewer', 'pending', '2099-01-01T00:00:00.000Z',
                   '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`
      ).bind(TENANT, GUEST, SYS, guestHash),
      env.DB.prepare(
        `INSERT OR IGNORE INTO sessions (
           id, tenant_id, user_id, token_hash, ip_address, user_agent,
           expires_at, created_at
         ) VALUES ('ip-sso-cookie-session', ?, ?, ?, ?, 'test',
                   '2099-01-01T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`
      ).bind(TENANT, COOKIE_USER, cookieHash, ALLOWED_IP),
    ]);
  });

  beforeEach(async () => {
    await resetPolicies();
  });

  describe('IP/CIDR engine', () => {
    it('matches IPv4 single addresses and CIDR boundaries', () => {
      expect(isIpAllowed('203.0.113.5', ['203.0.113.5'])).toBe(true);
      expect(isIpAllowed('203.0.113.6', ['203.0.113.5'])).toBe(false);
      expect(isIpAllowed('203.0.113.0', ['203.0.113.0/24'])).toBe(true);
      expect(isIpAllowed('203.0.113.255', ['203.0.113.0/24'])).toBe(true);
      expect(isIpAllowed('203.0.114.1', ['203.0.113.0/24'])).toBe(false);
      expect(isIpAllowed('198.51.100.5', ['203.0.113.0/24'])).toBe(false);
      expect(isIpAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
      expect(isIpAllowed('10.1.2.3', ['10.0.0.0/0'])).toBe(true);
    });

    it('matches IPv6 single addresses and CIDRs including bracket notation', () => {
      expect(isIpAllowed('2001:db8::1', ['2001:db8::1'])).toBe(true);
      expect(isIpAllowed('2001:db8::2', ['2001:db8::1'])).toBe(false);
      expect(isIpAllowed('2001:db8:ffff::1', ['2001:db8::/32'])).toBe(true);
      expect(isIpAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
      expect(isIpAllowed('[2001:db8::1]', ['2001:db8::/64'])).toBe(true);
      expect(isIpAllowed('::1', ['::1'])).toBe(true);
      expect(isIpAllowed('::2', ['::1/128'])).toBe(false);
      expect(parseIpAllowlistEntry('::1')?.normalized).toBe('::1');
      expect(parseIpAllowlistEntry('::')?.normalized).toBe('::');
      expect(parseIpAllowlistEntry('2001:DB8::1')?.normalized).toBe(
        '2001:db8::1'
      );
    });

    it('normalizes IPv4-mapped IPv6 addresses', () => {
      expect(isIpAllowed('::ffff:203.0.113.5', ['203.0.113.0/24'])).toBe(true);
      expect(isIpAllowed('203.0.113.5', ['::ffff:203.0.113.0/120'])).toBe(
        true
      );
      expect(
        parseIpAllowlistEntry('::ffff:203.0.113.5')?.normalized
      ).toBe('203.0.113.5');
      const normalized = normalizeIpAllowlistInput([
        '::ffff:203.0.113.5',
        '203.0.113.5',
      ]);
      expect(normalized).toEqual({ ok: true, entries: ['203.0.113.5'] });
    });

    it('rejects malformed entries and enforces the entry cap', () => {
      const invalid = [
        '192.168.1',
        '256.1.1.1',
        '192.168.1.1/33',
        '192.168.001.1',
        '2001:db8::/129',
        '2001:db8:::1',
        'not-an-ip',
        '10.0.0.0/',
        '10.0.0.0/08',
        '10.0.0.0/8/8',
        '10.0.0.0:443',
      ];
      for (const entry of invalid) {
        expect(parseIpAllowlistEntry(entry), entry).toBeNull();
      }
      const tooMany = Array.from(
        { length: IP_ALLOWLIST_MAX_ENTRIES + 1 },
        (_, index) => `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`
      );
      const result = normalizeIpAllowlistInput(tooMany);
      expect(result.ok).toBe(false);
    });

    it('resolves the client IP with CF priority and local XFF fallback', () => {
      const context = (
        headers: Record<string, string>,
        environment: OidcEnv['ENVIRONMENT'] = 'local'
      ) => ({
        env: { ENVIRONMENT: environment },
        req: { header: (name: string) => headers[name] },
      });
      expect(
        resolveClientIp(
          context({
            'CF-Connecting-IP': '203.0.113.1',
            'X-Forwarded-For': '198.51.100.1, 10.0.0.1',
          })
        )
      ).toBe('203.0.113.1');
      expect(
        resolveClientIp(context({ 'X-Forwarded-For': '198.51.100.1, 10.0.0.1' }))
      ).toBe('198.51.100.1');
      expect(
        resolveClientIp(context({ 'X-Forwarded-For': '198.51.100.1' }, 'staging'))
      ).toBe('127.0.0.1');
      expect(resolveClientIp(context({}))).toBe('127.0.0.1');
    });
  });

  describe('policy validation & self-lockout', () => {
    it('rejects invalid IP allowlist entries with INVALID_IP_ALLOWLIST_ENTRY', async () => {
      const res = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: { ipAllowlist: ['203.0.113.0/24', 'not-an-ip'], ipAllowlistEnabled: true },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_IP_ALLOWLIST_ENTRY');
      expect(res.body.invalidEntries).toEqual(['not-an-ip']);
    });

    it('rejects enabling an empty allowlist with SELF_IP_LOCKOUT_PREVENTED', async () => {
      const res = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        ip: BLOCKED_IP,
        body: { ipAllowlistEnabled: true, ipAllowlist: [] },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SELF_IP_LOCKOUT_PREVENTED');
      expect(res.body.ip).toBe(BLOCKED_IP);
    });

    it('blocks a new allowlist that omits the operating administrator IP', async () => {
      const enable = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        ip: ALLOWED_IP,
        body: {
          ipAllowlistEnabled: true,
          ipAllowlistScope: 'admin_only',
          ipAllowlist: [ALLOWED_IP],
        },
      });
      expect(enable.status).toBe(200);

      const lockout = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        ip: ALLOWED_IP,
        body: { ipAllowlist: ['192.0.2.0/24'] },
      });
      expect(lockout.status).toBe(400);
      expect(lockout.body.code).toBe('SELF_IP_LOCKOUT_PREVENTED');
      expect(lockout.body.ip).toBe(ALLOWED_IP);
    });

    it('normalizes and saves SSO domains while rejecting wildcards', async () => {
      const saved = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: {
          ssoAllowedDomains: [
            '@Example.COM',
            'partner.example',
            'example.com',
            ' Example.com ',
          ],
        },
      });
      expect(saved.status).toBe(200);
      expect(
        (saved.body.policy as { ssoAllowedDomains: string[] }).ssoAllowedDomains
      ).toEqual(['example.com', 'partner.example']);

      const wildcard = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: { ssoAllowedDomains: ['*.example.com'] },
      });
      expect(wildcard.status).toBe(400);
      expect(wildcard.body.code).toBe('INVALID_SSO_DOMAIN');

      const invalid = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: { ssoAllowedDomains: ['https://example.com'] },
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('INVALID_SSO_DOMAIN');
    });

    it('keeps auth-control writes restricted to sys_admin', async () => {
      const res = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SEC,
        role: 'sec_admin',
        body: { requireSsoLogin: true },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SYS_ADMIN_REQUIRED');
    });
  });

  describe('scope enforcement', () => {
    it('admin_only protects admin routes but not member workspace routes', async () => {
      await setIpPolicy(true, 'admin_only', [`${ALLOWED_IP}/32`]);

      const memberWorkspace = await call('/api/sync/bootstrap', {
        userId: MEMBER,
        role: 'member',
        ip: BLOCKED_IP,
      });
      expect(memberWorkspace.status).toBe(200);

      const adminBlocked = await call('/api/admin/policies', {
        userId: SYS,
        role: 'sys_admin',
        ip: BLOCKED_IP,
      });
      expect(adminBlocked.status).toBe(403);
      expect(adminBlocked.body).toEqual({
        error: 'Access from this IP address is not allowed',
        code: 'IP_NOT_ALLOWED',
        ip: BLOCKED_IP,
      });

      const auditAdmin = await call('/api/audit-logs', {
        userId: SEC,
        role: 'sec_admin',
        ip: BLOCKED_IP,
      });
      expect(auditAdmin.status).toBe(403);
      expect(auditAdmin.body.code).toBe('IP_NOT_ALLOWED');

      const adminAllowed = await call('/api/admin/policies', {
        userId: SYS,
        role: 'sys_admin',
        ip: ALLOWED_IP,
      });
      expect(adminAllowed.status).toBe(200);

      const audits = await blockedIpAudits();
      expect(audits).toHaveLength(2);
      for (const audit of audits) {
        expect(audit.status).toBe('blocked');
        expect(audit.action).toBe('auth.ip_blocked');
        expect(JSON.parse(audit.metadata_json ?? '{}').scope).toBe('admin_only');
      }
    });

    it('internal_users also protects member sessions and interactive login but not public links or guests', async () => {
      await setIpPolicy(true, 'internal_users', [`${ALLOWED_IP}/32`]);

      const memberBlocked = await call('/api/sync/bootstrap', {
        userId: MEMBER,
        role: 'member',
        ip: BLOCKED_IP,
      });
      expect(memberBlocked.status).toBe(403);
      expect(memberBlocked.body.code).toBe('IP_NOT_ALLOWED');

      const devLoginBlocked = await call('/auth/dev-login', {
        method: 'POST',
        ip: BLOCKED_IP,
        body: { userId: MEMBER },
      });
      expect(devLoginBlocked.status).toBe(403);
      expect(devLoginBlocked.body.code).toBe('IP_NOT_ALLOWED');

      const share = await call(`/api/s/${SHARE_TOKEN}/meta`, {
        ip: BLOCKED_IP,
      });
      expect(share.status).toBe(200);

      const fileRequest = await call(`/api/fr/${FILE_REQUEST_TOKEN}`, {
        ip: BLOCKED_IP,
      });
      expect(fileRequest.status).toBe(200);

      const guestMeta = await call(
        `/auth/guest/invite-meta?token=${GUEST_TOKEN}`,
        { ip: BLOCKED_IP }
      );
      expect(guestMeta.status).toBe(200);

      const memberAllowed = await call('/api/sync/bootstrap', {
        userId: MEMBER,
        role: 'member',
        ip: ALLOWED_IP,
      });
      expect(memberAllowed.status).toBe(200);
    });

    it('all_access protects public share links, file requests and guest auth', async () => {
      await setIpPolicy(true, 'all_access', [`${ALLOWED_IP}/32`]);

      const shareBlocked = await call(`/api/s/${SHARE_TOKEN}/meta`, {
        ip: BLOCKED_IP,
      });
      expect(shareBlocked.status).toBe(403);
      expect(shareBlocked.body.code).toBe('IP_NOT_ALLOWED');

      const fileRequestBlocked = await call(
        `/api/fr/${FILE_REQUEST_TOKEN}`,
        { ip: BLOCKED_IP }
      );
      expect(fileRequestBlocked.status).toBe(403);
      expect(fileRequestBlocked.body.code).toBe('IP_NOT_ALLOWED');

      const guestMetaBlocked = await call(
        `/auth/guest/invite-meta?token=${GUEST_TOKEN}`,
        { ip: BLOCKED_IP }
      );
      expect(guestMetaBlocked.status).toBe(403);
      expect(guestMetaBlocked.body.code).toBe('IP_NOT_ALLOWED');

      const shareAllowed = await call(`/api/s/${SHARE_TOKEN}/meta`, {
        ip: ALLOWED_IP,
      });
      expect(shareAllowed.status).toBe(200);

      const fileRequestAllowed = await call(
        `/api/fr/${FILE_REQUEST_TOKEN}`,
        { ip: ALLOWED_IP }
      );
      expect(fileRequestAllowed.status).toBe(200);

      const audits = await blockedIpAudits();
      expect(audits.length).toBe(3);
      expect(
        audits
          .map(
            (audit) => JSON.parse(audit.metadata_json ?? '{}').requestKind
          )
          .sort()
      ).toEqual(['file_request', 'guest_auth', 'public_share']);
    });
  });

  describe('SSO status & login enforcement', () => {
    it('masks IdP secrets and allows sec_admin read-only visibility', async () => {
      const sys = await call('/api/admin/sso/status', {
        userId: SYS,
        role: 'sys_admin',
      });
      expect(sys.status).toBe(200);
      const body = sys.body as {
        providers: Array<{
          provider: string;
          clientIdMasked: string;
          clientSecretConfigured: boolean;
          jwksUri: string | null;
        }>;
        callbackUrl: string;
        environment: string;
        allowDevAuth: boolean;
        clientIp: string;
      };
      expect(body.providers).toHaveLength(1);
      expect(body.providers[0]!.provider).toBe('okta');
      expect(body.providers[0]!.clientSecretConfigured).toBe(true);
      expect(body.providers[0]!.clientIdMasked).not.toBe(
        'okta-client-id-super-secret-value'
      );
      expect(body.callbackUrl).toBe(`${APP_ORIGIN}/auth/callback`);
      expect(body.environment).toBe('local');
      expect(body.allowDevAuth).toBe(true);
      expect(body.clientIp).toBe(ALLOWED_IP);

      const serialized = JSON.stringify(sys.body);
      expect(serialized).not.toContain('okta-client-id-super-secret-value');
      expect(serialized).not.toContain('okta-client-secret-never-returned');

      const sec = await call('/api/admin/sso/status', {
        userId: SEC,
        role: 'sec_admin',
      });
      expect(sec.status).toBe(200);

      const member = await call('/api/admin/sso/status', {
        userId: MEMBER,
        role: 'member',
      });
      expect(member.status).toBe(403);
    });

    it('require_sso_login blocks dev-login and the raw dev header but keeps D1 sessions and guest auth', async () => {
      const enable = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: { requireSsoLogin: true },
      });
      expect(enable.status).toBe(200);

      const devLogin = await call('/auth/dev-login', {
        method: 'POST',
        body: { userId: MEMBER },
      });
      expect(devLogin.status).toBe(403);
      expect(devLogin.body.code).toBe('SSO_LOGIN_REQUIRED');

      const headerBypass = await call('/api/admin/policies', {
        userId: SYS,
        role: 'sys_admin',
      });
      expect(headerBypass.status).toBe(403);
      expect(headerBypass.body.code).toBe('SSO_LOGIN_REQUIRED');

      const cookieSession = await call('/api/admin/policies', {
        cookie: `files_session_local=${COOKIE_SESSION_TOKEN}`,
      });
      expect(cookieSession.status).toBe(200);

      const guestMeta = await call(
        `/auth/guest/invite-meta?token=${GUEST_TOKEN}`
      );
      expect(guestMeta.status).toBe(200);

      expect(await auditActions()).toEqual(
        expect.arrayContaining([
          'auth.sso_required_blocked',
        ])
      );
    });

    it('blocks OIDC callback emails outside ssoAllowedDomains and records an audit log', async () => {
      await env.DB.prepare(
        `UPDATE tenant_policies
            SET require_sso_login = 0,
                sso_allowed_domains_json = '["example.com"]'
          WHERE tenant_id = ?`
      )
        .bind(TENANT)
        .run();

      const state = 'oidc-callback-state-1';
      const sealedState = await encryptCookiePayload(OIDC_STATE_COOKIE_KEY, {
        state,
        nonce: 'oidc-callback-nonce',
        codeVerifier: 'oidc-callback-verifier',
        idp: 'okta',
        tenantId: TENANT,
        returnTo: '/workspace',
        exp: Date.now() + 10 * 60 * 1000,
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ id_token: 'stub-id-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      );

      try {
        const response = await call(
          `/auth/callback?code=stub-code&state=${state}`,
          {
            ip: ALLOWED_IP,
            cookie: `files_oidc_local=${sealedState}`,
          }
        );
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('SSO_DOMAIN_NOT_ALLOWED');

        const audit = await env.DB.prepare(
          `SELECT status, actor_email, metadata_json FROM audit_logs
            WHERE tenant_id = ? AND action = 'auth.sso_domain_blocked'
            ORDER BY created_at DESC LIMIT 1`
        )
          .bind(TENANT)
          .first<{
            status: string;
            actor_email: string;
            metadata_json: string;
          }>();
        expect(audit?.status).toBe('blocked');
        expect(audit?.actor_email).toBe('outside@blocked.example');
        expect(JSON.parse(audit?.metadata_json ?? '{}').emailDomain).toBe(
          'blocked.example'
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('evaluates SSO domain allowlists with exact-match semantics', () => {
      expect(isSsoEmailDomainAllowed('user@example.com', [])).toBe(true);
      expect(
        isSsoEmailDomainAllowed('user@example.com', ['example.com'])
      ).toBe(true);
      expect(
        isSsoEmailDomainAllowed('user@sub.example.com', ['example.com'])
      ).toBe(false);
      expect(
        isSsoEmailDomainAllowed('user@other.com', ['example.com'])
      ).toBe(false);
      expect(
        isSsoEmailDomainAllowed('user@EXAMPLE.COM', ['example.com'])
      ).toBe(true);
      expect(
        isSsoEmailDomainAllowed('user@example.com', ['*.example.com'])
      ).toBe(false);
    });

    it('normalizes SSO domain input without widening the policy', () => {
      expect(
        normalizeSsoAllowedDomainsInput([
          '@Example.COM',
          'partner.example',
          'EXAMPLE.com',
        ])
      ).toEqual({ ok: true, domains: ['example.com', 'partner.example'] });
      expect(
        normalizeSsoAllowedDomainsInput(['*.example.com']).ok
      ).toBe(false);
      expect(
        normalizeSsoAllowedDomainsInput(['example']).ok
      ).toBe(false);
      expect(maskOidcClientId('abcdefghijklmnop')).toBe('abcd…mnop');
    });
  });
});
