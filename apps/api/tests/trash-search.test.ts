import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-trash';
const OTHER_TENANT = 'tenant-trash-other';
const SHARED_ROOT = 'trash-root-shared';
const SECRET_ROOT = 'trash-root-secret';
const OTHER_ROOT = 'trash-root-other';
const DAY_MS = 86_400_000;

// D1 storage is shared across tests in this file. Track every fixture row so
// each test starts from the same baseline (the suite runs serially).
const createdFolderIds: string[] = [];
const createdFileIds: string[] = [];

async function deleteRows(table: 'files' | 'folders', ids: string[]) {
  for (let offset = 0; offset < ids.length; offset += 40) {
    const chunk = ids.slice(offset, offset + 40);
    const placeholders = chunk.map(() => '?').join(', ');
    await env.DB.prepare(
      `DELETE FROM ${table} WHERE id IN (${placeholders})`
    )
      .bind(...chunk)
      .run();
  }
}

function authHeaders(
  userId = 'trash-admin',
  role: 'sys_admin' | 'sec_admin' | 'member' = 'sys_admin',
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

async function ensureBase() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenants (id, name, slug)
       VALUES ('${TENANT}', 'Trash Org', 'trash-org'), ('${OTHER_TENANT}', 'Other Trash Org', 'trash-other-org')`
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO tenant_policies (tenant_id, trash_retention_days)
       VALUES ('${TENANT}', 30), ('${OTHER_TENANT}', 30)`
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
       VALUES
         ('trash-admin', '${TENANT}', 'trash-admin@example.com', 'Trash Admin', 'sys_admin', 'active'),
         ('trash-member', '${TENANT}', 'trash-member@example.com', 'Trash Member', 'member', 'active'),
         ('trash-viewer', '${TENANT}', 'trash-viewer@example.com', 'Trash Viewer', 'member', 'active'),
         ('trash-outsider', '${TENANT}', 'trash-outsider@example.com', 'Trash Outsider', 'member', 'active'),
         ('trash-secret-deleter', '${TENANT}', 'secret-deleter@example.com', 'Secret Deleter', 'member', 'active'),
         ('trash-other-admin', '${OTHER_TENANT}', 'other-admin@example.com', 'Other Admin', 'sys_admin', 'active')`
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
       VALUES
         ('${SHARED_ROOT}', '${TENANT}', NULL, 'Shared Root', 0, 1, 'internal', 'trash-admin'),
         ('${SECRET_ROOT}', '${TENANT}', NULL, 'Secret Root', 0, 1, 'confidential', 'trash-admin'),
         ('${OTHER_ROOT}', '${OTHER_TENANT}', NULL, 'Other Root', 0, 1, 'internal', 'trash-other-admin')`
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       VALUES
         ('${TENANT}', '${SHARED_ROOT}', '${SHARED_ROOT}', 0),
         ('${TENANT}', '${SECRET_ROOT}', '${SECRET_ROOT}', 0),
         ('${OTHER_TENANT}', '${OTHER_ROOT}', '${OTHER_ROOT}', 0)`
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES
         ('trash-p-admin-shared', '${TENANT}', 'folder', '${SHARED_ROOT}', 'user', 'trash-admin', 'owner', 'trash-admin'),
         ('trash-p-member-shared', '${TENANT}', 'folder', '${SHARED_ROOT}', 'user', 'trash-member', 'editor', 'trash-admin'),
         ('trash-p-viewer-shared', '${TENANT}', 'folder', '${SHARED_ROOT}', 'user', 'trash-viewer', 'viewer', 'trash-admin'),
         ('trash-p-admin-secret', '${TENANT}', 'folder', '${SECRET_ROOT}', 'user', 'trash-admin', 'owner', 'trash-admin'),
         ('trash-p-other', '${OTHER_TENANT}', 'folder', '${OTHER_ROOT}', 'user', 'trash-other-admin', 'owner', 'trash-other-admin')`
    ),
    env.DB.prepare(
      `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
       VALUES
         ('${TENANT}', 'unset', 0, 0),
         ('${TENANT}', 'internal', 0, 0),
         ('${TENANT}', 'confidential', 0, 0),
         ('${OTHER_TENANT}', 'unset', 0, 0),
         ('${OTHER_TENANT}', 'internal', 0, 0)`
    ),
  ]);
}

