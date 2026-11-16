import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-trash-bulk';
const EMPTY_TENANT = 'tenant-trash-empty';
const ROOT = 'bulk-root';
const SECRET = 'bulk-secret';

const USERS = {
  admin: 'bulk-admin',
  owner: 'bulk-owner',
  coowner: 'bulk-coowner',
  editor: 'bulk-editor',
  viewer: 'bulk-viewer',
  previewer: 'bulk-previewer',
  outsider: 'bulk-outsider',
} as const;

interface BulkItemResult {
  type: 'file' | 'folder';
  id: string;
  ok: boolean;
  status: 'succeeded' | 'failed' | 'skipped';
  code?: string;
  error?: string;
  name?: string;
  purgedFileCount?: number;
  purgedFolderCount?: number;
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
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: input.method ?? 'GET',
      headers: authHeaders(
        input.user ?? USERS.admin,
        input.role ?? (input.user === USERS.admin ? 'sys_admin' : 'member'),
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
  tenantId?: string;
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
      TENANT,
      input.fileId,
      input.versionNum ?? 1,
      input.key,
      input.sizeBytes ?? 100,
      USERS.admin
    )
    .run();
}

async function deleteFolderViaApi(folderId: string, userId: string): Promise<void> {
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8787/api/folders/${folderId}`, {
      method: 'DELETE',
      headers: authHeaders(userId),
    }),
    buildTestEnv()
  );
  expect(response.status, `DELETE /api/folders/${folderId}`).toBe(200);
}

async function ensureBase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (id, name, slug)
       VALUES (?, 'Trash Bulk Org', 'trash-bulk-org')`
    ).bind(TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenant_policies (tenant_id, trash_retention_days)
       VALUES (?, 30)`
    ).bind(TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
       VALUES
         (?, ?, 'bulk-admin@example.com', 'Bulk Admin', 'sys_admin', 'active'),
         (?, ?, 'bulk-owner@example.com', 'Bulk Owner', 'member', 'active'),
         (?, ?, 'bulk-coowner@example.com', 'Bulk Coowner', 'member', 'active'),
         (?, ?, 'bulk-editor@example.com', 'Bulk Editor', 'member', 'active'),
         (?, ?, 'bulk-viewer@example.com', 'Bulk Viewer', 'member', 'active'),
         (?, ?, 'bulk-previewer@example.com', 'Bulk Previewer', 'member', 'active'),
         (?, ?, 'bulk-outsider@example.com', 'Bulk Outsider', 'member', 'active')`
    ).bind(
      USERS.admin,
      TENANT,
      USERS.owner,
      TENANT,
      USERS.coowner,
      TENANT,
      USERS.editor,
      TENANT,
      USERS.viewer,
      TENANT,
      USERS.previewer,
      TENANT,
      USERS.outsider,
      TENANT
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
       VALUES (?, 'unset', 0, 0), (?, 'internal', 0, 0), (?, 'confidential', 0, 0), (?, 'public', 0, 0)`
    ).bind(TENANT, TENANT, TENANT, TENANT),
  ]);

  await insertFolder({ id: ROOT, parentId: null, name: 'Bulk Root' });
  await insertFolder({
    id: SECRET,
    parentId: null,
    name: 'Bulk Secret',
    classification: 'confidential',
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions
         (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES
         ('bulk-p-root-owner', ?, 'folder', ?, 'user', ?, 'owner', ?),
         ('bulk-p-root-coowner', ?, 'folder', ?, 'user', ?, 'co_owner', ?),
         ('bulk-p-root-editor', ?, 'folder', ?, 'user', ?, 'editor', ?),
         ('bulk-p-root-viewer', ?, 'folder', ?, 'user', ?, 'viewer', ?),
         ('bulk-p-root-previewer', ?, 'folder', ?, 'user', ?, 'previewer', ?),
         ('bulk-p-secret-viewer', ?, 'folder', ?, 'user', ?, 'viewer', ?)`
    ).bind(
      TENANT,
      ROOT,
      USERS.owner,
      USERS.admin,
      TENANT,
      ROOT,
      USERS.coowner,
      USERS.admin,
      TENANT,
      ROOT,
      USERS.editor,
      USERS.admin,
      TENANT,
      ROOT,
      USERS.viewer,
      USERS.admin,
      TENANT,
      ROOT,
      USERS.previewer,
      USERS.admin,
      TENANT,
      SECRET,
      USERS.editor,
      USERS.admin
    ),
  ]);
}

function findResult(
  response: BulkResponse,
  type: 'file' | 'folder',
  id: string
): BulkItemResult {
  const found = response.results.find(
    (result) => result.type === type && result.id === id
  );
  expect(found, `result for ${type}:${id}`).toBeTruthy();
  return found!;
}

