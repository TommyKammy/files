import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-restore-options';
const ROOT = 'ro-root';
const OTHER = 'ro-other';
const SECRET = 'ro-secret';

const USERS = {
  admin: 'ro-admin',
  owner: 'ro-owner',
  editor: 'ro-editor',
  outsider: 'ro-outsider',
} as const;

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
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

interface CallInput {
  method?: string;
  user?: string;
  role?: 'sys_admin' | 'sec_admin' | 'member';
  body?: unknown;
}

async function call(
  path: string,
  input: CallInput = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: input.method ?? 'GET',
      headers: authHeaders(
        input.user ?? USERS.admin,
        input.role ?? (input.user === USERS.admin ? 'sys_admin' : 'member')
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
  id: string;
  parentId: string | null;
  name: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  classification?: 'unset' | 'confidential' | 'internal' | 'public';
}): Promise<void> {
  const parent = input.parentId
    ? await env.DB.prepare(
        'SELECT depth FROM folders WHERE tenant_id = ? AND id = ?'
      )
        .bind(TENANT, input.parentId)
        .first<{ depth: number }>()
    : null;
  const depth = parent ? parent.depth + 1 : 0;
  await env.DB.prepare(
    `INSERT INTO folders
       (id, tenant_id, parent_id, name, depth, version, classification, is_pinned, created_by, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`
  )
    .bind(
      input.id,
      TENANT,
      input.parentId,
      input.name,
      depth,
      input.classification ?? 'internal',
      USERS.admin,
      input.deletedAt ?? null,
      input.deletedBy ?? null
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
     VALUES (?, ?, ?, 0)`
  )
    .bind(TENANT, input.id, input.id)
    .run();
  if (input.parentId) {
    await env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       SELECT tenant_id, ancestor_id, ?, depth + 1
         FROM folder_closures
        WHERE tenant_id = ? AND descendant_id = ?`
    )
      .bind(input.id, TENANT, input.parentId)
      .run();
  }
}

