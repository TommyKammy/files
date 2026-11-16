import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-admin-trash';
const OTHER_TENANT = 'tenant-admin-trash-other';
const EMPTY_TENANT = 'tenant-admin-trash-empty';

const ROOT = 'at-root';
const SECRET = 'at-secret';
const PRIVATE = 'at-private';
const OTHER_ROOT = 'at-other-root';
const EMPTY_ROOT = 'at-empty-root';

const USERS = {
  admin: 'at-admin',
  sec: 'at-sec',
  member: 'at-member',
  otherMember: 'at-other-member',
  outsider: 'at-outsider',
  otherAdmin: 'at-other-admin',
  otherMember2: 'at-other-member-2',
  emptyAdmin: 'at-empty-admin',
  emptySec: 'at-empty-sec',
  emptyMember: 'at-empty-member',
} as const;

const ROLE_BY_USER: Record<
  string,
  'sys_admin' | 'sec_admin' | 'member'
> = {
  [USERS.admin]: 'sys_admin',
  [USERS.sec]: 'sec_admin',
  [USERS.member]: 'member',
  [USERS.otherMember]: 'member',
  [USERS.outsider]: 'member',
  [USERS.otherAdmin]: 'sys_admin',
  [USERS.otherMember2]: 'member',
  [USERS.emptyAdmin]: 'sys_admin',
  [USERS.emptySec]: 'sec_admin',
  [USERS.emptyMember]: 'member',
};

interface AdminTrashItemBody {
  type: 'file' | 'folder';
  id: string;
  name: string;
  classification: string;
  sizeBytes: number | null;
  currentVersionNum: number;
  parentFolder: { id: string; name: string } | null;
  owner: { id: string; name: string; email: string | null } | null;
  deletedBy: { id: string; name: string; email: string | null } | null;
  deletedAt: string;
  purgeAt: string;
  daysRemaining: number;
  permissionSummary: {
    total: number;
    direct: number;
    inherited: number;
    userCount: number;
    groupCount: number;
    roles: Record<string, number>;
    sharedLinkCount: number;
  };
}

interface AdminTrashListBody {
  type: string;
  items: AdminTrashItemBody[];
  owners: Array<{ id: string; name: string; email: string | null }>;
  deleters: Array<{ id: string; name: string; email: string | null }>;
  hasUnknownDeleter: boolean;
  nextCursor: string | null;
  hasMore: boolean;
  trashRetentionDays: number;
  limit: number;
  sort: string;
}

interface BulkItemResult {
  type: 'file' | 'folder';
  id: string;
  ok: boolean;
  status: 'succeeded' | 'failed' | 'skipped';
  code?: string;
  error?: string;
  name?: string;
}

interface BulkResponse {
  ok: boolean;
  results: BulkItemResult[];
  succeededCount: number;
  failedCount: number;
  skippedCount?: number;
}

interface EmptyResponse {
  ok: boolean;
  deletedCount: number;
  failedCount: number;
  skippedCount: number;
  results: BulkItemResult[];
}

interface AuditLogRow {
  id: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = ROLE_BY_USER[userId] ?? 'member',
  tenantId = TENANT
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@example.com`,
    'Content-Type': 'application/json',
  };
}

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
  } as OidcEnv;
}

async function call(
  path: string,
  input: {
    method?: string;
    user?: string;
    role?: 'sys_admin' | 'sec_admin' | 'member';
    tenantId?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const user = input.user ?? USERS.admin;
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: input.method ?? 'GET',
      headers: authHeaders(
        user,
        input.role ?? ROLE_BY_USER[user] ?? 'member',
        input.tenantId ?? TENANT
      ),
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    }),
    buildTestEnv()
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function insertFolder(input: {
  tenantId?: string;
  id: string;
  parentId: string | null;
  name: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  classification?: 'unset' | 'confidential' | 'internal' | 'public';
  createdBy?: string;
  version?: number;
}): Promise<void> {
  const tenantId = input.tenantId ?? TENANT;
  const parent = input.parentId
    ? await env.DB.prepare(
        'SELECT depth FROM folders WHERE tenant_id = ? AND id = ?'
      )
        .bind(tenantId, input.parentId)
        .first<{ depth: number }>()
    : null;
  const depth = parent ? parent.depth + 1 : 0;
  await env.DB.prepare(
    `INSERT INTO folders
       (id, tenant_id, parent_id, name, depth, version, classification, is_pinned, created_by, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(
      input.id,
      tenantId,
      input.parentId,
      input.name,
      depth,
      input.version ?? 1,
      input.classification ?? 'internal',
      input.createdBy ?? USERS.admin,
      input.deletedAt ?? null,
      input.deletedBy ?? null
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
     VALUES (?, ?, ?, 0)`
  )
    .bind(tenantId, input.id, input.id)
    .run();
  if (input.parentId) {
    await env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       SELECT tenant_id, ancestor_id, ?, depth + 1
         FROM folder_closures
        WHERE tenant_id = ? AND descendant_id = ?`
    )
      .bind(input.id, tenantId, input.parentId)
      .run();
  }
}

async function insertFile(input: {
  tenantId?: string;
  id: string;
  folderId: string | null;
  name: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  uploadState?: 'pending' | 'active' | 'failed';
  sizeBytes?: number;
  classification?: 'unset' | 'confidential' | 'internal' | 'public';
  createdBy?: string;
  currentVersionNum?: number;
}): Promise<void> {
  const tenantId = input.tenantId ?? TENANT;
  const extension = input.name.includes('.')
    ? input.name.slice(input.name.lastIndexOf('.') + 1).toLowerCase()
    : null;
  await env.DB.prepare(
    `INSERT INTO files
       (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state,
        current_version_num, classification, created_by, updated_by, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      tenantId,
      input.folderId,
      input.name,
      extension,
      input.sizeBytes ?? 100,
      input.uploadState ?? 'active',
      input.currentVersionNum ?? 1,
      input.classification ?? 'internal',
      input.createdBy ?? USERS.admin,
      input.createdBy ?? USERS.admin,
      input.deletedAt ?? null,
      input.deletedBy ?? null
    )
    .run();
}

async function grant(input: {
  tenantId?: string;
  id: string;
  targetType: 'file' | 'folder';
  targetId: string;
  userId: string;
  role: 'owner' | 'co_owner' | 'editor' | 'viewer' | 'previewer';
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO permissions
       (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
     VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`
  )
    .bind(
      input.id,
      input.tenantId ?? TENANT,
      input.targetType,
      input.targetId,
      input.userId,
      input.role,
      USERS.admin
    )
    .run();
}

