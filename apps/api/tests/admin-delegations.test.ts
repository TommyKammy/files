import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-admin-delegations';
const OTHER_TENANT = 'tenant-admin-delegations-other';
const APP_ORIGIN = 'http://127.0.0.1:8787';

const SYS = 'ad-sys';
const SEC = 'ad-sec';
const HELPDESK = 'ad-helpdesk';
const HELPDESK_SCOPED = 'ad-helpdesk-scoped';
const AUDITOR = 'ad-auditor';
const GROUP_MANAGER = 'ad-group-manager';
const GROUP_MANAGER_GLOBAL = 'ad-group-manager-global';
const CONTENT_OPERATOR = 'ad-content-operator';
const CUSTOM = 'ad-custom';
const CO_ADMIN_2 = 'ad-coadmin-2';
const PLAIN_MEMBER = 'ad-plain-member';
const TARGET = 'ad-target';
const OUT_OF_SCOPE = 'ad-out-of-scope';
const SUSPEND_TARGET = 'ad-suspend-target';
const CRUD_TARGET = 'ad-crud-target';
const GUEST = 'ad-guest';
const OTHER_TENANT_USER = 'ad-other-tenant-user';

const GROUP_SCOPE = 'ad-group-scope';
const GROUP_OTHER = 'ad-group-other';
const ROOT_SCOPE = 'ad-root-scope';
const SUB_SCOPE = 'ad-sub-scope';
const ROOT_OTHER = 'ad-root-other';

const FILE_SCOPE = 'ad-file-scope';
const FILE_OUTSIDE = 'ad-file-outside';
const FILE_TRASH_SCOPE = 'ad-file-trash-scope';
const FILE_TRASH_OUTSIDE = 'ad-file-trash-outside';
const LINK_SCOPE = 'ad-link-scope';
const LINK_OUTSIDE = 'ad-link-outside';
const REQUEST_SCOPE = 'ad-request-scope';
const REQUEST_OUTSIDE = 'ad-request-outside';
const SESSION_TARGET = 'ad-session-target';
const SESSION_OUTSIDE = 'ad-session-outside';

type UserRole = 'sys_admin' | 'sec_admin' | 'member';
type UserType = 'member' | 'guest';

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
  role: UserRole,
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
  } = {}
): Promise<{ status: number; body: T }> {
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
  return { status: response.status, body: body as T };
}

