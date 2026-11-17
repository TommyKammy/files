import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sha256Hex } from '../src/services/crypto-utils';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-admin-groups';
const OTHER_TENANT = 'tenant-admin-groups-other';
const SYS = 'gp-sys';
const SEC = 'gp-sec';
const MEMBER = 'gp-member';
const MEMBER2 = 'gp-member-2';
const GUEST = 'gp-guest';
const OTHER_SYS = 'gp-other-sys';
const OTHER_MEMBER = 'gp-other-member';
const APP_ORIGIN = 'http://127.0.0.1:8787';
const SCIM_SEED_TOKEN = 'scim_seed_plaintext_token_for_tests';

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
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
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

async function scimCall(
  token: string,
  path = '/scim/v2/Users'
): Promise<ApiResponse<Record<string, unknown>>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/scim+json',
      },
    }),
    buildTestEnv()
  );
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
    headers: response.headers,
  };
}

async function auditCount(action: string, targetId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM audit_logs WHERE action = ? AND target_id = ?'
  )
    .bind(action, targetId)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

describe('P11-3 / TOM-69 admin group & SCIM token management', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const seedTokenHash = await sha256Hex(SCIM_SEED_TOKEN);
    const otherTokenHash = await sha256Hex('scim_other_tenant_token');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug)
         VALUES (?, 'Admin Groups', 'admin-groups'),
                (?, 'Admin Groups Other', 'admin-groups-other')`
      ).bind(TENANT, OTHER_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?), (?)`
      ).bind(TENANT, OTHER_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (
           id, tenant_id, email, display_name, department, role, status, user_type
         ) VALUES
           (?, ?, 'gp-sys@example.com', 'Group Sys', 'IT', 'sys_admin', 'active', 'member'),
           (?, ?, 'gp-sec@example.com', 'Group Sec', 'Security', 'sec_admin', 'active', 'member'),
           (?, ?, 'gp-member@example.com', 'Group Member', 'Engineering', 'member', 'active', 'member'),
           (?, ?, 'gp-member-2@example.com', 'Group Member Two', 'Sales', 'member', 'active', 'member'),
           (?, ?, 'gp-guest@example.com', 'Group Guest', 'Partner', 'member', 'active', 'guest'),
           (?, ?, 'gp-other-sys@example.com', 'Other Sys', 'IT', 'sys_admin', 'active', 'member'),
           (?, ?, 'gp-other-member@example.com', 'Other Member', 'IT', 'member', 'active', 'member')`
      ).bind(
        SYS,
        TENANT,
        SEC,
        TENANT,
        MEMBER,
        TENANT,
        MEMBER2,
        TENANT,
        GUEST,
        TENANT,
        OTHER_SYS,
        OTHER_TENANT,
        OTHER_MEMBER,
        OTHER_TENANT
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO groups (id, tenant_id, external_idp_id, name)
         VALUES
           ('gp-list', ?, NULL, 'List Group'),
           ('gp-detail', ?, NULL, 'Detail Group'),
           ('gp-rename', ?, NULL, 'Rename Group'),
           ('gp-members', ?, NULL, 'Members Group'),
           ('gp-owner-only', ?, NULL, 'Owner Only'),
           ('gp-owner-safe', ?, NULL, 'Owner Safe'),
           ('gp-scim', ?, 'scim-group-1', 'SCIM Team'),
           ('gp-other', ?, NULL, 'Other Tenant Group')`
      ).bind(
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
        `INSERT OR IGNORE INTO group_members (group_id, user_id)
         VALUES ('gp-list', ?),
                ('gp-detail', ?),
                ('gp-owner-only', ?),
                ('gp-owner-safe', ?),
                ('gp-scim', ?),
                ('gp-other', ?)`
      ).bind(MEMBER, MEMBER, MEMBER, MEMBER, MEMBER, OTHER_MEMBER),
      env.DB.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, user_id)
         VALUES ('gp-detail', ?)`
      ).bind(MEMBER2),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification, created_by
         ) VALUES
           ('gp-folder-safe', ?, NULL, 'Owner Safe', 0, 1, 'internal', ?),
           ('gp-folder-owner-only', ?, NULL, 'Owner Only Folder', 0, 1, 'internal', ?)`
      ).bind(TENANT, SYS, TENANT, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, 'gp-folder-safe', 'gp-folder-safe', 0),
                (?, 'gp-folder-owner-only', 'gp-folder-owner-only', 0)`
      ).bind(TENANT, TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_num, classification, created_by, updated_by
         ) VALUES (
           'gp-file-1', ?, 'gp-folder-safe', 'quarterly.pdf', 'pdf',
           'application/pdf', 1024, 'active', 1, 'internal', ?, ?
         )`
      ).bind(TENANT, SYS, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by
         ) VALUES
           ('gp-perm-owner-only', ?, 'folder', 'gp-folder-owner-only', 'group', 'gp-owner-only', 'owner', ?),
           ('gp-perm-safe-group', ?, 'folder', 'gp-folder-safe', 'group', 'gp-owner-safe', 'owner', ?),
           ('gp-perm-safe-user', ?, 'folder', 'gp-folder-safe', 'user', ?, 'owner', ?),
           ('gp-perm-detail-folder', ?, 'folder', 'gp-folder-safe', 'group', 'gp-detail', 'viewer', ?),
           ('gp-perm-detail-file', ?, 'file', 'gp-file-1', 'group', 'gp-detail', 'editor', ?)`
      ).bind(
        TENANT,
        SYS,
        TENANT,
        SYS,
        TENANT,
        MEMBER,
        SYS,
        TENANT,
        SYS,
        TENANT,
        SYS
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO scim_tokens (
           id, tenant_id, idp_issuer, name, token_hash, last_used_at, revoked_at, created_at
         ) VALUES
           ('gp-scim-seed', ?, 'https://seed.example.com', 'Seed Provisioning', ?, NULL, NULL, '2026-11-01T00:00:00.000Z'),
           ('gp-other-token', ?, 'https://other.example.com', 'Other Tenant Token', ?, NULL, NULL, '2026-11-01T00:00:00.000Z')`
      ).bind(TENANT, seedTokenHash, OTHER_TENANT, otherTokenHash),
    ]);
  });

  it('lists tenant groups with member/permission counts, filters and summary', async () => {
    const list = await call<{
      groups: Array<{
        id: string;
        name: string;
        source: string;
        externalIdpId: string | null;
        memberCount: number;
        permissionCount: number;
      }>;
      total: number;
      summary: { total: number; manualCount: number; scimCount: number };
    }>('/api/admin/groups', SEC, { role: 'sec_admin' });

    expect(list.status).toBe(200);
    expect(list.body.total).toBe(7);
    expect(list.body.summary).toEqual({ total: 7, manualCount: 6, scimCount: 1 });
    expect(list.body.groups.map((group) => group.id)).not.toContain('gp-other');

    const detail = list.body.groups.find((group) => group.id === 'gp-detail');
    expect(detail).toMatchObject({
      name: 'Detail Group',
      source: 'manual',
      externalIdpId: null,
      memberCount: 2,
      permissionCount: 2,
    });
    const scim = list.body.groups.find((group) => group.id === 'gp-scim');
    expect(scim).toMatchObject({
      source: 'scim',
      externalIdpId: 'scim-group-1',
      memberCount: 1,
    });

    const searched = await call<{
      groups: Array<{ id: string; source: string }>;
      total: number;
    }>('/api/admin/groups?query=SCIM', SEC, { role: 'sec_admin' });
    expect(searched.status).toBe(200);
    expect(searched.body.groups.map((group) => group.id)).toEqual(['gp-scim']);
    expect(searched.body.total).toBe(1);

    const manual = await call<{ groups: Array<{ source: string }>; total: number }>(
      '/api/admin/groups?source=manual',
      SEC,
      { role: 'sec_admin' }
    );
    expect(manual.status).toBe(200);
    expect(manual.body.total).toBe(6);
    expect(manual.body.groups.every((group) => group.source === 'manual')).toBe(true);

    const scimOnly = await call<{ groups: Array<{ source: string }>; total: number }>(
      '/api/admin/groups?source=scim',
      SEC,
      { role: 'sec_admin' }
    );
    expect(scimOnly.status).toBe(200);
    expect(scimOnly.body.total).toBe(1);
    expect(scimOnly.body.groups[0]?.source).toBe('scim');

    const invalid = await call('/api/admin/groups?source=unknown', SEC, {
      role: 'sec_admin',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_GROUP_SOURCE_FILTER');

    const other = await call<{
      groups: Array<{ id: string }>;
      total: number;
      summary: { total: number; manualCount: number; scimCount: number };
    }>(
      '/api/admin/groups',
      OTHER_SYS,
      { role: 'sys_admin', tenantId: OTHER_TENANT }
    );
    expect(other.status).toBe(200);
    expect(other.body.groups.map((group) => group.id)).toEqual(['gp-other']);
    expect(other.body.summary).toEqual({ total: 1, manualCount: 1, scimCount: 0 });
  });

  it('returns group detail members and ACL targets with folder paths', async () => {
    const detail = await call<{
      group: { id: string; name: string; source: string };
      members: Array<{
        id: string;
        email: string;
        displayName: string;
        department: string | null;
        role: string;
        status: string;
      }>;
      permissions: Array<{
        targetType: string;
        targetId: string;
        targetName: string;
        targetPath: string;
        role: string;
      }>;
      scimManaged: boolean;
    }>('/api/admin/groups/gp-detail', SEC, { role: 'sec_admin' });

    expect(detail.status).toBe(200);
    expect(detail.body.group).toMatchObject({
      id: 'gp-detail',
      name: 'Detail Group',
      source: 'manual',
    });
    expect(detail.body.scimManaged).toBe(false);
    expect(detail.body.members.map((member) => member.email)).toEqual([
      'gp-member-2@example.com',
      'gp-member@example.com',
    ]);
    expect(detail.body.members[1]).toMatchObject({
      id: MEMBER,
      displayName: 'Group Member',
      department: 'Engineering',
      role: 'member',
      status: 'active',
    });

    expect(detail.body.permissions).toHaveLength(2);
    const folderPermission = detail.body.permissions.find(
      (permission) => permission.targetType === 'folder'
    );
    expect(folderPermission).toMatchObject({
      targetId: 'gp-folder-safe',
      targetName: 'Owner Safe',
      targetPath: 'Owner Safe',
      role: 'viewer',
    });
    const filePermission = detail.body.permissions.find(
      (permission) => permission.targetType === 'file'
    );
    expect(filePermission).toMatchObject({
      targetId: 'gp-file-1',
      targetName: 'quarterly.pdf',
      targetPath: 'Owner Safe',
      role: 'editor',
    });

    const scimDetail = await call<{ scimManaged: boolean }>(
      '/api/admin/groups/gp-scim',
      SEC,
      { role: 'sec_admin' }
    );
    expect(scimDetail.status).toBe(200);
    expect(scimDetail.body.scimManaged).toBe(true);

    const missing = await call('/api/admin/groups/gp-missing', SEC, {
      role: 'sec_admin',
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('GROUP_NOT_FOUND');

    const crossTenant = await call('/api/admin/groups/gp-detail', OTHER_SYS, {
      role: 'sys_admin',
      tenantId: OTHER_TENANT,
    });
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.code).toBe('GROUP_NOT_FOUND');
  });

  it('enforces sec_admin read-only and member/guest denial', async () => {
    const listAsSec = await call('/api/admin/groups', SEC, { role: 'sec_admin' });
    expect(listAsSec.status).toBe(200);

    const createAsSec = await call('/api/admin/groups', SEC, {
      role: 'sec_admin',
      method: 'POST',
      body: { name: 'Sec Cannot Create' },
    });
    expect(createAsSec.status).toBe(403);
    expect(createAsSec.body.code).toBe('SYS_ADMIN_REQUIRED');

    const renameAsSec = await call('/api/admin/groups/gp-rename', SEC, {
      role: 'sec_admin',
      method: 'PATCH',
      body: { name: 'Sec Cannot Rename' },
    });
    expect(renameAsSec.status).toBe(403);
    expect(renameAsSec.body.code).toBe('SYS_ADMIN_REQUIRED');

    const deleteAsSec = await call('/api/admin/groups/gp-rename', SEC, {
      role: 'sec_admin',
      method: 'DELETE',
    });
    expect(deleteAsSec.status).toBe(403);

    const addAsSec = await call('/api/admin/groups/gp-members/members', SEC, {
      role: 'sec_admin',
      method: 'POST',
      body: { userId: MEMBER },
    });
    expect(addAsSec.status).toBe(403);

    const removeAsSec = await call(
      `/api/admin/groups/gp-members/members/${MEMBER}`,
      SEC,
      { role: 'sec_admin', method: 'DELETE' }
    );
    expect(removeAsSec.status).toBe(403);

    const listAsMember = await call('/api/admin/groups', MEMBER, {
      role: 'member',
    });
    expect(listAsMember.status).toBe(403);

    const listAsGuest = await call('/api/admin/groups', GUEST, {
      role: 'member',
      userType: 'guest',
    });
    expect(listAsGuest.status).toBe(403);
    expect(listAsGuest.body.code).toBe('GUEST_FORBIDDEN');
  });

  it('creates manual groups, rejects duplicates and records audit/sync events', async () => {
    const created = await call<{
      ok: boolean;
      group: {
        id: string;
        name: string;
        source: string;
        memberCount: number;
        permissionCount: number;
      };
      syncSeq: number | null;
    }>('/api/admin/groups', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { name: '  New Manual Group  ' },
    });
    expect(created.status).toBe(201);
    expect(created.body.group).toMatchObject({
      name: 'New Manual Group',
      source: 'manual',
      memberCount: 0,
      permissionCount: 0,
    });
    expect(typeof created.body.syncSeq).toBe('number');

    const groupId = created.body.group.id;
    expect(await auditCount('admin.group.create', groupId)).toBe(1);
    const sync = await env.DB.prepare(
      'SELECT entity_type, payload_json FROM sync_changes WHERE action = ? AND entity_id = ?'
    )
      .bind('admin.group.create', groupId)
      .first<{ entity_type: string; payload_json: string }>();
    expect(sync?.entity_type).toBe('permission');
    expect(JSON.parse(sync?.payload_json ?? '{}')).toMatchObject({
      groupId,
      granteeType: 'group',
      granteeId: groupId,
      name: 'New Manual Group',
    });

    const duplicate = await call('/api/admin/groups', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { name: 'New Manual Group' },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('GROUP_ALREADY_EXISTS');

    const duplicateCaseInsensitive = await call('/api/admin/groups', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { name: 'new manual group' },
    });
    expect(duplicateCaseInsensitive.status).toBe(409);
    expect(duplicateCaseInsensitive.body.code).toBe('GROUP_ALREADY_EXISTS');

    const invalid = await call('/api/admin/groups', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { name: '   ' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_GROUP_NAME');

    const noBody = await call('/api/admin/groups', SYS, {
      role: 'sys_admin',
      method: 'POST',
    });
    expect(noBody.status).toBe(400);
    expect(noBody.body.code).toBe('INVALID_BODY');
  });

  it('renames manual groups and protects SCIM-managed groups', async () => {
    const renamed = await call<{
      group: { id: string; name: string; source: string };
      syncSeq: number | null;
    }>('/api/admin/groups/gp-rename', SYS, {
      role: 'sys_admin',
      method: 'PATCH',
      body: { name: 'Rename Group Updated' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.group).toMatchObject({
      id: 'gp-rename',
      name: 'Rename Group Updated',
      source: 'manual',
    });
    expect(await auditCount('admin.group.update', 'gp-rename')).toBe(1);

    const duplicate = await call('/api/admin/groups/gp-rename', SYS, {
      role: 'sys_admin',
      method: 'PATCH',
      body: { name: 'List Group' },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('GROUP_ALREADY_EXISTS');

    const scimRename = await call('/api/admin/groups/gp-scim', SYS, {
      role: 'sys_admin',
      method: 'PATCH',
      body: { name: 'SCIM Renamed Locally' },
    });
    expect(scimRename.status).toBe(409);
    expect(scimRename.body.code).toBe('SCIM_MANAGED_GROUP');

    const missing = await call('/api/admin/groups/gp-missing', SYS, {
      role: 'sys_admin',
      method: 'PATCH',
      body: { name: 'Nope' },
    });
    expect(missing.status).toBe(404);

    const crossTenant = await call('/api/admin/groups/gp-detail', OTHER_SYS, {
      role: 'sys_admin',
      tenantId: OTHER_TENANT,
      method: 'PATCH',
      body: { name: 'Cross Tenant Rename' },
    });
    expect(crossTenant.status).toBe(404);
  });

  it('adds and removes manual group members with tenant/type validation', async () => {
    const added = await call<{
      ok: boolean;
      addedUserIds: string[];
      alreadyMemberUserIds: string[];
      memberCount: number;
    }>('/api/admin/groups/gp-members/members', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { userIds: [MEMBER, MEMBER2] },
    });
    expect(added.status).toBe(200);
    expect(added.body.addedUserIds).toEqual([MEMBER, MEMBER2]);
    expect(added.body.alreadyMemberUserIds).toEqual([]);
    expect(added.body.memberCount).toBe(2);
    expect(await auditCount('admin.group.member_add', 'gp-members')).toBe(1);

    const again = await call<{
      addedUserIds: string[];
      alreadyMemberUserIds: string[];
      memberCount: number;
    }>('/api/admin/groups/gp-members/members', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { userId: MEMBER },
    });
    expect(again.status).toBe(200);
    expect(again.body.addedUserIds).toEqual([]);
    expect(again.body.alreadyMemberUserIds).toEqual([MEMBER]);
    expect(again.body.memberCount).toBe(2);

    const guest = await call('/api/admin/groups/gp-members/members', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { userIds: [GUEST] },
    });
    expect(guest.status).toBe(400);
    expect(guest.body.code).toBe('INVALID_GROUP_MEMBER');

    const crossTenantMember = await call(
      '/api/admin/groups/gp-members/members',
      SYS,
      {
        role: 'sys_admin',
        method: 'POST',
        body: { userIds: [OTHER_MEMBER] },
      }
    );
    expect(crossTenantMember.status).toBe(404);
    expect(crossTenantMember.body.code).toBe('MEMBER_NOT_FOUND');

    const unknown = await call('/api/admin/groups/gp-members/members', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { userIds: ['gp-unknown'] },
    });
    expect(unknown.status).toBe(404);

    const empty = await call('/api/admin/groups/gp-members/members', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { userIds: [] },
    });
    expect(empty.status).toBe(400);

    const scimAdd = await call('/api/admin/groups/gp-scim/members', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { userId: MEMBER2 },
    });
    expect(scimAdd.status).toBe(409);
    expect(scimAdd.body.code).toBe('SCIM_MANAGED_GROUP');

    const removed = await call<{ memberCount: number }>(
      `/api/admin/groups/gp-members/members/${MEMBER}`,
      SYS,
      { role: 'sys_admin', method: 'DELETE' }
    );
    expect(removed.status).toBe(200);
    expect(removed.body.memberCount).toBe(1);
    expect(await auditCount('admin.group.member_remove', 'gp-members')).toBe(1);

    const notMember = await call(
      `/api/admin/groups/gp-members/members/${MEMBER}`,
      SYS,
      { role: 'sys_admin', method: 'DELETE' }
    );
    expect(notMember.status).toBe(404);
    expect(notMember.body.code).toBe('MEMBER_NOT_IN_GROUP');

    const scimRemove = await call(
      `/api/admin/groups/gp-scim/members/${MEMBER}`,
      SYS,
      { role: 'sys_admin', method: 'DELETE' }
    );
    expect(scimRemove.status).toBe(409);

    const detail = await call<{ members: Array<{ id: string }> }>(
      '/api/admin/groups/gp-members',
      SYS,
      { role: 'sys_admin' }
    );
    expect(detail.body.members.map((member) => member.id)).toEqual([MEMBER2]);
  });

  it('refuses to delete the last effective owner group and cascades normal deletes atomically', async () => {
    const lastOwner = await call('/api/admin/groups/gp-owner-only', SYS, {
      role: 'sys_admin',
      method: 'DELETE',
    });
    expect(lastOwner.status).toBe(409);
    expect(lastOwner.body.code).toBe('LAST_OWNER_REQUIRED');

    const stillThere = await call('/api/admin/groups/gp-owner-only', SYS, {
      role: 'sys_admin',
    });
    expect(stillThere.status).toBe(200);

    const scimDelete = await call('/api/admin/groups/gp-scim', SYS, {
      role: 'sys_admin',
      method: 'DELETE',
    });
    expect(scimDelete.status).toBe(409);
    expect(scimDelete.body.code).toBe('SCIM_MANAGED_GROUP');

    const secDelete = await call('/api/admin/groups/gp-owner-safe', SEC, {
      role: 'sec_admin',
      method: 'DELETE',
    });
    expect(secDelete.status).toBe(403);

    const deleted = await call<{
      ok: boolean;
      deletedPermissions: number;
      deletedMembers: number;
      syncSeq: number | null;
    }>('/api/admin/groups/gp-owner-safe', SYS, {
      role: 'sys_admin',
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deletedPermissions).toBe(1);
    expect(deleted.body.deletedMembers).toBe(1);
    expect(typeof deleted.body.syncSeq).toBe('number');

    const groupRow = await env.DB.prepare('SELECT id FROM groups WHERE id = ?')
      .bind('gp-owner-safe')
      .first<{ id: string }>();
    expect(groupRow).toBeNull();
    const memberRow = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?'
    )
      .bind('gp-owner-safe')
      .first<{ cnt: number }>();
    expect(memberRow?.cnt).toBe(0);
    const groupPermission = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM permissions
        WHERE grantee_type = 'group' AND grantee_id = ?`
    )
      .bind('gp-owner-safe')
      .first<{ cnt: number }>();
    expect(groupPermission?.cnt).toBe(0);
    const userOwner = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM permissions
        WHERE id = 'gp-perm-safe-user'`
    ).first<{ cnt: number }>();
    expect(userOwner?.cnt).toBe(1);
    expect(await auditCount('admin.group.delete', 'gp-owner-safe')).toBe(1);

    const sync = await env.DB.prepare(
      'SELECT payload_json FROM sync_changes WHERE action = ? AND entity_id = ?'
    )
      .bind('admin.group.delete', 'gp-owner-safe')
      .first<{ payload_json: string }>();
    expect(JSON.parse(sync?.payload_json ?? '{}')).toMatchObject({
      groupId: 'gp-owner-safe',
      name: 'Owner Safe',
      memberCount: 1,
      permissionCount: 1,
    });

    const crossTenant = await call('/api/admin/groups/gp-detail', OTHER_SYS, {
      role: 'sys_admin',
      tenantId: OTHER_TENANT,
      method: 'DELETE',
    });
    expect(crossTenant.status).toBe(404);
  });

  it('lists SCIM tokens without hashes and issues plaintext exactly once', async () => {
    const list = await call<{
      tokens: Array<{
        id: string;
        name: string;
        idpIssuer: string;
        lastUsedAt: string | null;
        revokedAt: string | null;
        createdAt: string;
        status: string;
      }>;
      total: number;
      activeCount: number;
      revokedCount: number;
      endpoint: string;
    }>('/api/admin/scim-tokens', SEC, { role: 'sec_admin' });

    expect(list.status).toBe(200);
    expect(list.body.endpoint).toBe('/scim/v2');
    expect(list.body.tokens.map((token) => token.id)).toEqual(['gp-scim-seed']);
    expect(list.body).toMatchObject({ total: 1, activeCount: 1, revokedCount: 0 });
    expect(list.body.tokens[0]).toMatchObject({
      name: 'Seed Provisioning',
      idpIssuer: 'https://seed.example.com',
      status: 'active',
      revokedAt: null,
    });
    expect(JSON.stringify(list.body)).not.toContain('token_hash');
    const seedRow = await env.DB.prepare(
      'SELECT token_hash FROM scim_tokens WHERE id = ?'
    )
      .bind('gp-scim-seed')
      .first<{ token_hash: string }>();
    expect(JSON.stringify(list.body)).not.toContain(seedRow?.token_hash);

    const created = await call<{
      token: string;
      scimToken: {
        id: string;
        name: string;
        idpIssuer: string;
        status: string;
        lastUsedAt: string | null;
      };
    }>('/api/admin/scim-tokens', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { name: 'Provisioning Token', idpIssuer: 'https://idp.example.com' },
    });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^scim_[A-Za-z0-9_-]+$/);
    expect(created.body.scimToken).toMatchObject({
      name: 'Provisioning Token',
      idpIssuer: 'https://idp.example.com',
      status: 'active',
      lastUsedAt: null,
    });
    expect(JSON.stringify(created.body.scimToken)).not.toContain('token_hash');

    const plaintext = created.body.token;
    const tokenId = created.body.scimToken.id;
    const dbRow = await env.DB.prepare(
      'SELECT token_hash, name, idp_issuer FROM scim_tokens WHERE id = ?'
    )
      .bind(tokenId)
      .first<{ token_hash: string; name: string; idp_issuer: string }>();
    expect(dbRow?.token_hash).toBe(await sha256Hex(plaintext));
    expect(dbRow?.token_hash).not.toBe(plaintext);

    const audit = await env.DB.prepare(
      'SELECT metadata_json FROM audit_logs WHERE action = ? AND target_id = ?'
    )
      .bind('admin.scim_token.create', tokenId)
      .first<{ metadata_json: string }>();
    expect(audit?.metadata_json).not.toContain(plaintext);
    expect(audit?.metadata_json).not.toContain(await sha256Hex(plaintext));

    const auth = await scimCall(plaintext);
    expect(auth.status).toBe(200);
    expect(auth.body.schemas).toContain(
      'urn:ietf:params:scim:api:messages:2.0:ListResponse'
    );

    const afterUse = await call<{
      tokens: Array<{ id: string; lastUsedAt: string | null }>;
    }>('/api/admin/scim-tokens', SEC, { role: 'sec_admin' });
    const used = afterUse.body.tokens.find((token) => token.id === tokenId);
    expect(used?.lastUsedAt).toBeTruthy();

    const secCreate = await call('/api/admin/scim-tokens', SEC, {
      role: 'sec_admin',
      method: 'POST',
      body: { name: 'Sec Token', idpIssuer: 'https://idp.example.com' },
    });
    expect(secCreate.status).toBe(403);
    expect(secCreate.body.code).toBe('SYS_ADMIN_REQUIRED');

    const invalid = await call('/api/admin/scim-tokens', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: { name: '', idpIssuer: '' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_SCIM_TOKEN_NAME');
  });

  it('rotates and revokes SCIM tokens with old-token rejection', async () => {
    const created = await call<{
      token: string;
      scimToken: { id: string; name: string; idpIssuer: string };
    }>('/api/admin/scim-tokens', SYS, {
      role: 'sys_admin',
      method: 'POST',
      body: {
        name: 'Rotating Token',
        idpIssuer: 'https://rotate.example.com',
      },
    });
    expect(created.status).toBe(201);
    const oldToken = created.body.token;
    const oldId = created.body.scimToken.id;

    const rotated = await call<{
      token: string;
      revokedTokenId: string;
      scimToken: { id: string; name: string; idpIssuer: string; status: string };
    }>(`/api/admin/scim-tokens/${oldId}/rotate`, SYS, {
      role: 'sys_admin',
      method: 'POST',
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.revokedTokenId).toBe(oldId);
    expect(rotated.body.token).not.toBe(oldToken);
    expect(rotated.body.scimToken).toMatchObject({
      name: 'Rotating Token',
      idpIssuer: 'https://rotate.example.com',
      status: 'active',
    });
    expect(rotated.body.scimToken.id).not.toBe(oldId);

    const oldAuth = await scimCall(oldToken);
    expect(oldAuth.status).toBe(401);
    const newAuth = await scimCall(rotated.body.token);
    expect(newAuth.status).toBe(200);

    const oldRow = await env.DB.prepare(
      'SELECT revoked_at FROM scim_tokens WHERE id = ?'
    )
      .bind(oldId)
      .first<{ revoked_at: string | null }>();
    expect(oldRow?.revoked_at).toBeTruthy();
    expect(await auditCount('admin.scim_token.rotate', oldId)).toBe(1);
    expect(
      await auditCount('admin.scim_token.rotate', rotated.body.scimToken.id)
    ).toBe(0);

    const rotateAgain = await call(`/api/admin/scim-tokens/${oldId}/rotate`, SYS, {
      role: 'sys_admin',
      method: 'POST',
    });
    expect(rotateAgain.status).toBe(409);
    expect(rotateAgain.body.code).toBe('TOKEN_ALREADY_REVOKED');

    const revoked = await call<{
      alreadyRevoked?: boolean;
      scimToken: { status: string; revokedAt: string | null };
    }>(`/api/admin/scim-tokens/${rotated.body.scimToken.id}/revoke`, SYS, {
      role: 'sys_admin',
      method: 'POST',
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.scimToken.status).toBe('revoked');
    expect(revoked.body.scimToken.revokedAt).toBeTruthy();
    expect(revoked.body.alreadyRevoked).toBeUndefined();

    const revokedAuth = await scimCall(rotated.body.token);
    expect(revokedAuth.status).toBe(401);

    const revokedAgain = await call<{ alreadyRevoked: boolean }>(
      `/api/admin/scim-tokens/${rotated.body.scimToken.id}/revoke`,
      SYS,
      { role: 'sys_admin', method: 'POST' }
    );
    expect(revokedAgain.status).toBe(200);
    expect(revokedAgain.body.alreadyRevoked).toBe(true);
    expect(
      await auditCount('admin.scim_token.revoke', rotated.body.scimToken.id)
    ).toBe(1);

    const secRotate = await call(`/api/admin/scim-tokens/gp-scim-seed/rotate`, SEC, {
      role: 'sec_admin',
      method: 'POST',
    });
    expect(secRotate.status).toBe(403);
    const secRevoke = await call(`/api/admin/scim-tokens/gp-scim-seed/revoke`, SEC, {
      role: 'sec_admin',
      method: 'POST',
    });
    expect(secRevoke.status).toBe(403);

    const crossTenant = await call('/api/admin/scim-tokens/gp-other-token/rotate', SYS, {
      role: 'sys_admin',
      method: 'POST',
    });
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.code).toBe('SCIM_TOKEN_NOT_FOUND');

    const crossTenantRevoke = await call(
      '/api/admin/scim-tokens/gp-other-token/revoke',
      SYS,
      { role: 'sys_admin', method: 'POST' }
    );
    expect(crossTenantRevoke.status).toBe(404);

    const otherList = await call<{ tokens: Array<{ id: string }> }>(
      '/api/admin/scim-tokens',
      OTHER_SYS,
      { role: 'sys_admin', tenantId: OTHER_TENANT }
    );
    expect(otherList.status).toBe(200);
    expect(otherList.body.tokens.map((token) => token.id)).toEqual([
      'gp-other-token',
    ]);

    const finalList = await call<{
      tokens: Array<{ id: string; status: string }>;
      activeCount: number;
      revokedCount: number;
    }>('/api/admin/scim-tokens', SYS, { role: 'sys_admin' });
    expect(finalList.body.revokedCount).toBeGreaterThanOrEqual(1);
    expect(
      finalList.body.tokens.find(
        (token) => token.id === rotated.body.scimToken.id
      )?.status
    ).toBe('revoked');
    expect(finalList.body.activeCount).toBeGreaterThanOrEqual(1);
  });
});