async function insertVersion(input: {
  tenantId?: string;
  id: string;
  fileId: string;
  key: string;
  sizeBytes?: number;
  versionNum?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO file_versions
       (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 'completed', ?)`
  )
    .bind(
      input.id,
      input.tenantId ?? TENANT,
      input.fileId,
      input.versionNum ?? 1,
      input.key,
      input.sizeBytes ?? 100,
      USERS.admin
    )
    .run();
}

async function insertAuditLog(input: {
  tenantId?: string;
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actorEmail?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs
       (id, tenant_id, actor_id, actor_email, actor_ip, action, target_type, target_id,
        classification_snapshot, status, metadata_json, created_at)
     VALUES (?, ?, ?, ?, '127.0.0.1', ?, ?, ?, NULL, 'allowed', ?, ?)`
  )
    .bind(
      input.id,
      input.tenantId ?? TENANT,
      USERS.admin,
      input.actorEmail ?? `${USERS.admin}@example.com`,
      input.action,
      input.targetType,
      input.targetId,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.createdAt ?? '2026-11-17T00:00:00.000Z'
    )
    .run();
}

function findResult(
  body: BulkResponse | EmptyResponse,
  type: 'file' | 'folder',
  id: string
): BulkItemResult {
  const found = body.results.find(
    (result) => result.type === type && result.id === id
  );
  expect(found, `result for ${type}:${id}`).toBeTruthy();
  return found!;
}