async function insertFile(input: {
  id: string;
  folderId: string | null;
  name: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  uploadState?: 'pending' | 'active' | 'failed';
  sizeBytes?: number;
  classification?: 'unset' | 'confidential' | 'internal' | 'public';
}): Promise<void> {
  const extension = input.name.includes('.')
    ? input.name.slice(input.name.lastIndexOf('.') + 1).toLowerCase()
    : null;
  await env.DB.prepare(
    `INSERT INTO files
       (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state,
        classification, created_by, updated_by, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      TENANT,
      input.folderId,
      input.name,
      extension,
      input.sizeBytes ?? 100,
      input.uploadState ?? 'active',
      input.classification ?? 'internal',
      USERS.admin,
      USERS.admin,
      input.deletedAt ?? null,
      input.deletedBy ?? null
    )
    .run();
}

async function grant(input: {
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
      TENANT,
      input.targetType,
      input.targetId,
      input.userId,
      input.role,
      USERS.admin
    )
    .run();
}

async function deleteFolderViaApi(folderId: string, userId = USERS.admin) {
  const response = await call(`/api/folders/${folderId}`, {
    method: 'DELETE',
    user: userId,
  });
  expect(response.status, `DELETE /api/folders/${folderId}`).toBe(200);
}

async function folderRow(id: string) {
  return env.DB.prepare(
    `SELECT id, parent_id, name, depth, classification, deleted_at, deleted_by
       FROM folders WHERE tenant_id = ? AND id = ?`
  )
    .bind(TENANT, id)
    .first<{
      id: string;
      parent_id: string | null;
      name: string;
      depth: number;
      classification: string;
      deleted_at: string | null;
      deleted_by: string | null;
    }>();
}

async function fileRow(id: string) {
  return env.DB.prepare(
    `SELECT id, folder_id, name, extension, classification, deleted_at, deleted_by, meta_version
       FROM files WHERE tenant_id = ? AND id = ?`
  )
    .bind(TENANT, id)
    .first<{
      id: string;
      folder_id: string | null;
      name: string;
      extension: string | null;
      classification: string;
      deleted_at: string | null;
      deleted_by: string | null;
      meta_version: number;
    }>();
}

/** Rebuild the O(1) bucket counters from the authoritative active-file rows. */
async function syncStorageStats(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tenant_storage_stats WHERE tenant_id = ?').bind(
      TENANT
    ),
    env.DB.prepare(
      `INSERT INTO tenant_storage_stats
         (tenant_id, classification, file_count, total_bytes, updated_at)
       SELECT tenant_id, classification, COUNT(*), COALESCE(SUM(size_bytes), 0), ?
         FROM files
        WHERE tenant_id = ? AND upload_state = 'active'
        GROUP BY classification`
    ).bind(new Date().toISOString(), TENANT),
  ]);
}

async function assertStorageStatsConsistent(): Promise<void> {
  const [stats, actual] = await Promise.all([
    env.DB.prepare(
      `SELECT classification, file_count, total_bytes
         FROM tenant_storage_stats WHERE tenant_id = ?`
    )
      .bind(TENANT)
      .all<{
        classification: string;
        file_count: number;
        total_bytes: number;
      }>(),
    env.DB.prepare(
      `SELECT classification, COUNT(*) AS file_count, COALESCE(SUM(size_bytes), 0) AS total_bytes
         FROM files
        WHERE tenant_id = ? AND upload_state = 'active'
        GROUP BY classification`
    )
      .bind(TENANT)
      .all<{
        classification: string;
        file_count: number;
        total_bytes: number;
      }>(),
  ]);

  const normalize = (
    rows: Array<{
      classification: string;
      file_count: number;
      total_bytes: number;
    }>
  ) =>
    Object.fromEntries(
      rows
        .filter((row) => row.file_count > 0 || row.total_bytes > 0)
        .map((row) => [
          row.classification,
          { file_count: row.file_count, total_bytes: row.total_bytes },
        ])
    );
  expect(normalize(stats.results)).toEqual(normalize(actual.results));
}

async function ensureBase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (id, name, slug)
       VALUES (?, 'Restore Options Org', 'restore-options-org')`
    ).bind(TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenant_policies (tenant_id, trash_retention_days)
       VALUES (?, 30)`
    ).bind(TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
       VALUES
         (?, ?, 'ro-admin@example.com', 'RO Admin', 'sys_admin', 'active'),
         (?, ?, 'ro-owner@example.com', 'RO Owner', 'member', 'active'),
         (?, ?, 'ro-editor@example.com', 'RO Editor', 'member', 'active'),
         (?, ?, 'ro-outsider@example.com', 'RO Outsider', 'member', 'active')`
    ).bind(
      USERS.admin,
      TENANT,
      USERS.owner,
      TENANT,
      USERS.editor,
      TENANT,
      USERS.outsider,
      TENANT
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
       VALUES (?, 'unset', 0, 0), (?, 'public', 0, 0), (?, 'internal', 0, 0), (?, 'confidential', 0, 0)`
    ).bind(TENANT, TENANT, TENANT, TENANT),
  ]);

  await insertFolder({ id: ROOT, parentId: null, name: 'Restore Root' });
  await insertFolder({ id: OTHER, parentId: null, name: 'Restore Other' });
  await insertFolder({
    id: SECRET,
    parentId: null,
    name: 'Restore Secret',
    classification: 'confidential',
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO permissions
         (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES
         ('ro-p-root-owner', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('ro-p-root-editor', ?, 'folder', ?, 'user', ?, 'editor', ?),
         ('ro-p-root-admin', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('ro-p-other-owner', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('ro-p-other-editor', ?, 'folder', ?, 'user', ?, 'editor', ?),
         ('ro-p-other-admin', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('ro-p-secret-owner', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('ro-p-secret-admin', ?, 'folder', ?, 'user', ?, 'owner', ?)`
    ).bind(
      TENANT,
      ROOT,
      USERS.owner,
      USERS.admin,
      TENANT,
      ROOT,
      USERS.editor,
      USERS.admin,
      TENANT,
      ROOT,
      USERS.admin,
      USERS.admin,
      TENANT,
      OTHER,
      USERS.owner,
      USERS.admin,
      TENANT,
      OTHER,
      USERS.editor,
      USERS.admin,
      TENANT,
      OTHER,
      USERS.admin,
      USERS.admin,
      TENANT,
      SECRET,
      USERS.owner,
      USERS.admin,
      TENANT,
      SECRET,
      USERS.admin,
      USERS.admin
    ),
  ]);
}