async function insertFolder(input: {
  id: string;
  parentId: string;
  name: string;
  deletedAt: string | null;
  deletedBy: string | null;
  tenantId?: string;
}): Promise<void> {
  const tenantId = input.tenantId ?? TENANT;
  const createdBy =
    tenantId === OTHER_TENANT ? 'trash-other-admin' : 'trash-admin';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO folders
         (id, tenant_id, parent_id, name, depth, version, classification, is_pinned, created_by, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, 1, 1, 'internal', 0, ?, ?, ?)`
    ).bind(
      input.id,
      tenantId,
      input.parentId,
      input.name,
      createdBy,
      input.deletedAt,
      input.deletedBy
    ),
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       VALUES (?, ?, ?, 0)`
    ).bind(tenantId, input.id, input.id),
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       SELECT tenant_id, ancestor_id, ?, depth + 1
         FROM folder_closures
        WHERE tenant_id = ? AND descendant_id = ?`
    ).bind(input.id, tenantId, input.parentId),
  ]);
  createdFolderIds.push(input.id);
}

async function insertFile(input: {
  id: string;
  folderId: string | null;
  name: string;
  deletedAt: string | null;
  deletedBy: string | null;
  tenantId?: string;
}): Promise<void> {
  const tenantId = input.tenantId ?? TENANT;
  const createdBy =
    tenantId === OTHER_TENANT ? 'trash-other-admin' : 'trash-admin';
  const extension = input.name.includes('.')
    ? input.name.slice(input.name.lastIndexOf('.') + 1).toLowerCase()
    : null;
  await env.DB.prepare(
    `INSERT INTO files
       (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state,
        classification, created_by, updated_by, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, 'text/plain', 123, 'active', 'internal', ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      tenantId,
      input.folderId,
      input.name,
      extension,
      createdBy,
      createdBy,
      input.deletedAt,
      input.deletedBy
    )
    .run();
  createdFileIds.push(input.id);
}

interface TrashItemResponse {
  type: 'folder' | 'file';
  id: string;
  name: string;
  deleted_at: string;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName: string | null;
  purgeAt: string;
  daysRemaining: number;
}

interface TrashResponse {
  folders: TrashItemResponse[];
  files: TrashItemResponse[];
  items: TrashItemResponse[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  trashRetentionDays: number;
  deleters: Array<{ id: string; name: string }>;
  hasUnknownDeleter: boolean;
}

async function getTrash(
  query = '',
  userId = 'trash-admin',
  role: 'sys_admin' | 'member' = 'sys_admin'
): Promise<{ status: number; body: TrashResponse }> {
  const res = await app.fetch(
    new Request(`http://127.0.0.1:8787/api/folders/trash${query}`, {
      headers: authHeaders(userId, role),
    }),
    buildTestEnv()
  );
  return {
    status: res.status,
    body: (await res.json()) as TrashResponse,
  };
}

async function collectAll(
  sort: string,
  limit = 2,
  query = ''
): Promise<TrashItemResponse[]> {
  const items: TrashItemResponse[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      limit: String(limit),
      sort,
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const { status, body } = await getTrash(`?${params.toString()}`);
    expect(status).toBe(200);
    items.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) return items;
  }
  throw new Error('pagination did not terminate');
}