function parseAuditMetadata(raw: string | null): Record<string, unknown> | null {
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

async function ensureBase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (id, name, slug)
       VALUES
         (?, 'Admin Trash Org', 'admin-trash-org'),
         (?, 'Admin Trash Other Org', 'admin-trash-other-org'),
         (?, 'Admin Trash Empty Org', 'admin-trash-empty-org')`
    ).bind(TENANT, OTHER_TENANT, EMPTY_TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenant_policies (tenant_id, trash_retention_days)
       VALUES (?, 30), (?, 30), (?, 30)`
    ).bind(TENANT, OTHER_TENANT, EMPTY_TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
       VALUES
         (?, ?, 'at-admin@example.com', 'Admin Trash Admin', 'sys_admin', 'active'),
         (?, ?, 'at-sec@example.com', 'Admin Trash Sec', 'sec_admin', 'active'),
         (?, ?, 'at-member@example.com', 'Admin Trash Member', 'member', 'active'),
         (?, ?, 'at-other-member@example.com', 'Admin Trash Other Member', 'member', 'active'),
         (?, ?, 'at-outsider@example.com', 'Admin Trash Outsider', 'member', 'active'),
         (?, ?, 'at-other-admin@example.com', 'Other Tenant Admin', 'sys_admin', 'active'),
         (?, ?, 'at-other-member-2@example.com', 'Other Tenant Member', 'member', 'active'),
         (?, ?, 'at-empty-admin@example.com', 'Empty Tenant Admin', 'sys_admin', 'active'),
         (?, ?, 'at-empty-sec@example.com', 'Empty Tenant Sec', 'sec_admin', 'active'),
         (?, ?, 'at-empty-member@example.com', 'Empty Tenant Member', 'member', 'active')`
    ).bind(
      USERS.admin,
      TENANT,
      USERS.sec,
      TENANT,
      USERS.member,
      TENANT,
      USERS.otherMember,
      TENANT,
      USERS.outsider,
      TENANT,
      USERS.otherAdmin,
      OTHER_TENANT,
      USERS.otherMember2,
      OTHER_TENANT,
      USERS.emptyAdmin,
      EMPTY_TENANT,
      USERS.emptySec,
      EMPTY_TENANT,
      USERS.emptyMember,
      EMPTY_TENANT
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
       VALUES
         (?, 'unset', 0, 0), (?, 'internal', 0, 0), (?, 'confidential', 0, 0), (?, 'public', 0, 0),
         (?, 'unset', 0, 0), (?, 'internal', 0, 0), (?, 'confidential', 0, 0), (?, 'public', 0, 0),
         (?, 'unset', 0, 0), (?, 'internal', 0, 0), (?, 'confidential', 0, 0), (?, 'public', 0, 0)`
    ).bind(
      TENANT,
      TENANT,
      TENANT,
      TENANT,
      OTHER_TENANT,
      OTHER_TENANT,
      OTHER_TENANT,
      OTHER_TENANT,
      EMPTY_TENANT,
      EMPTY_TENANT,
      EMPTY_TENANT,
      EMPTY_TENANT
    ),
  ]);

  await insertFolder({
    id: ROOT,
    parentId: null,
    name: 'Admin Trash Root',
    createdBy: USERS.admin,
  });
  await insertFolder({
    id: SECRET,
    parentId: null,
    name: 'Admin Trash Secret',
    classification: 'confidential',
    createdBy: USERS.admin,
  });
  await insertFolder({
    id: PRIVATE,
    parentId: ROOT,
    name: 'Admin Trash Private',
    createdBy: USERS.member,
  });
  await insertFolder({
    tenantId: OTHER_TENANT,
    id: OTHER_ROOT,
    parentId: null,
    name: 'Other Tenant Root',
    createdBy: USERS.otherAdmin,
  });
  await insertFolder({
    tenantId: EMPTY_TENANT,
    id: EMPTY_ROOT,
    parentId: null,
    name: 'Empty Tenant Root',
    createdBy: USERS.emptyMember,
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions
         (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES
         ('at-p-root-member', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('at-p-private-member', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('at-p-other-root', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('at-p-empty-root', ?, 'folder', ?, 'user', ?, 'owner', ?)`
    ).bind(
      TENANT,
      ROOT,
      USERS.member,
      USERS.admin,
      TENANT,
      PRIVATE,
      USERS.member,
      USERS.admin,
      OTHER_TENANT,
      OTHER_ROOT,
      USERS.otherAdmin,
      USERS.otherAdmin,
      EMPTY_TENANT,
      EMPTY_ROOT,
      USERS.emptyMember,
      USERS.emptyAdmin
    ),
  ]);

  await insertFile({
    tenantId: OTHER_TENANT,
    id: 'at-other-file',
    folderId: OTHER_ROOT,
    name: 'other-tenant-deleted.txt',
    deletedAt: '2026-11-11T00:00:00.000Z',
    deletedBy: USERS.otherAdmin,
    createdBy: USERS.otherAdmin,
  });
}

describe('Admin Trash listing / delegated restore / tenant empty (TOM-51)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await ensureBase();
  });

  it('enforces RBAC and tenant boundaries before any write', async () => {
    const memberList = await call('/api/admin/trash', { user: USERS.member });
    expect(memberList.status).toBe(403);

    const secList = await call('/api/admin/trash', { user: USERS.sec });
    expect(secList.status).toBe(200);

    const sysList = await call('/api/admin/trash', { user: USERS.admin });
    expect(sysList.status).toBe(200);

    for (const key of [
      'tenantId',
      'tenant_id',
      'targetTenantId',
      'target_tenant_id',
      'tenantId%5B%5D',
    ]) {
      const rejected = await call(`/api/admin/trash?${key}=${OTHER_TENANT}`, {
        user: USERS.admin,
      });
      expect(rejected.status, key).toBe(403);
      expect(rejected.body.code).toBe('TENANT_FORBIDDEN');
    }

    const memberRestore = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.member,
      body: { items: [{ type: 'file', id: 'whatever' }] },
    });
    expect(memberRestore.status).toBe(403);

    const secEmpty = await call('/api/admin/trash/empty', {
      method: 'POST',
      user: USERS.sec,
      body: { confirm: 'EMPTY_TENANT_TRASH' },
    });
    expect(secEmpty.status).toBe(403);
    expect(secEmpty.body.code).toBe('FORBIDDEN');

    const memberEmpty = await call('/api/admin/trash/empty', {
      method: 'POST',
      user: USERS.member,
      body: { confirm: 'EMPTY_TENANT_TRASH' },
    });
    expect(memberEmpty.status).toBe(403);

    const secDelete = await call('/api/admin/trash/items', {
      method: 'DELETE',
      user: USERS.sec,
      body: { items: [{ type: 'file', id: 'whatever' }] },
    });
    expect(secDelete.status).toBe(403);
    expect(secDelete.body.code).toBe('FORBIDDEN');

    const memberDelete = await call('/api/admin/trash/items', {
      method: 'DELETE',
      user: USERS.member,
      body: { items: [{ type: 'file', id: 'whatever' }] },
    });
    expect(memberDelete.status).toBe(403);

    const memberAudit = await call(
      '/api/audit-logs?actions=admin.file.restore',
      { user: USERS.member }
    );
    expect(memberAudit.status).toBe(403);
    const secAudit = await call(
      '/api/audit-logs?actions=admin.file.restore,admin.folder.restore',
      { user: USERS.sec }
    );
    expect(secAudit.status).toBe(200);

    // Cross-tenant restore must fail before the valid item is written.
    await insertFile({
      id: 'at-cross-valid-file',
      folderId: ROOT,
      name: 'cross-valid.txt',
      deletedAt: '2026-11-12T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });

    const crossRestore = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.admin,
      body: {
        items: [
          { type: 'file', id: 'at-cross-valid-file' },
          { type: 'file', id: 'at-other-file' },
        ],
      },
    });
    expect(crossRestore.status).toBe(404);
    expect(crossRestore.body.code).toBe('NOT_FOUND');

    const validStillDeleted = await env.DB.prepare(
      'SELECT deleted_at FROM files WHERE id = ?'
    )
      .bind('at-cross-valid-file')
      .first<{ deleted_at: string | null }>();
    expect(validStillDeleted?.deleted_at).not.toBeNull();
    const auditCount = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM audit_logs
        WHERE action = 'admin.file.restore' AND target_id = 'at-cross-valid-file'`
    ).first<{ cnt: number }>();
    expect(auditCount?.cnt).toBe(0);
    const syncCount = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM sync_changes
        WHERE action = 'file.restore' AND entity_id = 'at-cross-valid-file'`
    ).first<{ cnt: number }>();
    expect(syncCount?.cnt).toBe(0);

    const bodyTenantReject = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.admin,
      body: {
        tenantId: OTHER_TENANT,
        items: [{ type: 'file', id: 'at-cross-valid-file' }],
      },
    });
    expect(bodyTenantReject.status).toBe(403);

    const crossDelete = await call('/api/admin/trash/items', {
      method: 'DELETE',
      user: USERS.admin,
      body: {
        items: [
          { type: 'file', id: 'at-cross-valid-file' },
          { type: 'file', id: 'at-other-file' },
        ],
      },
    });
    expect(crossDelete.status).toBe(404);
    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?')
        .bind('at-cross-valid-file')
        .first()
    ).not.toBeNull();

    const crossEmpty = await call('/api/admin/trash/empty', {
      method: 'POST',
      user: USERS.admin,
      body: { tenantId: OTHER_TENANT, confirm: 'EMPTY_TENANT_TRASH' },
    });
    expect(crossEmpty.status).toBe(403);
  });

  it('lists tenant-wide Trash metadata without R2 keys and supports filters, sorting and keyset pagination', async () => {
    const nowMs = Date.now();
    const nearDeletedAt = new Date(nowMs - 29 * 86_400_000).toISOString();
    const farDeletedAt = new Date(nowMs - 10 * 86_400_000).toISOString();

    await insertFolder({
      id: 'at-list-folder',
      parentId: ROOT,
      name: 'at-list-folder',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
      version: 3,
    });
    await insertFile({
      id: 'at-list-confidential',
      folderId: ROOT,
      name: 'at-list-confidential.txt',
      classification: 'confidential',
      sizeBytes: 1234,
      currentVersionNum: 3,
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });
    await insertFile({
      id: 'at-list-near',
      folderId: ROOT,
      name: 'at-list-near.txt',
      deletedAt: nearDeletedAt,
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });
    await insertFile({
      id: 'at-list-far',
      folderId: ROOT,
      name: 'at-list-far.txt',
      deletedAt: farDeletedAt,
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });
    await insertFile({
      id: 'at-report-underscore',
      folderId: ROOT,
      name: 'at-report_100%.txt',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });
    await insertFile({
      id: 'at-report-plain',
      folderId: ROOT,
      name: 'at-reportX100Y.txt',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO permissions
           (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('at-list-folder-editor', ?, 'folder', 'at-list-folder', 'user', ?, 'editor', ?),
           ('at-list-file-owner', ?, 'file', 'at-list-confidential', 'user', ?, 'owner', ?),
           ('at-list-file-viewer', ?, 'file', 'at-list-confidential', 'user', ?, 'viewer', ?)`
      ).bind(
        TENANT,
        USERS.otherMember,
        USERS.admin,
        TENANT,
        USERS.member,
        USERS.admin,
        TENANT,
        USERS.otherMember,
        USERS.admin
      ),
      env.DB.prepare(
        `INSERT INTO shared_links
           (id, tenant_id, token_hash, target_type, target_id, created_by, revoked_at)
         VALUES
           ('at-list-link-active', ?, 'at-list-token-active', 'file', 'at-list-confidential', ?, NULL),
           ('at-list-link-revoked', ?, 'at-list-token-revoked', 'file', 'at-list-confidential', ?, '2026-11-12T00:00:00.000Z')`
      ).bind(TENANT, USERS.admin, TENANT, USERS.admin),
    ]);

    const listed = await call(
      '/api/admin/trash?query=at-list-&limit=200',
      { user: USERS.sec }
    );
    expect(listed.status).toBe(200);
    const body = listed.body as unknown as AdminTrashListBody;
    expect(body.trashRetentionDays).toBe(30);
    expect(body.limit).toBe(200);
    expect(body.owners.map((row) => row.id)).toContain(USERS.member);
    expect(body.deleters.map((row) => row.id)).toContain(USERS.member);
    expect(body.hasUnknownDeleter).toBe(false);

    const confidentialItem = body.items.find(
      (item) => item.id === 'at-list-confidential'
    );
    expect(confidentialItem).toMatchObject({
      type: 'file',
      name: 'at-list-confidential.txt',
      classification: 'confidential',
      sizeBytes: 1234,
      currentVersionNum: 3,
      parentFolder: { id: ROOT, name: 'Admin Trash Root' },
      owner: {
        id: USERS.member,
        name: 'Admin Trash Member',
        email: 'at-member@example.com',
      },
      deletedBy: {
        id: USERS.member,
        name: 'Admin Trash Member',
        email: 'at-member@example.com',
      },
    });
    expect(confidentialItem?.permissionSummary).toMatchObject({
      total: 3,
      direct: 2,
      inherited: 1,
      userCount: 3,
      groupCount: 0,
      sharedLinkCount: 1,
    });
    expect(confidentialItem?.permissionSummary.roles).toMatchObject({
      owner: 2,
      viewer: 1,
    });
    expect(confidentialItem?.daysRemaining).toBeGreaterThan(0);
    expect(confidentialItem?.purgeAt).toBeTruthy();

    const folderItem = body.items.find((item) => item.id === 'at-list-folder');
    expect(folderItem).toMatchObject({
      type: 'folder',
      name: 'at-list-folder',
      sizeBytes: null,
      currentVersionNum: 3,
      parentFolder: { id: ROOT, name: 'Admin Trash Root' },
      owner: { id: USERS.member },
    });
    expect(folderItem?.permissionSummary).toMatchObject({
      total: 2,
      direct: 1,
      inherited: 1,
    });

    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'r2_object_key',
      'r2ObjectKey',
      'r2_upload_id',
      'upload_state',
      'content_url',
      'can_download',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }

    const folderOnly = await call(
      '/api/admin/trash?type=folder&query=at-list-folder',
      { user: USERS.sec }
    );
    const folderOnlyBody = folderOnly.body as unknown as AdminTrashListBody;
    expect(folderOnlyBody.items).toHaveLength(1);
    expect(folderOnlyBody.items[0].type).toBe('folder');

    const ownerFilter = await call(
      `/api/admin/trash?ownerId=${USERS.member}&query=at-list-`,
      { user: USERS.sec }
    );
    expect(
      (ownerFilter.body as unknown as AdminTrashListBody).items.every(
        (item) => item.owner?.id === USERS.member
      )
    ).toBe(true);

    const deleterFilter = await call(
      `/api/admin/trash?deletedById=${USERS.member}&query=at-list-`,
      { user: USERS.sec }
    );
    expect(
      (deleterFilter.body as unknown as AdminTrashListBody).items.every(
        (item) => item.deletedBy?.id === USERS.member
      )
    ).toBe(true);

    const dateFilter = await call(
      `/api/admin/trash?query=at-list-&deletedFrom=2026-11-10T00:00:00.000Z&deletedTo=2026-11-11T23:59:59.000Z`,
      { user: USERS.sec }
    );
    const dateItems = (dateFilter.body as unknown as AdminTrashListBody).items;
    expect(dateItems.map((item) => item.id).sort()).toEqual([
      'at-list-confidential',
      'at-list-folder',
    ]);

    const near = await call(
      '/api/admin/trash?query=at-list-&daysRemainingMax=7',
      { user: USERS.sec }
    );
    expect(
      (near.body as unknown as AdminTrashListBody).items.map((item) => item.id)
    ).toEqual(['at-list-near']);
    const nearItem = (near.body as unknown as AdminTrashListBody).items[0];
    expect(nearItem.daysRemaining).toBeLessThanOrEqual(7);

    const escaped = await call(
      '/api/admin/trash?query=report_100%25',
      { user: USERS.sec }
    );
    expect(
      (escaped.body as unknown as AdminTrashListBody).items.map(
        (item) => item.id
      )
    ).toEqual(['at-report-underscore']);

    const sorted = await call(
      '/api/admin/trash?query=at-report&sort=name_asc&limit=200',
      { user: USERS.sec }
    );
    expect(
      (sorted.body as unknown as AdminTrashListBody).items.map(
        (item) => item.name
      )
    ).toEqual(['at-reportX100Y.txt', 'at-report_100%.txt']);

    const pages: AdminTrashItemBody[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({
        query: 'at-list-',
        limit: '2',
        sort: 'name_asc',
      });
      if (cursor) qs.set('cursor', cursor);
      const res = await call(`/api/admin/trash?${qs.toString()}`, {
        user: USERS.sec,
      });
      expect(res.status).toBe(200);
      const pageBody = res.body as unknown as AdminTrashListBody;
      pages.push(...pageBody.items);
      cursor = pageBody.nextCursor;
      if (!cursor) break;
    }
    const pageIds = pages.map((item) => item.id);
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(pageIds.sort()).toEqual([
      'at-list-confidential',
      'at-list-far',
      'at-list-folder',
      'at-list-near',
    ]);

    const invalidSort = await call('/api/admin/trash?sort=updated_desc', {
      user: USERS.sec,
    });
    expect(invalidSort.status).toBe(400);
    const invalidCursor = await call('/api/admin/trash?cursor=not-a-cursor', {
      user: USERS.sec,
    });
    expect(invalidCursor.status).toBe(400);
    const invalidDays = await call(
      '/api/admin/trash?daysRemainingMax=abc',
      { user: USERS.sec }
    );
    expect(invalidDays.status).toBe(400);
  });

  it('delegated restore bypasses item ACLs and records admin audit plus owner sync', async () => {
    await insertFolder({
      id: 'at-restore-folder',
      parentId: ROOT,
      name: 'Restore Folder',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
      version: 2,
    });
    await insertFile({
      id: 'at-restore-file',
      folderId: 'at-restore-folder',
      name: 'restore-me.txt',
      currentVersionNum: 4,
      deletedAt: '2026-11-12T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });

    const restored = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: {
        items: [{ type: 'file', id: 'at-restore-file' }],
        restoreParentChain: true,
        conflictPolicy: 'fail',
      },
    });
    expect(restored.status).toBe(200);
    const restoredBody = restored.body as unknown as BulkResponse;
    expect(restoredBody.succeededCount).toBe(1);
    expect(restoredBody.failedCount).toBe(0);
    expect(findResult(restoredBody, 'file', 'at-restore-file')).toMatchObject({
      ok: true,
      status: 'succeeded',
      name: 'restore-me.txt',
    });

    const fileRow = await env.DB.prepare(
      'SELECT folder_id, deleted_at, deleted_by FROM files WHERE id = ?'
    )
      .bind('at-restore-file')
      .first<{
        folder_id: string | null;
        deleted_at: string | null;
        deleted_by: string | null;
      }>();
    expect(fileRow).toEqual({
      folder_id: 'at-restore-folder',
      deleted_at: null,
      deleted_by: null,
    });
    const folderRow = await env.DB.prepare(
      'SELECT deleted_at, deleted_by FROM folders WHERE id = ?'
    )
      .bind('at-restore-folder')
      .first<{ deleted_at: string | null; deleted_by: string | null }>();
    expect(folderRow).toEqual({ deleted_at: null, deleted_by: null });

    const audits = await env.DB.prepare(
      `SELECT action, target_id, actor_email, metadata_json
         FROM audit_logs
        WHERE target_id IN (?, ?)
          AND action IN ('admin.file.restore', 'admin.folder.restore')`
    )
      .bind('at-restore-file', 'at-restore-folder')
      .all<{
        action: string;
        target_id: string;
        actor_email: string | null;
        metadata_json: string | null;
      }>();
    const fileAudit = audits.results.find(
      (row) => row.action === 'admin.file.restore'
    );
    const folderAudit = audits.results.find(
      (row) => row.action === 'admin.folder.restore'
    );
    expect(fileAudit).toBeTruthy();
    expect(folderAudit).toBeTruthy();
    expect(fileAudit?.actor_email).toBe('at-sec@example.com');

    const fileMeta = parseAuditMetadata(fileAudit?.metadata_json ?? null);
    expect(fileMeta).toMatchObject({
      targetName: 'restore-me.txt',
      onBehalfOfUserId: USERS.member,
      ownerId: USERS.member,
      ownerName: 'Admin Trash Member',
      ownerEmail: 'at-member@example.com',
      sourceVersion: 4,
      targetParentId: 'at-restore-folder',
      restoredName: 'restore-me.txt',
      adminRestore: true,
    });
    expect(fileMeta?.restoredTo).toMatchObject({
      id: 'at-restore-folder',
      name: 'Restore Folder',
    });
    expect(String((fileMeta?.restoredTo as { path?: string })?.path)).toContain(
      'Restore Folder'
    );

    const folderMeta = parseAuditMetadata(folderAudit?.metadata_json ?? null);
    expect(folderMeta).toMatchObject({
      targetName: 'Restore Folder',
      onBehalfOfUserId: USERS.member,
      ownerId: USERS.member,
      sourceVersion: 2,
      targetParentId: ROOT,
      adminRestore: true,
    });

    const syncRows = await env.DB.prepare(
      `SELECT action, entity_id, target_user_id
         FROM sync_changes
        WHERE entity_id IN (?, ?) AND action IN ('file.restore', 'folder.restore')`
    )
      .bind('at-restore-file', 'at-restore-folder')
      .all<{
        action: string;
        entity_id: string;
        target_user_id: string | null;
      }>();
    expect(
      syncRows.results
        .map((row) => `${row.action}:${row.entity_id}:${row.target_user_id}`)
        .sort()
    ).toEqual([
      `file.restore:at-restore-file:${USERS.member}`,
      `folder.restore:at-restore-folder:${USERS.member}`,
    ].sort());

    const memberDelta = await call('/api/sync/delta?sinceSeq=0&limit=200', {
      user: USERS.member,
    });
    expect(memberDelta.status).toBe(200);
    const changes = (
      memberDelta.body as {
        changes: Array<{ action: string; entityId: string }>;
      }
    ).changes;
    expect(
      changes.some(
        (change) =>
          change.action === 'file.restore' &&
          change.entityId === 'at-restore-file'
      )
    ).toBe(true);
    expect(
      changes.some(
        (change) =>
          change.action === 'folder.restore' &&
          change.entityId === 'at-restore-folder'
      )
    ).toBe(true);

    const memberFile = await call('/api/files/at-restore-file', {
      user: USERS.member,
    });
    expect(memberFile.status).toBe(200);
    expect(
      (memberFile.body as { file: { deleted_at: string | null } }).file
        .deleted_at
    ).toBeNull();

    const auditApi = await call(
      '/api/audit-logs?actions=admin.file.restore&targetId=at-restore-file',
      { user: USERS.sec }
    );
    expect(auditApi.status).toBe(200);
    const auditBody = auditApi.body as { logs: AuditLogRow[] };
    expect(auditBody.logs.map((log) => log.action)).toEqual([
      'admin.file.restore',
    ]);
    expect(auditBody.logs[0].actorEmail).toBe('at-sec@example.com');

    // A folder the admin has no ACL on restores directly as well.
    await insertFolder({
      id: 'at-restore-folder-2',
      parentId: ROOT,
      name: 'Restore Folder 2',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
      version: 5,
    });
    const directFolder = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: { items: [{ type: 'folder', id: 'at-restore-folder-2' }] },
    });
    expect(directFolder.status).toBe(200);
    expect(
      (directFolder.body as unknown as BulkResponse).succeededCount
    ).toBe(1);
    const directFolderAudit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_logs
        WHERE action = 'admin.folder.restore' AND target_id = ?`
    )
      .bind('at-restore-folder-2')
      .first<{ metadata_json: string | null }>();
    expect(
      parseAuditMetadata(directFolderAudit?.metadata_json ?? null)
    ).toMatchObject({
      targetName: 'Restore Folder 2',
      sourceVersion: 5,
      onBehalfOfUserId: USERS.member,
    });
  });

  it('returns per-item failures, supports rename and target folder restore', async () => {
    await insertFolder({
      id: 'at-partial-parent',
      parentId: ROOT,
      name: 'Partial Parent',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });
    await insertFile({
      id: 'at-partial-child',
      folderId: 'at-partial-parent',
      name: 'partial-child.txt',
      deletedAt: '2026-11-12T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });
    await insertFile({
      id: 'at-partial-ok',
      folderId: ROOT,
      name: 'partial-ok.txt',
      deletedAt: '2026-11-12T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });

    const partial = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: {
        items: [
          { type: 'file', id: 'at-partial-child' },
          { type: 'file', id: 'at-partial-ok' },
        ],
        restoreParentChain: false,
      },
    });
    expect(partial.status).toBe(200);
    const partialBody = partial.body as unknown as BulkResponse;
    expect(partialBody.succeededCount).toBe(1);
    expect(partialBody.failedCount).toBe(1);
    expect(findResult(partialBody, 'file', 'at-partial-child')).toMatchObject({
      ok: false,
      code: 'PARENT_FOLDER_DELETED',
    });
    expect(findResult(partialBody, 'file', 'at-partial-ok')).toMatchObject({
      ok: true,
      status: 'succeeded',
    });
    expect(
      (
        await env.DB.prepare('SELECT deleted_at FROM files WHERE id = ?')
          .bind('at-partial-child')
          .first<{ deleted_at: string | null }>()
      )?.deleted_at
    ).not.toBeNull();

    await insertFile({
      id: 'at-rename-active',
      folderId: ROOT,
      name: 'rename-me.txt',
      createdBy: USERS.member,
    });
    await insertFile({
      id: 'at-rename-trash',
      folderId: ROOT,
      name: 'rename-me.txt',
      deletedAt: '2026-11-12T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });

    const conflict = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: {
        items: [{ type: 'file', id: 'at-rename-trash' }],
        conflictPolicy: 'fail',
      },
    });
    expect(conflict.status).toBe(200);
    expect(
      findResult(
        conflict.body as unknown as BulkResponse,
        'file',
        'at-rename-trash'
      )
    ).toMatchObject({ ok: false, code: 'NAME_CONFLICT' });

    const renamed = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: {
        items: [{ type: 'file', id: 'at-rename-trash' }],
        conflictPolicy: 'rename',
      },
    });
    expect(renamed.status).toBe(200);
    expect(
      (renamed.body as unknown as BulkResponse).succeededCount
    ).toBe(1);
    const renamedRow = await env.DB.prepare(
      'SELECT name, deleted_at FROM files WHERE id = ?'
    )
      .bind('at-rename-trash')
      .first<{ name: string; deleted_at: string | null }>();
    expect(renamedRow).toEqual({
      name: 'rename-me (Restored).txt',
      deleted_at: null,
    });
    const renameAudit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_logs
        WHERE action = 'admin.file.restore' AND target_id = ?`
    )
      .bind('at-rename-trash')
      .first<{ metadata_json: string | null }>();
    expect(
      parseAuditMetadata(renameAudit?.metadata_json ?? null)
    ).toMatchObject({ restoredName: 'rename-me (Restored).txt' });

    await insertFolder({
      id: 'at-target-folder',
      parentId: ROOT,
      name: 'Target Folder',
      createdBy: USERS.member,
    });
    await insertFile({
      id: 'at-target-file',
      folderId: ROOT,
      name: 'target-me.txt',
      deletedAt: '2026-11-12T00:00:00.000Z',
      deletedBy: USERS.member,
      createdBy: USERS.member,
    });
    const moved = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: {
        items: [{ type: 'file', id: 'at-target-file' }],
        targetFolderId: 'at-target-folder',
      },
    });
    expect(moved.status).toBe(200);
    expect((moved.body as unknown as BulkResponse).succeededCount).toBe(1);
    const movedRow = await env.DB.prepare(
      'SELECT folder_id, deleted_at FROM files WHERE id = ?'
    )
      .bind('at-target-file')
      .first<{ folder_id: string | null; deleted_at: string | null }>();
    expect(movedRow).toEqual({
      folder_id: 'at-target-folder',
      deleted_at: null,
    });
    const targetAudit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_logs
        WHERE action = 'admin.file.restore' AND target_id = ?`
    )
      .bind('at-target-file')
      .first<{ metadata_json: string | null }>();
    expect(
      parseAuditMetadata(targetAudit?.metadata_json ?? null)
    ).toMatchObject({ targetParentId: 'at-target-folder' });
    const ownerGrant = await env.DB.prepare(
      `SELECT role FROM permissions
        WHERE target_type = 'file' AND target_id = ? AND grantee_type = 'user' AND grantee_id = ?`
    )
      .bind('at-target-file', USERS.member)
      .first<{ role: string }>();
    expect(ownerGrant).toEqual({ role: 'owner' });

    const crossTarget = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: {
        items: [{ type: 'file', id: 'at-target-file' }],
        targetFolderId: OTHER_ROOT,
      },
    });
    expect(crossTarget.status).toBe(404);

    const badTarget = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: {
        items: [{ type: 'file', id: 'at-target-file' }],
        targetFolderId: 123,
      },
    });
    expect(badTarget.status).toBe(400);
    expect(badTarget.body.code).toBe('INVALID_TARGET_FOLDER');

    const badParentChain = await call('/api/admin/trash/restore', {
      method: 'POST',
      user: USERS.sec,
      body: {
        items: [{ type: 'file', id: 'at-target-file' }],
        restoreParentChain: 'yes',
      },
    });
    expect(badParentChain.status).toBe(400);
    expect(badParentChain.body.code).toBe('INVALID_RESTORE_PARENT_CHAIN');
  });

  it('empties the whole tenant Trash as sys_admin with CoW R2 protection and lock skips', async () => {
    await insertFile({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-file-delete',
      folderId: EMPTY_ROOT,
      name: 'delete-selected.txt',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.emptyMember,
      createdBy: USERS.emptyMember,
    });
    await insertFile({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-file',
      folderId: EMPTY_ROOT,
      name: 'empty-me.txt',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.emptyMember,
      createdBy: USERS.emptyMember,
    });
    await insertFile({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-locked',
      folderId: EMPTY_ROOT,
      name: 'empty-locked.txt',
      createdBy: USERS.emptyMember,
    });
    await insertFile({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-cow',
      folderId: EMPTY_ROOT,
      name: 'empty-cow.txt',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.emptyMember,
      createdBy: USERS.emptyMember,
    });
    await insertFile({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-external',
      folderId: EMPTY_ROOT,
      name: 'external-copy.txt',
      createdBy: USERS.emptyMember,
    });
    await insertFolder({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-folder',
      parentId: EMPTY_ROOT,
      name: 'Empty Folder',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.emptyMember,
      createdBy: USERS.emptyMember,
    });
    await insertFile({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-folder-child',
      folderId: 'at-empty-folder',
      name: 'folder-child.txt',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.emptyMember,
      createdBy: USERS.emptyMember,
    });

    const sharedCowKey = 'admin-trash/cow-shared';
    const uniqueKey = 'admin-trash/unique';
    await insertVersion({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-cow-version',
      fileId: 'at-empty-cow',
      key: sharedCowKey,
    });
    await insertVersion({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-external-version',
      fileId: 'at-empty-external',
      key: sharedCowKey,
    });
    await insertVersion({
      tenantId: EMPTY_TENANT,
      id: 'at-empty-folder-version',
      fileId: 'at-empty-folder-child',
      key: uniqueKey,
    });
    await env.BUCKET.put(sharedCowKey, 'shared-cow');
    await env.BUCKET.put(uniqueKey, 'unique');

    // Lock one file after it is already active, then force it into Trash to
    // reproduce the stale-lock race the purge path must skip safely.
    const lockResponse = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/at-empty-locked/lock', {
        method: 'POST',
        headers: authHeaders(USERS.emptyMember, 'member', EMPTY_TENANT),
        body: JSON.stringify({ lockId: 'at-empty-lock', ttlSeconds: 600 }),
      }),
      buildTestEnv()
    );
    expect(lockResponse.status).toBe(201);
    await env.DB.prepare(
      'UPDATE files SET deleted_at = ?, deleted_by = ? WHERE id = ?'
    )
      .bind('2026-11-11T00:00:00.000Z', USERS.emptyMember, 'at-empty-locked')
      .run();

    const missingConfirm = await call('/api/admin/trash/empty', {
      method: 'POST',
      user: USERS.emptyAdmin,
      tenantId: EMPTY_TENANT,
      body: {},
    });
    expect(missingConfirm.status).toBe(400);
    expect(missingConfirm.body.code).toBe('CONFIRMATION_REQUIRED');

    const wrongConfirm = await call('/api/admin/trash/empty', {
      method: 'POST',
      user: USERS.emptyAdmin,
      tenantId: EMPTY_TENANT,
      body: { confirm: 'EMPTY_TRASH' },
    });
    expect(wrongConfirm.status).toBe(400);
    expect(wrongConfirm.body.code).toBe('INVALID_CONFIRMATION');

    const secEmpty = await call('/api/admin/trash/empty', {
      method: 'POST',
      user: USERS.emptySec,
      tenantId: EMPTY_TENANT,
      body: { confirm: 'EMPTY_TENANT_TRASH' },
    });
    expect(secEmpty.status).toBe(403);
    expect(secEmpty.body.code).toBe('FORBIDDEN');

    const crossTenantDelete = await call('/api/admin/trash/items', {
      method: 'DELETE',
      user: USERS.emptyAdmin,
      tenantId: EMPTY_TENANT,
      body: { items: [{ type: 'file', id: 'at-other-file' }] },
    });
    expect(crossTenantDelete.status).toBe(404);
    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?')
        .bind('at-other-file')
        .first()
    ).not.toBeNull();

    const selectedDelete = await call('/api/admin/trash/items', {
      method: 'DELETE',
      user: USERS.emptyAdmin,
      tenantId: EMPTY_TENANT,
      body: { items: [{ type: 'file', id: 'at-empty-file-delete' }] },
    });
    expect(selectedDelete.status).toBe(200);
    expect(
      (selectedDelete.body as unknown as BulkResponse).succeededCount
    ).toBe(1);
    const selectedAudit = await env.DB.prepare(
      `SELECT action, metadata_json FROM audit_logs
        WHERE target_id = ? AND action = 'file.purge'`
    )
      .bind('at-empty-file-delete')
      .first<{ action: string; metadata_json: string | null }>();
    expect(
      parseAuditMetadata(selectedAudit?.metadata_json ?? null)
    ).toMatchObject({
      targetName: 'delete-selected.txt',
      onBehalfOfUserId: USERS.emptyMember,
      ownerId: USERS.emptyMember,
      ownerName: 'Empty Tenant Member',
    });

    const emptied = await call('/api/admin/trash/empty', {
      method: 'POST',
      user: USERS.emptyAdmin,
      tenantId: EMPTY_TENANT,
      body: { confirm: 'EMPTY_TENANT_TRASH' },
    });
    expect(emptied.status).toBe(200);
    const emptiedBody = emptied.body as unknown as EmptyResponse;
    expect(emptiedBody.deletedCount).toBe(3);
    expect(emptiedBody.failedCount).toBe(0);
    expect(emptiedBody.skippedCount).toBe(1);
    expect(
      findResult(emptiedBody, 'file', 'at-empty-locked')
    ).toMatchObject({
      ok: false,
      status: 'skipped',
      code: 'FILE_LOCKED',
    });
    expect(
      findResult(emptiedBody, 'folder', 'at-empty-folder')
    ).toMatchObject({ ok: true, status: 'succeeded' });

    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?')
        .bind('at-empty-file')
        .first()
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM folders WHERE id = ?')
        .bind('at-empty-folder')
        .first()
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?')
        .bind('at-empty-folder-child')
        .first()
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?')
        .bind('at-empty-locked')
        .first()
    ).not.toBeNull();

    expect(await env.BUCKET.head(sharedCowKey)).not.toBeNull();
    expect(await env.BUCKET.head(uniqueKey)).toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?')
        .bind('at-empty-external')
        .first()
    ).not.toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?')
        .bind('at-other-file')
        .first()
    ).not.toBeNull();

    const emptyAudit = await env.DB.prepare(
      `SELECT actor_email, target_type, target_id, metadata_json
         FROM audit_logs
        WHERE action = 'admin.trash.empty'
        ORDER BY created_at DESC
        LIMIT 1`
    ).first<{
      actor_email: string | null;
      target_type: string;
      target_id: string;
      metadata_json: string | null;
    }>();
    expect(emptyAudit).toMatchObject({
      actor_email: 'at-empty-admin@example.com',
      target_type: 'tenant',
      target_id: EMPTY_TENANT,
    });
    const emptyMeta = parseAuditMetadata(emptyAudit?.metadata_json ?? null);
    expect(emptyMeta).toMatchObject({
      deletedCount: 3,
      failedCount: 0,
      skippedCount: 1,
    });
    expect(emptyMeta?.skippedItems).toEqual([
      expect.objectContaining({
        id: 'at-empty-locked',
        code: 'FILE_LOCKED',
      }),
    ]);

    if (env.FILE_LOCK_HUB) {
      const hub = env.FILE_LOCK_HUB.get(
        env.FILE_LOCK_HUB.idFromName('at-empty-locked')
      );
      await hub.unlockFile({
        fileId: 'at-empty-locked',
        lockId: 'at-empty-lock',
      });
    }

    const afterUnlock = await call('/api/admin/trash/empty', {
      method: 'POST',
      user: USERS.emptyAdmin,
      tenantId: EMPTY_TENANT,
      body: { confirm: 'EMPTY_TENANT_TRASH' },
    });
    expect(afterUnlock.status).toBe(200);
    expect(
      (afterUnlock.body as unknown as EmptyResponse).deletedCount
    ).toBe(1);
    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?')
        .bind('at-empty-locked')
        .first()
    ).toBeNull();
  }, 60_000);

  it('filters audit logs by multiple actions while preserving the single action contract', async () => {
    const actions = [
      'file.restore',
      'folder.restore',
      'file.purge',
      'folder.purge',
      'admin.file.restore',
      'admin.folder.restore',
      'admin.trash.empty',
    ];
    await env.DB.batch(
      actions.map((action, index) =>
        env.DB.prepare(
          `INSERT INTO audit_logs
             (id, tenant_id, actor_id, actor_email, actor_ip, action, target_type, target_id,
              classification_snapshot, status, metadata_json, created_at)
           VALUES (?, ?, ?, ?, '127.0.0.1', ?, 'file', ?, NULL, 'allowed', NULL, ?)`
        ).bind(
          `at-filter-audit-${index}`,
          TENANT,
          USERS.admin,
          'at-admin@example.com',
          action,
          `at-filter-target-${index}`,
          `2026-11-17T00:0${index}:00.000Z`
        )
      )
    );
    await insertAuditLog({
      id: 'at-filter-noise',
      action: 'shared_link.create',
      targetType: 'shared_link',
      targetId: 'at-noise',
      createdAt: '2026-11-17T00:30:00.000Z',
    });

    const csvActions = 'admin.file.restore,admin.folder.restore,admin.trash.empty';
    const csv = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/audit-logs?format=csv&limit=200&actions=${encodeURIComponent(csvActions)}`,
        { headers: authHeaders(USERS.sec) }
      ),
      buildTestEnv()
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get('Content-Type')).toContain('text/csv');
    const csvText = await csv.text();
    const csvLines = csvText.trim().split('\n').slice(1);
    const csvActionsSeen = csvLines.map((line) =>
      line.split(',')[2].replace(/^"|"$/g, '')
    );
    expect(new Set(csvActionsSeen)).toEqual(
      new Set(['admin.file.restore', 'admin.folder.restore', 'admin.trash.empty'])
    );
    expect(csvText).not.toContain('shared_link.create');

    const plural = await call(
      '/api/audit-logs?actions=file.restore,folder.restore&limit=200',
      { user: USERS.sec }
    );
    expect(plural.status).toBe(200);
    const pluralLogs = (plural.body as { logs: AuditLogRow[] }).logs;
    expect(pluralLogs.length).toBeGreaterThan(0);
    expect(
      pluralLogs.every((log) =>
        ['file.restore', 'folder.restore'].includes(log.action)
      )
    ).toBe(true);

    const repeated = await call(
      '/api/audit-logs?actions=file.restore&actions=folder.restore&limit=200',
      { user: USERS.sec }
    );
    expect(repeated.status).toBe(200);
    const repeatedLogs = (repeated.body as { logs: AuditLogRow[] }).logs;
    expect(repeatedLogs.length).toBeGreaterThan(0);
    expect(
      repeatedLogs.every((log) =>
        ['file.restore', 'folder.restore'].includes(log.action)
      )
    ).toBe(true);

    const single = await call('/api/audit-logs?action=file.restore&limit=200', {
      user: USERS.sec,
    });
    expect(single.status).toBe(200);
    const singleLogs = (single.body as { logs: AuditLogRow[] }).logs;
    expect(singleLogs.length).toBeGreaterThan(0);
    expect(singleLogs.every((log) => log.action === 'file.restore')).toBe(true);

    const combined = await call(
      '/api/audit-logs?action=file.purge&actions=admin.trash.empty&limit=200',
      { user: USERS.sec }
    );
    expect(combined.status).toBe(200);
    expect(
      (combined.body as { logs: AuditLogRow[] }).logs.every((log) =>
        ['file.purge', 'admin.trash.empty'].includes(log.action)
      )
    ).toBe(true);

    const tooMany = await call(
      `/api/audit-logs?actions=${Array.from(
        { length: 21 },
        (_, index) => `action.${index}`
      ).join(',')}`,
      { user: USERS.sec }
    );
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('INVALID_ACTION_FILTER');

    const emptyActions = await call('/api/audit-logs?actions=', {
      user: USERS.sec,
    });
    expect(emptyActions.status).toBe(400);
    expect(emptyActions.body.code).toBe('INVALID_ACTION_FILTER');
  });
});
