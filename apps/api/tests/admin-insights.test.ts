import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker, { app } from '../src/index';
import { runDailyMaintenance } from '../src/consumers/maintenance-cron';
import {
  addUtcDays,
  aggregateTenantDailyInsights,
  buildAdminInsightsQueries,
} from '../src/services/admin-insights';
import type { AdminInsightsResponse } from '../src/services/admin-insights';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-insights';
const OTHER_TENANT = 'tenant-insights-other';
const CRON_TENANT = 'tenant-insights-cron';

const SYS = 'insights-sys';
const SEC = 'insights-sec';
const MEMBER = 'insights-member';
const MEMBER_SUSPENDED = 'insights-member-suspended';
const GUEST = 'insights-guest';
const GUEST_FAR = 'insights-guest-far';
const GUEST_SUSPENDED = 'insights-guest-suspended';
const OTHER_SYS = 'insights-other-sys';
const OTHER_MEMBER = 'insights-other-member';
const CRON_MEMBER = 'insights-cron-member';
const CRON_SEC = 'insights-cron-sec';

const API_NOW = new Date();
const TODAY = API_NOW.toISOString().slice(0, 10);
const YESTERDAY = addUtcDays(TODAY, -1);
const TWO_DAYS_AGO = addUtcDays(TODAY, -2);

const CRON_DAY = '2026-11-10';
const CRON_NOW = new Date('2026-11-11T03:00:00.000Z');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TODAY_START = `${TODAY}T00:00:00.000Z`;

function ago(ms: number): string {
  return new Date(API_NOW.getTime() - ms).toISOString();
}

function future(ms: number): string {
  return new Date(API_NOW.getTime() + ms).toISOString();
}

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
    DEFAULT_TENANT_ID: TENANT,
    JOBS_QUEUE: { send: async () => undefined },
  } as unknown as OidcEnv;
}

function headers(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'sys_admin',
  options: {
    tenantId?: string;
    userType?: 'member' | 'guest';
    expiresAt?: string;
  } = {}
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': options.tenantId ?? TENANT,
    'X-Dev-User-Email': `${userId}@insights.example.com`,
    'X-Dev-User-Type': options.userType ?? 'member',
    ...(options.expiresAt ? { 'X-Dev-User-Expires-At': options.expiresAt } : {}),
    'Content-Type': 'application/json',
    Origin: 'http://127.0.0.1:8787',
  };
}

async function call(
  path: string,
  userId = SYS,
  options: {
    role?: 'sys_admin' | 'sec_admin' | 'member';
    tenantId?: string;
    userType?: 'member' | 'guest';
    expiresAt?: string;
  } = {}
): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      headers: headers(userId, options.role ?? 'sys_admin', options),
    }),
    buildTestEnv()
  );
}

async function getInsights(
  days: 7 | 30 = 7,
  options: {
    userId?: string;
    role?: 'sys_admin' | 'sec_admin' | 'member';
    tenantId?: string;
    userType?: 'member' | 'guest';
  } = {}
): Promise<AdminInsightsResponse> {
  const res = await call(`/api/admin/insights?days=${days}`, options.userId, {
    role: options.role ?? 'sys_admin',
    tenantId: options.tenantId,
    userType: options.userType,
  });
  expect(res.status, `GET /api/admin/insights?days=${days}`).toBe(200);
  return (await res.json()) as AdminInsightsResponse;
}

function byAction(
  response: AdminInsightsResponse
): Record<string, number> {
  return Object.fromEntries(
    response.security.blockedByAction.map((row) => [row.action, row.count])
  );
}

