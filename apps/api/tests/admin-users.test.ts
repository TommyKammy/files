import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-admin-users';
const OTHER_TENANT = 'tenant-admin-users-other';
const SOLO_TENANT = 'tenant-admin-users-solo';
const SYS = 'au-sys';
const SYS2 = 'au-sys-2';
const SEC = 'au-sec';
const MEMBER_A = 'au-member-a';
const MEMBER_B = 'au-member-b';
const GUEST = 'au-guest';
const QUOTA_USER = 'au-quota-user';
const SOLO_SYS = 'au-solo-sys';
const VIRTUAL_ADMIN = 'au-virtual-sys';
const APP_ORIGIN = 'http://127.0.0.1:8787';

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
    LOCAL_PROXY_SECRET: 'test-hmac-proxy-secret',
    DEFAULT_TENANT_ID: TENANT,
    JOBS_QUEUE: { send: async () => undefined },
  } as unknown as OidcEnv;
}

function headers(
  userId: string,
  role: UserRole = 'member',
  tenantId = TENANT,
  userType: UserType = 'member'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@example.com`,
    'X-Dev-User-Type': userType,
    'Content-Type': 'application/json',
    Origin: APP_ORIGIN,
  };
}

async function call<T = Record<string, unknown>>(
  path: string,
  userId: string,
  options: {
    method?: string;
    body?: unknown;
    role?: UserRole;
    tenantId?: string;
    userType?: UserType;
    extraHeaders?: Record<string, string>;
    rawBody?: BodyInit;
  } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...headers(
          userId,
          options.role ?? 'member',
          options.tenantId ?? TENANT,
          options.userType ?? 'member'
        ),
        ...(options.extraHeaders ?? {}),
      },
      body:
        options.rawBody !== undefined
          ? options.rawBody
          : options.body !== undefined
            ? JSON.stringify(options.body)
            : undefined,
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

async function uploadFile(
  userId: string,
  fileName: string,
  sizeBytes: number
): Promise<{
  initStatus: number;
  initBody: Record<string, unknown>;
  completeStatus: number;
  completeBody: Record<string, unknown>;
}> {
  const init = await call<{
    fileId: string;
    versionId: string;
    uploadUrl: string;
  }>('/api/files/upload-init', userId, {
    method: 'POST',
    body: {
      folderId: 'au-quota-folder',
      fileName,
      mimeType: 'text/plain',
      sizeBytes,
    },
  });
  if (init.status !== 201) {
    return {
      initStatus: init.status,
      initBody: init.body as Record<string, unknown>,
      completeStatus: 0,
      completeBody: {},
    };
  }
  const put = await app.fetch(
    new Request(`${APP_ORIGIN}${init.body.uploadUrl}`, {
      method: 'PUT',
      body: new Uint8Array(sizeBytes),
    }),
    buildTestEnv()
  );
  expect(put.status).toBe(200);
  const complete = await call<Record<string, unknown>>(
    '/api/files/upload-complete',
    userId,
    {
      method: 'POST',
      body: {
        fileId: init.body.fileId,
        versionId: init.body.versionId,
      },
    }
  );
  return {
    initStatus: init.status,
    initBody: init.body as unknown as Record<string, unknown>,
    completeStatus: complete.status,
    completeBody: complete.body,
  };
}

describe('P11-2 / TOM-64 admin internal member administration', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug)
         VALUES (?, 'Admin Users', 'admin-users'),
                (?, 'Other Admin Users', 'admin-users-other'),
                (?, 'Solo Admin Users', 'admin-users-solo')`
      ).bind(TENANT, OTHER_TENANT, SOLO_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id)
         VALUES (?), (?), (?)`
      ).bind(TENANT, OTHER_TENANT, SOLO_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (
           id, tenant_id, email, display_name, department, role, status,
           user_type, storage_quota_bytes
         ) VALUES
           (?, ?, 'au-sys@example.com', 'Admin Users Sys', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'au-sys-2@example.com', 'Admin Users Sys Two', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'au-sec@example.com', 'Admin Users Sec', 'Security', 'sec_admin', 'active', 'member', NULL),
           (?, ?, 'au-member-a@example.com', 'Member Alpha', 'Engineering', 'member', 'active', 'member', NULL),
           (?, ?, 'au-member-b@example.com', 'Member Bravo', 'Sales', 'member', 'suspended', 'member', NULL),
           (?, ?, 'au-quota-user@example.com', 'Quota User', 'Engineering', 'member', 'active', 'member', NULL),
           (?, ?, 'au-guest@example.com', 'Guest User', 'Partner', 'member', 'active', 'guest', NULL),
           (?, ?, 'au-other@example.com', 'Other Tenant User', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'au-solo-sys@example.com', 'Solo Sys', 'IT', 'sys_admin', 'active', 'member', NULL)`
      ).bind(
        SYS,
        TENANT,
        SYS2,
        TENANT,
        SEC,
        TENANT,
        MEMBER_A,
        TENANT,
        MEMBER_B,
        TENANT,
        QUOTA_USER,
        TENANT,
        GUEST,
        TENANT,
        'au-other-sys',
        OTHER_TENANT,
        SOLO_SYS,
        SOLO_TENANT
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO user_storage_stats (
           tenant_id, user_id, file_count, total_bytes, updated_at
         ) VALUES
           (?, ?, 5, 5000, '2026-11-01T00:00:00.000Z'),
           (?, ?, 2, 1000, '2026-11-01T00:00:00.000Z'),
           (?, ?, 0, 0, '2026-11-01T00:00:00.000Z')`
      ).bind(
        TENANT,
        MEMBER_A,
        TENANT,
        MEMBER_B,
        TENANT,
        QUOTA_USER
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification, created_by
         ) VALUES
           ('au-member-root', ?, NULL, 'Alpha Root', 0, 1, 'internal', ?),
           ('au-quota-folder', ?, NULL, 'Quota Folder', 0, 1, 'internal', ?)`
      ).bind(TENANT, MEMBER_A, TENANT, QUOTA_USER),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, 'au-member-root', 'au-member-root', 0),
                (?, 'au-quota-folder', 'au-quota-folder', 0)`
      ).bind(TENANT, TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by
         ) VALUES
           ('au-perm-root', ?, 'folder', 'au-member-root', 'user', ?, 'owner', ?),
           ('au-perm-quota', ?, 'folder', 'au-quota-folder', 'user', ?, 'editor', ?)`
      ).bind(TENANT, MEMBER_A, SYS, TENANT, QUOTA_USER, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO groups (id, tenant_id, name)
         VALUES ('au-group-eng', ?, 'Engineering Group')`
      ).bind(TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, user_id)
         VALUES ('au-group-eng', ?)`
      ).bind(MEMBER_A),
      env.DB.prepare(
        `INSERT OR IGNORE INTO sessions (
           id, tenant_id, user_id, token_hash, ip_address, user_agent,
           expires_at, revoked_at, created_at
         ) VALUES
           ('au-session-1', ?, ?, 'au-token-1', '127.0.0.1', 'vitest',
            '2099-01-01T00:00:00.000Z', NULL, '2026-11-01T00:00:00.000Z'),
           ('au-session-2', ?, ?, 'au-token-2', '127.0.0.1', 'vitest',
            '2099-01-01T00:00:00.000Z', NULL, '2026-11-01T00:00:00.000Z'),
           ('au-session-3', ?, ?, 'au-token-3', '127.0.0.1', 'vitest',
            '2099-01-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z',
            '2026-11-01T00:00:00.000Z')`
      ).bind(TENANT, MEMBER_A, TENANT, MEMBER_A, TENANT, MEMBER_A),
    ]);
  });

  it('lists members with search, role/status/department filters, sorting and CSV export', async () => {
    const list = await call<{
      users: Array<{
        id: string;
        email: string;
        displayName: string;
        department: string | null;
        role: UserRole;
        status: string;
        usedBytes: number;
        fileCount: number;
        storageQuotaBytes: number | null;
        lastLoginAt: string | null;
      }>;
      total: number;
      summary: {
        total: number;
        byStatus: Record<string, number>;
        byRole: Record<string, number>;
        departments: Array<{ department: string | null; count: number }>;
      };
    }>('/api/admin/users?limit=100', SEC, { role: 'sec_admin' });
    expect(list.status).toBe(200);
    expect(list.body.users.every((row) => row.email !== 'au-guest@example.com')).toBe(
      true
    );
    expect(list.body.users.map((row) => row.id)).toEqual(
      expect.arrayContaining([SYS, SEC, MEMBER_A, MEMBER_B, QUOTA_USER])
    );
    expect(list.body.summary.byRole.sys_admin).toBe(2);
    expect(list.body.summary.byRole.sec_admin).toBe(1);
    expect(list.body.summary.byStatus.active).toBeGreaterThanOrEqual(5);
    expect(list.body.summary.byStatus.suspended).toBe(1);
    expect(
      list.body.summary.departments.map((row) => row.department)
    ).toEqual(expect.arrayContaining(['Engineering', 'Sales']));
    const alpha = list.body.users.find((row) => row.id === MEMBER_A);
    expect(alpha).toMatchObject({
      email: 'au-member-a@example.com',
      department: 'Engineering',
      role: 'member',
      status: 'active',
      usedBytes: 5000,
      fileCount: 5,
      storageQuotaBytes: null,
    });

    const searched = await call<{ users: Array<{ id: string }> }>(
      '/api/admin/users?query=member-a',
      SEC,
      { role: 'sec_admin' }
    );
    expect(searched.body.users.map((row) => row.id)).toEqual([MEMBER_A]);

    const roleFiltered = await call<{
      users: Array<{ id: string; role: string }>;
    }>(
      '/api/admin/users?role=member&limit=100',
      SEC,
      { role: 'sec_admin' }
    );
    expect(roleFiltered.body.users.every((row) => row.role === 'member')).toBe(
      true
    );
    expect(roleFiltered.body.users.map((row) => row.id)).toContain(MEMBER_A);

    const suspended = await call<{ users: Array<{ id: string }> }>(
      '/api/admin/users?status=suspended',
      SEC,
      { role: 'sec_admin' }
    );
    expect(suspended.body.users.map((row) => row.id)).toEqual([MEMBER_B]);

    const engineering = await call<{ users: Array<{ id: string }> }>(
      '/api/admin/users?department=Engineering&limit=100',
      SEC,
      { role: 'sec_admin' }
    );
    expect(engineering.body.users.map((row) => row.id)).toEqual(
      expect.arrayContaining([MEMBER_A, QUOTA_USER])
    );

    const sorted = await call<{ users: Array<{ id: string; usedBytes: number }> }>(
      '/api/admin/users?sortBy=usedBytes&sortDir=desc&limit=100',
      SEC,
      { role: 'sec_admin' }
    );
    const used = sorted.body.users.map((row) => row.usedBytes);
    expect(used).toEqual([...used].sort((a, b) => b - a));

    const csv = await call('/api/admin/users?format=csv&limit=100', SEC, {
      role: 'sec_admin',
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('Content-Type')).toContain('text/csv');
    const csvText = (csv.body as unknown as { raw: string }).raw;
    expect(csvText.split('\n')[0]).toContain(
      'email,display_name,department,role,status'
    );
    expect(csvText).toContain('au-member-a@example.com');
    expect(csvText).not.toContain('au-guest@example.com');

    const invalid = await call('/api/admin/users?role=owner', SEC, {
      role: 'sec_admin',
    });
    expect(invalid.status).toBe(400);
    expect((invalid.body as { code: string }).code).toBe(
      'INVALID_MEMBER_ROLE_FILTER'
    );

    const memberForbidden = await call('/api/admin/users', MEMBER_A);
    expect(memberForbidden.status).toBe(403);
  });

  it('returns member detail with storage, root folders, groups and sessions', async () => {
    const detail = await call<{
      user: {
        id: string;
        email: string;
        department: string | null;
        role: string;
        status: string;
        storageQuotaBytes: number | null;
        usedBytes: number;
        fileCount: number;
        lastLoginAt: string | null;
        updatedAt: string;
      };
      rootFolders: Array<{ id: string; name: string }>;
      groups: Array<{ id: string; name: string }>;
      activeSessionCount: number;
      recentAuditLogs: Array<{ id: string; action: string }>;
    }>(`/api/admin/users/${MEMBER_A}`, SEC, { role: 'sec_admin' });
    expect(detail.status).toBe(200);
    expect(detail.body.user).toMatchObject({
      id: MEMBER_A,
      email: 'au-member-a@example.com',
      department: 'Engineering',
      role: 'member',
      status: 'active',
      storageQuotaBytes: null,
      usedBytes: 5000,
      fileCount: 5,
    });
    expect(detail.body.rootFolders.map((folder) => folder.id)).toContain(
      'au-member-root'
    );
    expect(detail.body.groups.map((group) => group.id)).toContain(
      'au-group-eng'
    );
    expect(detail.body.activeSessionCount).toBe(2);

    const guest = await call<{ code: string }>(
      `/api/admin/users/${GUEST}`,
      SEC,
      { role: 'sec_admin' }
    );
    expect(guest.status).toBe(404);
    expect(guest.body.code).toBe('NOT_INTERNAL_MEMBER');

    const otherTenant = await call(
      `/api/admin/users/au-other-sys`,
      SYS,
      { role: 'sys_admin' }
    );
    expect(otherTenant.status).toBe(404);

    const missing = await call<{ code: string }>(
      '/api/admin/users/not-a-member',
      SEC,
      { role: 'sec_admin' }
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('MEMBER_NOT_FOUND');
  });

  it('creates and updates members with sys_admin guards and audit logs', async () => {
    const forbidden = await call('/api/admin/users', SEC, {
      method: 'POST',
      role: 'sec_admin',
      body: {
        email: 'forbidden@example.com',
        displayName: 'Forbidden',
      },
    });
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { code: string }).code).toBe(
      'SYS_ADMIN_REQUIRED'
    );

    const created = await call<{
      ok: boolean;
      user: { id: string; email: string; status: string; role: string };
      notice: string;
    }>('/api/admin/users', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        email: 'New.Member@Example.com',
        displayName: 'New Member',
        department: 'Products',
        role: 'member',
        storageQuotaBytes: 2048,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({
      email: 'new.member@example.com',
      status: 'active',
      role: 'member',
    });
    expect(created.body.notice).toContain('登録しました');

    const duplicate = await call<{ code: string }>('/api/admin/users', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        email: 'NEW.MEMBER@example.com',
        displayName: 'Duplicate',
      },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_ALREADY_EXISTS');

    const duplicateGuest = await call<{ code: string }>(
      '/api/admin/users',
      SYS,
      {
        method: 'POST',
        role: 'sys_admin',
        body: {
          email: 'au-guest@example.com',
          displayName: 'Guest Duplicate',
        },
      }
    );
    expect(duplicateGuest.status).toBe(409);
    expect(duplicateGuest.body.code).toBe('EMAIL_ALREADY_EXISTS');

    const invalidQuota = await call('/api/admin/users', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        email: 'bad-quota@example.com',
        displayName: 'Bad Quota',
        storageQuotaBytes: 0,
      },
    });
    expect(invalidQuota.status).toBe(400);
    expect((invalidQuota.body as { code: string }).code).toBe(
      'INVALID_STORAGE_QUOTA'
    );

    const audit = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.user.create' AND target_id = ?`
    )
      .bind(TENANT, created.body.user.id)
      .first<{ action: string }>();
    expect(audit?.action).toBe('admin.user.create');

    const secUpdate = await call(`/api/admin/users/${created.body.user.id}`, SEC, {
      method: 'PATCH',
      role: 'sec_admin',
      body: { role: 'sec_admin' },
    });
    expect(secUpdate.status).toBe(403);
    expect((secUpdate.body as { code: string }).code).toBe(
      'SYS_ADMIN_REQUIRED'
    );

    const updated = await call<{
      user: {
        displayName: string;
        department: string;
        role: string;
        storageQuotaBytes: number | null;
        status: string;
      };
    }>(`/api/admin/users/${created.body.user.id}`, SYS, {
      method: 'PATCH',
      role: 'sys_admin',
      body: {
        displayName: 'Renamed Member',
        department: 'Sales',
        role: 'sec_admin',
        storageQuotaBytes: 4096,
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.user).toMatchObject({
      displayName: 'Renamed Member',
      department: 'Sales',
      role: 'sec_admin',
      storageQuotaBytes: 4096,
      status: 'active',
    });

    const cleared = await call<{
      user: { storageQuotaBytes: number | null };
    }>(`/api/admin/users/${created.body.user.id}`, SYS, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { storageQuotaBytes: null },
    });
    expect(cleared.body.user.storageQuotaBytes).toBeNull();

    const guestUpdate = await call<{ code: string }>(
      `/api/admin/users/${GUEST}`,
      SYS,
      {
        method: 'PATCH',
        role: 'sys_admin',
        body: { displayName: 'Guest Rename' },
      }
    );
    expect(guestUpdate.status).toBe(404);
    expect(guestUpdate.body.code).toBe('NOT_INTERNAL_MEMBER');

    const selfDemote = await call<{ code: string }>(
      `/api/admin/users/${SYS}`,
      SYS,
      {
        method: 'PATCH',
        role: 'sys_admin',
        body: { role: 'member' },
      }
    );
    expect(selfDemote.status).toBe(409);
    expect(selfDemote.body.code).toBe('CANNOT_SELF_MODIFY_PRIVILEGE');

    const lastAdmin = await call<{ code: string }>(
      `/api/admin/users/${SOLO_SYS}`,
      VIRTUAL_ADMIN,
      {
        method: 'PATCH',
        role: 'sys_admin',
        tenantId: SOLO_TENANT,
        body: { role: 'member' },
      }
    );
    expect(lastAdmin.status).toBe(409);
    expect(lastAdmin.body.code).toBe('LAST_SYS_ADMIN_REQUIRED');

    const noChange = await call<{ notice: string }>(
      `/api/admin/users/${MEMBER_A}`,
      SYS,
      {
        method: 'PATCH',
        role: 'sys_admin',
        body: { displayName: 'Member Alpha' },
      }
    );
    expect(noChange.status).toBe(200);
    expect(noChange.body.notice).toContain('変更はありません');
  });

  it('suspends and resumes members with session revocation, idempotency and RBAC', async () => {
    const key = 'au-suspend-key';
    const suspended = await call<{
      ok: boolean;
      user: { id: string; status: string };
      sessionsRevoked: number;
      syncSeq: number | null;
    }>(`/api/admin/users/${MEMBER_A}/suspend`, SEC, {
      method: 'POST',
      role: 'sec_admin',
      extraHeaders: { 'Idempotency-Key': key },
      body: { idempotencyKey: key },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.user.status).toBe('suspended');
    expect(suspended.body.sessionsRevoked).toBe(2);
    expect(suspended.body.syncSeq).not.toBeNull();

    const sessions = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM sessions
        WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
    )
      .bind(TENANT, MEMBER_A)
      .first<{ count: number }>();
    expect(sessions?.count).toBe(0);

    const sync = await env.DB.prepare(
      `SELECT action FROM sync_changes
        WHERE tenant_id = ? AND entity_id = ? AND action = 'user.suspended'
        ORDER BY seq DESC LIMIT 1`
    )
      .bind(TENANT, MEMBER_A)
      .first<{ action: string }>();
    expect(sync?.action).toBe('user.suspended');

    const audit = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.user.suspend' AND target_id = ?`
    )
      .bind(TENANT, MEMBER_A)
      .first<{ action: string }>();
    expect(audit?.action).toBe('admin.user.suspend');

    const replay = await call<{ replayed: boolean; sessionsRevoked: number }>(
      `/api/admin/users/${MEMBER_A}/suspend`,
      SEC,
      {
        method: 'POST',
        role: 'sec_admin',
        extraHeaders: { 'Idempotency-Key': key },
        body: { idempotencyKey: key },
      }
    );
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.sessionsRevoked).toBe(2);

    const resumed = await call<{ user: { status: string } }>(
      `/api/admin/users/${MEMBER_A}/resume`,
      SEC,
      { method: 'POST', role: 'sec_admin', body: {} }
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body.user.status).toBe('active');

    const secTargetsSys = await call<{ code: string }>(
      `/api/admin/users/${SYS2}/suspend`,
      SEC,
      { method: 'POST', role: 'sec_admin', body: {} }
    );
    expect(secTargetsSys.status).toBe(403);
    expect(secTargetsSys.body.code).toBe('SYS_ADMIN_REQUIRED');

    const secResumesSec = await call<{ code: string }>(
      `/api/admin/users/${SEC}/resume`,
      SEC,
      { method: 'POST', role: 'sec_admin', body: {} }
    );
    expect(secResumesSec.status).toBe(403);

    const selfSuspend = await call<{ code: string }>(
      `/api/admin/users/${SYS}/suspend`,
      SYS,
      { method: 'POST', role: 'sys_admin', body: {} }
    );
    expect(selfSuspend.status).toBe(409);
    expect(selfSuspend.body.code).toBe('CANNOT_SELF_MODIFY_PRIVILEGE');

    const guestSuspend = await call<{ code: string }>(
      `/api/admin/users/${GUEST}/suspend`,
      SYS,
      { method: 'POST', role: 'sys_admin', body: {} }
    );
    expect(guestSuspend.status).toBe(404);
    expect(guestSuspend.body.code).toBe('NOT_INTERNAL_MEMBER');

    const lastAdminSuspend = await call<{ code: string }>(
      `/api/admin/users/${SOLO_SYS}/suspend`,
      VIRTUAL_ADMIN,
      {
        method: 'POST',
        role: 'sys_admin',
        tenantId: SOLO_TENANT,
        body: {},
      }
    );
    expect(lastAdminSuspend.status).toBe(409);
    expect(lastAdminSuspend.body.code).toBe('LAST_SYS_ADMIN_REQUIRED');
  });

  it('bulk imports CSV with dryRun, idempotency, duplicate and privilege guards', async () => {
    const csv = [
      'email,displayName,department,role,storageQuotaBytes',
      'bulk-new@example.com,一括 新規,営業部,member,2048',
      'au-member-a@example.com,一括 更新,Engineering,member,',
    ].join('\n');

    const secForbidden = await call('/api/admin/users/bulk-import', SEC, {
      method: 'POST',
      role: 'sec_admin',
      body: { csv, dryRun: true },
    });
    expect(secForbidden.status).toBe(403);

    const preview = await call<{
      dryRun: boolean;
      createdCount: number;
      updatedCount: number;
      results: Array<{ email: string; action: string }>;
    }>('/api/admin/users/bulk-import', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: { csv, dryRun: true },
    });
    expect(preview.status).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    expect(preview.body.createdCount).toBe(1);
    expect(preview.body.updatedCount).toBe(1);
    expect(preview.body.results.map((row) => row.action)).toEqual([
      'create',
      'update',
    ]);
    const stillMissing = await env.DB.prepare(
      `SELECT id FROM users WHERE tenant_id = ? AND email = 'bulk-new@example.com'`
    )
      .bind(TENANT)
      .first();
    expect(stillMissing).toBeNull();
    const unchanged = await env.DB.prepare(
      `SELECT display_name FROM users WHERE tenant_id = ? AND id = ?`
    )
      .bind(TENANT, MEMBER_A)
      .first<{ display_name: string }>();
    expect(unchanged?.display_name).toBe('Member Alpha');

    const key = 'au-bulk-key';
    const executed = await call<{
      dryRun: boolean;
      replayed: boolean;
      createdCount: number;
      updatedCount: number;
      errorCount: number;
      syncSeq: number | null;
    }>('/api/admin/users/bulk-import', SYS, {
      method: 'POST',
      role: 'sys_admin',
      extraHeaders: { 'Idempotency-Key': key },
      body: { csv, idempotencyKey: key },
    });
    expect(executed.status).toBe(200);
    expect(executed.body).toMatchObject({
      dryRun: false,
      replayed: false,
      createdCount: 1,
      updatedCount: 1,
      errorCount: 0,
    });
    expect(executed.body.syncSeq).not.toBeNull();

    const createdRow = await env.DB.prepare(
      `SELECT id, display_name, department, role, storage_quota_bytes
         FROM users WHERE tenant_id = ? AND email = 'bulk-new@example.com'`
    )
      .bind(TENANT)
      .first<{
        id: string;
        display_name: string;
        department: string;
        role: string;
        storage_quota_bytes: number;
      }>();
    expect(createdRow).toMatchObject({
      display_name: '一括 新規',
      department: '営業部',
      role: 'member',
      storage_quota_bytes: 2048,
    });

    const bulkAudit = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.user.bulk_import'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(TENANT)
      .first<{ action: string }>();
    expect(bulkAudit?.action).toBe('admin.user.bulk_import');

    const replay = await call<{
      replayed: boolean;
      createdCount: number;
      updatedCount: number;
    }>('/api/admin/users/bulk-import', SYS, {
      method: 'POST',
      role: 'sys_admin',
      extraHeaders: { 'Idempotency-Key': key },
      body: { csv, idempotencyKey: key },
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      replayed: true,
      createdCount: 1,
      updatedCount: 1,
    });

    const duplicates = await call<{
      errorCount: number;
      results: Array<{ code?: string }>;
    }>('/api/admin/users/bulk-import', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        csv: [
          'email,displayName',
          'dup@example.com,Duplicate One',
          'DUP@example.com,Duplicate Two',
        ].join('\n'),
      },
    });
    expect(duplicates.status).toBe(200);
    expect(duplicates.body.errorCount).toBe(1);
    expect(duplicates.body.results.map((row) => row.code)).toEqual([
      undefined,
      'DUPLICATE_EMAIL_IN_IMPORT',
    ]);

    const guestRow = await call<{
      errorCount: number;
      results: Array<{ code?: string }>;
    }>('/api/admin/users/bulk-import', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        rows: [
          {
            email: 'au-guest@example.com',
            displayName: 'Guest Row',
          },
        ],
      },
    });
    expect(guestRow.status).toBe(200);
    expect(guestRow.body.errorCount).toBe(1);
    expect(guestRow.body.results[0]?.code).toBe('NOT_INTERNAL_MEMBER');

    const tooLarge = await call('/api/admin/users/bulk-import', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        csv: [
          'email,displayName',
          ...Array.from({ length: 201 }, (_, index) => `bulk-${index}@example.com,User ${index}`),
        ].join('\n'),
      },
    });
    expect(tooLarge.status).toBe(400);
    expect((tooLarge.body as { code: string }).code).toBe(
      'BULK_IMPORT_TOO_LARGE'
    );

    const selfDemote = await call<{
      errorCount: number;
      results: Array<{ code?: string }>;
    }>('/api/admin/users/bulk-import', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        rows: [{ email: 'au-sys@example.com', role: 'member' }],
      },
    });
    expect(selfDemote.status).toBe(200);
    expect(selfDemote.body.errorCount).toBe(1);
    expect(selfDemote.body.results[0]?.code).toBe(
      'CANNOT_SELF_MODIFY_PRIVILEGE'
    );

    const lastAdmin = await call<{
      errorCount: number;
      results: Array<{ code?: string }>;
    }>('/api/admin/users/bulk-import', VIRTUAL_ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      tenantId: SOLO_TENANT,
      body: {
        rows: [{ email: 'au-solo-sys@example.com', role: 'member' }],
      },
    });
    expect(lastAdmin.status).toBe(200);
    expect(lastAdmin.body.errorCount).toBe(1);
    expect(lastAdmin.body.results[0]?.code).toBe('LAST_SYS_ADMIN_REQUIRED');

    const invalidRows = await call<{
      errorCount: number;
      results: Array<{ code?: string }>;
    }>('/api/admin/users/bulk-import', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        rows: [
          { email: 'missing-name@example.com' },
          {
            email: 'invalid-quota@example.com',
            displayName: 'Invalid Quota',
            storageQuotaBytes: -5,
          },
        ],
      },
    });
    expect(invalidRows.status).toBe(200);
    expect(invalidRows.body.errorCount).toBe(2);
    expect(invalidRows.body.results.map((row) => row.code)).toEqual([
      'DISPLAY_NAME_REQUIRED',
      'INVALID_STORAGE_QUOTA',
    ]);
  });

  it('enforces personal storage quota only when storageQuotaBytes is set', async () => {
    const uploaded = await uploadFile(QUOTA_USER, 'quota-first.txt', 128);
    expect(uploaded.initStatus).toBe(201);
    expect(uploaded.completeStatus).toBe(200);

    const stats = await env.DB.prepare(
      `SELECT file_count, total_bytes FROM user_storage_stats
        WHERE tenant_id = ? AND user_id = ?`
    )
      .bind(TENANT, QUOTA_USER)
      .first<{ file_count: number; total_bytes: number }>();
    expect(stats).toEqual({ file_count: 1, total_bytes: 128 });

    await env.DB.prepare(
      `UPDATE users SET storage_quota_bytes = 200 WHERE tenant_id = ? AND id = ?`
    )
      .bind(TENANT, QUOTA_USER)
      .run();

    const rejected = await call<{ code: string }>(
      '/api/files/upload-init',
      QUOTA_USER,
      {
        method: 'POST',
        body: {
          folderId: 'au-quota-folder',
          fileName: 'quota-over.txt',
          mimeType: 'text/plain',
          sizeBytes: 300,
        },
      }
    );
    expect(rejected.status).toBe(413);
    expect(rejected.body.code).toBe('USER_QUOTA_EXCEEDED');

    const allowed = await call(
      '/api/files/upload-init',
      QUOTA_USER,
      {
        method: 'POST',
        body: {
          folderId: 'au-quota-folder',
          fileName: 'quota-under.txt',
          mimeType: 'text/plain',
          sizeBytes: 50,
        },
      }
    );
    expect(allowed.status).toBe(201);
  });
});