function delegationSql(input: {
  id: string;
  userId: string;
  preset: string | null;
  permissions: string[];
  scopeGroupId?: string | null;
  scopeRootFolderId?: string | null;
}): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO admin_delegations (
       id, tenant_id, user_id, preset, permissions_json, scope_group_id,
       scope_root_folder_id, note, granted_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  ).bind(
    input.id,
    TENANT,
    input.userId,
    input.preset,
    JSON.stringify(input.permissions),
    input.scopeGroupId ?? null,
    input.scopeRootFolderId ?? null,
    SYS,
    '2026-11-17T00:00:00.000Z',
    '2026-11-17T00:00:00.000Z'
  );
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO tenants (id, name, slug) VALUES (?, 'Delegations', 'delegations')"
    ).bind(TENANT),
    env.DB.prepare(
      "INSERT INTO tenants (id, name, slug) VALUES (?, 'Other', 'delegations-other')"
    ).bind(OTHER_TENANT),
    env.DB.prepare('INSERT INTO tenant_policies (tenant_id) VALUES (?)').bind(
      TENANT
    ),
    env.DB.prepare('INSERT INTO tenant_policies (tenant_id) VALUES (?)').bind(
      OTHER_TENANT
    ),
  ]);

  const users: Array<[string, UserRole, UserType]> = [
    [SYS, 'sys_admin', 'member'],
    [SEC, 'sec_admin', 'member'],
    [HELPDESK, 'member', 'member'],
    [HELPDESK_SCOPED, 'member', 'member'],
    [AUDITOR, 'member', 'member'],
    [GROUP_MANAGER, 'member', 'member'],
    [GROUP_MANAGER_GLOBAL, 'member', 'member'],
    [CONTENT_OPERATOR, 'member', 'member'],
    [CUSTOM, 'member', 'member'],
    [CO_ADMIN_2, 'member', 'member'],
    [PLAIN_MEMBER, 'member', 'member'],
    [TARGET, 'member', 'member'],
    [OUT_OF_SCOPE, 'member', 'member'],
    [SUSPEND_TARGET, 'member', 'member'],
    [CRUD_TARGET, 'member', 'member'],
    [GUEST, 'member', 'guest'],
  ];
  await env.DB.batch(
    users.map(([id, role, userType]) =>
      env.DB.prepare(
        `INSERT INTO users (
           id, tenant_id, email, display_name, role, user_type, status, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
      ).bind(
        id,
        TENANT,
        `${id}@example.com`,
        id,
        role,
        userType,
        userType === 'guest' ? '2099-01-01T00:00:00.000Z' : null
      )
    )
  );
  await env.DB.prepare(
    `INSERT INTO users (id, tenant_id, email, display_name, role, user_type, status)
     VALUES (?, ?, 'other@example.com', 'Other Tenant User', 'member', 'member', 'active')`
  )
    .bind(OTHER_TENANT_USER, OTHER_TENANT)
    .run();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO groups (id, tenant_id, name) VALUES (?, ?, 'Scoped Group')"
    ).bind(GROUP_SCOPE, TENANT),
    env.DB.prepare(
      "INSERT INTO groups (id, tenant_id, name) VALUES (?, ?, 'Other Group')"
    ).bind(GROUP_OTHER, TENANT),
    env.DB.prepare(
      'INSERT INTO group_members (group_id, user_id) VALUES (?, ?)'
    ).bind(GROUP_SCOPE, TARGET),
    env.DB.prepare(
      'INSERT INTO group_members (group_id, user_id) VALUES (?, ?)'
    ).bind(GROUP_SCOPE, SUSPEND_TARGET),
    env.DB.prepare(
      'INSERT INTO group_members (group_id, user_id) VALUES (?, ?)'
    ).bind(GROUP_OTHER, OUT_OF_SCOPE),
    env.DB.prepare(
      `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
       VALUES (?, ?, NULL, 'Scoped Root', 0, 1, 'internal', ?)`
    ).bind(ROOT_SCOPE, TENANT, SYS),
    env.DB.prepare(
      `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
       VALUES (?, ?, ?, 'Scoped Sub', 1, 1, 'internal', ?)`
    ).bind(SUB_SCOPE, TENANT, ROOT_SCOPE, SYS),
    env.DB.prepare(
      `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
       VALUES (?, ?, NULL, 'Outside Root', 0, 1, 'internal', ?)`
    ).bind(ROOT_OTHER, TENANT, SYS),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth) VALUES (?, ?, ?, 0)`
    ).bind(TENANT, ROOT_SCOPE, ROOT_SCOPE),
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth) VALUES (?, ?, ?, 0)`
    ).bind(TENANT, SUB_SCOPE, SUB_SCOPE),
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth) VALUES (?, ?, ?, 1)`
    ).bind(TENANT, ROOT_SCOPE, SUB_SCOPE),
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth) VALUES (?, ?, ?, 0)`
    ).bind(TENANT, ROOT_OTHER, ROOT_OTHER),
  ]);

  const files = [
    { id: FILE_SCOPE, folderId: SUB_SCOPE, name: 'scoped-file.txt', deletedAt: null },
    { id: FILE_OUTSIDE, folderId: ROOT_OTHER, name: 'outside-file.txt', deletedAt: null },
    {
      id: FILE_TRASH_SCOPE,
      folderId: SUB_SCOPE,
      name: 'scoped-trash.txt',
      deletedAt: '2026-11-16T00:00:00.000Z',
    },
    {
      id: FILE_TRASH_OUTSIDE,
      folderId: ROOT_OTHER,
      name: 'outside-trash.txt',
      deletedAt: '2026-11-16T00:00:00.000Z',
    },
  ];
  await env.DB.batch(
    files.map((file) =>
      env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, classification, created_by, updated_by, deleted_at
         ) VALUES (?, ?, ?, ?, 'txt', 'text/plain', 10, 'active', 'internal', ?, ?, ?)`
      ).bind(
        file.id,
        TENANT,
        file.folderId,
        file.name,
        SYS,
        SYS,
        file.deletedAt
      )
    )
  );

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO shared_links (
         id, tenant_id, token_hash, target_type, target_id, access_scope,
         can_download, created_by, created_at
       ) VALUES (?, ?, 'hash-scope', 'file', ?, 'company_only', 1, ?, '2026-11-17T00:00:00.000Z')`
    ).bind(LINK_SCOPE, TENANT, FILE_SCOPE, SYS),
    env.DB.prepare(
      `INSERT INTO shared_links (
         id, tenant_id, token_hash, target_type, target_id, access_scope,
         can_download, created_by, created_at
       ) VALUES (?, ?, 'hash-outside', 'file', ?, 'company_only', 1, ?, '2026-11-17T00:00:00.000Z')`
    ).bind(LINK_OUTSIDE, TENANT, FILE_OUTSIDE, SYS),
    env.DB.prepare(
      `INSERT INTO file_requests (
         id, tenant_id, folder_id, token_hash, title, created_by, created_at
       ) VALUES (?, ?, ?, 'hash-request-scope', 'Scoped Request', ?, '2026-11-17T00:00:00.000Z')`
    ).bind(REQUEST_SCOPE, TENANT, SUB_SCOPE, SYS),
    env.DB.prepare(
      `INSERT INTO file_requests (
         id, tenant_id, folder_id, token_hash, title, created_by, created_at
       ) VALUES (?, ?, ?, 'hash-request-outside', 'Outside Request', ?, '2026-11-17T00:00:00.000Z')`
    ).bind(REQUEST_OUTSIDE, TENANT, ROOT_OTHER, SYS),
    env.DB.prepare(
      `INSERT INTO sessions (
         id, tenant_id, user_id, token_hash, expires_at, created_at
       ) VALUES (?, ?, ?, 'hash-session-target', '2099-01-01T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`
    ).bind(SESSION_TARGET, TENANT, TARGET),
    env.DB.prepare(
      `INSERT INTO sessions (
         id, tenant_id, user_id, token_hash, expires_at, created_at
       ) VALUES (?, ?, ?, 'hash-session-outside', '2099-01-01T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`
    ).bind(SESSION_OUTSIDE, TENANT, OUT_OF_SCOPE),
  ]);

  await env.DB.batch([
    delegationSql({
      id: 'ad-helpdesk-delegation',
      userId: HELPDESK,
      preset: 'helpdesk',
      permissions: [
        'admin.users.read',
        'admin.users.suspend',
        'admin.content.unlock',
        'admin.trash.manage',
      ],
    }),
    delegationSql({
      id: 'ad-helpdesk-scoped-delegation',
      userId: HELPDESK_SCOPED,
      preset: 'helpdesk',
      permissions: [
        'admin.users.read',
        'admin.users.suspend',
        'admin.content.unlock',
        'admin.trash.manage',
      ],
      scopeGroupId: GROUP_SCOPE,
    }),
    delegationSql({
      id: 'ad-auditor-delegation',
      userId: AUDITOR,
      preset: 'auditor',
      permissions: [
        'admin.insights.read',
        'admin.audit.read',
        'admin.reports.run',
        'admin.policies.read',
      ],
    }),
    delegationSql({
      id: 'ad-group-manager-delegation',
      userId: GROUP_MANAGER,
      preset: 'group_manager',
      permissions: ['admin.users.read', 'admin.groups.manage'],
      scopeGroupId: GROUP_SCOPE,
    }),
    delegationSql({
      id: 'ad-group-manager-global-delegation',
      userId: GROUP_MANAGER_GLOBAL,
      preset: 'group_manager',
      permissions: ['admin.users.read', 'admin.groups.manage'],
    }),
    delegationSql({
      id: 'ad-content-operator-delegation',
      userId: CONTENT_OPERATOR,
      preset: 'content_operator',
      permissions: [
        'admin.content.unlock',
        'admin.trash.manage',
        'admin.links.revoke',
      ],
      scopeRootFolderId: ROOT_SCOPE,
    }),
    delegationSql({
      id: 'ad-custom-delegation',
      userId: CUSTOM,
      preset: null,
      permissions: ['admin.users.read', 'admin.links.revoke'],
    }),
    delegationSql({
      id: 'ad-coadmin-2-delegation',
      userId: CO_ADMIN_2,
      preset: 'auditor',
      permissions: [
        'admin.insights.read',
        'admin.audit.read',
        'admin.reports.run',
        'admin.policies.read',
      ],
    }),
  ]);
});

