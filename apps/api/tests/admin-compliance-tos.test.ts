import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { sha256Hex } from '../src/services/crypto-utils';
import {
  computeSiemSignature,
  validateSiemWebhookUrl,
  verifySiemSignature,
} from '../src/services/siem-webhook';
import {
  isTosProtectedPath,
  isTosAudienceApplicable,
} from '../src/services/tos';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-tos';
const APP_ORIGIN = 'http://127.0.0.1:8787';
const SYS = 'tos-sys';
const SEC = 'tos-sec';
const MEMBER = 'tos-member';
const GUEST = 'tos-guest';

const SHARE_TOKEN = 'tos-shared-link-token-0000001';
const FILE_REQUEST_TOKEN = 'tos-file-request-token-0000001';
const FOLDER_ID = 'tos-folder';
const SHARED_LINK_ID = 'tos-shared-link';
const SEEDED_FILE_REQUEST_ID = 'tos-seeded-request';

type UserRole = 'sys_admin' | 'sec_admin' | 'member';
type UserType = 'member' | 'guest';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

function buildTestEnv(overrides: Partial<OidcEnv> = {}): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN,
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-tos-secret',
    DEFAULT_TENANT_ID: TENANT,
    ...overrides,
  } as unknown as OidcEnv;
}

function authHeaders(
  userId: string,
  role: UserRole = 'member',
  options: { userType?: UserType; tenantId?: string; extra?: Record<string, string> } = {}
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': options.tenantId ?? TENANT,
    'X-Dev-User-Email': `${userId}@example.com`,
    'X-Dev-User-Type': options.userType ?? 'member',
    'CF-Connecting-IP': '198.51.100.20',
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
    headers?: Record<string, string>;
    envOverride?: Partial<OidcEnv>;
  } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers:
        options.headers ??
        (options.userId
          ? authHeaders(options.userId, options.role ?? 'member', {
              userType: options.userType,
            })
          : { 'Content-Type': 'application/json', Origin: APP_ORIGIN }),
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }),
    buildTestEnv(options.envOverride)
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

async function resetTenantGovernance(): Promise<void> {
  await env.DB.prepare('DELETE FROM tenant_tos_policies WHERE tenant_id = ?')
    .bind(TENANT)
    .run();
  await env.DB.prepare('DELETE FROM user_tos_acceptances WHERE tenant_id = ?')
    .bind(TENANT)
    .run();
  await env.DB.prepare('DELETE FROM audit_logs WHERE tenant_id = ?')
    .bind(TENANT)
    .run();
  await env.DB.prepare(
    `UPDATE tenant_policies
        SET allow_file_requests = 1,
            file_request_max_size_bytes = 104857600,
            file_request_enforce_allowed_extensions = 0,
            branding_org_name = NULL,
            branding_contact_info = NULL,
            branding_footer_note = NULL,
            siem_webhook_enabled = 0,
            siem_webhook_url = NULL,
            siem_webhook_secret_encrypted = NULL,
            siem_events_json = '["security_blocked","admin_mutation"]',
            quota_warn_threshold_pct = 80,
            quota_critical_threshold_pct = 90
      WHERE tenant_id = ?`
  )
    .bind(TENANT)
    .run();
  await env.DB.prepare('UPDATE file_requests SET is_active = 1 WHERE tenant_id = ?')
    .bind(TENANT)
    .run();
  await env.DB.prepare('DELETE FROM file_requests WHERE tenant_id = ? AND id != ?')
    .bind(TENANT, SEEDED_FILE_REQUEST_ID)
    .run();
}

async function enableTos(
  options: {
    enabled?: boolean;
    targetAudience?: 'all_users' | 'guests_only' | 'members_only';
    title?: string;
    bodyMarkdown?: string;
    bumpVersion?: boolean;
  } = {}
): Promise<ApiResponse<{ tos: { version: number; enabled: boolean } }>> {
  return call('/api/admin/tos', {
    method: 'PUT',
    userId: SYS,
    role: 'sys_admin',
    body: {
      enabled: true,
      targetAudience: 'all_users',
      title: 'カスタム利用規約',
      bodyMarkdown: '# 第1条\n\n機密情報を適切に扱うこと。\n\n- 共有リンクの再配布禁止',
      ...options,
    },
  });
}