describe('Trash search, filter, sort, pagination, RBAC and deleted_by (TOM-48)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await ensureBase();
  });

  afterEach(async () => {
    await deleteRows('files', createdFileIds.splice(0));
    await deleteRows('folders', createdFolderIds.splice(0));
    await env.DB.prepare(
      "UPDATE tenant_policies SET trash_retention_days = 30 WHERE tenant_id = ?"
    )
      .bind(TENANT)
      .run();
  });

  it('adds deleted_by columns, accepts 730-day retention, records/clears deleted_by, and keeps legacy NULL rows compatible', async () => {
    await ensureBase();

    const [folderCols, fileCols, policySql] = await Promise.all([
      env.DB.prepare('PRAGMA table_info(folders)').all<{ name: string }>(),
      env.DB.prepare('PRAGMA table_info(files)').all<{ name: string }>(),
      env.DB.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tenant_policies'"
      ).first<{ sql: string }>(),
    ]);
    expect(folderCols.results.map((c) => c.name)).toContain('deleted_by');
    expect(fileCols.results.map((c) => c.name)).toContain('deleted_by');
    expect(policySql?.sql).toContain('3650');

    const trashIndexes = await env.DB.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name IN ('idx_folders_trash_lookup', 'idx_files_trash_lookup')
        ORDER BY name`
    ).all<{ name: string }>();
    expect(trashIndexes.results.map((row) => row.name)).toEqual([
      'idx_files_trash_lookup',
      'idx_folders_trash_lookup',
    ]);

    const patchRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/policies', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ trashRetentionDays: 730 }),
      }),
      buildTestEnv()
    );
    expect(patchRes.status).toBe(200);
    const policy = (await patchRes.json()) as {
      policy: { trash_retention_days: number };
    };
    expect(policy.policy.trash_retention_days).toBe(730);

    await insertFile({
      id: 'trash-api-file',
      folderId: SHARED_ROOT,
      name: 'trash-api-file.txt',
      deletedAt: null,
      deletedBy: null,
    });

    const deleteRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/trash-api-file', {
        method: 'DELETE',
        headers: authHeaders('trash-member', 'member'),
      }),
      buildTestEnv()
    );
    expect(deleteRes.status).toBe(200);

    const deletedRow = await env.DB.prepare(
      "SELECT deleted_at, deleted_by FROM files WHERE id = 'trash-api-file'"
    ).first<{ deleted_at: string; deleted_by: string }>();
    expect(deletedRow?.deleted_at).toBeTruthy();
    expect(deletedRow?.deleted_by).toBe('trash-member');

    const listed = await getTrash('?query=trash-api-file');
    expect(listed.status).toBe(200);
    expect(listed.body.trashRetentionDays).toBe(730);
    expect(listed.body.items).toHaveLength(1);
    const item = listed.body.items[0];
    expect(item.type).toBe('file');
    expect(item.deletedBy).toBe('trash-member');
    expect(item.deletedByName).toBe('Trash Member');
    expect(item.deletedAt).toBe(deletedRow?.deleted_at);
    expect(item.daysRemaining).toBe(730);
    expect(
      Date.parse(item.purgeAt) - Date.parse(item.deletedAt)
    ).toBe(730 * DAY_MS);

    const restoreRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/trash-api-file/restore', {
        method: 'POST',
        headers: authHeaders('trash-member', 'member'),
        body: JSON.stringify({}),
      }),
      buildTestEnv()
    );
    expect(restoreRes.status).toBe(200);
    const restored = await env.DB.prepare(
      "SELECT deleted_at, deleted_by FROM files WHERE id = 'trash-api-file'"
    ).first<{ deleted_at: string | null; deleted_by: string | null }>();
    expect(restored).toEqual({ deleted_at: null, deleted_by: null });

    // Legacy rows: backfilled NULL deleted_by must list as unknown, not error.
    await insertFile({
      id: 'trash-legacy-file',
      folderId: SHARED_ROOT,
      name: 'trash-legacy-file.txt',
      deletedAt: '2026-11-01T00:00:00.000Z',
      deletedBy: null,
    });
    const legacy = await getTrash('?query=trash-legacy-file');
    expect(legacy.status).toBe(200);
    expect(legacy.body.items[0]).toMatchObject({
      deletedBy: null,
      deletedByName: null,
    });
    expect(legacy.body.hasUnknownDeleter).toBe(true);

    const legacyFiltered = await getTrash(
      '?query=trash-legacy-file&deletedBy=unknown'
    );
    expect(legacyFiltered.status).toBe(200);
    expect(legacyFiltered.body.items.map((item) => item.id)).toEqual([
      'trash-legacy-file',
    ]);

    // Resetting the policy keeps the rest of the suite deterministic.
    await env.DB.prepare(
      "UPDATE tenant_policies SET trash_retention_days = 30 WHERE tenant_id = 'tenant-trash'"
    ).run();
  });

  it('records deleted_by on every folder-subtree row and restores the whole subtree atomically', async () => {
    await ensureBase();

    await insertFolder({
      id: 'trash-sub-parent',
      parentId: SHARED_ROOT,
      name: 'trash-sub-parent',
      deletedAt: null,
      deletedBy: null,
    });
    await insertFolder({
      id: 'trash-sub-child',
      parentId: 'trash-sub-parent',
      name: 'trash-sub-child',
      deletedAt: null,
      deletedBy: null,
    });
    await insertFile({
      id: 'trash-sub-file',
      folderId: 'trash-sub-child',
      name: 'trash-sub-file.txt',
      deletedAt: null,
      deletedBy: null,
    });

    const deleteRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders/trash-sub-parent', {
        method: 'DELETE',
        headers: authHeaders('trash-admin', 'sys_admin'),
      }),
      buildTestEnv()
    );
    expect(deleteRes.status).toBe(200);

    const rows = await env.DB.prepare(
      `SELECT id, deleted_at, deleted_by FROM folders WHERE id IN ('trash-sub-parent', 'trash-sub-child')
       UNION ALL
       SELECT id, deleted_at, deleted_by FROM files WHERE id = 'trash-sub-file'`
    ).all<{ id: string; deleted_at: string; deleted_by: string }>();
    expect(rows.results).toHaveLength(3);
    for (const row of rows.results) {
      expect(row.deleted_at).toBeTruthy();
      expect(row.deleted_by).toBe('trash-admin');
    }

    const listed = await getTrash('?query=trash-sub-');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item) => item.id)).toEqual([
      'trash-sub-parent',
    ]);

    const restoreRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders/trash-sub-parent/restore', {
        method: 'POST',
        headers: authHeaders('trash-admin', 'sys_admin'),
        body: JSON.stringify({ conflictPolicy: 'rename' }),
      }),
      buildTestEnv()
    );
    expect(restoreRes.status).toBe(200);

    const restored = await env.DB.prepare(
      `SELECT id, deleted_at, deleted_by FROM folders WHERE id IN ('trash-sub-parent', 'trash-sub-child')
       UNION ALL
       SELECT id, deleted_at, deleted_by FROM files WHERE id = 'trash-sub-file'`
    ).all<{ id: string; deleted_at: string | null; deleted_by: string | null }>();
    expect(restored.results).toHaveLength(3);
    for (const row of restored.results) {
      expect(row.deleted_at).toBeNull();
      expect(row.deleted_by).toBeNull();
    }
  });

  it('escapes LIKE metacharacters and filters by type, deleter and deleted-at range', async () => {
    await ensureBase();

    const fixtures: Array<{
      kind: 'file' | 'folder';
      id: string;
      name: string;
      deletedAt: string;
      deletedBy: string;
    }> = [
      {
        kind: 'file',
        id: 'trash-like-pct',
        name: 'trash-pct-a%z.txt',
        deletedAt: '2026-11-10T00:00:00.000Z',
        deletedBy: 'trash-admin',
      },
      {
        kind: 'file',
        id: 'trash-like-pct-decoy',
        name: 'trash-pct-axz.txt',
        deletedAt: '2026-11-11T00:00:00.000Z',
        deletedBy: 'trash-member',
      },
      {
        kind: 'file',
        id: 'trash-like-underscore',
        name: 'trash-und-a_z.txt',
        deletedAt: '2026-11-12T00:00:00.000Z',
        deletedBy: 'trash-admin',
      },
      {
        kind: 'file',
        id: 'trash-like-underscore-decoy',
        name: 'trash-und-aQz.txt',
        deletedAt: '2026-11-13T00:00:00.000Z',
        deletedBy: 'trash-member',
      },
      {
        kind: 'folder',
        id: 'trash-like-backslash',
        name: 'trash-bs-a\\z',
        deletedAt: '2026-11-14T00:00:00.000Z',
        deletedBy: 'trash-admin',
      },
      {
        kind: 'folder',
        id: 'trash-like-plain',
        name: 'trash-plain',
        deletedAt: '2026-11-15T00:00:00.000Z',
        deletedBy: 'trash-member',
      },
    ];

    for (const fixture of fixtures) {
      if (fixture.kind === 'folder') {
        await insertFolder({
          id: fixture.id,
          parentId: SHARED_ROOT,
          name: fixture.name,
          deletedAt: fixture.deletedAt,
          deletedBy: fixture.deletedBy,
        });
      } else {
        await insertFile({
          id: fixture.id,
          folderId: SHARED_ROOT,
          name: fixture.name,
          deletedAt: fixture.deletedAt,
          deletedBy: fixture.deletedBy,
        });
      }
    }

    const pct = await getTrash(
      `?query=${encodeURIComponent('a%z')}`
    );
    expect(pct.status).toBe(200);
    expect(pct.body.items.map((item) => item.id)).toEqual([
      'trash-like-pct',
    ]);

    const underscore = await getTrash(
      `?query=${encodeURIComponent('a_z')}`
    );
    expect(underscore.body.items.map((item) => item.id)).toEqual([
      'trash-like-underscore',
    ]);

    const backslash = await getTrash(
      `?query=${encodeURIComponent('a\\z')}`
    );
    expect(backslash.body.items.map((item) => item.id)).toEqual([
      'trash-like-backslash',
    ]);

    const all = await getTrash('?query=trash-&limit=200');
    expect(all.body.items).toHaveLength(6);
    expect(all.body.folders).toHaveLength(2);
    expect(all.body.files).toHaveLength(4);
    expect(
      all.body.items
        .filter((item) => item.type === 'folder')
        .map((item) => item.id)
    ).toEqual(all.body.folders.map((item) => item.id));
    expect(
      all.body.items
        .filter((item) => item.type === 'file')
        .map((item) => item.id)
    ).toEqual(all.body.files.map((item) => item.id));

    const onlyFiles = await getTrash('?query=trash-&type=file&limit=200');
    expect(onlyFiles.body.items).toHaveLength(4);
    expect(onlyFiles.body.items.every((item) => item.type === 'file')).toBe(
      true
    );

    const onlyFolders = await getTrash('?query=trash-&type=folder&limit=200');
    expect(onlyFolders.body.items).toHaveLength(2);
    expect(
      onlyFolders.body.items.every((item) => item.type === 'folder')
    ).toBe(true);

    const adminDeleted = await getTrash(
      '?query=trash-&deletedBy=trash-admin&limit=200'
    );
    expect(adminDeleted.body.items).toHaveLength(3);
    expect(
      adminDeleted.body.items.every(
        (item) => item.deletedBy === 'trash-admin'
      )
    ).toBe(true);
    expect(adminDeleted.body.deleters.map((d) => d.id).sort()).toEqual([
      'trash-admin',
      'trash-member',
    ]);

    const memberDeleted = await getTrash(
      '?query=trash-&deletedBy=trash-member&limit=200'
    );
    expect(memberDeleted.body.items).toHaveLength(3);

    const range = await getTrash(
      `?query=trash-&deletedFrom=${encodeURIComponent(
        '2026-11-11T00:00:00.000Z'
      )}&deletedTo=${encodeURIComponent('2026-11-13T23:59:59.000Z')}&limit=200`
    );
    expect(range.body.items.map((item) => item.id).sort()).toEqual([
      'trash-like-pct-decoy',
      'trash-like-underscore',
      'trash-like-underscore-decoy',
    ]);
  });

  it('paginates mixed folders/files with all four sorts without duplicates or gaps', async () => {
    await ensureBase();

    // Five folders + five files, deliberately including tied deleted_at values.
    for (let i = 0; i < 5; i++) {
      await insertFolder({
        id: `trash-page-folder-${i}`,
        parentId: SHARED_ROOT,
        name: `trash-page-${String(i).padStart(2, '0')}`,
        deletedAt: `2026-11-${String(10 + (i < 2 ? 0 : i)).padStart(2, '0')}T00:00:00.000Z`,
        deletedBy: i % 2 === 0 ? 'trash-admin' : 'trash-member',
      });
      await insertFile({
        id: `trash-page-file-${i}`,
        folderId: SHARED_ROOT,
        name: `trash-page-${String(i).padStart(2, '0')}.txt`,
        deletedAt: `2026-11-${String(10 + (i < 2 ? 0 : i)).padStart(2, '0')}T00:00:00.000Z`,
        deletedBy: i % 2 === 0 ? 'trash-member' : 'trash-admin',
      });
    }

    const expectedIds = new Set<string>([
      ...Array.from({ length: 5 }, (_, i) => `trash-page-folder-${i}`),
      ...Array.from({ length: 5 }, (_, i) => `trash-page-file-${i}`),
    ]);

    const sorts = ['deletedAt_desc', 'deletedAt_asc', 'name_asc', 'name_desc'];
    for (const sort of sorts) {
      const items = await collectAll(sort, 2, 'trash-page-');
      expect(items).toHaveLength(10);
      expect(new Set(items.map((item) => item.id))).toEqual(expectedIds);
      expect(new Set(items.map((item) => `${item.type}:${item.id}`)).size).toBe(
        10
      );

      for (let i = 1; i < items.length; i++) {
        const prev = items[i - 1];
        const next = items[i];
        if (sort === 'name_asc') {
          expect(prev.name <= next.name).toBe(true);
        } else if (sort === 'name_desc') {
          expect(prev.name >= next.name).toBe(true);
        } else if (sort === 'deletedAt_asc') {
          expect(prev.deletedAt <= next.deletedAt).toBe(true);
        } else {
          expect(prev.deletedAt >= next.deletedAt).toBe(true);
        }
      }
    }

    // limit is clamped to 200 and out-of-range minimum is clamped to 1.
    const clamped = await getTrash('?limit=999');
    expect(clamped.body.limit).toBe(200);
    expect(clamped.body.items.length).toBeLessThanOrEqual(200);
    const low = await getTrash('?limit=0');
    expect(low.status).toBe(200);
    expect(low.body.limit).toBe(1);
    expect(low.body.items.length).toBeLessThanOrEqual(1);
  });

  it('rejects malformed cursors, dates, sort and type values with HTTP 400', async () => {
    await ensureBase();

    expect((await getTrash('?cursor=not-a-cursor')).status).toBe(400);
    expect((await getTrash('?deletedFrom=2026-11-01')).status).toBe(400);
    expect((await getTrash('?deletedTo=not-a-date')).status).toBe(400);
    expect(
      (
        await getTrash(
          `?deletedFrom=${encodeURIComponent(
            '2026-11-10T00:00:00.000Z'
          )}&deletedTo=${encodeURIComponent('2026-11-01T00:00:00.000Z')}`
        )
      ).status
    ).toBe(400);
    expect((await getTrash('?sort=size_asc')).status).toBe(400);
    expect((await getTrash('?type=image')).status).toBe(400);

    // A cursor minted for name_asc is invalid for deletedAt_desc.
    await insertFile({
      id: 'trash-cursor-file-1',
      folderId: SHARED_ROOT,
      name: 'trash-cursor-file-1.txt',
      deletedAt: '2026-11-10T00:00:00.000Z',
      deletedBy: 'trash-admin',
    });
    await insertFile({
      id: 'trash-cursor-file-2',
      folderId: SHARED_ROOT,
      name: 'trash-cursor-file-2.txt',
      deletedAt: '2026-11-09T00:00:00.000Z',
      deletedBy: 'trash-admin',
    });
    const first = await getTrash('?sort=name_asc&limit=1&query=trash-cursor-');
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeTruthy();
    const mismatched = await getTrash(
      `?sort=deletedAt_desc&limit=1&query=trash-cursor-&cursor=${encodeURIComponent(
        first.body.nextCursor!
      )}`
    );
    expect(mismatched.status).toBe(400);
  });

  it('enforces RBAC and tenant isolation and never leaks unavailable deleters', async () => {
    await ensureBase();

    await insertFolder({
      id: 'trash-rbac-secret-parent',
      parentId: SECRET_ROOT,
      name: 'trash-rbac-secret-parent',
      deletedAt: null,
      deletedBy: null,
    });
    await insertFile({
      id: 'trash-rbac-secret-file',
      folderId: 'trash-rbac-secret-parent',
      name: 'trash-rbac-secret-file.txt',
      deletedAt: '2026-11-12T00:00:00.000Z',
      deletedBy: 'trash-secret-deleter',
    });
    await insertFile({
      id: 'trash-rbac-shared-file',
      folderId: SHARED_ROOT,
      name: 'trash-rbac-shared-file.txt',
      deletedAt: '2026-11-13T00:00:00.000Z',
      deletedBy: 'trash-admin',
    });
    await insertFile({
      id: 'trash-rbac-other-file',
      folderId: OTHER_ROOT,
      name: 'trash-rbac-other-file.txt',
      deletedAt: '2026-11-14T00:00:00.000Z',
      deletedBy: 'trash-other-admin',
      tenantId: OTHER_TENANT,
    });

    const member = await getTrash(
      '?query=trash-rbac-&limit=200',
      'trash-member',
      'member'
    );
    expect(member.status).toBe(200);
    expect(member.body.items.map((item) => item.id)).toEqual([
      'trash-rbac-shared-file',
    ]);
    expect(member.body.deleters).toEqual([
      { id: 'trash-admin', name: 'Trash Admin' },
    ]);
    expect(member.body.hasUnknownDeleter).toBe(false);

    const viewer = await getTrash(
      '?query=trash-rbac-&limit=200',
      'trash-viewer',
      'member'
    );
    expect(viewer.body.items.map((item) => item.id)).toEqual([
      'trash-rbac-shared-file',
    ]);

    const outsider = await getTrash(
      '?query=trash-rbac-&limit=200',
      'trash-outsider',
      'member'
    );
    expect(outsider.status).toBe(200);
    expect(outsider.body.items).toHaveLength(0);
    expect(outsider.body.deleters).toHaveLength(0);

    const admin = await getTrash('?query=trash-rbac-&limit=200');
    expect(admin.body.items.map((item) => item.id).sort()).toEqual([
      'trash-rbac-secret-file',
      'trash-rbac-shared-file',
    ]);
    expect(admin.body.deleters.map((d) => d.id).sort()).toEqual([
      'trash-admin',
      'trash-secret-deleter',
    ]);
  });

  it('hides children of deleted folders while keeping deleted children of active parents visible', async () => {
    await ensureBase();

    // Deleted subtree root (all rows share the batch timestamp).
    const deletedAt = '2026-11-15T00:00:00.000Z';
    await insertFolder({
      id: 'trash-tree-deleted-parent',
      parentId: SHARED_ROOT,
      name: 'trash-tree-deleted-parent',
      deletedAt,
      deletedBy: 'trash-admin',
    });
    await insertFolder({
      id: 'trash-tree-deleted-child',
      parentId: 'trash-tree-deleted-parent',
      name: 'trash-tree-deleted-child',
      deletedAt,
      deletedBy: 'trash-admin',
    });
    await insertFile({
      id: 'trash-tree-deleted-child-file',
      folderId: 'trash-tree-deleted-child',
      name: 'trash-tree-deleted-child-file.txt',
      deletedAt,
      deletedBy: 'trash-admin',
    });

    // Active parent with a directly deleted child remains top-level.
    await insertFolder({
      id: 'trash-tree-active-parent',
      parentId: SHARED_ROOT,
      name: 'trash-tree-active-parent',
      deletedAt: null,
      deletedBy: null,
    });
    await insertFolder({
      id: 'trash-tree-active-parent-child',
      parentId: 'trash-tree-active-parent',
      name: 'trash-tree-active-parent-child',
      deletedAt: '2026-11-14T00:00:00.000Z',
      deletedBy: 'trash-member',
    });

    const listed = await getTrash('?query=trash-tree-&limit=200');
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item) => item.id).sort()).toEqual([
      'trash-tree-active-parent-child',
      'trash-tree-deleted-parent',
    ]);
    expect(
      listed.body.items.some(
        (item) => item.id === 'trash-tree-deleted-child-file'
      )
    ).toBe(false);
  });
});