describe('Admin insights dashboard (P13-2 / TOM-67)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tenants (id, name, slug, storage_quota_bytes) VALUES
           (?, 'Insights Corp', 'insights-corp', 10000),
           (?, 'Insights Other', 'insights-other', 5000),
           (?, 'Insights Cron', 'insights-cron', 20000)`
      ).bind(TENANT, OTHER_TENANT, CRON_TENANT),
      env.DB.prepare(
        `INSERT INTO tenant_policies (tenant_id) VALUES (?), (?), (?)`
      ).bind(TENANT, OTHER_TENANT, CRON_TENANT),
      env.DB.prepare(
        `INSERT INTO users (
           id, tenant_id, email, display_name, role, status, user_type,
           external_org, expires_at, offboarded_at
         ) VALUES
           (?, ?, 'sys@insights.example.com', 'Insights Sys', 'sys_admin', 'active', 'member', NULL, NULL, NULL),
           (?, ?, 'sec@insights.example.com', 'Insights Sec', 'sec_admin', 'active', 'member', NULL, NULL, NULL),
           (?, ?, 'member@insights.example.com', 'Insights Member', 'member', 'active', 'member', NULL, NULL, NULL),
           (?, ?, 'suspended@insights.example.com', 'Insights Suspended', 'member', 'suspended', 'member', NULL, NULL, NULL),
           (?, ?, 'guest@partner.example', 'Insights Guest', 'member', 'active', 'guest', 'Partner', ?, NULL),
           (?, ?, 'guest-far@partner.example', 'Insights Guest Far', 'member', 'active', 'guest', 'Partner', ?, NULL),
           (?, ?, 'guest-susp@partner.example', 'Insights Guest Susp', 'member', 'suspended', 'guest', 'Partner', ?, NULL),
           (?, ?, 'other-sys@insights.example.com', 'Other Sys', 'sys_admin', 'active', 'member', NULL, NULL, NULL),
           (?, ?, 'other-member@insights.example.com', 'Other Member', 'member', 'active', 'member', NULL, NULL, NULL),
           (?, ?, 'cron-member@insights.example.com', 'Cron Member', 'member', 'active', 'member', NULL, NULL, NULL),
           (?, ?, 'cron-sec@insights.example.com', 'Cron Sec', 'sec_admin', 'active', 'member', NULL, NULL, NULL)`
      ).bind(
        SYS,
        TENANT,
        SEC,
        TENANT,
        MEMBER,
        TENANT,
        MEMBER_SUSPENDED,
        TENANT,
        GUEST,
        TENANT,
        future(48 * HOUR_MS),
        GUEST_FAR,
        TENANT,
        future(10 * DAY_MS),
        GUEST_SUSPENDED,
        TENANT,
        future(48 * HOUR_MS),
        OTHER_SYS,
        OTHER_TENANT,
        OTHER_MEMBER,
        OTHER_TENANT,
        CRON_MEMBER,
        CRON_TENANT,
        CRON_SEC,
        CRON_TENANT
      ),
      env.DB.prepare(
        `INSERT INTO tenant_storage_stats (
           tenant_id, classification, file_count, total_bytes
         ) VALUES
           (?, 'unset', 2, 300),
           (?, 'confidential', 1, 900),
           (?, 'internal', 1, 500),
           (?, 'public', 1, 100),
           (?, 'internal', 1, 100),
           (?, 'internal', 2, 1234)`
      ).bind(
        TENANT,
        TENANT,
        TENANT,
        TENANT,
        OTHER_TENANT,
        CRON_TENANT
      ),
      env.DB.prepare(
        `INSERT INTO groups (id, tenant_id, name) VALUES
           ('insights-group-1', ?, 'Insights Group 1'),
           ('insights-group-2', ?, 'Insights Group 2'),
           ('insights-group-other', ?, 'Other Group')`
      ).bind(TENANT, TENANT, OTHER_TENANT),
    ]);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state,
           classification, created_by, updated_by, created_at, updated_at
         ) VALUES
           ('insights-file-unset-shared', ?, NULL, 'unset-shared.pdf', 'application/pdf', 100, 'active', 'unset', ?, ?, ?, ?),
           ('insights-file-conf-shared', ?, NULL, 'conf-shared.pdf', 'application/pdf', 200, 'active', 'confidential', ?, ?, ?, ?),
           ('insights-file-unset-revoked', ?, NULL, 'unset-revoked.pdf', 'application/pdf', 100, 'active', 'unset', ?, ?, ?, ?),
           ('insights-file-unset-expired-link', ?, NULL, 'unset-expired.pdf', 'application/pdf', 100, 'active', 'unset', ?, ?, ?, ?),
           ('insights-file-unset-no-link', ?, NULL, 'unset-no-link.pdf', 'application/pdf', 100, 'active', 'unset', ?, ?, ?, ?),
           ('insights-file-public', ?, NULL, 'public.pdf', 'application/pdf', 100, 'active', 'public', ?, ?, ?, ?),
           ('insights-file-old', ?, NULL, 'old.pdf', 'application/pdf', 100, 'active', 'unset', ?, ?, ?, ?),
           ('insights-file-other', ?, NULL, 'other.pdf', 'application/pdf', 100, 'active', 'unset', ?, ?, ?, ?),
           ('insights-cron-file', ?, NULL, 'cron.pdf', 'application/pdf', 1000, 'active', 'internal', ?, ?, '2026-11-10T01:00:00.000Z', '2026-11-10T01:00:00.000Z'),
           ('insights-cron-file-old', ?, NULL, 'cron-old.pdf', 'application/pdf', 1000, 'active', 'internal', ?, ?, '2026-11-09T01:00:00.000Z', '2026-11-09T01:00:00.000Z')`
      ).bind(
        TENANT,
        MEMBER,
        MEMBER,
        TODAY_START,
        TODAY_START,
        TENANT,
        MEMBER,
        MEMBER,
        TODAY_START,
        TODAY_START,
        TENANT,
        MEMBER,
        MEMBER,
        TODAY_START,
        TODAY_START,
        TENANT,
        MEMBER,
        MEMBER,
        TODAY_START,
        TODAY_START,
        TENANT,
        MEMBER,
        MEMBER,
        TODAY_START,
        TODAY_START,
        TENANT,
        MEMBER,
        MEMBER,
        TODAY_START,
        TODAY_START,
        TENANT,
        MEMBER,
        MEMBER,
        ago(10 * DAY_MS),
        ago(10 * DAY_MS),
        OTHER_TENANT,
        OTHER_MEMBER,
        OTHER_MEMBER,
        TODAY_START,
        TODAY_START,
        CRON_TENANT,
        CRON_MEMBER,
        CRON_MEMBER,
        CRON_TENANT,
        CRON_MEMBER,
        CRON_MEMBER
      ),
      env.DB.prepare(
        `INSERT INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           created_by, created_at, expires_at, revoked_at
         ) VALUES
           ('insights-sl-unset-1', ?, 'insights-hash-unset-1', 'file', 'insights-file-unset-shared', 'company_only', ?, ?, NULL, NULL),
           ('insights-sl-unset-2', ?, 'insights-hash-unset-2', 'file', 'insights-file-unset-shared', 'company_only', ?, ?, NULL, NULL),
           ('insights-sl-conf', ?, 'insights-hash-conf', 'file', 'insights-file-conf-shared', 'company_only', ?, ?, NULL, NULL),
           ('insights-sl-public', ?, 'insights-hash-public', 'file', 'insights-file-public', 'public', ?, ?, NULL, NULL),
           ('insights-sl-folder', ?, 'insights-hash-folder', 'folder', 'insights-folder', 'company_only', ?, ?, NULL, NULL),
           ('insights-sl-revoked', ?, 'insights-hash-revoked', 'file', 'insights-file-unset-revoked', 'company_only', ?, ?, NULL, ?),
           ('insights-sl-expired', ?, 'insights-hash-expired', 'file', 'insights-file-unset-expired-link', 'company_only', ?, ?, ?, NULL),
           ('insights-sl-other', ?, 'insights-hash-other', 'file', 'insights-file-other', 'company_only', ?, ?, NULL, NULL),
           ('insights-sl-cron', ?, 'insights-hash-cron', 'file', 'insights-cron-file', 'company_only', ?, '2026-11-10T02:00:00.000Z', NULL, NULL)`
      ).bind(
        TENANT,
        MEMBER,
        TODAY_START,
        TENANT,
        MEMBER,
        TODAY_START,
        TENANT,
        MEMBER,
        TODAY_START,
        TENANT,
        MEMBER,
        TODAY_START,
        TENANT,
        MEMBER,
        TODAY_START,
        TENANT,
        MEMBER,
        TODAY_START,
        ago(90 * 60_000),
        TENANT,
        MEMBER,
        TODAY_START,
        ago(1 * HOUR_MS),
        OTHER_TENANT,
        OTHER_MEMBER,
        '2026-11-10T00:00:00.000Z',
        CRON_TENANT,
        CRON_MEMBER
      ),
      env.DB.prepare(
        `INSERT INTO active_file_locks (
           file_id, tenant_id, mode, lock_id, owner_id, owner_name,
           owner_email, expires_at, updated_at
         ) VALUES
           ('insights-file-unset-shared', ?, 'desktop_exclusive', 'insights-lock-active', ?, 'Member', 'member@insights.example.com', ?, ?),
           ('insights-file-conf-shared', ?, 'wopi_collab', 'insights-lock-expired', ?, 'Member', 'member@insights.example.com', ?, ?),
           ('insights-file-other', ?, 'desktop_exclusive', 'insights-lock-other', ?, 'Other', 'other-member@insights.example.com', ?, ?)`
      ).bind(
        TENANT,
        MEMBER,
        future(1 * HOUR_MS),
        ago(1 * HOUR_MS),
        TENANT,
        MEMBER,
        TODAY_START,
        TODAY_START,
        OTHER_TENANT,
        OTHER_MEMBER,
        future(1 * HOUR_MS),
        ago(1 * HOUR_MS)
      ),
      env.DB.prepare(
        `INSERT INTO sessions (
           id, tenant_id, user_id, token_hash, expires_at, revoked_at
         ) VALUES
           ('insights-sess-1', ?, ?, 'insights-token-1', ?, NULL),
           ('insights-sess-2', ?, ?, 'insights-token-2', ?, NULL),
           ('insights-sess-expired', ?, ?, 'insights-token-3', ?, NULL),
           ('insights-sess-revoked', ?, ?, 'insights-token-4', ?, ?),
           ('insights-sess-other', ?, ?, 'insights-token-5', ?, NULL)`
      ).bind(
        TENANT,
        SYS,
        future(2 * HOUR_MS),
        TENANT,
        MEMBER,
        future(3 * HOUR_MS),
        TENANT,
        MEMBER,
        ago(1 * HOUR_MS),
        TENANT,
        MEMBER,
        future(2 * HOUR_MS),
        ago(1 * HOUR_MS),
        OTHER_TENANT,
        OTHER_MEMBER,
        future(2 * HOUR_MS)
      ),
    ]);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_logs (
           id, tenant_id, actor_id, actor_email, action, target_type,
           target_id, status, created_at
         ) VALUES
           ('insights-audit-ip', ?, ?, 'sys@insights.example.com', 'auth.ip_blocked', 'auth', '/api/admin/insights', 'blocked', ?),
           ('insights-audit-pw-fail', ?, ?, 'member@insights.example.com', 'shared_link.password_failed', 'file', 'insights-file-public', 'blocked', ?),
           ('insights-audit-pw-lock', ?, ?, 'member@insights.example.com', 'shared_link.password_locked', 'file', 'insights-file-public', 'blocked', ?),
           ('insights-audit-domain', ?, ?, 'sys@insights.example.com', 'auth.sso_domain_blocked', 'auth', '/auth/login', 'blocked', ?),
           ('insights-audit-download-block', ?, ?, 'member@insights.example.com', 'shared_link.download_blocked', 'file', 'insights-file-public', 'blocked', ?),
           ('insights-audit-content', ?, ?, 'member@insights.example.com', 'file.content_access_denied', 'file', 'insights-file-conf-shared', 'blocked', ?),
           ('insights-audit-old-block', ?, ?, 'sys@insights.example.com', 'auth.ip_blocked', 'auth', '/api/admin/insights', 'blocked', ?),
           ('insights-audit-download', ?, ?, 'member@insights.example.com', 'file.download', 'file', 'insights-file-public', 'allowed', ?),
           ('insights-audit-version-download', ?, ?, 'sys@insights.example.com', 'file.version.download', 'file', 'insights-file-public', 'allowed', ?),
           ('insights-audit-guest', ?, ?, 'guest@partner.example', 'guest.access', 'file', 'insights-file-public', 'allowed', ?),
           ('insights-audit-shared-download', ?, ?, 'member@insights.example.com', 'shared_link.download', 'file', 'insights-file-public', 'allowed', ?),
           ('insights-audit-old-download', ?, ?, 'member@insights.example.com', 'file.download', 'file', 'insights-file-public', 'allowed', ?),
           ('insights-audit-other', ?, ?, 'other-member@insights.example.com', 'auth.ip_blocked', 'auth', '/api/admin/insights', 'blocked', ?)`
      ).bind(
        TENANT,
        SYS,
        TODAY_START,
        TENANT,
        MEMBER,
        TODAY_START,
        TENANT,
        MEMBER,
        ago(25 * HOUR_MS),
        TENANT,
        SYS,
        ago(3 * DAY_MS),
        TENANT,
        MEMBER,
        ago(6 * DAY_MS),
        TENANT,
        MEMBER,
        ago(10 * DAY_MS),
        TENANT,
        SYS,
        ago(40 * DAY_MS),
        TENANT,
        MEMBER,
        TODAY_START,
        TENANT,
        SYS,
        TODAY_START,
        TENANT,
        GUEST,
        TODAY_START,
        TENANT,
        MEMBER,
        TODAY_START,
        TENANT,
        MEMBER,
        ago(8 * DAY_MS),
        OTHER_TENANT,
        OTHER_MEMBER,
        ago(1 * HOUR_MS)
      ),
      env.DB.prepare(
        `INSERT INTO audit_logs (
           id, tenant_id, actor_id, actor_email, action, target_type,
           target_id, status, created_at
         ) VALUES
           ('insights-audit-cron-download', ?, ?, 'cron-member@insights.example.com', 'file.download', 'file', 'insights-cron-file', 'allowed', '2026-11-10T03:00:00.000Z'),
           ('insights-audit-cron-blocked', ?, ?, 'cron-sec@insights.example.com', 'auth.ip_blocked', 'auth', '/api/admin/insights', 'blocked', '2026-11-10T04:00:00.000Z'),
           ('insights-audit-cron-old', ?, ?, 'cron-member@insights.example.com', 'file.download', 'file', 'insights-cron-file', 'allowed', '2026-11-09T03:00:00.000Z')`
      ).bind(
        CRON_TENANT,
        CRON_MEMBER,
        CRON_TENANT,
        CRON_SEC,
        CRON_TENANT,
        CRON_MEMBER
      ),
      env.DB.prepare(
        `INSERT INTO tenant_daily_insights (
           tenant_id, day_utc, active_users_count, active_guests_count,
           new_files_count, downloads_count, shared_links_created_count,
           blocked_audit_count, used_bytes_snapshot, total_files_snapshot,
           updated_at
         ) VALUES
           (?, ?, 5, 1, 3, 4, 2, 1, 1500, 7, ?),
           (?, ?, 4, 0, 2, 3, 1, 2, 1200, 6, ?)`
      ).bind(
        TENANT,
        YESTERDAY,
        ago(24 * HOUR_MS),
        TENANT,
        TWO_DAYS_AGO,
        ago(48 * HOUR_MS)
      ),
    ]);
  });

  it('returns 7-day storage, security and collaboration KPIs with gap-free trends', async () => {
    const body = await getInsights(7);

    expect(body.rangeDays).toBe(7);
    expect(body.storage).toMatchObject({
      quotaBytes: 10000,
      usedBytes: 1800,
      remainingBytes: 8200,
      totalFiles: 5,
    });
    expect(body.storage.byClassification).toEqual({
      confidential: { fileCount: 1, totalBytes: 900 },
      internal: { fileCount: 1, totalBytes: 500 },
      public: { fileCount: 1, totalBytes: 100 },
      unset: { fileCount: 2, totalBytes: 300 },
    });
    expect(
      body.storage.d1EstimatedBytes === null ||
        typeof body.storage.d1EstimatedBytes === 'number'
    ).toBe(true);

    // The legacy O(1) storage endpoint and the insights payload must stay
    // byte-for-byte compatible so both admin views report the same numbers.
    const storageRes = await call('/api/admin/storage-stats');
    expect(storageRes.status).toBe(200);
    expect(await storageRes.json()).toEqual(body.storage);

    expect(body.security).toMatchObject({
      blocked7dCount: 5,
      blocked30dCount: 6,
      blockedRecentCount: 5,
      unsetSharedFilesCount: 1,
      activeSharedLinksCount: 5,
      publicSharedLinksCount: 1,
      activeFileLocksCount: 1,
      expiringGuestsCount: 1,
    });
    expect(byAction(body)).toEqual({
      'auth.ip_blocked': 1,
      'auth.sso_domain_blocked': 1,
      'shared_link.download_blocked': 1,
      'shared_link.password_failed': 1,
      'shared_link.password_locked': 1,
    });
    expect(body.collaboration).toEqual({
      activeMembers: 3,
      suspendedMembers: 1,
      activeGuests: 2,
      expiringGuests72h: 1,
      groupsCount: 2,
      activeSessionsCount: 2,
    });

    expect(body.trends).toHaveLength(7);
    expect(body.trends.map((point) => point.day)).toEqual(
      Array.from({ length: 7 }, (_, index) =>
        addUtcDays(TODAY, -(6 - index))
      )
    );
    expect(body.trends[4]).toMatchObject({
      day: TWO_DAYS_AGO,
      activeUsers: 4,
      activeGuests: 0,
      newFiles: 2,
      downloads: 3,
      sharedLinksCreated: 1,
      blockedAudits: 2,
      usedBytesSnapshot: 1200,
      totalFilesSnapshot: 6,
    });
    expect(body.trends[5]).toMatchObject({
      day: YESTERDAY,
      activeUsers: 5,
      activeGuests: 1,
      newFiles: 3,
      downloads: 4,
      sharedLinksCreated: 2,
      blockedAudits: 1,
      usedBytesSnapshot: 1500,
      totalFilesSnapshot: 7,
    });
    // Today is composed from the lightweight boundary queries, not a stored
    // row, so the current day is never stale by one Cron run.
    expect(body.trends[6]).toMatchObject({
      day: TODAY,
      activeUsers: 2,
      activeGuests: 1,
      newFiles: 6,
      downloads: 3,
      sharedLinksCreated: 7,
      blockedAudits: 2,
      usedBytesSnapshot: 1800,
      totalFilesSnapshot: 5,
    });
  });

  it('supports the 30-day window without changing tenant isolation', async () => {
    const body = await getInsights(30);

    expect(body.rangeDays).toBe(30);
    expect(body.trends).toHaveLength(30);
    expect(body.trends[body.trends.length - 1]?.day).toBe(TODAY);
    expect(body.security.blockedRecentCount).toBe(6);
    expect(body.security.blocked7dCount).toBe(5);
    expect(body.security.blocked30dCount).toBe(6);
    expect(byAction(body)['file.content_access_denied']).toBe(1);

    const other = await getInsights(7, {
      userId: OTHER_SYS,
      tenantId: OTHER_TENANT,
    });
    expect(other.storage).toMatchObject({
      quotaBytes: 5000,
      usedBytes: 100,
      remainingBytes: 4900,
      totalFiles: 1,
    });
    expect(other.storage.byClassification.unset).toEqual({
      fileCount: 0,
      totalBytes: 0,
    });
    expect(other.security.blocked7dCount).toBe(1);
    expect(other.security.blocked30dCount).toBe(1);
    expect(other.security.unsetSharedFilesCount).toBe(1);
    expect(other.security.activeSharedLinksCount).toBe(1);
    expect(other.security.publicSharedLinksCount).toBe(0);
    expect(other.security.activeFileLocksCount).toBe(1);
    expect(other.collaboration).toMatchObject({
      activeMembers: 2,
      suspendedMembers: 0,
      activeGuests: 0,
      groupsCount: 1,
      activeSessionsCount: 1,
    });
    expect(byAction(other)).toEqual({ 'auth.ip_blocked': 1 });
  });

  it('rejects members, guests and invalid range parameters', async () => {
    const member = await call('/api/admin/insights?days=7', MEMBER, {
      role: 'member',
    });
    expect(member.status).toBe(403);

    const guest = await call('/api/admin/insights?days=7', GUEST, {
      role: 'member',
      userType: 'guest',
      expiresAt: future(48 * HOUR_MS),
    });
    expect(guest.status).toBe(403);

    const invalid = await call('/api/admin/insights?days=90');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: 'days must be 7 or 30',
      code: 'INVALID_INSIGHTS_RANGE',
    });
  });

  it('upserts the daily aggregate idempotently with an O(1) storage snapshot', async () => {
    const first = await aggregateTenantDailyInsights(
      env.DB,
      CRON_TENANT,
      CRON_DAY,
      CRON_NOW
    );
    expect(first).toMatchObject({
      tenantId: CRON_TENANT,
      dayUtc: CRON_DAY,
      activeUsersCount: 2,
      activeGuestsCount: 0,
      newFilesCount: 1,
      downloadsCount: 1,
      sharedLinksCreatedCount: 1,
      blockedAuditCount: 1,
      usedBytesSnapshot: 1234,
      totalFilesSnapshot: 2,
      updatedAt: CRON_NOW.toISOString(),
    });

    const second = await aggregateTenantDailyInsights(
      env.DB,
      CRON_TENANT,
      CRON_DAY,
      CRON_NOW
    );
    expect(second).toEqual(first);

    const rows = await env.DB.prepare(
      `SELECT * FROM tenant_daily_insights
        WHERE tenant_id = ? AND day_utc = ?`
    )
      .bind(CRON_TENANT, CRON_DAY)
      .all<{
        active_users_count: number;
        active_guests_count: number;
        new_files_count: number;
        downloads_count: number;
        shared_links_created_count: number;
        blocked_audit_count: number;
        used_bytes_snapshot: number;
        total_files_snapshot: number;
        updated_at: string;
      }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      active_users_count: 2,
      active_guests_count: 0,
      new_files_count: 1,
      downloads_count: 1,
      shared_links_created_count: 1,
      blocked_audit_count: 1,
      used_bytes_snapshot: 1234,
      total_files_snapshot: 2,
      updated_at: CRON_NOW.toISOString(),
    });

    const refreshed = await aggregateTenantDailyInsights(
      env.DB,
      CRON_TENANT,
      CRON_DAY,
      new Date(CRON_NOW.getTime() + HOUR_MS)
    );
    expect(refreshed.updatedAt).toBe(
      new Date(CRON_NOW.getTime() + HOUR_MS).toISOString()
    );
    expect(
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM tenant_daily_insights
            WHERE tenant_id = ? AND day_utc = ?`
        )
          .bind(CRON_TENANT, CRON_DAY)
          .first<{ count: number }>()
      )?.count
    ).toBe(1);
  });

  it('runs the daily maintenance aggregation for yesterday and today', async () => {
    const summary = await runDailyMaintenance(buildTestEnv(), CRON_NOW);
    expect(summary.insightTenantsAggregated).toBeGreaterThanOrEqual(3);
    expect(summary.insightDaysAggregated).toBe(
      summary.insightTenantsAggregated * 2
    );

    const rows = await env.DB.prepare(
      `SELECT day_utc, new_files_count, downloads_count,
              shared_links_created_count, blocked_audit_count,
              used_bytes_snapshot, total_files_snapshot
         FROM tenant_daily_insights
        WHERE tenant_id = ?
        ORDER BY day_utc ASC`
    )
      .bind(CRON_TENANT)
      .all<{
        day_utc: string;
        new_files_count: number;
        downloads_count: number;
        shared_links_created_count: number;
        blocked_audit_count: number;
        used_bytes_snapshot: number;
        total_files_snapshot: number;
      }>();
    const yesterday = rows.results.find((row) => row.day_utc === CRON_DAY);
    expect(yesterday).toMatchObject({
      new_files_count: 1,
      downloads_count: 1,
      shared_links_created_count: 1,
      blocked_audit_count: 1,
      used_bytes_snapshot: 1234,
      total_files_snapshot: 2,
    });
    const today = rows.results.find(
      (row) => row.day_utc === '2026-11-11'
    );
    expect(today).toMatchObject({
      new_files_count: 0,
      downloads_count: 0,
      shared_links_created_count: 0,
      blocked_audit_count: 0,
      used_bytes_snapshot: 1234,
      total_files_snapshot: 2,
    });

    // The Cron path is also reachable through the Worker scheduled handler.
    const ctx = createExecutionContext();
    await expect(
      worker.scheduled?.(
        {
          cron: '0 3 * * *',
          scheduledTime: CRON_NOW.getTime(),
          noRetry: () => {},
        },
        buildTestEnv(),
        ctx
      )
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });

  it('never full-scans files, audit_logs or shared_links in any insights query', async () => {
    for (const days of [7, 30] as const) {
      const queries = buildAdminInsightsQueries({
        tenantId: TENANT,
        rangeDays: days,
        now: API_NOW,
      });
      expect(queries.length).toBeGreaterThan(10);

      const plans = new Map<string, string[]>();
      for (const query of queries) {
        const plan = await env.DB.prepare(
          `EXPLAIN QUERY PLAN ${query.sql}`
        )
          .bind(...query.binds)
          .all<{ detail: string }>();
        plans.set(
          query.name,
          plan.results.map((row) => row.detail)
        );
      }

      for (const [name, details] of plans) {
        const fullScan = details.find(
          (detail) =>
            /^SCAN (files|audit_logs|shared_links)\b/.test(detail) &&
            !detail.includes('USING')
        );
        expect(
          fullScan,
          `${days}d ${name} must not full-scan a large table: ${details.join(' | ')}`
        ).toBeUndefined();
      }

      expect(plans.get('storageStats')?.join(' | ')).toContain(
        'tenant_storage_stats'
      );
      expect(plans.get('blockedCounts')?.join(' | ')).toContain(
        'idx_audit_logs_blocked'
      );
      expect(plans.get('blockedByAction')?.join(' | ')).toContain(
        'idx_audit_logs_blocked'
      );
      expect(plans.get('unsetSharedFiles')?.join(' | ')).toContain(
        'idx_shared_links_tenant_active'
      );
      expect(plans.get('activeSharedLinks')?.join(' | ')).toContain(
        'idx_shared_links_tenant_active'
      );
      expect(plans.get('activeFileLocks')?.join(' | ')).toContain(
        'idx_active_file_locks_tenant_exp'
      );
      expect(plans.get('activeSessions')?.join(' | ')).toContain(
        'idx_sessions_tenant_active'
      );
      expect(plans.get('dailyTrends')?.join(' | ')).toContain(
        'tenant_daily_insights'
      );
      expect(plans.get('today.newFiles')?.join(' | ')).toContain(
        'idx_files_active_created'
      );
      expect(plans.get('today.auditMetrics')?.join(' | ')).toContain(
        'idx_audit_logs_tenant_time'
      );
      expect(plans.get('today.sharedLinksCreated')?.join(' | ')).toContain(
        'idx_shared_links_tenant_created'
      );
      expect(plans.get('today.activeUsers')?.join(' | ')).toContain(
        'idx_audit_logs_tenant_time'
      );
    }
  });
});
