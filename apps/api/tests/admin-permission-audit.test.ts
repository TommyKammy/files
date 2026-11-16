import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-audit';
const OTHER_TENANT = 'tenant-other-audit';

const USERS = {
  sys: 'audit-sys',
  sec: 'audit-sec',
  member: 'audit-member',
  owner: 'audit-owner',
  owner2: 'audit-owner2',
  suspended: 'audit-suspended',
  suspendedGrantor: 'audit-grantor-suspended',
  otherSys: 'other-audit-sys',
} as const;

function authHeaders(
  userId: string = USERS.sec,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'sec_admin',
  tenantId: string = TENANT
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@audit.example.com`,
    'Content-Type': 'application/json',
  };
}

const HEADERS = {
  sys: authHeaders(USERS.sys, 'sys_admin'),
  sec: authHeaders(USERS.sec, 'sec_admin'),
  member: authHeaders(USERS.member, 'member'),
};

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-audit-secret-001',
    SESSION_SECRET: 'test-session-audit-secret-001',
  } as OidcEnv;
}

async function call(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: options.method ?? 'GET',
      headers: options.headers ?? HEADERS.sec,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    buildTestEnv()
  );
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function requestHash(operation: string, payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson({ operation, payload }))
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function seed() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, 'Audit Org', 'audit-org')"
    ).bind(TENANT),
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, 'Other Org', 'other-org')"
    ).bind(OTHER_TENANT),
    env.DB.prepare(
      'INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)'
    ).bind(TENANT),
    env.DB.prepare(
      'INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)'
    ).bind(OTHER_TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
       VALUES
         (?, ?, 'audit-sys@audit.example.com', 'Audit Sys', 'sys_admin', 'active'),
         (?, ?, 'audit-sec@audit.example.com', 'Audit Sec', 'sec_admin', 'active'),
         (?, ?, 'audit-member@audit.example.com', 'Audit Member', 'member', 'active'),
         (?, ?, 'audit-owner@audit.example.com', 'Audit Owner', 'member', 'active'),
         (?, ?, 'audit-owner2@audit.example.com', 'Audit Owner Two', 'member', 'active'),
         (?, ?, 'audit-suspended@audit.example.com', 'Suspended Owner', 'member', 'suspended'),
         (?, ?, 'audit-grantor-suspended@audit.example.com', 'Suspended Grantor', 'sec_admin', 'suspended')`
    ).bind(
      USERS.sys,
      TENANT,
      USERS.sec,
      TENANT,
      USERS.member,
      TENANT,
      USERS.owner,
      TENANT,
      USERS.owner2,
      TENANT,
      USERS.suspended,
      TENANT,
      USERS.suspendedGrantor,
      TENANT
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
       VALUES (?, ?, 'other-sys@audit.example.com', 'Other Sys', 'sys_admin', 'active')`
    ).bind(USERS.otherSys, OTHER_TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO groups (id, tenant_id, name) VALUES
         ('audit-group', ?, 'Audit Collaborators'),
         ('audit-group-2', ?, 'Audit Collaborators Two'),
         ('audit-formula', ?, '=SUM(1,1)')`
    ).bind(TENANT, TENANT, TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO groups (id, tenant_id, name)
       VALUES ('other-audit-group', ?, 'Other Tenant Group')`
    ).bind(OTHER_TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO group_members (group_id, user_id)
       VALUES ('audit-group', ?)`
    ).bind(USERS.member),
    env.DB.prepare(
      `INSERT OR IGNORE INTO folders
         (id, tenant_id, parent_id, name, depth, version, classification, created_by, deleted_at)
       VALUES
         ('audit-root-a', ?, NULL, 'Audit Root A', 0, 1, 'internal', ?, NULL),
         ('audit-child-a', ?, 'audit-root-a', 'Audit Child A', 1, 1, 'internal', ?, NULL),
         ('audit-subchild-a', ?, 'audit-child-a', 'Audit SubChild A', 2, 1, 'internal', ?, NULL),
         ('audit-root-b', ?, NULL, 'Audit Root B', 0, 1, 'confidential', ?, NULL),
         ('audit-root-c', ?, NULL, 'Audit Root C', 0, 1, 'unset', ?, NULL),
         ('audit-root-archived', ?, NULL, 'Audit Root Archived', 0, 1, 'internal', ?, ?),
         ('audit-root-deleted-owner', ?, NULL, 'Audit Root Deleted Owner', 0, 1, 'internal', ?, NULL),
         ('audit-root-sole', ?, NULL, 'Audit Root Sole', 0, 1, 'internal', ?, NULL)`
    ).bind(
      TENANT,
      USERS.sys,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.sys,
      now,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.sys
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO folders
         (id, tenant_id, parent_id, name, depth, version, classification, created_by)
       VALUES ('other-audit-root', ?, NULL, 'Other Tenant Root', 0, 1, 'internal', ?)`
    ).bind(OTHER_TENANT, USERS.otherSys),
    env.DB.prepare(
      `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       VALUES
         (?, 'audit-root-a', 'audit-root-a', 0),
         (?, 'audit-root-a', 'audit-child-a', 1),
         (?, 'audit-root-a', 'audit-subchild-a', 2),
         (?, 'audit-child-a', 'audit-child-a', 0),
         (?, 'audit-child-a', 'audit-subchild-a', 1),
         (?, 'audit-subchild-a', 'audit-subchild-a', 0),
         (?, 'audit-root-b', 'audit-root-b', 0),
         (?, 'audit-root-c', 'audit-root-c', 0),
         (?, 'audit-root-archived', 'audit-root-archived', 0),
         (?, 'audit-root-deleted-owner', 'audit-root-deleted-owner', 0),
         (?, 'audit-root-sole', 'audit-root-sole', 0),
         (?, 'other-audit-root', 'other-audit-root', 0)`
    ).bind(
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      OTHER_TENANT
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO files
         (id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
          upload_state, current_version_num, classification, ai_reason,
          created_by, updated_by)
       VALUES
         ('audit-file-secret', ?, 'audit-subchild-a', 'secret.pdf', 'pdf',
          'application/pdf', 2048, 'active', 1, 'confidential',
          'SENSITIVE_AI_REASON_DO_NOT_LEAK', ?, ?),
         ('audit-file-normal', ?, 'audit-child-a', 'normal.txt', 'txt',
          'text/plain', 100, 'active', 1, 'internal', 'normal reason', ?, ?)`
    ).bind(
      TENANT,
      USERS.sys,
      USERS.sys,
      TENANT,
      USERS.sys,
      USERS.sys
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO file_versions
         (id, tenant_id, file_id, version_num, r2_object_key, size_bytes,
          mime_type, upload_status, uploaded_by)
       VALUES ('audit-fv-secret', ?, 'audit-file-secret', 1,
               'tenants/tenant-audit/objects/SECRET_R2_KEY_DO_NOT_LEAK',
               2048, 'application/pdf', 'completed', ?)`
    ).bind(TENANT, USERS.sys),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions
         (id, tenant_id, target_type, target_id, grantee_type, grantee_id,
          role, granted_by, created_at)
       VALUES
         ('audit-perm-root-owner', ?, 'folder', 'audit-root-a', 'user', ?, 'owner', ?, '2026-01-01T00:00:00.000Z'),
         ('audit-perm-root-coowner', ?, 'folder', 'audit-root-a', 'group', 'audit-group', 'co_owner', ?, '2026-01-02T00:00:00.000Z'),
         ('audit-perm-root-editor', ?, 'folder', 'audit-root-a', 'user', ?, 'editor', ?, '2026-01-03T00:00:00.000Z'),
         ('audit-perm-root-formula', ?, 'folder', 'audit-root-a', 'group', 'audit-formula', 'co_owner', ?, '2026-01-03T00:00:00.000Z'),
         ('audit-perm-root-orphan', ?, 'folder', 'audit-root-a', 'user', 'ghost-user', 'editor', ?, '2026-01-04T00:00:00.000Z'),
         ('audit-perm-root-inactive-grantor', ?, 'folder', 'audit-root-a', 'user', ?, 'viewer', ?, '2026-01-05T00:00:00.000Z'),
         ('audit-perm-child-editor', ?, 'folder', 'audit-child-a', 'user', ?, 'editor', ?, '2026-01-06T00:00:00.000Z'),
         ('audit-perm-subchild-viewer', ?, 'folder', 'audit-subchild-a', 'user', ?, 'viewer', ?, '2026-01-07T00:00:00.000Z'),
         ('audit-perm-file-direct', ?, 'file', 'audit-file-secret', 'user', ?, 'viewer', ?, '2026-01-08T00:00:00.000Z'),
         ('audit-perm-root-b-owner', ?, 'folder', 'audit-root-b', 'user', ?, 'owner', ?, '2026-01-09T00:00:00.000Z'),
         ('audit-perm-root-archived-owner', ?, 'folder', 'audit-root-archived', 'user', ?, 'owner', ?, '2026-01-10T00:00:00.000Z'),
         ('audit-perm-root-deleted-owner', ?, 'folder', 'audit-root-deleted-owner', 'user', 'ghost-owner', 'owner', ?, '2026-01-11T00:00:00.000Z'),
         ('audit-perm-root-sole-owner', ?, 'folder', 'audit-root-sole', 'user', ?, 'owner', ?, '2026-01-12T00:00:00.000Z')`
    ).bind(
      TENANT,
      USERS.owner,
      USERS.sys,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.owner2,
      USERS.sys,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.member,
      USERS.suspendedGrantor,
      TENANT,
      USERS.owner2,
      USERS.sys,
      TENANT,
      USERS.member,
      USERS.sys,
      TENANT,
      USERS.owner2,
      USERS.sys,
      TENANT,
      USERS.suspended,
      USERS.sys,
      TENANT,
      USERS.owner,
      USERS.sys,
      TENANT,
      USERS.sys,
      TENANT,
      USERS.owner2,
      USERS.sys
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions
         (id, tenant_id, target_type, target_id, grantee_type, grantee_id,
          role, granted_by, created_at)
       VALUES ('other-audit-perm', ?, 'folder', 'other-audit-root', 'user', ?,
               'owner', ?, '2026-01-13T00:00:00.000Z')`
    ).bind(OTHER_TENANT, USERS.otherSys, USERS.otherSys),
  ]);
}

describe('Admin permission audit & bulk operations (P9-7 / TOM-57)', () => {
  beforeAll(async () => {
    await seed();
  });

  it('enforces RBAC: sec_admin audits, member is denied, bulk mutations are sys_admin-only', async () => {
    const memberGet = await call('/api/admin/permissions', {
      headers: HEADERS.member,
    });
    expect(memberGet.status).toBe(403);

    const secGet = await call('/api/admin/permissions', { headers: HEADERS.sec });
    expect(secGet.status).toBe(200);

    const sysGet = await call('/api/admin/permissions', { headers: HEADERS.sys });
    expect(sysGet.status).toBe(200);

    const secBulk = await call('/api/admin/permissions/bulk-co-owner', {
      method: 'POST',
      headers: HEADERS.sec,
      body: { folderIds: ['audit-root-a'], groupIds: ['audit-group-2'] },
    });
    expect(secBulk.status).toBe(403);
    expect(secBulk.body.code).toBe('SYS_ADMIN_REQUIRED');

    const memberBulk = await call('/api/admin/root-folders/bulk-archive', {
      method: 'POST',
      headers: HEADERS.member,
      body: { folderIds: ['audit-root-a'] },
    });
    expect(memberBulk.status).toBe(403);
  });

  it('lists tenant-scoped permissions with root health summaries and DLP-safe file metadata', async () => {
    const response = await call('/api/admin/permissions?limit=200', {
      headers: HEADERS.sec,
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      entries: Array<Record<string, unknown>>;
      totalCount: number;
      rootSummaries: Array<Record<string, unknown>>;
      anomaliesSummary: Record<string, number>;
    };
    expect(body.totalCount).toBeGreaterThan(0);
    expect(body.entries.every((entry) => entry.tenantId === undefined)).toBe(
      true
    );
    expect(JSON.stringify(body)).not.toContain('other-audit-root');
    expect(JSON.stringify(body)).not.toContain('Other Tenant Root');
    expect(JSON.stringify(body)).not.toContain('SENSITIVE_AI_REASON_DO_NOT_LEAK');
    expect(JSON.stringify(body)).not.toContain('SECRET_R2_KEY_DO_NOT_LEAK');
    expect(JSON.stringify(body)).not.toContain('signedUrl');
    expect(JSON.stringify(body)).not.toContain('"content"');

    const secretFile = body.entries.find(
      (entry) => entry.targetId === 'audit-file-secret'
    );
    expect(secretFile).toBeTruthy();
    expect(secretFile).toMatchObject({
      targetType: 'file',
      targetName: 'secret.pdf',
      classification: 'confidential',
      rootFolderName: 'Audit Root A',
    });

    const rootA = body.rootSummaries.find(
      (root) => root.id === 'audit-root-a'
    ) as Record<string, unknown>;
    expect(rootA).toMatchObject({
      name: 'Audit Root A',
      ownerCount: 1,
      activeOwnerCount: 1,
      coOwnerCount: 2,
      editorCount: 2,
      ownerMissing: false,
      hasSuspendedOwner: false,
      hasDeletedOwner: false,
      archived: false,
    });
    const rootB = body.rootSummaries.find(
      (root) => root.id === 'audit-root-b'
    ) as Record<string, unknown>;
    expect(rootB.ownerMissing).toBe(true);
    expect(rootB.hasSuspendedOwner).toBe(true);
    const rootDeletedOwner = body.rootSummaries.find(
      (root) => root.id === 'audit-root-deleted-owner'
    ) as Record<string, unknown>;
    expect(rootDeletedOwner.ownerMissing).toBe(true);
    expect(rootDeletedOwner.hasDeletedOwner).toBe(true);
    const archivedRoot = body.rootSummaries.find(
      (root) => root.id === 'audit-root-archived'
    ) as Record<string, unknown>;
    expect(archivedRoot.archived).toBe(true);
    expect(archivedRoot.deletedAt).toBeTruthy();

    expect(body.anomaliesSummary.ownerMissingCount).toBeGreaterThanOrEqual(3);
    expect(body.anomaliesSummary.suspendedOwnerCount).toBeGreaterThanOrEqual(1);
    expect(body.anomaliesSummary.deletedOwnerCount).toBeGreaterThanOrEqual(1);
    expect(body.anomaliesSummary.inactiveGranterCount).toBeGreaterThanOrEqual(1);
    expect(body.anomaliesSummary.deletedGranteeCount).toBeGreaterThanOrEqual(2);
  });

  it('supports every audit filter, sorting, paging, CSV and JSON download', async () => {
    const folderTarget = await call(
      '/api/admin/permissions?targetId=audit-subchild-a&limit=200',
      { headers: HEADERS.sec }
    );
    expect(folderTarget.status).toBe(200);
    const folderEntries = (
      folderTarget.body as {
        entries: Array<Record<string, unknown>>;
      }
    ).entries;
    expect(
      folderEntries.every((entry) => entry.targetId === 'audit-subchild-a')
    ).toBe(true);
    expect(
      folderEntries.some(
        (entry) =>
          entry.source === 'inherited' &&
          entry.inheritedFromId === 'audit-root-a' &&
          entry.inheritedFromName === 'Audit Root A'
      )
    ).toBe(true);

    const fileTarget = await call(
      '/api/admin/permissions?targetId=audit-file-secret&source=inherited&limit=200',
      { headers: HEADERS.sec }
    );
    expect(fileTarget.status).toBe(200);
    const fileInherited = (
      fileTarget.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(fileInherited.length).toBeGreaterThan(0);
    expect(fileInherited.every((entry) => entry.source === 'inherited')).toBe(
      true
    );
    expect(fileInherited.every((entry) => entry.targetId === 'audit-file-secret')).toBe(
      true
    );

    const direct = await call(
      '/api/admin/permissions?source=direct&limit=200',
      { headers: HEADERS.sec }
    );
    expect(
      (direct.body as { entries: Array<Record<string, unknown>> }).entries.every(
        (entry) => entry.source === 'direct'
      )
    ).toBe(true);

    const inheritedFrom = await call(
      '/api/admin/permissions?targetId=audit-subchild-a&inheritedFromId=audit-child-a&source=inherited&limit=200',
      { headers: HEADERS.sec }
    );
    expect(
      (
        inheritedFrom.body as { entries: Array<Record<string, unknown>> }
      ).entries.every(
        (entry) => entry.inheritedFromId === 'audit-child-a'
      )
    ).toBe(true);

    const rootScoped = await call(
      '/api/admin/permissions?rootFolderId=audit-root-a&limit=200',
      { headers: HEADERS.sec }
    );
    const rootEntries = (
      rootScoped.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(rootEntries.length).toBeGreaterThan(0);
    expect(
      rootEntries.every((entry) => entry.rootFolderId === 'audit-root-a')
    ).toBe(true);

    const grantee = await call(
      '/api/admin/permissions?grantee=owner2&limit=200',
      { headers: HEADERS.sec }
    );
    const granteeEntries = (
      grantee.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(granteeEntries.length).toBeGreaterThan(0);
    expect(
      granteeEntries.every((entry) =>
        JSON.stringify(entry).toLowerCase().includes('owner2')
      )
    ).toBe(true);

    const roles = await call(
      '/api/admin/permissions?role=owner,editor&limit=200',
      { headers: HEADERS.sec }
    );
    const roleEntries = (
      roles.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(roleEntries.length).toBeGreaterThan(0);
    expect(
      roleEntries.every((entry) => ['owner', 'editor'].includes(String(entry.role)))
    ).toBe(true);

    const grantedBy = await call(
      '/api/admin/permissions?grantedBy=audit-grantor-suspended&limit=200',
      { headers: HEADERS.sec }
    );
    const grantedEntries = (
      grantedBy.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(grantedEntries.length).toBeGreaterThan(0);
    expect(
      grantedEntries.every(
        (entry) => entry.grantedBy === USERS.suspendedGrantor
      )
    ).toBe(true);

    const dateRange = await call(
      '/api/admin/permissions?from=2026-01-07T00:00:00.000Z&to=2026-01-08T23:59:59.999Z&limit=200',
      { headers: HEADERS.sec }
    );
    const dateEntries = (
      dateRange.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(dateEntries.length).toBeGreaterThan(0);
    expect(
      dateEntries.every(
        (entry) =>
          String(entry.createdAt) >= '2026-01-07T00:00:00.000Z' &&
          String(entry.createdAt) <= '2026-01-08T23:59:59.999Z'
      )
    ).toBe(true);

    const suspended = await call(
      '/api/admin/permissions?granteeStatus=suspended&limit=200',
      { headers: HEADERS.sec }
    );
    expect(
      (
        suspended.body as { entries: Array<Record<string, unknown>> }
      ).entries.every((entry) => entry.granteeStatus === 'suspended')
    ).toBe(true);

    const deleted = await call(
      '/api/admin/permissions?granteeStatus=deleted&limit=200',
      { headers: HEADERS.sec }
    );
    const deletedEntries = (
      deleted.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(
      deletedEntries.some((entry) => entry.granteeId === 'ghost-user')
    ).toBe(true);

    const ownerMissing = await call(
      '/api/admin/permissions?health=owner_missing&limit=200',
      { headers: HEADERS.sec }
    );
    const ownerMissingEntries = (
      ownerMissing.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(ownerMissingEntries.length).toBeGreaterThan(0);
    expect(
      ownerMissingEntries.every((entry) =>
        ['audit-root-b', 'audit-root-c', 'audit-root-deleted-owner'].includes(
          String(entry.rootFolderId)
        )
      )
    ).toBe(true);

    const inactiveOwner = await call(
      '/api/admin/permissions?health=inactive_owner&limit=200',
      { headers: HEADERS.sec }
    );
    const inactiveEntries = (
      inactiveOwner.body as { entries: Array<Record<string, unknown>> }
    ).entries;
    expect(inactiveEntries.length).toBeGreaterThan(0);
    expect(
      inactiveEntries.every((entry) =>
        ['audit-root-b', 'audit-root-deleted-owner'].includes(
          String(entry.rootFolderId)
        )
      )
    ).toBe(true);

    const sorted = await call(
      '/api/admin/permissions?sortBy=targetName&sortDir=asc&limit=200',
      { headers: HEADERS.sec }
    );
    const names = (
      sorted.body as { entries: Array<Record<string, unknown>> }
    ).entries.map((entry) => String(entry.targetName));
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);

    const paged1 = await call('/api/admin/permissions?limit=2', {
      headers: HEADERS.sec,
    });
    const page1 = paged1.body as {
      entries: Array<Record<string, unknown>>;
      totalCount: number;
      nextOffset: number | null;
    };
    expect(page1.entries).toHaveLength(2);
    expect(page1.nextOffset).toBe(2);
    const paged2 = await call(
      `/api/admin/permissions?limit=2&offset=${page1.nextOffset}`,
      { headers: HEADERS.sec }
    );
    const page2 = paged2.body as {
      entries: Array<Record<string, unknown>>;
      totalCount: number;
    };
    expect(page2.totalCount).toBe(page1.totalCount);
    expect(page2.entries[0]?.id).not.toBe(page1.entries[0]?.id);

    const csv = await call('/api/admin/permissions?format=csv&limit=200', {
      headers: HEADERS.sec,
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('Content-Type')).toContain('text/csv');
    expect(csv.headers.get('Content-Disposition')).toContain('attachment');
    const csvText = String(csv.body.raw);
    expect(csvText).toContain('target_type');
    // Formula-leading cells are neutralized before CSV quoting.
    expect(csvText).toContain('"\'=SUM(1,1)"');
    expect(csvText).not.toContain('"=SUM(1,1)"');

    const jsonDownload = await call(
      '/api/admin/permissions?format=json&download=1&limit=5',
      { headers: HEADERS.sec }
    );
    expect(jsonDownload.status).toBe(200);
    expect(jsonDownload.headers.get('Content-Disposition')).toContain(
      'attachment'
    );

    const invalidRole = await call('/api/admin/permissions?role=superuser', {
      headers: HEADERS.sec,
    });
    expect(invalidRole.status).toBe(400);
    expect(invalidRole.body.code).toBe('INVALID_ROLE_FILTER');
    const invalidTarget = await call(
      '/api/admin/permissions?targetType=workspace',
      { headers: HEADERS.sec }
    );
    expect(invalidTarget.body.code).toBe('INVALID_TARGET_TYPE');
    const invalidDate = await call('/api/admin/permissions?from=not-a-date', {
      headers: HEADERS.sec,
    });
    expect(invalidDate.body.code).toBe('INVALID_DATE_RANGE');
  });

  it('bulk co-owner grant previews, executes partially, preserves owners and replays idempotently', async () => {
    const preview = await call('/api/admin/permissions/bulk-co-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: [
          'audit-root-a',
          'other-audit-root',
          'audit-child-a',
          'audit-root-archived',
        ],
        groupIds: ['audit-group-2'],
        dryRun: true,
      },
    });
    expect(preview.status).toBe(200);
    const previewBody = preview.body as {
      dryRun: boolean;
      results: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };
    expect(previewBody.dryRun).toBe(true);
    expect(previewBody.summary.requested).toBe(4);
    expect(previewBody.summary.succeeded).toBe(1);
    expect(previewBody.summary.failed).toBe(2);
    expect(previewBody.summary.skipped).toBe(1);
    const previewByFolder = new Map(
      previewBody.results.map((item) => [item.folderId, item])
    );
    expect(previewByFolder.get('audit-root-a')?.status).toBe('succeeded');
    expect(previewByFolder.get('other-audit-root')?.code).toBe('NOT_FOUND');
    expect(previewByFolder.get('audit-child-a')?.code).toBe('NOT_ROOT_FOLDER');
    expect(previewByFolder.get('audit-root-archived')?.status).toBe('skipped');

    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM permissions WHERE tenant_id = ? AND target_id = 'audit-root-a' AND grantee_id = 'audit-group-2'"
    )
      .bind(TENANT)
      .first<{ cnt: number }>();
    expect(before?.cnt).toBe(0);

    const key = 'bulk-coowner-replay-key';
    const payload = {
      folderIds: ['audit-root-a', 'audit-root-c'],
      groupIds: ['audit-group-2'],
      userIds: [USERS.owner2],
    };
    const first = await call('/api/admin/permissions/bulk-co-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: { ...payload, idempotencyKey: key },
    });
    expect(first.status).toBe(200);
    const firstBody = first.body as {
      replayed: boolean;
      summary: Record<string, number>;
    };
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.summary.succeeded).toBe(2);

    const rootAGrants = await env.DB.prepare(
      `SELECT grantee_type, grantee_id, role FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND target_id = 'audit-root-a'
        ORDER BY grantee_id`
    )
      .bind(TENANT)
      .all<{ grantee_type: string; grantee_id: string; role: string }>();
    expect(
      rootAGrants.results.some(
        (row) =>
          row.grantee_type === 'user' &&
          row.grantee_id === USERS.owner &&
          row.role === 'owner'
      )
    ).toBe(true);
    expect(
      rootAGrants.results.some(
        (row) =>
          row.grantee_type === 'group' &&
          row.grantee_id === 'audit-group-2' &&
          row.role === 'co_owner'
      )
    ).toBe(true);
    expect(
      rootAGrants.results.some(
        (row) =>
          row.grantee_type === 'user' &&
          row.grantee_id === USERS.owner2 &&
          row.role === 'co_owner'
      )
    ).toBe(true);

    const replay = await call('/api/admin/permissions/bulk-co-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: { ...payload, idempotencyKey: key },
    });
    expect(replay.status).toBe(200);
    expect((replay.body as { replayed: boolean }).replayed).toBe(true);

    const conflict = await call('/api/admin/permissions/bulk-co-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        ...payload,
        groupIds: ['audit-group'],
        idempotencyKey: key,
      },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const audit = await call(
      '/api/audit-logs?action=admin.permission.bulk_grant&targetType=permission&limit=200',
      { headers: HEADERS.sec }
    );
    const auditLogs = (audit.body as { logs: Array<Record<string, unknown>> }).logs;
    expect(auditLogs.length).toBeGreaterThan(0);
    expect(
      auditLogs.every(
        (log) =>
          log.action === 'admin.permission.bulk_grant' &&
          log.targetType === 'permission' &&
          log.targetId === 'bulk'
      )
    ).toBe(true);
  });

  it('rejects concurrent idempotency keys and accepts the Idempotency-Key header', async () => {
    const payload = {
      folderIds: ['audit-root-a'],
      groupIds: ['audit-group'],
      userIds: [USERS.member],
    };
    const key = 'in-progress-key';
    const normalized = {
      folderIds: [...payload.folderIds].sort(),
      userIds: [...payload.userIds].sort(),
      groupIds: [...payload.groupIds].sort(),
    };
    const hash = await requestHash('admin.permission.bulk_grant', normalized);
    await env.DB.prepare(
      `INSERT INTO admin_bulk_idempotency
         (tenant_id, operation, idempotency_key, request_hash, status)
       VALUES (?, 'admin.permission.bulk_grant', ?, ?, 'in_progress')`
    )
      .bind(TENANT, key, hash)
      .run();

    const inProgress = await call('/api/admin/permissions/bulk-co-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: { ...payload, idempotencyKey: key },
    });
    expect(inProgress.status).toBe(409);
    expect(inProgress.body.code).toBe('BULK_OPERATION_IN_PROGRESS');

    const headerKey = 'header-idempotency-key';
    const headerPayload = {
      folderIds: ['audit-root-a'],
      groupIds: ['audit-group'],
      userIds: [USERS.member],
    };
    const first = await call('/api/admin/permissions/bulk-co-owner', {
      method: 'POST',
      headers: { ...HEADERS.sys, 'Idempotency-Key': headerKey },
      body: headerPayload,
    });
    expect(first.status).toBe(200);
    const replay = await call('/api/admin/permissions/bulk-co-owner', {
      method: 'POST',
      headers: { ...HEADERS.sys, 'Idempotency-Key': headerKey },
      body: headerPayload,
    });
    expect(replay.status).toBe(200);
    expect((replay.body as { replayed: boolean }).replayed).toBe(true);
  });

  it('bulk owner transfer keeps a new owner first, demotes previous owners and rejects invalid targets', async () => {
    const invalidOther = await call('/api/admin/root-folders/bulk-transfer-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: ['audit-root-a'],
        newOwnerUserId: USERS.otherSys,
        dryRun: true,
      },
    });
    expect(invalidOther.status).toBe(400);
    expect(invalidOther.body.code).toBe('INVALID_OWNER');

    const suspended = await call('/api/admin/root-folders/bulk-transfer-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: ['audit-root-a'],
        newOwnerUserId: USERS.suspended,
        dryRun: true,
      },
    });
    expect(suspended.status).toBe(400);
    expect(suspended.body.code).toBe('SUSPENDED_USER_BLOCKED');

    const preview = await call('/api/admin/root-folders/bulk-transfer-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: [
          'audit-root-a',
          'audit-root-b',
          'audit-root-c',
          'audit-child-a',
          'other-audit-root',
          'audit-root-archived',
          'audit-root-sole',
        ],
        newOwnerUserId: USERS.owner2,
        demotePreviousOwnersTo: 'co_owner',
        dryRun: true,
      },
    });
    expect(preview.status).toBe(200);
    const previewBody = preview.body as {
      results: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };
    const byFolder = new Map(
      previewBody.results.map((item) => [item.folderId, item])
    );
    expect(byFolder.get('audit-root-a')?.status).toBe('succeeded');
    expect(byFolder.get('audit-root-b')?.status).toBe('succeeded');
    expect(byFolder.get('audit-root-c')?.status).toBe('succeeded');
    expect(byFolder.get('audit-child-a')?.code).toBe('NOT_ROOT_FOLDER');
    expect(byFolder.get('other-audit-root')?.code).toBe('NOT_FOUND');
    expect(byFolder.get('audit-root-archived')?.code).toBe('ARCHIVED');
    expect(byFolder.get('audit-root-sole')?.status).toBe('skipped');
    expect(byFolder.get('audit-root-sole')?.code).toBe('ALREADY_OWNER');

    const key = 'bulk-transfer-key';
    const transfer = await call('/api/admin/root-folders/bulk-transfer-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: [
          'audit-root-a',
          'audit-root-b',
          'audit-root-c',
          'audit-child-a',
          'other-audit-root',
          'audit-root-archived',
        ],
        newOwnerUserId: USERS.owner2,
        demotePreviousOwnersTo: 'co_owner',
        idempotencyKey: key,
      },
    });
    expect(transfer.status).toBe(200);
    const transferBody = transfer.body as {
      replayed: boolean;
      results: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };
    expect(transferBody.replayed).toBe(false);
    expect(transferBody.summary.succeeded).toBe(3);
    expect(transferBody.summary.failed).toBe(3);

    const rootOwners = await env.DB.prepare(
      `SELECT grantee_id, role FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND target_id = 'audit-root-a'
          AND role IN ('owner', 'co_owner')
        ORDER BY grantee_id`
    )
      .bind(TENANT)
      .all<{ grantee_id: string; role: string }>();
    expect(
      rootOwners.results.some(
        (row) => row.grantee_id === USERS.owner2 && row.role === 'owner'
      )
    ).toBe(true);
    expect(
      rootOwners.results.some(
        (row) => row.grantee_id === USERS.owner && row.role === 'co_owner'
      )
    ).toBe(true);

    const rootB = await env.DB.prepare(
      `SELECT grantee_id, role FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND target_id = 'audit-root-b'
          AND role IN ('owner', 'co_owner')
        ORDER BY grantee_id`
    )
      .bind(TENANT)
      .all<{ grantee_id: string; role: string }>();
    expect(
      rootB.results.some(
        (row) => row.grantee_id === USERS.owner2 && row.role === 'owner'
      )
    ).toBe(true);
    expect(
      rootB.results.some(
        (row) => row.grantee_id === USERS.suspended && row.role === 'co_owner'
      )
    ).toBe(true);

    const replay = await call('/api/admin/root-folders/bulk-transfer-owner', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: [
          'audit-root-a',
          'audit-root-b',
          'audit-root-c',
          'audit-child-a',
          'other-audit-root',
          'audit-root-archived',
        ],
        newOwnerUserId: USERS.owner2,
        demotePreviousOwnersTo: 'co_owner',
        idempotencyKey: key,
      },
    });
    expect((replay.body as { replayed: boolean }).replayed).toBe(true);

    const audit = await call(
      '/api/audit-logs?action=admin.root_folder.bulk_transfer&limit=200',
      { headers: HEADERS.sec }
    );
    expect(
      (audit.body as { logs: Array<Record<string, unknown>> }).logs.length
    ).toBeGreaterThan(0);
  });

  it('bulk archive and restore preview, execute atomically per root and record bulk audit actions', async () => {
    const preview = await call('/api/admin/root-folders/bulk-archive', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: [
          'audit-root-c',
          'audit-root-archived',
          'audit-child-a',
          'other-audit-root',
        ],
        dryRun: true,
      },
    });
    expect(preview.status).toBe(200);
    const previewBody = preview.body as {
      results: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };
    const byFolder = new Map(
      previewBody.results.map((item) => [item.folderId, item])
    );
    expect(byFolder.get('audit-root-c')?.status).toBe('succeeded');
    expect(byFolder.get('audit-root-archived')?.code).toBe('ALREADY_ARCHIVED');
    expect(byFolder.get('audit-child-a')?.code).toBe('NOT_ROOT_FOLDER');
    expect(byFolder.get('other-audit-root')?.code).toBe('NOT_FOUND');

    const archive = await call('/api/admin/root-folders/bulk-archive', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: ['audit-root-c', 'other-audit-root'],
        idempotencyKey: 'bulk-archive-key',
      },
    });
    expect(archive.status).toBe(200);
    const archiveBody = archive.body as {
      results: Array<Record<string, unknown>>;
      summary: Record<string, number>;
    };
    expect(archiveBody.summary.succeeded).toBe(1);
    expect(archiveBody.summary.failed).toBe(1);

    const archivedRow = await env.DB.prepare(
      "SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = 'audit-root-c'"
    )
      .bind(TENANT)
      .first<{ deleted_at: string | null }>();
    expect(archivedRow?.deleted_at).toBeTruthy();
    const otherRow = await env.DB.prepare(
      "SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = 'other-audit-root'"
    )
      .bind(OTHER_TENANT)
      .first<{ deleted_at: string | null }>();
    expect(otherRow?.deleted_at).toBeNull();

    const restorePreview = await call('/api/admin/root-folders/bulk-restore', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: ['audit-root-c', 'audit-root-a'],
        dryRun: true,
      },
    });
    const restoreByFolder = new Map(
      (
        restorePreview.body as {
          results: Array<Record<string, unknown>>;
        }
      ).results.map((item) => [item.folderId, item])
    );
    expect(restoreByFolder.get('audit-root-c')?.status).toBe('succeeded');
    expect(restoreByFolder.get('audit-root-a')?.code).toBe('NOT_ARCHIVED');

    const restore = await call('/api/admin/root-folders/bulk-restore', {
      method: 'POST',
      headers: HEADERS.sys,
      body: {
        folderIds: ['audit-root-c', 'audit-root-a'],
        idempotencyKey: 'bulk-restore-key',
      },
    });
    expect(restore.status).toBe(200);
    expect(
      (restore.body as { summary: Record<string, number> }).summary
    ).toMatchObject({ succeeded: 1, failed: 1 });

    const restoredRow = await env.DB.prepare(
      "SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = 'audit-root-c'"
    )
      .bind(TENANT)
      .first<{ deleted_at: string | null }>();
    expect(restoredRow?.deleted_at).toBeNull();

    const audit = await call(
      '/api/audit-logs?actionPrefixes=admin.root_folder.bulk_archive,admin.root_folder.bulk_restore&limit=200',
      { headers: HEADERS.sec }
    );
    const actions = (
      audit.body as { logs: Array<Record<string, unknown>> }
    ).logs.map((log) => log.action);
    expect(actions).toContain('admin.root_folder.bulk_archive');
    expect(actions).toContain('admin.root_folder.bulk_restore');
  });

  it('audit log action-prefix and targetType filters are bounded, escaped and backward compatible', async () => {
    const prefixes = await call(
      '/api/audit-logs?actionPrefixes=admin.permission.,admin.root_folder.&limit=200',
      { headers: HEADERS.sec }
    );
    expect(prefixes.status).toBe(200);
    const prefixLogs = (
      prefixes.body as { logs: Array<Record<string, unknown>> }
    ).logs;
    expect(prefixLogs.length).toBeGreaterThan(0);
    expect(
      prefixLogs.every(
        (log) =>
          String(log.action).startsWith('admin.permission.') ||
          String(log.action).startsWith('admin.root_folder.')
      )
    ).toBe(true);

    const singlePrefix = await call(
      '/api/audit-logs?actionPrefix=admin.permission.,admin.root_folder.&limit=200',
      { headers: HEADERS.sec }
    );
    expect(singlePrefix.status).toBe(200);
    expect(
      (singlePrefix.body as { logs: Array<Record<string, unknown>> }).logs
        .length
    ).toBeGreaterThan(0);

    const tooLongPrefix = await call(
      `/api/audit-logs?actionPrefix=${'a'.repeat(121)}`,
      { headers: HEADERS.sec }
    );
    expect(tooLongPrefix.status).toBe(400);
    expect(tooLongPrefix.body.code).toBe('INVALID_ACTION_FILTER');

    const targetType = await call(
      '/api/audit-logs?targetType=permission&actionPrefixes=admin.permission.&limit=200',
      { headers: HEADERS.sec }
    );
    expect(
      (
        targetType.body as { logs: Array<Record<string, unknown>> }
      ).logs.every((log) => log.targetType === 'permission')
    ).toBe(true);

    const escaped = await call(
      '/api/audit-logs?actionPrefixes=admin.%&limit=200',
      { headers: HEADERS.sec }
    );
    expect(escaped.status).toBe(200);
    expect(
      (escaped.body as { logs: Array<Record<string, unknown>> }).logs
    ).toHaveLength(0);

    const tooMany = await call(
      `/api/audit-logs?actionPrefixes=${Array.from(
        { length: 21 },
        (_, index) => `prefix.${index}`
      ).join(',')}`,
      { headers: HEADERS.sec }
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('INVALID_ACTION_FILTER');

    const empty = await call('/api/audit-logs?actionPrefixes=', {
      headers: HEADERS.sec,
    });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('INVALID_ACTION_FILTER');

    const combined = await call(
      '/api/audit-logs?actions=admin.permission.bulk_grant&actionPrefixes=admin.root_folder.&limit=200',
      { headers: HEADERS.sec }
    );
    expect(combined.status).toBe(200);
    expect(
      (
        combined.body as { logs: Array<Record<string, unknown>> }
      ).logs.every(
        (log) =>
          log.action === 'admin.permission.bulk_grant' ||
          String(log.action).startsWith('admin.root_folder.')
      )
    ).toBe(true);
  });
});