async function auditActions(): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT action FROM audit_logs WHERE tenant_id = ? ORDER BY created_at ASC, rowid ASC'
  )
    .bind(TENANT)
    .all<{ action: string }>();
  return rows.results.map((row) => row.action);
}

describe('Custom ToS, file-request governance, branding & SIEM (TOM-72)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const [shareHash, fileRequestHash] = await Promise.all([
      sha256Hex(SHARE_TOKEN),
      sha256Hex(FILE_REQUEST_TOKEN),
    ]);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'ToS Tenant', 'tos-tenant', 1000000)`
      ).bind(TENANT),
      env.DB.prepare('INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)')
        .bind(TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (
           id, tenant_id, email, display_name, role, status, user_type, external_org
         ) VALUES
           (?, ?, 'tos-sys@example.com', 'ToS Sys', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'tos-sec@example.com', 'ToS Sec', 'sec_admin', 'active', 'member', NULL),
           (?, ?, 'tos-member@example.com', 'ToS Member', 'member', 'active', 'member', NULL),
           (?, ?, 'tos-guest@partner.example', 'ToS Guest', 'member', 'active', 'guest', 'Partner')`
      ).bind(SYS, TENANT, SEC, TENANT, MEMBER, TENANT, GUEST, TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification, created_by
         ) VALUES (?, ?, NULL, 'Governance', 0, 1, 'internal', ?)`
      ).bind(FOLDER_ID, TENANT, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, 0)`
      ).bind(TENANT, FOLDER_ID, FOLDER_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by
         ) VALUES ('tos-perm-member', ?, 'folder', ?, 'user', ?, 'editor', ?)`
      ).bind(TENANT, FOLDER_ID, MEMBER, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, created_by
         ) VALUES (?, ?, ?, 'folder', ?, 'public', 1, ?)`
      ).bind(SHARED_LINK_ID, TENANT, shareHash, FOLDER_ID, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_requests (
           id, tenant_id, folder_id, token_hash, title, description,
           require_submitter_email, max_file_size_bytes, submission_count,
           is_active, created_by
         ) VALUES (?, ?, ?, ?, 'Seed upload', NULL, 0, 4096, 2, 1, ?)`
      ).bind(SEEDED_FILE_REQUEST_ID, TENANT, FOLDER_ID, fileRequestHash, SYS),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (
           tenant_id, classification, file_count, total_bytes
         ) VALUES (?, 'internal', 0, 0)`
      ).bind(TENANT),
    ]);
  });

  beforeEach(async () => {
    vi.unstubAllGlobals();
    await resetTenantGovernance();
  });

  describe('ToS acceptance gate', () => {
    it('blocks workspace APIs, exposes bootstrap status, accepts idempotently and audits', async () => {
      const enabled = await enableTos();
      expect(enabled.status).toBe(200);
      expect(enabled.body.tos.version).toBe(1);

      const status = await call<{
        tos: {
          enabled: boolean;
          applicable: boolean;
          requiresAcceptance: boolean;
          version: number;
          bodyMarkdown: string;
        };
        branding: { orgName: string | null };
      }>('/api/auth/tos', { userId: MEMBER });
      expect(status.status).toBe(200);
      expect(status.body.tos).toMatchObject({
        enabled: true,
        applicable: true,
        requiresAcceptance: true,
        version: 1,
      });
      expect(status.body.tos.bodyMarkdown).toContain('機密情報');

      const blocked = await call('/api/shared-items', { userId: MEMBER });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('TOS_ACCEPTANCE_REQUIRED');
      expect(blocked.body.version).toBe(1);

      // Bootstrap stays reachable and carries the same status for the client.
      const bootstrap = await call<{
        tosStatus: { requiresAcceptance: boolean; version: number };
        rootFolders: unknown[];
      }>('/api/sync/bootstrap', { userId: MEMBER });
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.body.tosStatus.requiresAcceptance).toBe(true);
      expect(bootstrap.body.tosStatus.version).toBe(1);

      const mismatch = await call('/api/auth/tos/accept', {
        method: 'POST',
        userId: MEMBER,
        body: { version: 99 },
      });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.code).toBe('TOS_VERSION_MISMATCH');

      const accepted = await call<{ ok: boolean; tos: { requiresAcceptance: boolean } }>(
        '/api/auth/tos/accept',
        { method: 'POST', userId: MEMBER, body: { version: 1 } }
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body.ok).toBe(true);
      expect(accepted.body.tos.requiresAcceptance).toBe(false);
      expect(await auditActions()).toContain('auth.tos_accepted');

      // Idempotent retry must not duplicate the acceptance audit.
      const retry = await call('/api/auth/tos/accept', {
        method: 'POST',
        userId: MEMBER,
        body: { version: 1 },
      });
      expect(retry.status).toBe(200);
      expect(
        (await auditActions()).filter((action) => action === 'auth.tos_accepted')
      ).toHaveLength(1);

      const unblocked = await call('/api/shared-items', { userId: MEMBER });
      expect(unblocked.status).toBe(200);
    });

    it('forces re-consent when an active policy body/title changes', async () => {
      await enableTos();
      await call('/api/auth/tos/accept', {
        method: 'POST',
        userId: MEMBER,
        body: { version: 1 },
      });

      const revised = await enableTos({
        title: 'カスタム利用規約 (改定)',
        bodyMarkdown: '# 第1条\n\n改定後の本文',
      });
      expect(revised.status).toBe(200);
      expect(revised.body.tos.version).toBe(2);

      const blocked = await call('/api/shared-items', { userId: MEMBER });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('TOS_ACCEPTANCE_REQUIRED');
      expect(blocked.body.version).toBe(2);

      const stale = await call('/api/auth/tos/accept', {
        method: 'POST',
        userId: MEMBER,
        body: { version: 1 },
      });
      expect(stale.status).toBe(409);

      const accepted = await call('/api/auth/tos/accept', {
        method: 'POST',
        userId: MEMBER,
        body: { version: 2 },
      });
      expect(accepted.status).toBe(200);
      expect((await call('/api/shared-items', { userId: MEMBER })).status).toBe(200);
    });

    it('switches audience between all_users, members_only and guests_only', async () => {
      await enableTos({ targetAudience: 'members_only' });
      expect((await call('/api/shared-items', { userId: MEMBER })).status).toBe(403);
      expect((await call('/api/shared-items', { userId: GUEST, userType: 'guest' })).status).toBe(200);

      await env.DB.prepare('DELETE FROM tenant_tos_policies WHERE tenant_id = ?')
        .bind(TENANT)
        .run();
      await enableTos({ targetAudience: 'guests_only' });
      expect((await call('/api/shared-items', { userId: MEMBER })).status).toBe(200);
      expect((await call('/api/shared-items', { userId: GUEST, userType: 'guest' })).status).toBe(403);

      expect(isTosAudienceApplicable('all_users', 'member')).toBe(true);
      expect(isTosAudienceApplicable('all_users', 'guest')).toBe(true);
      expect(isTosAudienceApplicable('members_only', 'guest')).toBe(false);
      expect(isTosAudienceApplicable('guests_only', 'member')).toBe(false);
    });

    it('keeps auth/admin/bootstrap/public routes exempt from the gate', () => {
      expect(isTosProtectedPath('/api/workspace/batch-move')).toBe(true);
      expect(isTosProtectedPath('/api/folders/f1')).toBe(true);
      expect(isTosProtectedPath('/api/files/f1')).toBe(true);
      expect(isTosProtectedPath('/api/shared-links')).toBe(true);
      expect(isTosProtectedPath('/api/file-requests')).toBe(true);
      expect(isTosProtectedPath('/api/trash')).toBe(true);
      expect(isTosProtectedPath('/api/permissions/f1')).toBe(true);
      expect(isTosProtectedPath('/api/search')).toBe(true);
      expect(isTosProtectedPath('/api/sync/delta')).toBe(true);
      expect(isTosProtectedPath('/api/guests')).toBe(true);

      expect(isTosProtectedPath('/api/auth/tos/accept')).toBe(false);
      expect(isTosProtectedPath('/api/admin/tos')).toBe(false);
      expect(isTosProtectedPath('/api/sync/bootstrap')).toBe(false);
      expect(isTosProtectedPath('/api/s/token/meta')).toBe(false);
      expect(isTosProtectedPath('/api/fr/token')).toBe(false);
      expect(isTosProtectedPath('/auth/guest/invite-meta')).toBe(false);
    });

    it('allows sec_admin to read but not write the ToS policy', async () => {
      await enableTos();
      const read = await call('/api/admin/tos', { userId: SEC, role: 'sec_admin' });
      expect(read.status).toBe(200);
      const write = await call('/api/admin/tos', {
        method: 'PUT',
        userId: SEC,
        role: 'sec_admin',
        body: { enabled: false },
      });
      expect(write.status).toBe(403);
      expect(write.body.code).toBe('SYS_ADMIN_REQUIRED');
    });
  });

  describe('tenant-wide file-request governance', () => {
    it('blocks creation when the tenant policy disables file requests', async () => {
      const disabled = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: { allowFileRequests: false },
      });
      expect(disabled.status).toBe(200);

      const create = await call('/api/file-requests', {
        method: 'POST',
        userId: MEMBER,
        body: { folderId: FOLDER_ID, title: 'Disabled request' },
      });
      expect(create.status).toBe(403);
      expect(create.body.code).toBe('FILE_REQUESTS_DISABLED_BY_POLICY');

      const publicMeta = await call(`/api/fr/${FILE_REQUEST_TOKEN}`);
      expect(publicMeta.status).toBe(403);
      expect(publicMeta.body.code).toBe('FILE_REQUESTS_DISABLED_BY_POLICY');
    });

    it('enforces the tenant-wide maximum size on creation and public upload init', async () => {
      const limited = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: { fileRequestMaxSizeBytes: 512 },
      });
      expect(limited.status).toBe(200);

      const exceeds = await call('/api/file-requests', {
        method: 'POST',
        userId: MEMBER,
        body: {
          folderId: FOLDER_ID,
          title: 'Too large',
          maxFileSizeBytes: 1024,
        },
      });
      expect(exceeds.status).toBe(400);
      expect(exceeds.body.code).toBe('FILE_REQUEST_SIZE_EXCEEDS_POLICY');

      const defaulted = await call<{ fileRequest: { maxFileSizeBytes: number } }>(
        '/api/file-requests',
        {
          method: 'POST',
          userId: MEMBER,
          body: { folderId: FOLDER_ID, title: 'Default limited' },
        }
      );
      expect(defaulted.status).toBe(201);
      expect(defaulted.body.fileRequest.maxFileSizeBytes).toBe(512);

      const meta = await call<{ maxFileSizeBytes: number }>(
        `/api/fr/${FILE_REQUEST_TOKEN}`
      );
      expect(meta.status).toBe(200);
      expect(meta.body.maxFileSizeBytes).toBe(512);

      const uploadInit = await call('/api/fr/' + FILE_REQUEST_TOKEN + '/upload-init', {
        method: 'POST',
        body: {
          fileName: 'large.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
        },
      });
      expect(uploadInit.status).toBe(413);
      expect(uploadInit.body.code).toBe('FILE_SIZE_LIMIT_EXCEEDED');
    });

    it('requires allowed extensions when the tenant policy enforces them', async () => {
      const enforced = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: { fileRequestEnforceAllowedExtensions: true },
      });
      expect(enforced.status).toBe(200);

      const missing = await call('/api/file-requests', {
        method: 'POST',
        userId: MEMBER,
        body: { folderId: FOLDER_ID, title: 'Need extensions' },
      });
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('FILE_REQUEST_EXTENSIONS_REQUIRED');

      const empty = await call('/api/file-requests', {
        method: 'POST',
        userId: MEMBER,
        body: {
          folderId: FOLDER_ID,
          title: 'Empty extensions',
          allowedExtensions: [],
        },
      });
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe('FILE_REQUEST_EXTENSIONS_REQUIRED');

      const valid = await call('/api/file-requests', {
        method: 'POST',
        userId: MEMBER,
        body: {
          folderId: FOLDER_ID,
          title: 'Allowed extensions',
          allowedExtensions: ['pdf'],
        },
      });
      expect(valid.status).toBe(201);
    });

    it('lists tenant-wide requests and lets admins emergency-disable a link', async () => {
      const created = await call<{ token: string; fileRequest: { id: string } }>(
        '/api/file-requests',
        {
          method: 'POST',
          userId: MEMBER,
          body: { folderId: FOLDER_ID, title: 'Emergency target' },
        }
      );
      expect(created.status).toBe(201);
      const requestId = created.body.fileRequest.id;
      const exact = await call<{ token: string }>('/api/fr/' + created.body.token);
      expect(exact.status).toBe(200);

      const listed = await call<{
        fileRequests: Array<{
          id: string;
          title: string;
          folderName: string | null;
          ownerName: string | null;
          ownerEmail: string | null;
          submissionCount: number;
          isActive: boolean;
        }>;
      }>('/api/admin/file-requests?status=active&search=Emergency', {
        userId: SEC,
        role: 'sec_admin',
      });
      expect(listed.status).toBe(200);
      const row = listed.body.fileRequests.find((item) => item.id === requestId);
      expect(row).toBeTruthy();
      expect(row?.folderName).toBe('Governance');
      expect(row?.ownerName).toBe('ToS Member');
      expect(row?.ownerEmail).toBe('tos-member@example.com');
      expect(row?.submissionCount).toBe(0);
      expect(row?.isActive).toBe(true);

      const disabled = await call<{ ok: boolean; alreadyDisabled: boolean }>(
        `/api/admin/file-requests/${requestId}/disable`,
        { method: 'POST', userId: SEC, role: 'sec_admin' }
      );
      expect(disabled.status).toBe(200);
      expect(disabled.body.ok).toBe(true);
      expect(disabled.body.alreadyDisabled).toBe(false);
      expect(await auditActions()).toContain('admin.file_request.disabled');

      const closed = await call('/api/fr/' + created.body.token);
      expect(closed.status).toBe(410);
      expect(closed.body.code).toBe('REQUEST_CLOSED');

      const createDenied = await call('/api/file-requests', {
        method: 'POST',
        userId: MEMBER,
        body: { folderId: FOLDER_ID, title: 'After disable' },
      });
      expect(createDenied.status).toBe(201);
    });

    it('keeps file-request administration to admins', async () => {
      const memberList = await call('/api/admin/file-requests', { userId: MEMBER });
      expect(memberList.status).toBe(403);
      const secList = await call('/api/admin/file-requests', {
        userId: SEC,
        role: 'sec_admin',
      });
      expect(secList.status).toBe(200);
    });
  });

  describe('branding projection', () => {
    it('exposes branding on shared links, file requests and ToS status', async () => {
      const saved = await call('/api/admin/policies', {
        method: 'PATCH',
        userId: SYS,
        role: 'sys_admin',
        body: {
          brandingOrgName: 'サンプル株式会社',
          brandingContactInfo: 'security@example.com',
          brandingFooterNote: '本リンクは秘密保持契約に準拠します。',
        },
      });
      expect(saved.status).toBe(200);

      const shareMeta = await call<{
        branding: { orgName: string; contactInfo: string; footerNote: string };
      }>(`/api/s/${SHARE_TOKEN}/meta`);
      expect(shareMeta.status).toBe(200);
      expect(shareMeta.body.branding).toEqual({
        orgName: 'サンプル株式会社',
        contactInfo: 'security@example.com',
        footerNote: '本リンクは秘密保持契約に準拠します。',
      });

      const fileRequestMeta = await call<{
        branding: { orgName: string; footerNote: string };
      }>(`/api/fr/${FILE_REQUEST_TOKEN}`);
      expect(fileRequestMeta.status).toBe(200);
      expect(fileRequestMeta.body.branding.orgName).toBe('サンプル株式会社');
      expect(fileRequestMeta.body.branding.footerNote).toBe(
        '本リンクは秘密保持契約に準拠します。'
      );

      await enableTos();
      const tos = await call<{
        branding: { orgName: string; contactInfo: string; footerNote: string };
      }>('/api/auth/tos', { userId: MEMBER });
      expect(tos.status).toBe(200);
      expect(tos.body.branding.orgName).toBe('サンプル株式会社');
    });
  });

  describe('SIEM webhook security', () => {
    it('rejects http, localhost, internal, private and link-local targets', () => {
      const rejected = [
        'http://siem.example.com/hook',
        'https://localhost/hook',
        'https://collector.internal/hook',
        'https://siem.local/hook',
        'https://127.0.0.1/hook',
        'https://127.10.0.2/hook',
        'https://10.1.2.3/hook',
        'https://172.16.0.1/hook',
        'https://172.31.255.1/hook',
        'https://192.168.1.1/hook',
        'https://169.254.169.254/latest/meta-data',
        'https://100.64.0.1/hook',
        'https://0.0.0.0/hook',
        'https://[::1]/hook',
        'https://[fc00::1]/hook',
        'https://[fd12:3456::1]/hook',
        'https://[fe80::1]/hook',
        'https://[::ffff:127.0.0.1]/hook',
        'https://[::ffff:10.0.0.1]/hook',
      ];
      for (const url of rejected) {
        const result = validateSiemWebhookUrl(url);
        expect(result.ok, url).toBe(false);
        expect(['INVALID_SIEM_WEBHOOK_URL', 'SIEM_WEBHOOK_URL_FORBIDDEN']).toContain(
          result.code
        );
      }
      expect(validateSiemWebhookUrl('https://siem.example.com/hook').ok).toBe(true);
      expect(validateSiemWebhookUrl('https://198.51.100.10/hook').ok).toBe(true);
      expect(validateSiemWebhookUrl('https://[2001:db8::1]/hook').ok).toBe(true);
    });

    it('signs with HMAC-SHA256 over timestamp, event and raw body', async () => {
      const secret = 'siem-shared-secret';
      const timestamp = '1794900000';
      const body = '{"event":"admin.siem.test"}';
      const signature = await computeSiemSignature(
        secret,
        timestamp,
        'admin.siem.test',
        body
      );
      expect(signature).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await verifySiemSignature(
          secret,
          timestamp,
          'admin.siem.test',
          body,
          `sha256=${signature}`
        )
      ).toBe(true);
      expect(
        await verifySiemSignature(
          secret,
          timestamp,
          'admin.siem.test',
          body,
          'sha256=deadbeef'
        )
      ).toBe(false);
    });

    it('validates URL/secret, hides the secret, and enforces RBAC', async () => {
      const memberRead = await call('/api/admin/siem', { userId: MEMBER });
      expect(memberRead.status).toBe(403);
      const secRead = await call('/api/admin/siem', {
        userId: SEC,
        role: 'sec_admin',
      });
      expect(secRead.status).toBe(200);
      const secWrite = await call('/api/admin/siem', {
        method: 'PUT',
        userId: SEC,
        role: 'sec_admin',
        body: { enabled: false },
      });
      expect(secWrite.status).toBe(403);

      for (const url of ['http://siem.example.com', 'https://localhost/hook']) {
        const rejected = await call('/api/admin/siem', {
          method: 'PUT',
          userId: SYS,
          role: 'sys_admin',
          body: { enabled: true, url, secret: 'super-secret' },
        });
        expect(rejected.status).toBe(400);
      }

      const saved = await call<{
        siem: { enabled: boolean; url: string; secretConfigured: boolean };
      }>('/api/admin/siem', {
        method: 'PUT',
        userId: SYS,
        role: 'sys_admin',
        body: {
          enabled: true,
          url: 'https://siem.example.com/hook',
          secret: 'super-secret-value',
          events: ['security_blocked', 'admin_mutation'],
        },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.siem.enabled).toBe(true);
      expect(saved.body.siem.secretConfigured).toBe(true);
      expect(JSON.stringify(saved.body)).not.toContain('super-secret-value');

      const read = await call<{ siem: Record<string, unknown> }>('/api/admin/siem', {
        userId: SYS,
        role: 'sys_admin',
      });
      expect(read.status).toBe(200);
      expect(read.body.siem.secretConfigured).toBe(true);
      expect(JSON.stringify(read.body)).not.toContain('super-secret-value');
      expect(read.body.siem).not.toHaveProperty('secret');

      const stored = await env.DB.prepare(
        'SELECT siem_webhook_secret_encrypted FROM tenant_policies WHERE tenant_id = ?'
      )
        .bind(TENANT)
        .first<{ siem_webhook_secret_encrypted: string }>();
      expect(stored?.siem_webhook_secret_encrypted).toBeTruthy();
      expect(stored?.siem_webhook_secret_encrypted).not.toContain(
        'super-secret-value'
      );
      expect(await auditActions()).toContain('admin.siem.updated');

      // Secret ciphertext must not leak through the generic policy projection
      // or the member-facing bootstrap payload.
      const policies = await call<{ policy: Record<string, unknown> }>(
        '/api/admin/policies',
        { userId: SYS, role: 'sys_admin' }
      );
      expect(policies.status).toBe(200);
      expect(policies.body.policy).not.toHaveProperty(
        'siem_webhook_secret_encrypted'
      );
      expect(JSON.stringify(policies.body)).not.toContain(
        stored!.siem_webhook_secret_encrypted
      );

      const bootstrap = await call<{ policy: Record<string, unknown> }>(
        '/api/sync/bootstrap',
        { userId: MEMBER }
      );
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.body.policy).not.toHaveProperty(
        'siem_webhook_secret_encrypted'
      );
      expect(bootstrap.body.policy).not.toHaveProperty('siem_webhook_url');
      expect(bootstrap.body.policy).not.toHaveProperty('siem_events_json');
    });

    it('sends a signed test event and records the audit entry', async () => {
      await call('/api/admin/siem', {
        method: 'PUT',
        userId: SYS,
        role: 'sys_admin',
        body: {
          enabled: true,
          url: 'https://siem.example.com/hook',
          secret: 'test-signing-secret',
        },
      });

      const captured: Array<{ url: string; init: RequestInit }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          captured.push({ url: String(input), init: init ?? {} });
          return new Response('accepted', { status: 202 });
        })
      );

      const tested = await call<{ ok: boolean; delivered: boolean; status: number }>(
        '/api/admin/siem/test',
        { method: 'POST', userId: SYS, role: 'sys_admin' }
      );
      expect(tested.status).toBe(200);
      expect(tested.body.ok).toBe(true);
      expect(tested.body.delivered).toBe(true);
      expect(tested.body.status).toBe(202);

      expect(captured).toHaveLength(1);
      const request = captured[0]!;
      expect(request.url).toBe('https://siem.example.com/hook');
      expect(request.init.redirect).toBe('manual');
      const headers = new Headers(request.init.headers);
      expect(headers.get('X-Files-Event')).toBe('admin.siem.test');
      expect(headers.get('X-Files-Timestamp')).toBeTruthy();
      const signature = headers.get('X-Files-Signature-256');
      expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(
        await verifySiemSignature(
          'test-signing-secret',
          headers.get('X-Files-Timestamp')!,
          'admin.siem.test',
          String(request.init.body),
          signature!
        )
      ).toBe(true);
      expect(await auditActions()).toContain('admin.siem.tested');
      vi.unstubAllGlobals();
    });

    it('rejects test delivery when the webhook is not configured', async () => {
      const result = await call('/api/admin/siem/test', {
        method: 'POST',
        userId: SYS,
        role: 'sys_admin',
      });
      expect(result.status).toBe(400);
      expect(result.body.code).toBe('SIEM_NOT_CONFIGURED');
    });
  });
});