describe('Admin Co-Admin delegations (P13-1 / TOM-73)', () => {
  it('sys_admin CRUD writes audit rows and exposes preset metadata', async () => {
    const created = await call<{
      delegation: {
        id: string;
        userId: string;
        preset: string;
        permissions: string[];
      };
    }>('/api/admin/delegations', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        userId: CRUD_TARGET,
        preset: 'auditor',
        scopeRootFolderId: ROOT_SCOPE,
        note: 'Q4 audit',
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.delegation.userId).toBe(CRUD_TARGET);
    expect(created.body.delegation.permissions).toEqual([
      'admin.insights.read',
      'admin.audit.read',
      'admin.reports.run',
      'admin.policies.read',
    ]);

    const listed = await call<{
      delegations: Array<{
        id: string;
        userId: string;
        rootFolderName: string | null;
      }>;
      presets: Array<{ id: string }>;
      capabilities: Array<{ id: string }>;
    }>('/api/admin/delegations', SYS, { role: 'sys_admin' });
    expect(listed.status).toBe(200);
    expect(
      listed.body.delegations.find((item) => item.userId === CRUD_TARGET)
        ?.rootFolderName
    ).toBe('Scoped Root');
    expect(listed.body.presets.map((preset) => preset.id)).toEqual([
      'helpdesk',
      'auditor',
      'group_manager',
      'content_operator',
    ]);
    expect(listed.body.capabilities).toHaveLength(15);

    const updated = await call<{
      delegation: { permissions: string[] };
    }>(`/api/admin/delegations/${created.body.delegation.id}`, SYS, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { permissions: ['admin.users.read'], note: 'narrowed' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.delegation.permissions).toEqual(['admin.users.read']);

    const deleted = await call<{ ok: boolean }>(
      `/api/admin/delegations/${created.body.delegation.id}`,
      SYS,
      { method: 'DELETE', role: 'sys_admin' }
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.ok).toBe(true);

    const audit = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND target_type = 'admin_delegation'
          AND target_id = ?
        ORDER BY created_at ASC`
    )
      .bind(TENANT, created.body.delegation.id)
      .all<{ action: string }>();
    expect(audit.results.map((entry) => entry.action)).toEqual([
      'admin.delegation.created',
      'admin.delegation.updated',
      'admin.delegation.deleted',
    ]);
  });

  it('rejects guest, cross-tenant, invalid scopes and duplicate grants', async () => {
    const guest = await call('/api/admin/delegations', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: { userId: GUEST, permissions: ['admin.users.read'] },
    });
    expect(guest.status).toBe(400);
    expect(guest.body.code).toBe('GUEST_DELEGATION_FORBIDDEN');

    const otherTenant = await call('/api/admin/delegations', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: { userId: OTHER_TENANT_USER, permissions: ['admin.users.read'] },
    });
    expect(otherTenant.status).toBe(404);
    expect(otherTenant.body.code).toBe('DELEGATION_USER_NOT_FOUND');

    const missingGroup = await call('/api/admin/delegations', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        userId: SUSPEND_TARGET,
        permissions: ['admin.users.read'],
        scopeGroupId: 'missing-group',
      },
    });
    expect(missingGroup.status).toBe(404);
    expect(missingGroup.body.code).toBe('DELEGATION_GROUP_NOT_FOUND');

    const nonRoot = await call('/api/admin/delegations', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        userId: SUSPEND_TARGET,
        permissions: ['admin.users.read'],
        scopeRootFolderId: SUB_SCOPE,
      },
    });
    expect(nonRoot.status).toBe(400);
    expect(nonRoot.body.code).toBe('DELEGATION_ROOT_FOLDER_INVALID');

    const duplicate = await call('/api/admin/delegations', SYS, {
      method: 'POST',
      role: 'sys_admin',
      body: { userId: HELPDESK, permissions: ['admin.users.read'] },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DELEGATION_EXISTS');
  });

  it('keeps delegation management sys_admin-only', async () => {
    expect(
      (await call('/api/admin/delegations', SEC, { role: 'sec_admin' })).status
    ).toBe(403);
    expect((await call('/api/admin/delegations', HELPDESK)).status).toBe(403);
    expect(
      (
        await call('/api/admin/delegations', CUSTOM, {
          method: 'POST',
          body: { userId: SUSPEND_TARGET, permissions: ['admin.users.read'] },
        })
      ).status
    ).toBe(403);
    const guest = await call('/api/admin/delegations', GUEST, {
      userType: 'guest',
    });
    expect(guest.status).toBe(403);
    expect(guest.body.code).toBe('GUEST_FORBIDDEN');
  });

  it('enforces the preset/custom capability matrix', async () => {
    expect((await call('/api/admin/users', HELPDESK)).status).toBe(200);
    expect((await call('/api/admin/insights', HELPDESK)).status).toBe(403);
    expect((await call('/api/audit-logs', HELPDESK)).status).toBe(403);
    expect((await call('/api/admin/content/search', HELPDESK)).status).toBe(200);
    expect((await call('/api/admin/trash', HELPDESK)).status).toBe(200);
    expect((await call('/api/admin/policies', HELPDESK)).status).toBe(403);

    expect((await call('/api/admin/insights', AUDITOR)).status).toBe(200);
    expect((await call('/api/audit-logs', AUDITOR)).status).toBe(200);
    expect((await call('/api/admin/reports/jobs', AUDITOR)).status).toBe(200);
    expect((await call('/api/admin/policies', AUDITOR)).status).toBe(200);
    expect((await call('/api/admin/users', AUDITOR)).status).toBe(403);
    expect((await call('/api/admin/content/search', AUDITOR)).status).toBe(403);

    expect((await call('/api/admin/users', GROUP_MANAGER)).status).toBe(200);
    expect((await call('/api/admin/groups', GROUP_MANAGER)).status).toBe(200);

    expect(
      (await call('/api/admin/content/search', CONTENT_OPERATOR)).status
    ).toBe(200);
    expect((await call('/api/admin/trash', CONTENT_OPERATOR)).status).toBe(200);
    expect(
      (await call('/api/admin/shared-links', CONTENT_OPERATOR)).status
    ).toBe(200);
    expect((await call('/api/admin/users', CONTENT_OPERATOR)).status).toBe(403);

    expect((await call('/api/admin/users', CUSTOM)).status).toBe(200);
    expect((await call('/api/admin/shared-links', CUSTOM)).status).toBe(200);
    expect((await call('/api/admin/insights', CUSTOM)).status).toBe(403);

    const plain = await call('/api/admin/users', PLAIN_MEMBER);
    expect(plain.status).toBe(403);
    expect(plain.body.code).toBe('ADMIN_CAPABILITY_REQUIRED');
  });

  it('blocks privilege escalation to sys_admin, sec_admin, other Co-Admins and self', async () => {
    for (const target of [SYS, SEC, CO_ADMIN_2, HELPDESK]) {
      const res = await call(
        `/api/admin/users/${encodeURIComponent(target)}/suspend`,
        HELPDESK,
        {
          method: 'POST',
          body: { idempotencyKey: `escalation-${target}` },
          extraHeaders: { 'Idempotency-Key': `escalation-${target}` },
        }
      );
      expect(res.status, `suspend ${target}`).toBe(403);
      expect(res.body.code).toBe('PRIVILEGE_ESCALATION_FORBIDDEN');
    }

    for (const [path, method, body] of [
      [`/api/admin/users/${TARGET}`, 'PATCH', { role: 'sec_admin' }],
      [
        '/api/admin/users',
        'POST',
        { email: 'new@example.com', displayName: 'New', role: 'sys_admin' },
      ],
      [
        `/api/admin/users/${TARGET}/offboard`,
        'POST',
        { transferToUserId: SYS, confirmation: 'OFFBOARD' },
      ],
      ['/api/admin/sessions/revoke-all', 'POST', {}],
    ] as const) {
      const res = await call(path, HELPDESK, { method, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.code).toBe('PRIVILEGE_ESCALATION_FORBIDDEN');
    }

    expect(
      (
        await call('/api/admin/policies', HELPDESK, {
          method: 'PATCH',
          body: { enforceCompanyOnlyLinks: true },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call('/api/admin/scim-tokens', HELPDESK, {
          method: 'POST',
          body: { name: 'nope', idpIssuer: 'x' },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call('/api/admin/trash/empty', HELPDESK, {
          method: 'POST',
          body: { confirm: 'EMPTY_TENANT_TRASH' },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call('/api/admin/root-folders', HELPDESK, {
          method: 'POST',
          body: { name: 'Nope', ownerUserId: TARGET },
        })
      ).status
    ).toBe(403);
  });

  it('enforces scopeGroupId on groups, users and sessions', async () => {
    const groups = await call<{ groups: Array<{ id: string }>; total: number }>(
      '/api/admin/groups',
      GROUP_MANAGER
    );
    expect(groups.status).toBe(200);
    expect(groups.body.groups.map((group) => group.id)).toEqual([GROUP_SCOPE]);
    expect(groups.body.total).toBe(1);

    expect(
      (await call(`/api/admin/groups/${GROUP_SCOPE}`, GROUP_MANAGER)).status
    ).toBe(200);
    const otherGroup = await call(
      `/api/admin/groups/${GROUP_OTHER}`,
      GROUP_MANAGER
    );
    expect(otherGroup.status).toBe(403);
    expect(otherGroup.body.code).toBe('OUT_OF_DELEGATION_SCOPE');

    const createGroup = await call('/api/admin/groups', GROUP_MANAGER, {
      method: 'POST',
      body: { name: 'Scoped Create' },
    });
    expect(createGroup.status).toBe(403);
    expect(createGroup.body.code).toBe('OUT_OF_DELEGATION_SCOPE');

    expect(
      (
        await call(`/api/admin/groups/${GROUP_OTHER}`, GROUP_MANAGER, {
          method: 'PATCH',
          body: { name: 'Renamed' },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(`/api/admin/groups/${GROUP_OTHER}/members`, GROUP_MANAGER, {
          method: 'POST',
          body: { userId: TARGET },
        })
      ).status
    ).toBe(403);

    const users = await call<{ users: Array<{ id: string }> }>(
      '/api/admin/users',
      GROUP_MANAGER
    );
    expect(users.status).toBe(200);
    expect(users.body.users.map((user) => user.id).sort()).toEqual(
      [SUSPEND_TARGET, TARGET].sort()
    );
    expect(
      (await call(`/api/admin/users/${OUT_OF_SCOPE}`, GROUP_MANAGER)).status
    ).toBe(403);
    expect(
      (
        await call(`/api/admin/users/${OUT_OF_SCOPE}/suspend`, HELPDESK_SCOPED, {
          method: 'POST',
          body: { idempotencyKey: 'scope-out-suspend' },
          extraHeaders: { 'Idempotency-Key': 'scope-out-suspend' },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(
          `/api/admin/users/${SUSPEND_TARGET}/suspend`,
          HELPDESK_SCOPED,
          {
            method: 'POST',
            body: { idempotencyKey: 'scope-in-suspend' },
            extraHeaders: { 'Idempotency-Key': 'scope-in-suspend' },
          }
        )
      ).status
    ).toBe(200);

    const sessions = await call<{ sessions: Array<{ id: string }> }>(
      '/api/admin/sessions',
      HELPDESK_SCOPED
    );
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions.map((session) => session.id)).toEqual([
      SESSION_TARGET,
    ]);
    expect(
      (
        await call(
          `/api/admin/sessions/${SESSION_OUTSIDE}/revoke`,
          HELPDESK_SCOPED,
          { method: 'POST', body: {} }
        )
      ).status
    ).toBe(403);
    expect(
      (
        await call(
          `/api/admin/sessions/${SESSION_TARGET}/revoke`,
          HELPDESK_SCOPED,
          { method: 'POST', body: {} }
        )
      ).status
    ).toBe(200);
  });

  it('enforces scopeRootFolderId on content, links, trash and file requests', async () => {
    const outsideSearch = await call(
      `/api/admin/content/search?rootFolderId=${ROOT_OTHER}`,
      CONTENT_OPERATOR
    );
    expect(outsideSearch.status).toBe(403);
    expect(outsideSearch.body.code).toBe('OUT_OF_DELEGATION_SCOPE');

    const search = await call<{
      items: Array<{ id: string }>;
      filters: { rootFolderId: string };
    }>('/api/admin/content/search', CONTENT_OPERATOR);
    expect(search.status).toBe(200);
    expect(search.body.filters.rootFolderId).toBe(ROOT_SCOPE);
    const searchIds = search.body.items.map((item) => item.id);
    expect(searchIds).toContain(FILE_SCOPE);
    expect(searchIds).not.toContain(FILE_OUTSIDE);

    expect(
      (await call(`/api/admin/content/file/${FILE_OUTSIDE}`, CONTENT_OPERATOR))
        .status
    ).toBe(403);

    const links = await call<{ links: Array<{ id: string }> }>(
      '/api/admin/shared-links',
      CONTENT_OPERATOR
    );
    expect(links.status).toBe(200);
    expect(links.body.links.map((link) => link.id)).toEqual([LINK_SCOPE]);
    expect(
      (
        await call(`/api/admin/shared-links/${LINK_OUTSIDE}/revoke`, CONTENT_OPERATOR, {
          method: 'POST',
          body: {},
        })
      ).status
    ).toBe(403);

    const trash = await call<{ items: Array<{ id: string }> }>(
      '/api/admin/trash',
      CONTENT_OPERATOR
    );
    expect(trash.status).toBe(200);
    expect(trash.body.items.map((item) => item.id)).toEqual([
      FILE_TRASH_SCOPE,
    ]);
    expect(
      (
        await call('/api/admin/trash/restore', CONTENT_OPERATOR, {
          method: 'POST',
          body: { items: [{ type: 'file', id: FILE_TRASH_OUTSIDE }] },
        })
      ).status
    ).toBe(403);
    const restored = await call<{ succeededCount: number }>(
      '/api/admin/trash/restore',
      CONTENT_OPERATOR,
      {
        method: 'POST',
        body: { items: [{ type: 'file', id: FILE_TRASH_SCOPE }] },
      }
    );
    expect(restored.status).toBe(200);
    expect(restored.body.succeededCount).toBe(1);

    const requests = await call<{ fileRequests: Array<{ id: string }> }>(
      '/api/admin/file-requests',
      CONTENT_OPERATOR
    );
    expect(requests.status).toBe(200);
    expect(requests.body.fileRequests.map((request) => request.id)).toEqual([
      REQUEST_SCOPE,
    ]);
    expect(
      (
        await call(
          `/api/admin/file-requests/${REQUEST_OUTSIDE}/disable`,
          CONTENT_OPERATOR,
          { method: 'POST', body: {} }
        )
      ).status
    ).toBe(403);
  });

  it('projects adminCapabilities and adminScope through /me and bootstrap', async () => {
    const me = await call<{
      user: {
        role: string;
        adminCapabilities: string[];
        adminScope: { groupId: string | null; rootFolderId: string | null } | null;
        token_hash?: string;
      };
    }>('/api/auth/me', CONTENT_OPERATOR);
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('member');
    expect(me.body.user.adminCapabilities).toEqual([
      'admin.content.unlock',
      'admin.trash.manage',
      'admin.links.revoke',
    ]);
    expect(me.body.user.adminScope).toEqual({
      groupId: null,
      rootFolderId: ROOT_SCOPE,
    });
    expect(me.body.user.token_hash).toBeUndefined();

    const bootstrap = await call<{
      user: { adminCapabilities: string[]; adminScope: unknown };
    }>('/api/sync/bootstrap', CONTENT_OPERATOR);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.user.adminCapabilities).toContain(
      'admin.content.unlock'
    );
    expect(bootstrap.body.user.adminScope).toEqual({
      groupId: null,
      rootFolderId: ROOT_SCOPE,
    });

    const sysMe = await call<{
      user: { adminCapabilities: string[]; adminScope: unknown };
    }>('/api/auth/me', SYS, { role: 'sys_admin' });
    expect(sysMe.status).toBe(200);
    expect(sysMe.body.user.adminCapabilities).toHaveLength(15);
    expect(sysMe.body.user.adminScope).toBeNull();

    const plainMe = await call<{
      user: { adminCapabilities: string[]; adminScope: unknown };
    }>('/api/auth/me', PLAIN_MEMBER);
    expect(plainMe.status).toBe(200);
    expect(plainMe.body.user.adminCapabilities).toEqual([]);
    expect(plainMe.body.user.adminScope).toBeNull();
  });

  it('serves GET /api/admin/settings-bundle with strict role, capability and scope isolation', async () => {
    const sysRes = await call<{
      policies: { policy: Record<string, unknown> | null } | null;
      sharedLinks: { links: Array<{ id: string }> } | null;
      ssoStatus: { providers: unknown[] } | null;
      tos: { tos: { enabled: boolean } } | null;
      siem: { siem: { enabled: boolean } } | null;
      sessions: { sessions: Array<{ id: string }> } | null;
      guestInvitations: { invitations: unknown[] } | null;
    }>('/api/admin/settings-bundle', SYS, { role: 'sys_admin' });
    expect(sysRes.status).toBe(200);
    expect(sysRes.body.policies?.policy).not.toBeNull();
    expect(sysRes.body.sharedLinks?.links.map((l) => l.id)).toContain(LINK_SCOPE);
    expect(sysRes.body.ssoStatus).not.toBeNull();
    expect(sysRes.body.tos?.tos).not.toBeUndefined();
    expect(sysRes.body.siem?.siem).not.toBeUndefined();
    expect(sysRes.body.sessions?.sessions).toBeDefined();
    expect(sysRes.body.guestInvitations?.invitations).toBeDefined();

    // sec_admin sees settings surfaces, never tenant guest invitations
    const secRes = await call<typeof sysRes.body>(
      '/api/admin/settings-bundle',
      SEC,
      { role: 'sec_admin' }
    );
    expect(secRes.status).toBe(200);
    expect(secRes.body.policies?.policy).not.toBeNull();
    expect(secRes.body.sharedLinks).not.toBeNull();
    expect(secRes.body.ssoStatus).not.toBeNull();
    expect(secRes.body.tos).not.toBeNull();
    expect(secRes.body.siem).not.toBeNull();
    expect(secRes.body.sessions).not.toBeNull();
    expect(secRes.body.guestInvitations).toBeNull();

    // Co-Admin AUDITOR (admin.policies.read) sees only policies/ssoStatus/tos/siem
    const auditorRes = await call<typeof sysRes.body>(
      '/api/admin/settings-bundle',
      AUDITOR
    );
    expect(auditorRes.status).toBe(200);
    expect(auditorRes.body.policies).not.toBeNull();
    expect(auditorRes.body.ssoStatus).not.toBeNull();
    expect(auditorRes.body.tos).not.toBeNull();
    expect(auditorRes.body.siem).not.toBeNull();
    expect(auditorRes.body.sharedLinks).toBeNull();
    expect(auditorRes.body.sessions).toBeNull();
    expect(auditorRes.body.guestInvitations).toBeNull();

    // Co-Admin CONTENT_OPERATOR (admin.links.revoke + scopeRootFolderId=ROOT_SCOPE)
    // sees only scoped sharedLinks, never policies/tos/siem/sessions
    const contentOpRes = await call<typeof sysRes.body>(
      '/api/admin/settings-bundle',
      CONTENT_OPERATOR
    );
    expect(contentOpRes.status).toBe(200);
    expect(contentOpRes.body.policies).toBeNull();
    expect(contentOpRes.body.ssoStatus).toBeNull();
    expect(contentOpRes.body.tos).toBeNull();
    expect(contentOpRes.body.siem).toBeNull();
    expect(contentOpRes.body.sessions).toBeNull();
    expect(contentOpRes.body.guestInvitations).toBeNull();
    const scopedLinks = contentOpRes.body.sharedLinks?.links.map((l) => l.id) ?? [];
    expect(scopedLinks).toContain(LINK_SCOPE);
    expect(scopedLinks).not.toContain(LINK_OUTSIDE);

    // Co-Admin GROUP_MANAGER (admin.users.read + scopeGroupId=GROUP_SCOPE)
    // sees only group-scoped sessions
    const groupMgrRes = await call<typeof sysRes.body>(
      '/api/admin/settings-bundle',
      GROUP_MANAGER
    );
    expect(groupMgrRes.status).toBe(200);
    expect(groupMgrRes.body.policies).toBeNull();
    expect(groupMgrRes.body.sharedLinks).toBeNull();
    expect(groupMgrRes.body.sessions).not.toBeNull();
    const scopedSessionIds = groupMgrRes.body.sessions?.sessions.map((s) => s.id) ?? [];
    expect(scopedSessionIds).not.toContain(SESSION_OUTSIDE);

    // Plain member & guest rejected
    expect((await call('/api/admin/settings-bundle', PLAIN_MEMBER)).status).toBe(403);
    expect((await call('/api/admin/settings-bundle', GUEST)).status).toBe(403);
  });
});