describe('Trash restore destination, parent chain and conflict options (TOM-50)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await ensureBase();
  });

  it('restores in place, into a chosen folder, and to the root while keeping direct file ACLs', async () => {
    await insertFile({
      id: 'rf-orig',
      folderId: ROOT,
      name: 'rf-orig.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    const inPlace = await call('/api/files/rf-orig/restore', {
      method: 'POST',
      user: USERS.editor,
      body: {},
    });
    expect(inPlace.status).toBe(200);
    expect(await fileRow('rf-orig')).toMatchObject({
      folder_id: ROOT,
      deleted_at: null,
      deleted_by: null,
    });
    const ftsOrig = await env.DB.prepare(
      'SELECT classification, name FROM files_fts WHERE file_id = ?'
    )
      .bind('rf-orig')
      .first<{ classification: string; name: string }>();
    expect(ftsOrig).toEqual({ classification: 'internal', name: 'rf-orig.txt' });

    await insertFile({
      id: 'rf-move',
      folderId: ROOT,
      name: 'rf-move.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    const moved = await call('/api/files/rf-move/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { targetFolderId: OTHER },
    });
    expect(moved.status).toBe(200);
    expect(await fileRow('rf-move')).toMatchObject({
      folder_id: OTHER,
      deleted_at: null,
    });
    expect(
      (moved.body.destination as { id: string }).id
    ).toBe(OTHER);

    await insertFile({
      id: 'rf-root',
      folderId: ROOT,
      name: 'rf-root.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    const toRoot = await call('/api/files/rf-root/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { targetFolderId: null },
    });
    expect(toRoot.status).toBe(200);
    expect(await fileRow('rf-root')).toMatchObject({
      folder_id: null,
      deleted_at: null,
    });
    const directAcl = await env.DB.prepare(
      `SELECT role FROM permissions
        WHERE tenant_id = ? AND target_type = 'file' AND target_id = ? AND grantee_id = ?`
    )
      .bind(TENANT, 'rf-root', USERS.editor)
      .first<{ role: string }>();
    expect(directAcl?.role).toBe('editor');
    const accessibleAtRoot = await call('/api/files/rf-root', {
      user: USERS.editor,
    });
    expect(accessibleAtRoot.status).toBe(200);

    await insertFile({
      id: 'rf-secret',
      folderId: ROOT,
      name: 'rf-secret.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    const denied = await call('/api/files/rf-secret/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { targetFolderId: SECRET },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN');
    expect(await fileRow('rf-secret')).toMatchObject({
      deleted_at: '2026-11-10T00:00:00.000Z',
    });
    expect(
      JSON.stringify(denied.body.destination ?? {})
    ).not.toContain('Restore Secret');

    const invalidTarget = await call('/api/files/rf-secret/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { targetFolderId: 42 },
    });
    expect(invalidTarget.status).toBe(400);
    expect(invalidTarget.body.code).toBe('INVALID_TARGET_FOLDER');
  });

  it('restores a 3-level ancestor chain with different deletion times without touching unrelated siblings', async () => {
    await insertFolder({ id: 'pc-a', parentId: ROOT, name: 'pc-a' });
    await insertFolder({ id: 'pc-b', parentId: 'pc-a', name: 'pc-b' });
    await insertFolder({
      id: 'pc-x',
      parentId: 'pc-a',
      name: 'pc-x',
      deletedAt: '2026-11-01T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await insertFile({
      id: 'pc-y',
      folderId: 'pc-a',
      name: 'pc-y-unrelated.txt',
      deletedAt: '2026-11-02T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await insertFile({
      id: 'pc-f',
      folderId: 'pc-b',
      name: 'pc-target.txt',
      deletedAt: '2026-11-03T00:00:00.000Z',
      deletedBy: USERS.admin,
    });

    await deleteFolderViaApi('pc-b');
    const bAfterDelete = await folderRow('pc-b');
    expect(bAfterDelete?.deleted_at).toBeTruthy();
    await deleteFolderViaApi('pc-a');
    const aAfterDelete = await folderRow('pc-a');
    expect(aAfterDelete?.deleted_at).toBeTruthy();
    expect(
      new Set([
        aAfterDelete!.deleted_at,
        bAfterDelete!.deleted_at,
        '2026-11-03T00:00:00.000Z',
      ]).size
    ).toBe(3);

    const restored = await call('/api/files/pc-f/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.restoredAncestorIds).toEqual(['pc-a', 'pc-b']);
    expect((restored.body.affectedFolderIds as unknown[]).length).toBeGreaterThan(0);

    expect(await folderRow('pc-a')).toMatchObject({
      deleted_at: null,
      deleted_by: null,
    });
    expect(await folderRow('pc-b')).toMatchObject({
      deleted_at: null,
      deleted_by: null,
    });
    expect(await fileRow('pc-f')).toMatchObject({
      folder_id: 'pc-b',
      deleted_at: null,
      deleted_by: null,
    });

    // Unrelated earlier deletions under the same ancestors stay in Trash.
    expect((await folderRow('pc-x'))?.deleted_at).toBe(
      '2026-11-01T00:00:00.000Z'
    );
    expect((await fileRow('pc-y'))?.deleted_at).toBe(
      '2026-11-02T00:00:00.000Z'
    );

    const audits = await env.DB.prepare(
      `SELECT action, target_id, metadata_json
         FROM audit_logs
        WHERE tenant_id = ? AND target_id IN ('pc-a', 'pc-b', 'pc-f')
          AND action IN ('folder.restore', 'file.restore')`
    )
      .bind(TENANT)
      .all<{ action: string; target_id: string; metadata_json: string }>();
    const auditMap = new Map(
      audits.results.map((row) => [`${row.action}:${row.target_id}`, row])
    );
    expect(auditMap.has('folder.restore:pc-a')).toBe(true);
    expect(auditMap.has('folder.restore:pc-b')).toBe(true);
    expect(auditMap.has('file.restore:pc-f')).toBe(true);
    expect(auditMap.get('folder.restore:pc-a')?.metadata_json).toContain(
      'parent_chain'
    );
    expect(auditMap.get('folder.restore:pc-b')?.metadata_json).toContain(
      'parent_chain'
    );

    const syncRows = await env.DB.prepare(
      `SELECT action, entity_id FROM sync_changes
        WHERE tenant_id = ? AND entity_id IN ('pc-a', 'pc-b', 'pc-f')
          AND action IN ('folder.restore', 'file.restore')`
    )
      .bind(TENANT)
      .all<{ action: string; entity_id: string }>();
    expect(
      new Set(syncRows.results.map((row) => `${row.action}:${row.entity_id}`))
    ).toEqual(
      new Set([
        'folder.restore:pc-a',
        'folder.restore:pc-b',
        'file.restore:pc-f',
      ])
    );
  });

  it('restores a deleted folder through its folder ancestor chain and keeps the subtree boundary', async () => {
    await insertFolder({ id: 'fc-a', parentId: ROOT, name: 'fc-a' });
    await insertFolder({ id: 'fc-b', parentId: 'fc-a', name: 'fc-b' });
    await insertFolder({ id: 'fc-c', parentId: 'fc-b', name: 'fc-c' });
    await insertFolder({
      id: 'fc-x',
      parentId: 'fc-a',
      name: 'fc-x',
      deletedAt: '2026-11-01T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await insertFile({
      id: 'fc-file',
      folderId: 'fc-c',
      name: 'fc-child.txt',
    });

    await deleteFolderViaApi('fc-c');
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE folders SET deleted_at = '2026-11-04T00:00:00.000Z' WHERE id = 'fc-c'"
      ),
      env.DB.prepare(
        "UPDATE files SET deleted_at = '2026-11-04T00:00:00.000Z' WHERE folder_id = 'fc-c'"
      ),
    ]);
    await deleteFolderViaApi('fc-b');
    await env.DB.prepare(
      "UPDATE folders SET deleted_at = '2026-11-05T00:00:00.000Z' WHERE id = 'fc-b'"
    ).run();
    await deleteFolderViaApi('fc-a');
    await env.DB.prepare(
      "UPDATE folders SET deleted_at = '2026-11-06T00:00:00.000Z' WHERE id = 'fc-a'"
    ).run();

    const restored = await call('/api/folders/fc-c/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.restoredAncestorIds).toEqual(['fc-a', 'fc-b']);
    expect((await folderRow('fc-a'))?.deleted_at).toBeNull();
    expect((await folderRow('fc-b'))?.deleted_at).toBeNull();
    expect((await folderRow('fc-c'))?.deleted_at).toBeNull();
    expect((await fileRow('fc-file'))?.deleted_at).toBeNull();
    // Sibling deleted in an unrelated batch remains in Trash.
    expect((await folderRow('fc-x'))?.deleted_at).toBe(
      '2026-11-01T00:00:00.000Z'
    );
  });

  it('rolls the whole plan back when an ancestor permission or name conflict fails', async () => {
    await insertFolder({ id: 'rb-private-root', parentId: null, name: 'rb-private-root' });
    await insertFolder({ id: 'rb-a', parentId: 'rb-private-root', name: 'rb-a', deletedAt: '2026-11-13T00:00:00.000Z', deletedBy: USERS.admin });
    await insertFolder({ id: 'rb-b', parentId: 'rb-a', name: 'rb-b', deletedAt: '2026-11-12T00:00:00.000Z', deletedBy: USERS.admin });
    await insertFile({
      id: 'rb-f',
      folderId: 'rb-b',
      name: 'rb-target.txt',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await grant({ id: 'rb-perm-b', targetType: 'folder', targetId: 'rb-b', userId: USERS.editor, role: 'editor' });
    await grant({ id: 'rb-perm-f', targetType: 'file', targetId: 'rb-f', userId: USERS.editor, role: 'editor' });

    const forbidden = await call('/api/files/rb-f/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('FORBIDDEN');
    expect((await folderRow('rb-a'))?.deleted_at).toBe(
      '2026-11-13T00:00:00.000Z'
    );
    expect((await folderRow('rb-b'))?.deleted_at).toBe(
      '2026-11-12T00:00:00.000Z'
    );
    expect((await fileRow('rb-f'))?.deleted_at).toBe(
      '2026-11-11T00:00:00.000Z'
    );
    const forbiddenAudits = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM audit_logs
        WHERE tenant_id = ? AND target_id IN ('rb-a', 'rb-b', 'rb-f')
          AND action IN ('folder.restore', 'file.restore')`
    )
      .bind(TENANT)
      .first<{ cnt: number }>();
    expect(forbiddenAudits?.cnt).toBe(0);

    await insertFolder({ id: 'rc-a', parentId: ROOT, name: 'rc-a', deletedAt: '2026-11-13T00:00:00.000Z', deletedBy: USERS.admin });
    await insertFolder({ id: 'rc-b', parentId: 'rc-a', name: 'rc-b', deletedAt: '2026-11-12T00:00:00.000Z', deletedBy: USERS.admin });
    await insertFile({
      id: 'rc-f',
      folderId: 'rc-b',
      name: 'rc-conflict.txt',
      deletedAt: '2026-11-11T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await insertFile({
      id: 'rc-active',
      folderId: 'rc-b',
      name: 'rc-conflict.txt',
      classification: 'internal',
    });

    const conflict = await call('/api/files/rc-f/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true, conflictPolicy: 'fail' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('NAME_CONFLICT');
    expect(typeof conflict.body.suggestedName).toBe('string');
    expect((await folderRow('rc-a'))?.deleted_at).toBe(
      '2026-11-13T00:00:00.000Z'
    );
    expect((await folderRow('rc-b'))?.deleted_at).toBe(
      '2026-11-12T00:00:00.000Z'
    );
    expect((await fileRow('rc-f'))?.deleted_at).toBe(
      '2026-11-11T00:00:00.000Z'
    );
    expect((await fileRow('rc-active'))?.deleted_at).toBeNull();

    const renamed = await call('/api/files/rc-f/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true, conflictPolicy: 'rename' },
    });
    expect(renamed.status).toBe(200);
    expect((await folderRow('rc-a'))?.deleted_at).toBeNull();
    expect((await folderRow('rc-b'))?.deleted_at).toBeNull();
    expect((await fileRow('rc-f'))?.name).toBe('rc-conflict (Restored).txt');
    expect((await fileRow('rc-active'))?.name).toBe('rc-conflict.txt');
  });

  it('renames a conflicting deleted ancestor with the rename policy and leaves the active sibling untouched', async () => {
    await insertFolder({ id: 're-a', parentId: ROOT, name: 're-a' });
    await insertFolder({ id: 're-b-original', parentId: 're-a', name: 're-b' });
    await insertFile({
      id: 're-f',
      folderId: 're-b-original',
      name: 're-target.txt',
      deletedAt: '2026-11-12T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await deleteFolderViaApi('re-b-original');
    await insertFolder({ id: 're-b-active', parentId: 're-a', name: 're-b' });

    const fail = await call('/api/files/re-f/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true, conflictPolicy: 'fail' },
    });
    expect(fail.status).toBe(409);
    expect(fail.body.code).toBe('NAME_CONFLICT');
    expect(fail.body.suggestedName).toBe('re-b (Restored)');
    expect((await folderRow('re-b-original'))?.name).toBe('re-b');
    expect((await folderRow('re-b-original'))?.deleted_at).not.toBeNull();

    const rename = await call('/api/files/re-f/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true, conflictPolicy: 'rename' },
    });
    expect(rename.status).toBe(200);
    expect((await folderRow('re-b-original'))?.name).toBe('re-b (Restored)');
    expect((await folderRow('re-b-original'))?.deleted_at).toBeNull();
    expect((await folderRow('re-b-active'))?.name).toBe('re-b');
    expect((await fileRow('re-f'))?.folder_id).toBe('re-b-original');
    expect((await fileRow('re-f'))?.deleted_at).toBeNull();
  });

  it('rejects circular restores and MAX_FOLDER_DEPTH (20) violations', async () => {
    await insertFolder({ id: 'cy-p', parentId: ROOT, name: 'cy-p', deletedAt: '2026-11-10T00:00:00.000Z', deletedBy: USERS.admin });
    await insertFolder({ id: 'cy-c', parentId: 'cy-p', name: 'cy-c', deletedAt: '2026-11-10T00:00:00.000Z', deletedBy: USERS.admin });

    const intoChild = await call('/api/folders/cy-p/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { targetParentId: 'cy-c' },
    });
    expect(intoChild.status).toBe(400);
    expect(intoChild.body.code).toBe('CIRCULAR_RESTORE');
    expect((await folderRow('cy-p'))?.deleted_at).not.toBeNull();

    const intoSelf = await call('/api/folders/cy-p/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { targetParentId: 'cy-p' },
    });
    expect(intoSelf.status).toBe(400);
    expect(intoSelf.body.code).toBe('CIRCULAR_RESTORE');

    let parentId: string | null = ROOT;
    for (let depth = 0; depth < 20; depth++) {
      const id = `dp-${depth}`;
      await insertFolder({
        id,
        parentId,
        name: `dp-${depth}`,
      });
      parentId = id;
    }
    await insertFolder({ id: 'dp-src', parentId: ROOT, name: 'dp-src' });
    await insertFolder({ id: 'dp-sub', parentId: 'dp-src', name: 'dp-sub' });
    await deleteFolderViaApi('dp-src');

    const tooDeep = await call('/api/folders/dp-src/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { targetParentId: 'dp-19' },
    });
    expect(tooDeep.status).toBe(400);
    expect(tooDeep.body.code).toBe('MAX_DEPTH_EXCEEDED');
    expect((await folderRow('dp-src'))?.deleted_at).not.toBeNull();
  });

  it('promotes the destination classification floor across subtrees and keeps FTS/storage buckets consistent', async () => {
    await syncStorageStats();

    await insertFolder({ id: 'cf-src', parentId: ROOT, name: 'cf-src' });
    await insertFolder({ id: 'cf-sub', parentId: 'cf-src', name: 'cf-sub' });
    await insertFile({
      id: 'cf-file-1',
      folderId: 'cf-src',
      name: 'cf-one.txt',
      classification: 'internal',
      sizeBytes: 110,
    });
    await insertFile({
      id: 'cf-file-2',
      folderId: 'cf-sub',
      name: 'cf-two.txt',
      classification: 'public',
      sizeBytes: 120,
    });
    await deleteFolderViaApi('cf-src');
    await syncStorageStats();

    const folderRestore = await call('/api/folders/cf-src/restore', {
      method: 'POST',
      user: USERS.owner,
      body: { targetParentId: SECRET },
    });
    expect(folderRestore.status).toBe(200);
    expect(await folderRow('cf-src')).toMatchObject({
      parent_id: SECRET,
      classification: 'confidential',
      deleted_at: null,
    });
    expect(await folderRow('cf-sub')).toMatchObject({
      classification: 'confidential',
      deleted_at: null,
    });
    const movedClosures = await env.DB.prepare(
      `SELECT ancestor_id, descendant_id, depth
         FROM folder_closures
        WHERE tenant_id = ? AND descendant_id IN ('cf-src', 'cf-sub')
        ORDER BY descendant_id, depth`
    )
      .bind(TENANT)
      .all<{ ancestor_id: string; descendant_id: string; depth: number }>();
    expect(
      movedClosures.results.map((row) => `${row.ancestor_id}:${row.descendant_id}:${row.depth}`)
    ).toEqual(
      expect.arrayContaining([
        `${SECRET}:cf-src:1`,
        `${SECRET}:cf-sub:2`,
        `cf-src:cf-sub:1`,
      ])
    );
    expect((await folderRow('cf-sub'))?.depth).toBe(2);
    expect(await fileRow('cf-file-1')).toMatchObject({
      classification: 'confidential',
      deleted_at: null,
    });
    expect(await fileRow('cf-file-2')).toMatchObject({
      classification: 'confidential',
      deleted_at: null,
    });
    const fts = await env.DB.prepare(
      `SELECT file_id, classification FROM files_fts
        WHERE file_id IN ('cf-file-1', 'cf-file-2') ORDER BY file_id`
    ).all<{ file_id: string; classification: string }>();
    expect(fts.results).toEqual([
      { file_id: 'cf-file-1', classification: 'confidential' },
      { file_id: 'cf-file-2', classification: 'confidential' },
    ]);
    await assertStorageStatsConsistent();

    await insertFile({
      id: 'cf-file-3',
      folderId: ROOT,
      name: 'cf-three.txt',
      classification: 'internal',
      deletedAt: '2026-11-09T00:00:00.000Z',
      deletedBy: USERS.admin,
      sizeBytes: 130,
    });
    await syncStorageStats();
    const fileRestore = await call('/api/files/cf-file-3/restore', {
      method: 'POST',
      user: USERS.owner,
      body: { targetFolderId: SECRET },
    });
    expect(fileRestore.status).toBe(200);
    expect((await fileRow('cf-file-3'))?.classification).toBe('confidential');
    const fileFts = await env.DB.prepare(
      'SELECT classification FROM files_fts WHERE file_id = ?'
    )
      .bind('cf-file-3')
      .first<{ classification: string }>();
    expect(fileFts?.classification).toBe('confidential');
    await assertStorageStatsConsistent();
  });

  it('handles file/folder name conflicts, suggested names, newName compatibility and never overwrites', async () => {
    await insertFile({ id: 'nc-active', folderId: ROOT, name: 'nc.txt' });
    await insertFile({
      id: 'nc-trashed',
      folderId: ROOT,
      name: 'nc.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });

    const fail = await call('/api/files/nc-trashed/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { conflictPolicy: 'fail' },
    });
    expect(fail.status).toBe(409);
    expect(fail.body.code).toBe('NAME_CONFLICT');
    expect(fail.body.suggestedName).toBe('nc (Restored).txt');
    expect((fail.body.destination as { id: string }).id).toBe(ROOT);
    expect((fail.body.destination as { path: string }).path).toContain(
      'Restore Root'
    );
    expect((await fileRow('nc-trashed'))?.deleted_at).not.toBeNull();
    expect((await fileRow('nc-active'))?.name).toBe('nc.txt');

    const rename = await call('/api/files/nc-trashed/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { conflictPolicy: 'rename' },
    });
    expect(rename.status).toBe(200);
    expect((await fileRow('nc-trashed'))?.name).toBe('nc (Restored).txt');
    expect((await fileRow('nc-active'))?.name).toBe('nc.txt');
    const activeNames = await env.DB.prepare(
      `SELECT name FROM files WHERE tenant_id = ? AND folder_id = ? AND deleted_at IS NULL
        AND name LIKE 'nc%' ORDER BY name`
    )
      .bind(TENANT, ROOT)
      .all<{ name: string }>();
    expect(activeNames.results.map((row) => row.name)).toEqual([
      'nc (Restored).txt',
      'nc.txt',
    ]);

    await insertFile({
      id: 'nc-new-name',
      folderId: ROOT,
      name: 'nc-old.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    const newName = await call('/api/files/nc-new-name/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { newName: 'nc-renamed.txt' },
    });
    expect(newName.status).toBe(200);
    expect((await fileRow('nc-new-name'))?.name).toBe('nc-renamed.txt');

    await insertFile({
      id: 'nc-new-conflict',
      folderId: ROOT,
      name: 'nc-other.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    const newNameConflict = await call('/api/files/nc-new-conflict/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { newName: 'nc-renamed.txt', conflictPolicy: 'fail' },
    });
    expect(newNameConflict.status).toBe(409);
    expect(newNameConflict.body.code).toBe('NAME_CONFLICT');
    expect((await fileRow('nc-new-conflict'))?.deleted_at).not.toBeNull();

    await insertFolder({ id: 'ncf-active', parentId: ROOT, name: 'ncf' });
    await insertFolder({
      id: 'ncf-trashed',
      parentId: ROOT,
      name: 'ncf',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    const folderFail = await call('/api/folders/ncf-trashed/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { conflictPolicy: 'fail' },
    });
    expect(folderFail.status).toBe(409);
    expect(folderFail.body.code).toBe('NAME_CONFLICT');
    expect(folderFail.body.suggestedName).toBe('ncf (Restored)');

    const folderRename = await call('/api/folders/ncf-trashed/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { conflictPolicy: 'rename' },
    });
    expect(folderRename.status).toBe(200);
    expect((await folderRow('ncf-trashed'))?.name).toBe('ncf (Restored)');
    expect((await folderRow('ncf-active'))?.name).toBe('ncf');
  });

  it('exposes restore context with breadcrumbs, floor, deleted ancestors and conflict suggestions without leaking private parents', async () => {
    await insertFolder({ id: 'tl-a', parentId: ROOT, name: 'tl-a', classification: 'internal' });
    await insertFile({
      id: 'tl-same',
      folderId: 'tl-a',
      name: 'tl-same.txt',
    });
    await insertFile({
      id: 'tl-early',
      folderId: 'tl-a',
      name: 'tl-early.txt',
      deletedAt: '2026-11-01T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await deleteFolderViaApi('tl-a');

    const listed = await call('/api/folders/trash?limit=200&query=tl-');
    expect(listed.status).toBe(200);
    const listedItems = listed.body.items as Array<{
      type: string;
      id: string;
      name: string;
    }>;
    expect(listedItems.some((item) => item.id === 'tl-a')).toBe(true);
    expect(listedItems.some((item) => item.id === 'tl-early')).toBe(true);
    // Same-batch subtree rows stay hidden; only the subtree root is listed.
    expect(listedItems.some((item) => item.id === 'tl-same')).toBe(false);

    const context = await call(
      '/api/trash/restore-context?type=file&id=tl-early',
      { user: USERS.editor }
    );
    expect(context.status).toBe(200);
    expect(context.body.type).toBe('file');
    expect(context.body.restoreParentChainAvailable).toBe(true);
    expect(context.body.restoreParentChainDefault).toBe(true);
    expect(context.body.itemEffectiveRole).toBe('editor');
    const original = context.body.originalLocation as {
      id: string;
      path: string;
      classification: string;
      isDeleted: boolean;
      deletedAncestorCount: number;
      accessible: boolean;
      breadcrumbs: Array<{ id: string; name: string }>;
    };
    expect(original).toMatchObject({
      id: 'tl-a',
      classification: 'internal',
      isDeleted: true,
      deletedAncestorCount: 1,
      accessible: true,
    });
    expect(original.path).toContain('Restore Root');
    expect(original.path).toContain('tl-a');
    expect(original.breadcrumbs.map((crumb) => crumb.name)).toEqual([
      'Restore Root',
      'tl-a',
    ]);

    await insertFolder({
      id: 'tl-private-root',
      parentId: null,
      name: '極秘人事評価',
      deletedAt: '2026-10-31T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await insertFile({
      id: 'tl-hidden',
      folderId: 'tl-private-root',
      name: 'tl-hidden.txt',
      deletedAt: '2026-11-01T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await grant({
      id: 'tl-hidden-editor',
      targetType: 'file',
      targetId: 'tl-hidden',
      userId: USERS.editor,
      role: 'editor',
    });

    const hiddenContext = await call(
      '/api/trash/restore-context?type=file&id=tl-hidden',
      { user: USERS.editor }
    );
    expect(hiddenContext.status).toBe(200);
    const hiddenOriginal = hiddenContext.body.originalLocation as {
      accessible: boolean;
      name: string;
      path: string;
    };
    expect(hiddenOriginal.accessible).toBe(false);
    expect(JSON.stringify(hiddenContext.body)).not.toContain('極秘人事評価');
    expect(hiddenOriginal.name).not.toContain('極秘人事評価');
    expect(hiddenOriginal.path).not.toContain('極秘人事評価');

    const deniedChain = await call('/api/files/tl-hidden/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true },
    });
    expect(deniedChain.status).toBe(403);
    expect((await folderRow('tl-private-root'))?.deleted_at).toBe(
      '2026-10-31T00:00:00.000Z'
    );
    expect((await fileRow('tl-hidden'))?.deleted_at).not.toBeNull();

    const outsider = await call(
      '/api/trash/restore-context?type=file&id=tl-early',
      { user: USERS.outsider }
    );
    expect(outsider.status).toBe(403);

    await insertFile({
      id: 'ctx-conflict-active',
      folderId: ROOT,
      name: 'ctx-conflict.txt',
    });
    await insertFile({
      id: 'ctx-conflict-trashed',
      folderId: ROOT,
      name: 'ctx-conflict.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    const conflictContext = await call(
      '/api/trash/restore-context?type=file&id=ctx-conflict-trashed',
      { user: USERS.editor }
    );
    expect(conflictContext.status).toBe(200);
    expect(
      (conflictContext.body.conflict as {
        hasConflict: boolean;
        suggestedName: string;
      })
    ).toEqual({
      hasConflict: true,
      suggestedName: 'ctx-conflict (Restored).txt',
    });

    const targetContext = await call(
      '/api/trash/restore-context?type=file&id=tl-early&targetParentId=ro-other',
      { user: USERS.editor }
    );
    expect(targetContext.status).toBe(200);
    const targetDestination = targetContext.body.destination as {
      id: string;
      classification: string;
      accessible: boolean;
    };
    expect(targetDestination.id).toBe(OTHER);
    expect(targetDestination.classification).toBe('internal');
    expect(targetDestination.accessible).toBe(true);
  });

  it('validates expectedVersion, parent-deleted defaults and bulk restore compatibility', async () => {
    await insertFile({ id: 'ev-file', folderId: ROOT, name: 'ev-file.txt' });
    const del = await call('/api/files/ev-file', { method: 'DELETE', user: USERS.editor });
    expect(del.status).toBe(200);
    const evRow = await fileRow('ev-file');
    expect(evRow?.meta_version).toBe(2);

    const wrongVersion = await call('/api/files/ev-file/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { expectedVersion: 999 },
    });
    expect(wrongVersion.status).toBe(409);
    expect(wrongVersion.body.code).toBe('VERSION_CONFLICT');
    expect((wrongVersion.body.latest as { id: string }).id).toBe('ev-file');
    expect((await fileRow('ev-file'))?.deleted_at).not.toBeNull();

    const okVersion = await call('/api/files/ev-file/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { expectedVersion: 2 },
    });
    expect(okVersion.status).toBe(200);

    await insertFolder({
      id: 'bf-parent',
      parentId: ROOT,
      name: 'bf-parent',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await insertFile({
      id: 'bf-file',
      folderId: 'bf-parent',
      name: 'bf-file.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    const defaultRestore = await call('/api/files/bf-file/restore', {
      method: 'POST',
      user: USERS.editor,
      body: {},
    });
    expect(defaultRestore.status).toBe(409);
    expect(defaultRestore.body.code).toBe('PARENT_FOLDER_DELETED');
    expect((defaultRestore.body.destination as { isDeleted: boolean }).isDeleted).toBe(true);

    const bulk = await call('/api/trash/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { items: [{ type: 'file', id: 'bf-file' }], conflictPolicy: 'fail' },
    });
    expect(bulk.status).toBe(200);
    const bulkResults = bulk.body.results as Array<{
      id: string;
      code?: string;
      status: string;
    }>;
    expect(bulkResults[0]).toMatchObject({
      id: 'bf-file',
      status: 'failed',
      code: 'PARENT_FOLDER_DELETED',
    });
    expect((await fileRow('bf-file'))?.deleted_at).not.toBeNull();

    const bulkChain = await call('/api/files/bf-file/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { restoreParentChain: true },
    });
    expect(bulkChain.status).toBe(200);
    expect((await folderRow('bf-parent'))?.deleted_at).toBeNull();
    expect((await fileRow('bf-file'))?.deleted_at).toBeNull();
  });
});