describe('Trash bulk restore / permanent purge / empty APIs (TOM-49)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await ensureBase();
  });

  it('restores items independently: success + forbidden + not-in-trash + parent-deleted partial success', async () => {
    const okFolder = 'rb-ok-folder';
    const okFile = 'rb-ok-file';
    const secretFile = 'rb-secret-file';
    const activeFile = 'rb-active-file';
    const parentFolder = 'rb-parent-deleted';
    const childFile = 'rb-child-of-deleted';

    await insertFolder({
      id: okFolder,
      parentId: ROOT,
      name: 'Restore OK Folder',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    await insertFile({
      id: okFile,
      folderId: ROOT,
      name: 'restore-ok.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    await insertFile({
      id: secretFile,
      folderId: SECRET,
      name: 'restore-forbidden.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    await insertFile({
      id: activeFile,
      folderId: ROOT,
      name: 'restore-active.txt',
    });
    await insertFolder({
      id: parentFolder,
      parentId: ROOT,
      name: 'Restore Parent Deleted',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    await insertFile({
      id: childFile,
      folderId: parentFolder,
      name: 'restore-parent-deleted.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });

    const response = await call('/api/trash/restore', {
      method: 'POST',
      user: USERS.editor,
      body: {
        items: [
          { type: 'folder', id: okFolder },
          { type: 'file', id: okFile },
          { type: 'file', id: okFile }, // duplicate must be normalized
          { type: 'file', id: secretFile },
          { type: 'file', id: activeFile },
          { type: 'file', id: childFile },
        ],
        conflictPolicy: 'fail',
      },
    });

    expect(response.status).toBe(200);
    const body = response.body as unknown as BulkResponse;
    expect(body.results).toHaveLength(5);
    expect(body.succeededCount).toBe(2);
    expect(body.failedCount).toBe(3);
    expect(findResult(body, 'folder', okFolder)).toMatchObject({
      ok: true,
      status: 'succeeded',
    });
    expect(findResult(body, 'file', okFile)).toMatchObject({
      ok: true,
      status: 'succeeded',
    });
    expect(findResult(body, 'file', secretFile)).toMatchObject({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(findResult(body, 'file', activeFile)).toMatchObject({
      ok: false,
      code: 'NOT_IN_TRASH',
    });
    expect(findResult(body, 'file', childFile)).toMatchObject({
      ok: false,
      code: 'PARENT_FOLDER_DELETED',
    });

    const restoredRows = await env.DB.prepare(
      `SELECT id, deleted_at, deleted_by FROM files WHERE id IN (?, ?)`
    )
      .bind(okFile, childFile)
      .all<{ id: string; deleted_at: string | null; deleted_by: string | null }>();
    const okRow = restoredRows.results.find((row) => row.id === okFile);
    expect(okRow).toEqual({ id: okFile, deleted_at: null, deleted_by: null });

    const restoredFolder = await env.DB.prepare(
      'SELECT deleted_at, deleted_by FROM folders WHERE id = ?'
    )
      .bind(okFolder)
      .first<{ deleted_at: string | null; deleted_by: string | null }>();
    expect(restoredFolder).toEqual({ deleted_at: null, deleted_by: null });

    const childRow = await env.DB.prepare(
      'SELECT deleted_at FROM files WHERE id = ?'
    )
      .bind(childFile)
      .first<{ deleted_at: string | null }>();
    expect(childRow?.deleted_at).not.toBeNull();

    const audits = await env.DB.prepare(
      `SELECT action, target_id FROM audit_logs
        WHERE tenant_id = ? AND target_id IN (?, ?) AND action IN ('file.restore', 'folder.restore')`
    )
      .bind(TENANT, okFile, okFolder)
      .all<{ action: string; target_id: string }>();
    expect(audits.results.map((row) => `${row.action}:${row.target_id}`).sort())
      .toEqual([`file.restore:${okFile}`, `folder.restore:${okFolder}`].sort());

    const syncRows = await env.DB.prepare(
      `SELECT action, entity_id FROM sync_changes
        WHERE tenant_id = ? AND entity_id IN (?, ?) AND action IN ('file.restore', 'folder.restore')`
    )
      .bind(TENANT, okFile, okFolder)
      .all<{ action: string; entity_id: string }>();
    expect(syncRows.results.map((row) => `${row.action}:${row.entity_id}`).sort())
      .toEqual([`file.restore:${okFile}`, `folder.restore:${okFolder}`].sort());
  });

  it('honors conflictPolicy fail/rename for files and folders and keeps the single-file API compatible', async () => {
    const activeFile = 'rb-conflict-active-file';
    const trashedFile = 'rb-conflict-trashed-file';
    const activeFolder = 'rb-conflict-active-folder';
    const trashedFolder = 'rb-conflict-trashed-folder';

    await insertFile({
      id: activeFile,
      folderId: ROOT,
      name: 'conflict.txt',
    });
    await insertFile({
      id: trashedFile,
      folderId: ROOT,
      name: 'conflict.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    await insertFolder({
      id: activeFolder,
      parentId: ROOT,
      name: 'conflict-folder',
    });
    await insertFolder({
      id: trashedFolder,
      parentId: ROOT,
      name: 'conflict-folder',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });

    const fail = await call('/api/trash/restore', {
      method: 'POST',
      user: USERS.editor,
      body: {
        items: [
          { type: 'file', id: trashedFile },
          { type: 'folder', id: trashedFolder },
        ],
        conflictPolicy: 'fail',
      },
    });
    expect(fail.status).toBe(200);
    const failBody = fail.body as unknown as BulkResponse;
    expect(failBody.succeededCount).toBe(0);
    expect(findResult(failBody, 'file', trashedFile)).toMatchObject({
      code: 'NAME_CONFLICT',
    });
    expect(findResult(failBody, 'folder', trashedFolder)).toMatchObject({
      code: 'NAME_CONFLICT',
    });

    const rename = await call('/api/trash/restore', {
      method: 'POST',
      user: USERS.editor,
      body: {
        items: [
          { type: 'file', id: trashedFile },
          { type: 'folder', id: trashedFolder },
        ],
        conflictPolicy: 'rename',
      },
    });
    expect(rename.status).toBe(200);
    const renameBody = rename.body as unknown as BulkResponse;
    expect(renameBody.succeededCount).toBe(2);

    const renamedFile = await env.DB.prepare(
      'SELECT name FROM files WHERE id = ?'
    )
      .bind(trashedFile)
      .first<{ name: string }>();
    expect(renamedFile?.name).toBe('conflict (Restored).txt');
    const renamedFolder = await env.DB.prepare(
      'SELECT name FROM folders WHERE id = ?'
    )
      .bind(trashedFolder)
      .first<{ name: string }>();
    expect(renamedFolder?.name).toBe('conflict-folder (Restored)');

    // Existing single-file restore contract (`newName`) still works.
    const singleTrashed = 'rb-single-restore';
    await insertFile({
      id: singleTrashed,
      folderId: ROOT,
      name: 'single.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.editor,
    });
    const single = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${singleTrashed}/restore`, {
        method: 'POST',
        headers: authHeaders(USERS.editor),
        body: JSON.stringify({ newName: 'single-renamed.txt' }),
      }),
      buildTestEnv()
    );
    expect(single.status).toBe(200);
    const singleBody = (await single.json()) as { file: { name: string } };
    expect(singleBody.file.name).toBe('single-renamed.txt');
  });

  it('validates item arrays and conflictPolicy before touching D1', async () => {
    const empty = await call('/api/trash/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { items: [] },
    });
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('EMPTY_ITEMS');

    const tooMany = await call('/api/trash/restore', {
      method: 'POST',
      user: USERS.editor,
      body: {
        items: Array.from({ length: 101 }, (_, index) => ({
          type: 'file',
          id: `validation-${index}`,
        })),
      },
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.code).toBe('TOO_MANY_ITEMS');

    const invalid = await call('/api/trash/restore', {
      method: 'POST',
      user: USERS.editor,
      body: { items: [{ type: 'link', id: 'x' }] },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_ITEM_TYPE');

    const badPolicy = await call('/api/trash/restore', {
      method: 'POST',
      user: USERS.editor,
      body: {
        items: [{ type: 'file', id: 'whatever' }],
        conflictPolicy: 'overwrite',
      },
    });
    expect(badPolicy.status).toBe(400);
    expect(badPolicy.body.code).toBe('INVALID_CONFLICT_POLICY');

    const emptyPurge = await call('/api/trash/items', {
      method: 'DELETE',
      user: USERS.owner,
      body: { items: [] },
    });
    expect(emptyPurge.status).toBe(400);
    expect(emptyPurge.body.code).toBe('EMPTY_ITEMS');

    const tooManyPurge = await call('/api/trash/items', {
      method: 'DELETE',
      user: USERS.owner,
      body: {
        items: Array.from({ length: 101 }, (_, index) => ({
          type: 'file',
          id: `validation-purge-${index}`,
        })),
      },
    });
    expect(tooManyPurge.status).toBe(400);
    expect(tooManyPurge.body.code).toBe('TOO_MANY_ITEMS');
  });

  it('allows permanent deletion only for sys_admin / owner / co_owner and rejects active or pending rows', async () => {
    const targets = {
      owner: 'pq-file-owner',
      coowner: 'pq-file-coowner',
      editor: 'pq-file-editor',
      viewer: 'pq-file-viewer',
      previewer: 'pq-file-previewer',
      outsider: 'pq-file-outsider',
      admin: 'pq-file-admin',
      active: 'pq-file-active',
      pending: 'pq-file-pending',
    };
    const roleMap = {
      owner: 'owner',
      coowner: 'co_owner',
      editor: 'editor',
      viewer: 'viewer',
      previewer: 'previewer',
    } as const;
    for (const roleName of ['owner', 'coowner', 'editor', 'viewer', 'previewer'] as const) {
      await insertFile({
        id: targets[roleName],
        folderId: null,
        name: `${roleName}.txt`,
        deletedAt: '2026-11-10T00:00:00.000Z',
        deletedBy: USERS.admin,
      });
      await grant({
        id: `pq-perm-${roleName}`,
        targetType: 'file',
        targetId: targets[roleName],
        userId: USERS[roleName],
        role: roleMap[roleName],
      });
    }
    await insertFile({
      id: targets.outsider,
      folderId: null,
      name: 'outsider.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await insertFile({
      id: targets.admin,
      folderId: null,
      name: 'admin.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await insertFile({
      id: targets.active,
      folderId: null,
      name: 'active-not-trash.txt',
    });
    await insertFile({
      id: targets.pending,
      folderId: null,
      name: 'pending-not-active.txt',
      uploadState: 'pending',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: USERS.admin,
    });
    await grant({
      id: 'pq-perm-active-owner',
      targetType: 'file',
      targetId: targets.active,
      userId: USERS.owner,
      role: 'owner',
    });
    await grant({
      id: 'pq-perm-pending-owner',
      targetType: 'file',
      targetId: targets.pending,
      userId: USERS.owner,
      role: 'owner',
    });

    for (const [user, id] of [
      [USERS.owner, targets.owner],
      [USERS.coowner, targets.coowner],
    ] as const) {
      const response = await call('/api/trash/items', {
        method: 'DELETE',
        user,
        body: { items: [{ type: 'file', id }] },
      });
      expect(response.status, `${user} should purge ${id}`).toBe(200);
      const body = response.body as unknown as BulkResponse;
      expect(body.succeededCount).toBe(1);
      expect(
        await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(id).first()
      ).toBeNull();
    }

    const adminPurge = await call('/api/trash/items', {
      method: 'DELETE',
      user: USERS.admin,
      body: { items: [{ type: 'file', id: targets.admin }] },
    });
    expect(adminPurge.status).toBe(200);
    expect(
      (adminPurge.body as unknown as BulkResponse).succeededCount
    ).toBe(1);

    for (const [user, id] of [
      [USERS.editor, targets.editor],
      [USERS.viewer, targets.viewer],
      [USERS.previewer, targets.previewer],
      [USERS.outsider, targets.outsider],
    ] as const) {
      const response = await call('/api/trash/items', {
        method: 'DELETE',
        user,
        body: { items: [{ type: 'file', id }] },
      });
      expect(response.status, `${user} must be rejected`).toBe(200);
      const body = response.body as unknown as BulkResponse;
      expect(body.succeededCount).toBe(0);
      const result = findResult(body, 'file', id);
      expect(result.ok).toBe(false);
      expect(['FORBIDDEN', 'NOT_FOUND']).toContain(result.code);
      expect(
        await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(id).first()
      ).not.toBeNull();
    }

    const activeReject = await call('/api/trash/items', {
      method: 'DELETE',
      user: USERS.owner,
      body: { items: [{ type: 'file', id: targets.active }] },
    });
    expect(activeReject.status).toBe(200);
    expect(
      findResult(activeReject.body as unknown as BulkResponse, 'file', targets.active)
    ).toMatchObject({ ok: false, code: 'NOT_IN_TRASH' });

    const pendingReject = await call('/api/trash/items', {
      method: 'DELETE',
      user: USERS.owner,
      body: { items: [{ type: 'file', id: targets.pending }] },
    });
    expect(pendingReject.status).toBe(200);
    expect(
      findResult(pendingReject.body as unknown as BulkResponse, 'file', targets.pending)
    ).toMatchObject({ ok: false, code: 'UPLOAD_NOT_ACTIVE' });

    const audit = await env.DB.prepare(
      `SELECT target_id FROM audit_logs
        WHERE tenant_id = ? AND action = 'file.purge' AND target_id = ?`
    )
      .bind(TENANT, targets.owner)
      .all<{ target_id: string }>();
    expect(audit.results).toHaveLength(1);
    const sync = await env.DB.prepare(
      `SELECT entity_id FROM sync_changes
        WHERE tenant_id = ? AND action = 'file.purged' AND entity_id = ?`
    )
      .bind(TENANT, targets.owner)
      .all<{ entity_id: string }>();
    expect(sync.results).toHaveLength(1);

    // Purge invalidations are tenant-scoped so even a user whose ACL rows were
    // deleted with the file can remove the stale cached entity.
    const delta = await call('/api/sync/delta?sinceSeq=0&limit=200', {
      user: USERS.viewer,
    });
    expect(delta.status).toBe(200);
    const changes = (delta.body as { changes: Array<{ action: string; entityId: string }> })
      .changes;
    expect(
      changes.some(
        (change) =>
          change.action === 'file.purged' && change.entityId === targets.owner
      )
    ).toBe(true);
  });

  it('skips locked files and folders containing locked files with FILE_LOCKED', async () => {
    const lockedFile = 'pq-locked-file';
    const folderId = 'pq-locked-folder';
    const childFile = 'pq-locked-child';
    await insertFile({
      id: lockedFile,
      folderId: ROOT,
      name: 'locked.txt',
    });
    await insertFolder({ id: folderId, parentId: ROOT, name: 'Locked Folder' });
    await insertFile({
      id: childFile,
      folderId,
      name: 'locked-child.txt',
    });

    const lockResponse = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${lockedFile}/lock`, {
        method: 'POST',
        headers: authHeaders(USERS.owner),
        body: JSON.stringify({ lockId: 'bulk-lock-1', ttlSeconds: 600 }),
      }),
      buildTestEnv()
    );
    expect(lockResponse.status).toBe(201);

    const childLock = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${childFile}/lock`, {
        method: 'POST',
        headers: authHeaders(USERS.owner),
        body: JSON.stringify({ lockId: 'bulk-lock-2', ttlSeconds: 600 }),
      }),
      buildTestEnv()
    );
    expect(childLock.status).toBe(201);

    // Simulate an item reaching Trash while a lock is still held (the normal
    // soft-delete route correctly rejects locked files). This reproduces the
    // stale-lock race the purge API must defend against.
    await env.DB.prepare(
      'UPDATE files SET deleted_at = ?, deleted_by = ? WHERE id = ?'
    )
      .bind('2026-11-10T00:00:00.000Z', USERS.admin, lockedFile)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE folders SET deleted_at = ?, deleted_by = ? WHERE id = ?'
      ).bind('2026-11-10T00:00:00.000Z', USERS.admin, folderId),
      env.DB.prepare(
        'UPDATE files SET deleted_at = ?, deleted_by = ? WHERE id = ?'
      ).bind('2026-11-10T00:00:00.000Z', USERS.admin, childFile),
    ]);

    const response = await call('/api/trash/items', {
      method: 'DELETE',
      user: USERS.admin,
      body: {
        items: [
          { type: 'file', id: lockedFile },
          { type: 'folder', id: folderId },
        ],
      },
    });
    expect(response.status).toBe(200);
    const body = response.body as unknown as BulkResponse;
    expect(body.succeededCount).toBe(0);
    expect(body.failedCount).toBe(2);
    expect(body.skippedCount).toBe(2);
    expect(findResult(body, 'file', lockedFile)).toMatchObject({
      status: 'skipped',
      code: 'FILE_LOCKED',
    });
    expect(findResult(body, 'folder', folderId)).toMatchObject({
      status: 'skipped',
      code: 'FILE_LOCKED',
    });

    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(lockedFile).first()
    ).not.toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM folders WHERE id = ?').bind(folderId).first()
    ).not.toBeNull();

    if (env.FILE_LOCK_HUB) {
      const unlockFile = env.FILE_LOCK_HUB.get(
        env.FILE_LOCK_HUB.idFromName(lockedFile)
      );
      await unlockFile.unlockFile({ fileId: lockedFile, lockId: 'bulk-lock-1' });
      const unlockChild = env.FILE_LOCK_HUB.get(
        env.FILE_LOCK_HUB.idFromName(childFile)
      );
      await unlockChild.unlockFile({ fileId: childFile, lockId: 'bulk-lock-2' });
    }

    const afterUnlock = await call('/api/trash/items', {
      method: 'DELETE',
      user: USERS.admin,
      body: {
        items: [
          { type: 'file', id: lockedFile },
          { type: 'folder', id: folderId },
        ],
      },
    });
    expect(afterUnlock.status).toBe(200);
    expect(
      (afterUnlock.body as unknown as BulkResponse).succeededCount
    ).toBe(2);
  });

  it('purges a folder subtree with D1 consistency, storage stats, CoW R2 protection and WOPI draft cleanup', async () => {
    const folderId = 'pq-tree-root';
    const subFolderId = 'pq-tree-sub';
    const sharedFile = 'pq-tree-file-shared';
    const uniqueFile = 'pq-tree-file-unique';
    const externalFile = 'pq-tree-external';
    const sharedKey = 'bulk/cow-shared';
    const uniqueKey = 'bulk/unique-version';
    const draftUniqueKey = 'bulk/draft-unique';
    const draftSharedKey = 'bulk/draft-shared';

    await insertFolder({ id: folderId, parentId: ROOT, name: 'Purge Tree' });
    await insertFolder({
      id: subFolderId,
      parentId: folderId,
      name: 'Purge Subtree',
    });
    await insertFile({
      id: sharedFile,
      folderId,
      name: 'shared-cow.txt',
      sizeBytes: 100,
    });
    await insertFile({
      id: uniqueFile,
      folderId: subFolderId,
      name: 'unique.txt',
      sizeBytes: 200,
    });
    await insertFile({
      id: externalFile,
      folderId: null,
      name: 'external-copy.txt',
      sizeBytes: 100,
    });
    await insertVersion({
      id: 'pq-tree-ver-shared',
      fileId: sharedFile,
      key: sharedKey,
      sizeBytes: 100,
    });
    await insertVersion({
      id: 'pq-tree-ver-unique',
      fileId: uniqueFile,
      key: uniqueKey,
      sizeBytes: 200,
    });
    await insertVersion({
      id: 'pq-tree-ver-external',
      fileId: externalFile,
      key: sharedKey,
      sizeBytes: 100,
    });
    await insertVersion({
      id: 'pq-tree-ver-draft-shared',
      fileId: externalFile,
      key: draftSharedKey,
      sizeBytes: 50,
      versionNum: 2,
    });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO wopi_sessions
           (id, tenant_id, file_id, user_id, role, can_write, access_token_hash, is_active, expires_at)
         VALUES ('pq-tree-wopi-session', ?, ?, ?, 'owner', 1, 'hash', 1, '2099-01-01T00:00:00Z')`
      ).bind(TENANT, uniqueFile, USERS.owner),
      env.DB.prepare(
        `INSERT INTO wopi_drafts
           (id, session_id, tenant_id, file_id, r2_object_key, size_bytes, mime_type, last_saved_by, is_active, expires_at)
         VALUES ('pq-tree-draft-unique', 'pq-tree-wopi-session', ?, ?, ?, 20, 'text/plain', ?, 1, '2099-01-01T00:00:00Z')`
      ).bind(TENANT, uniqueFile, draftUniqueKey, USERS.owner),
      env.DB.prepare(
        `INSERT INTO wopi_drafts
           (id, session_id, tenant_id, file_id, r2_object_key, size_bytes, mime_type, last_saved_by, is_active, expires_at)
         VALUES ('pq-tree-draft-shared', 'pq-tree-wopi-session', ?, ?, ?, 20, 'text/plain', ?, 1, '2099-01-01T00:00:00Z')`
      ).bind(TENANT, uniqueFile, draftSharedKey, USERS.owner),
      env.DB.prepare(
        `INSERT INTO permissions
           (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('pq-tree-perm-folder', ?, 'folder', ?, 'user', ?, 'owner', ?),
           ('pq-tree-perm-file', ?, 'file', ?, 'user', ?, 'owner', ?)`
      ).bind(
        TENANT,
        folderId,
        USERS.owner,
        USERS.admin,
        TENANT,
        sharedFile,
        USERS.owner,
        USERS.admin
      ),
      env.DB.prepare(
        `INSERT INTO shared_links
           (id, tenant_id, token_hash, target_type, target_id, created_by)
         VALUES
           ('pq-tree-link-folder', ?, 'hash-folder', 'folder', ?, ?),
           ('pq-tree-link-file', ?, 'hash-file', 'file', ?, ?)`
      ).bind(TENANT, folderId, USERS.admin, TENANT, uniqueFile, USERS.admin),
      env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES (?, ?, 'internal', 'shared-cow.txt', 'txt', ''), (?, ?, 'internal', 'unique.txt', 'txt', '')`
      ).bind(sharedFile, TENANT, uniqueFile, TENANT),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES (?, 'internal', 3, 400)`
      ).bind(TENANT),
      env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS ai_classification_jobs (
           id TEXT PRIMARY KEY,
           tenant_id TEXT NOT NULL,
           file_id TEXT NOT NULL
         )`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO ai_classification_jobs (id, tenant_id, file_id)
         VALUES ('pq-tree-ai-job', ?, ?)`
      ).bind(TENANT, uniqueFile),
    ]);

    for (const key of [sharedKey, uniqueKey, draftUniqueKey, draftSharedKey]) {
      await env.BUCKET.put(key, `payload-${key}`);
    }

    await deleteFolderViaApi(folderId, USERS.owner);

    // Confirm the whole subtree entered Trash before the purge.
    const trashed = await env.DB.prepare(
      `SELECT id FROM folders WHERE id IN (?, ?) AND deleted_at IS NOT NULL`
    )
      .bind(folderId, subFolderId)
      .all<{ id: string }>();
    expect(trashed.results).toHaveLength(2);

    const response = await call('/api/trash/items', {
      method: 'DELETE',
      user: USERS.owner,
      body: { items: [{ type: 'folder', id: folderId }] },
    });
    expect(response.status).toBe(200);
    const body = response.body as unknown as BulkResponse;
    expect(body.succeededCount).toBe(1);
    const result = findResult(body, 'folder', folderId);
    expect(result.purgedFileCount).toBe(2);
    expect(result.purgedFolderCount).toBe(2);

    const remainingFolders = await env.DB.prepare(
      'SELECT id FROM folders WHERE id IN (?, ?)'
    )
      .bind(folderId, subFolderId)
      .all();
    expect(remainingFolders.results).toHaveLength(0);
    const remainingFiles = await env.DB.prepare(
      'SELECT id FROM files WHERE id IN (?, ?)'
    )
      .bind(sharedFile, uniqueFile)
      .all();
    expect(remainingFiles.results).toHaveLength(0);
    // CoW sibling outside the subtree must survive.
    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(externalFile).first()
    ).not.toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM file_versions WHERE id = ?')
        .bind('pq-tree-ver-external')
        .first()
    ).not.toBeNull();

    const orphanChecks = await env.DB.batch([
      env.DB.prepare(
        "SELECT id FROM permissions WHERE target_id IN (?, ?, ?)"
      ).bind(folderId, subFolderId, uniqueFile),
      env.DB.prepare(
        "SELECT id FROM shared_links WHERE target_id IN (?, ?)"
      ).bind(folderId, uniqueFile),
      env.DB.prepare(
        "SELECT file_id FROM files_fts WHERE file_id IN (?, ?)"
      ).bind(sharedFile, uniqueFile),
      env.DB.prepare(
        "SELECT id FROM wopi_drafts WHERE file_id = ?"
      ).bind(uniqueFile),
      env.DB.prepare(
        "SELECT id FROM wopi_sessions WHERE file_id = ?"
      ).bind(uniqueFile),
      env.DB.prepare(
        "SELECT id FROM file_versions WHERE file_id IN (?, ?)"
      ).bind(sharedFile, uniqueFile),
      env.DB.prepare(
        "SELECT descendant_id FROM folder_closures WHERE descendant_id IN (?, ?)"
      ).bind(folderId, subFolderId),
      env.DB.prepare(
        "SELECT id FROM ai_classification_jobs WHERE file_id = ?"
      ).bind(uniqueFile),
    ]);
    for (const [index, result] of orphanChecks.entries()) {
      expect(result.results, `orphan check ${index}`).toHaveLength(0);
    }

    const stats = await env.DB.prepare(
      "SELECT file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = ? AND classification = 'internal'"
    )
      .bind(TENANT)
      .first<{ file_count: number; total_bytes: number }>();
    expect(stats).toEqual({ file_count: 1, total_bytes: 100 });

    expect(await env.BUCKET.head(sharedKey)).not.toBeNull();
    expect(await env.BUCKET.head(draftSharedKey)).not.toBeNull();
    expect(await env.BUCKET.head(uniqueKey)).toBeNull();
    expect(await env.BUCKET.head(draftUniqueKey)).toBeNull();

    const audit = await env.DB.prepare(
      "SELECT target_id FROM audit_logs WHERE action = 'folder.purge' AND target_id = ?"
    )
      .bind(folderId)
      .all<{ target_id: string }>();
    expect(audit.results).toHaveLength(1);
    const sync = await env.DB.prepare(
      "SELECT entity_id FROM sync_changes WHERE action = 'folder.purged' AND entity_id = ?"
    )
      .bind(folderId)
      .all<{ entity_id: string }>();
    expect(sync.results).toHaveLength(1);
  });

  it('requires EMPTY_TRASH confirmation, deletes only purgeable items and drains >100 items', async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug)
         VALUES (?, 'Trash Empty Org', 'trash-empty-org')`
      ).bind(EMPTY_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id, trash_retention_days)
         VALUES (?, 30)`
      ).bind(EMPTY_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('empty-owner', ?, 'empty-owner@example.com', 'Empty Owner', 'member', 'active'),
           ('empty-editor', ?, 'empty-editor@example.com', 'Empty Editor', 'member', 'active'),
           ('empty-admin', ?, 'empty-admin@example.com', 'Empty Admin', 'sys_admin', 'active')`
      ).bind(EMPTY_TENANT, EMPTY_TENANT, EMPTY_TENANT),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES (?, 'internal', 107, 10700)`
      ).bind(EMPTY_TENANT),
    ]);

    await insertFolderForTenant({
      tenantId: EMPTY_TENANT,
      id: 'empty-owner-root',
      parentId: null,
      name: 'Empty Owner Root',
    });
    await insertFolderForTenant({
      tenantId: EMPTY_TENANT,
      id: 'empty-editor-root',
      parentId: null,
      name: 'Empty Editor Root',
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO permissions
           (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('empty-p-owner', ?, 'folder', 'empty-owner-root', 'user', 'empty-owner', 'owner', 'empty-owner'),
           ('empty-p-editor', ?, 'folder', 'empty-editor-root', 'user', 'empty-owner', 'editor', 'empty-editor'),
           ('empty-p-editor-owner', ?, 'folder', 'empty-editor-root', 'user', 'empty-editor', 'owner', 'empty-editor')`
      ).bind(EMPTY_TENANT, EMPTY_TENANT, EMPTY_TENANT),
      env.DB.prepare(
        `INSERT INTO files
           (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state,
            classification, created_by, updated_by, deleted_at, deleted_by)
         VALUES
           ('empty-owner-file', ?, 'empty-owner-root', 'owner-deletable.txt', 'txt', 'text/plain', 100, 'active',
            'internal', 'empty-owner', 'empty-owner', '2026-11-10T00:00:00.000Z', 'empty-owner'),
           ('empty-editor-file', ?, 'empty-editor-root', 'editor-only.txt', 'txt', 'text/plain', 100, 'active',
            'internal', 'empty-editor', 'empty-editor', '2026-11-10T00:00:00.000Z', 'empty-editor')`
      ).bind(EMPTY_TENANT, EMPTY_TENANT),
    ]);

    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 105; index++) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO files
             (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state,
              classification, created_by, updated_by, deleted_at, deleted_by)
           VALUES (?, ?, 'empty-owner-root', ?, 'txt', 'text/plain', 100, 'active',
                   'internal', 'empty-owner', 'empty-owner', '2026-11-10T00:00:00.000Z', 'empty-owner')`
        ).bind(
          `empty-bulk-${index}`,
          EMPTY_TENANT,
          `bulk-${String(index).padStart(3, '0')}.txt`
        )
      );
      if (statements.length === 30) {
        await env.DB.batch(statements.splice(0));
      }
    }
    if (statements.length > 0) {
      await env.DB.batch(statements);
    }

    const missing = await call('/api/trash/empty', {
      method: 'POST',
      user: 'empty-owner',
      tenantId: EMPTY_TENANT,
      body: {},
    });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('CONFIRMATION_REQUIRED');

    const wrong = await call('/api/trash/empty', {
      method: 'POST',
      user: 'empty-owner',
      tenantId: EMPTY_TENANT,
      body: { confirm: 'EMPTY' },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_CONFIRMATION');

    const response = await call('/api/trash/empty', {
      method: 'POST',
      user: 'empty-owner',
      tenantId: EMPTY_TENANT,
      body: { confirm: 'EMPTY_TRASH' },
    });
    expect(response.status).toBe(200);
    const body = response.body as unknown as EmptyResponse;
    expect(body.deletedCount).toBe(106);
    expect(body.failedCount).toBe(0);
    expect(body.skippedCount).toBe(0);

    const ownerRows = await env.DB.prepare(
      "SELECT id FROM files WHERE tenant_id = ? AND folder_id = 'empty-owner-root'"
    )
      .bind(EMPTY_TENANT)
      .all();
    expect(ownerRows.results).toHaveLength(0);
    expect(
      await env.DB.prepare(
        "SELECT id FROM files WHERE id = 'empty-editor-file'"
      ).first()
    ).not.toBeNull();

    const remainingTrash = await call(
      '/api/folders/trash?limit=200&query=editor-only',
      { user: 'empty-owner', tenantId: EMPTY_TENANT }
    );
    expect(remainingTrash.status).toBe(200);
    const items = (remainingTrash.body as { items: Array<{ id: string }> }).items;
    expect(items.map((item) => item.id)).toEqual(['empty-editor-file']);

    // P8-6 keeps tenant-wide admin bypass out of this endpoint: a sys_admin
    // only empties items inside their own accessible Trash range.
    const adminEmpty = await call('/api/trash/empty', {
      method: 'POST',
      user: 'empty-admin',
      role: 'sys_admin',
      tenantId: EMPTY_TENANT,
      body: { confirm: 'EMPTY_TRASH' },
    });
    expect(adminEmpty.status).toBe(200);
    expect((adminEmpty.body as unknown as EmptyResponse).deletedCount).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT id FROM files WHERE id = 'empty-editor-file'"
      ).first()
    ).not.toBeNull();

    const stats = await env.DB.prepare(
      "SELECT file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = ? AND classification = 'internal'"
    )
      .bind(EMPTY_TENANT)
      .first<{ file_count: number; total_bytes: number }>();
    expect(stats).toEqual({ file_count: 1, total_bytes: 100 });
  }, 180_000);
});

async function insertFolderForTenant(input: {
  tenantId: string;
  id: string;
  parentId: string | null;
  name: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO folders
       (id, tenant_id, parent_id, name, depth, version, classification, is_pinned, created_by)
     VALUES (?, ?, ?, ?, 0, 1, 'internal', 0, ?)`
  )
    .bind(input.id, input.tenantId, input.parentId, input.name, USERS.admin)
    .run();
  await env.DB.prepare(
    `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
     VALUES (?, ?, ?, 0)`
  )
    .bind(input.tenantId, input.id, input.id)
    .run();
  if (input.parentId) {
    await env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       SELECT tenant_id, ancestor_id, ?, depth + 1
         FROM folder_closures
        WHERE tenant_id = ? AND descendant_id = ?`
    )
      .bind(input.id, input.tenantId, input.parentId)
      .run();
  }
}
