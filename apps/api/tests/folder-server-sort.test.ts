import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

function authHeaders(
  userId = 'ss-owner',
  role: 'sys_admin' | 'member' = 'sys_admin',
  tenantId = 'tenant-ss'
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

async function fetchAllRoots(
  testEnv: OidcEnv,
  sortBy?: string,
  sortDir?: string,
  limit = 2
) {
  const collected: Array<{
    id: string;
    name: string;
    is_pinned: number;
    classification: string;
    updated_at: string;
  }> = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: String(limit) });
    if (sortBy) params.set('sortBy', sortBy);
    if (sortDir) params.set('sortDir', sortDir);
    if (cursor) params.set('cursor', cursor);
    const res = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/roots?${params.toString()}`, {
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folders: typeof collected;
      nextCursor: string | null;
    };
    collected.push(...body.folders);
    cursor = body.nextCursor;
    pages += 1;
    expect(pages).toBeLessThan(20);
  } while (cursor);
  return collected;
}

async function fetchAllChildren(
  testEnv: OidcEnv,
  parentId: string,
  sortBy?: string,
  sortDir?: string,
  limit = 2
) {
  const folders: Array<{
    id: string;
    name: string;
    classification: string;
    updated_at: string;
  }> = [];
  const files: Array<{
    id: string;
    name: string;
    size_bytes: number;
    classification: string;
    updated_at: string;
  }> = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({ limit: String(limit) });
    if (sortBy) params.set('sortBy', sortBy);
    if (sortDir) params.set('sortDir', sortDir);
    if (cursor) params.set('cursor', cursor);
    const res = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/${parentId}/children?${params.toString()}`,
        { headers: authHeaders() }
      ),
      testEnv
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folders: typeof folders;
      files: typeof files;
      nextCursor: string | null;
    };
    folders.push(...body.folders);
    files.push(...body.files);
    cursor = body.nextCursor;
    pages += 1;
    expect(pages).toBeLessThan(30);
  } while (cursor);
  return { folders, files };
}

describe('Folder Server-Side Sorting & Keyset Pagination', () => {
  const parentId = 'ss-parent-root';

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-ss', 'Sort Org', 'sort-org')"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES ('tenant-ss')"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES ('ss-owner', 'tenant-ss', 'ss-owner@example.com', 'SS Owner', 'sys_admin', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES ('tenant-ss', 'unset', 0, 0), ('tenant-ss', 'public', 0, 0), ('tenant-ss', 'internal', 0, 0), ('tenant-ss', 'confidential', 0, 0)`
      ),
    ]);

    // Insert 5 root folders: 2 pinned, 3 unpinned (including parentId)
    const roots = [
      { id: parentId, name: 'ParentRoot', pinned: 1, cls: 'internal', ts: '2026-01-03T00:00:00Z' },
      { id: 'ss-r-pin-a', name: 'AlphaPin', pinned: 1, cls: 'public', ts: '2026-01-01T00:00:00Z' },
      { id: 'ss-r-unpin-z', name: 'Zulu', pinned: 0, cls: 'confidential', ts: '2026-01-05T00:00:00Z' },
      { id: 'ss-r-unpin-b', name: 'Bravo', pinned: 0, cls: 'unset', ts: '2026-01-02T00:00:00Z' },
      { id: 'ss-r-unpin-m', name: 'Mike', pinned: 0, cls: 'internal', ts: '2026-01-04T00:00:00Z' },
    ];
    for (const r of roots) {
      await env.DB.prepare(
        `INSERT INTO folders (id, tenant_id, parent_id, name, depth, classification, is_pinned, created_by, created_at, updated_at)
         VALUES (?, 'tenant-ss', NULL, ?, 0, ?, ?, 'ss-owner', ?, ?)`
      )
        .bind(r.id, r.name, r.cls, r.pinned, r.ts, r.ts)
        .run();
      await env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth) VALUES ('tenant-ss', ?, ?, 0)`
      )
        .bind(r.id, r.id)
        .run();
      await env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES (?, 'tenant-ss', 'folder', ?, 'user', 'ss-owner', 'owner', 'ss-owner')`
      )
        .bind(`perm-${r.id}`, r.id)
        .run();
    }

    // Insert 4 child folders inside parentId (with tied updated_at & classification to test id tie-breaker)
    const childFolders = [
      { id: 'ss-cf-1', name: 'FolderC', cls: 'public', ts: '2026-02-02T00:00:00Z' },
      { id: 'ss-cf-2', name: 'FolderA', cls: 'confidential', ts: '2026-02-01T00:00:00Z' },
      { id: 'ss-cf-3', name: 'FolderD', cls: 'unset', ts: '2026-02-02T00:00:00Z' },
      { id: 'ss-cf-4', name: 'FolderB', cls: 'internal', ts: '2026-02-04T00:00:00Z' },
    ];
    for (const cf of childFolders) {
      await env.DB.prepare(
        `INSERT INTO folders (id, tenant_id, parent_id, name, depth, classification, is_pinned, created_by, created_at, updated_at)
         VALUES (?, 'tenant-ss', ?, ?, 1, ?, 0, 'ss-owner', ?, ?)`
      )
        .bind(cf.id, parentId, cf.name, cf.cls, cf.ts, cf.ts)
        .run();
      await env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES ('tenant-ss', ?, ?, 0), ('tenant-ss', ?, ?, 1)`
      )
        .bind(cf.id, cf.id, parentId, cf.id)
        .run();
    }

    // Insert 5 active files inside parentId
    const childFiles = [
      { id: 'ss-fl-1', name: 'c.txt', size: 300, cls: 'public', ts: '2026-03-03T00:00:00Z' },
      { id: 'ss-fl-2', name: 'a.txt', size: 100, cls: 'confidential', ts: '2026-03-01T00:00:00Z' },
      { id: 'ss-fl-3', name: 'e.txt', size: 300, cls: 'unset', ts: '2026-03-05T00:00:00Z' },
      { id: 'ss-fl-4', name: 'b.txt', size: 500, cls: 'internal', ts: '2026-03-02T00:00:00Z' },
      { id: 'ss-fl-5', name: 'd.txt', size: 50, cls: 'confidential', ts: '2026-03-03T00:00:00Z' },
    ];
    for (const fl of childFiles) {
      await env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, classification, upload_state, created_by, updated_by, created_at, updated_at)
         VALUES (?, 'tenant-ss', ?, ?, 'txt', 'text/plain', ?, ?, 'active', 'ss-owner', 'ss-owner', ?, ?)`
      )
        .bind(fl.id, parentId, fl.name, fl.size, fl.cls, fl.ts, fl.ts)
        .run();
    }
  });

  it('paginates /api/folders/roots with is_pinned DESC first across all sortBy × sortDir', async () => {
    const testEnv = buildTestEnv();

    // name ASC
    const nameAsc = await fetchAllRoots(testEnv, 'name', 'asc', 2);
    expect(nameAsc.map((f) => f.name)).toEqual([
      'AlphaPin',
      'ParentRoot',
      'Bravo',
      'Mike',
      'Zulu',
    ]);

    // name DESC (pinned still first!)
    const nameDesc = await fetchAllRoots(testEnv, 'name', 'desc', 2);
    expect(nameDesc.map((f) => f.name)).toEqual([
      'ParentRoot',
      'AlphaPin',
      'Zulu',
      'Mike',
      'Bravo',
    ]);

    // updated_at ASC
    const updAsc = await fetchAllRoots(testEnv, 'updated_at', 'asc', 2);
    expect(updAsc.map((f) => f.name)).toEqual([
      'AlphaPin',
      'ParentRoot',
      'Bravo',
      'Mike',
      'Zulu',
    ]);

    // updated_at DESC
    const updDesc = await fetchAllRoots(testEnv, 'updated_at', 'desc', 2);
    expect(updDesc.map((f) => f.name)).toEqual([
      'ParentRoot',
      'AlphaPin',
      'Zulu',
      'Mike',
      'Bravo',
    ]);

    // classification ASC (unset=0, public=1, internal=2, confidential=3)
    const clsAsc = await fetchAllRoots(testEnv, 'classification', 'asc', 2);
    expect(clsAsc.map((f) => f.name)).toEqual([
      'AlphaPin', // pinned, public(1)
      'ParentRoot', // pinned, internal(2)
      'Bravo', // unpinned, unset(0)
      'Mike', // unpinned, internal(2)
      'Zulu', // unpinned, confidential(3)
    ]);

    // classification DESC
    const clsDesc = await fetchAllRoots(testEnv, 'classification', 'desc', 2);
    expect(clsDesc.map((f) => f.name)).toEqual([
      'ParentRoot', // pinned, internal(2)
      'AlphaPin', // pinned, public(1)
      'Zulu', // unpinned, confidential(3)
      'Mike', // unpinned, internal(2)
      'Bravo', // unpinned, unset(0)
    ]);

    // size_bytes falls back to name on /roots
    const sizeDesc = await fetchAllRoots(testEnv, 'size_bytes', 'desc', 2);
    expect(sizeDesc.map((f) => f.name)).toEqual([
      'ParentRoot',
      'AlphaPin',
      'Zulu',
      'Mike',
      'Bravo',
    ]);
  });

  it('paginates /api/folders/:id/children across name, updated_at, size_bytes, classification × asc/desc', async () => {
    const testEnv = buildTestEnv();

    // name ASC / DESC
    const nameAsc = await fetchAllChildren(testEnv, parentId, 'name', 'asc', 2);
    expect(nameAsc.folders.map((f) => f.name)).toEqual([
      'FolderA',
      'FolderB',
      'FolderC',
      'FolderD',
    ]);
    expect(nameAsc.files.map((f) => f.name)).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
      'd.txt',
      'e.txt',
    ]);

    const nameDesc = await fetchAllChildren(testEnv, parentId, 'name', 'desc', 2);
    expect(nameDesc.folders.map((f) => f.name)).toEqual([
      'FolderD',
      'FolderC',
      'FolderB',
      'FolderA',
    ]);
    expect(nameDesc.files.map((f) => f.name)).toEqual([
      'e.txt',
      'd.txt',
      'c.txt',
      'b.txt',
      'a.txt',
    ]);

    // updated_at ASC / DESC (with tie-breaker on id)
    const updAsc = await fetchAllChildren(testEnv, parentId, 'updated_at', 'asc', 2);
    expect(updAsc.folders.map((f) => f.id)).toEqual([
      'ss-cf-2', // 02-01
      'ss-cf-1', // 02-02, id ss-cf-1
      'ss-cf-3', // 02-02, id ss-cf-3
      'ss-cf-4', // 02-04
    ]);
    expect(updAsc.files.map((f) => f.id)).toEqual([
      'ss-fl-2', // 03-01
      'ss-fl-4', // 03-02
      'ss-fl-1', // 03-03, id ss-fl-1
      'ss-fl-5', // 03-03, id ss-fl-5
      'ss-fl-3', // 03-05
    ]);

    const updDesc = await fetchAllChildren(testEnv, parentId, 'updated_at', 'desc', 2);
    expect(updDesc.folders.map((f) => f.id)).toEqual([
      'ss-cf-4',
      'ss-cf-3',
      'ss-cf-1',
      'ss-cf-2',
    ]);
    expect(updDesc.files.map((f) => f.id)).toEqual([
      'ss-fl-3',
      'ss-fl-5',
      'ss-fl-1',
      'ss-fl-4',
      'ss-fl-2',
    ]);

    // size_bytes: folders stay name ASC, files sort by size_bytes <DIR>
    const sizeAsc = await fetchAllChildren(testEnv, parentId, 'size_bytes', 'asc', 2);
    expect(sizeAsc.folders.map((f) => f.name)).toEqual([
      'FolderA',
      'FolderB',
      'FolderC',
      'FolderD',
    ]);
    expect(sizeAsc.files.map((f) => f.id)).toEqual([
      'ss-fl-5', // 50
      'ss-fl-2', // 100
      'ss-fl-1', // 300, ss-fl-1
      'ss-fl-3', // 300, ss-fl-3
      'ss-fl-4', // 500
    ]);

    const sizeDesc = await fetchAllChildren(testEnv, parentId, 'size_bytes', 'desc', 2);
    expect(sizeDesc.folders.map((f) => f.name)).toEqual([
      'FolderA',
      'FolderB',
      'FolderC',
      'FolderD',
    ]);
    expect(sizeDesc.files.map((f) => f.id)).toEqual([
      'ss-fl-4', // 500
      'ss-fl-3', // 300, ss-fl-3
      'ss-fl-1', // 300, ss-fl-1
      'ss-fl-2', // 100
      'ss-fl-5', // 50
    ]);

    // classification ASC / DESC
    const clsAsc = await fetchAllChildren(testEnv, parentId, 'classification', 'asc', 2);
    expect(clsAsc.folders.map((f) => f.classification)).toEqual([
      'unset',
      'public',
      'internal',
      'confidential',
    ]);
    expect(clsAsc.files.map((f) => f.classification)).toEqual([
      'unset',
      'public',
      'internal',
      'confidential',
      'confidential',
    ]);

    const clsDesc = await fetchAllChildren(testEnv, parentId, 'classification', 'desc', 2);
    expect(clsDesc.folders.map((f) => f.classification)).toEqual([
      'confidential',
      'internal',
      'public',
      'unset',
    ]);
    expect(clsDesc.files.map((f) => f.classification)).toEqual([
      'confidential',
      'confidential',
      'internal',
      'public',
      'unset',
    ]);
  });

  it('falls back to name/asc on invalid sort params and rejects mismatched cursor sort params', async () => {
    const testEnv = buildTestEnv();

    // Invalid sortBy/sortDir fall back safely to name/asc
    const invalidRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/${parentId}/children?limit=2&sortBy=DROP_TABLE&sortDir=sideways`,
        { headers: authHeaders() }
      ),
      testEnv
    );
    expect(invalidRes.status).toBe(200);
    const invalidBody = (await invalidRes.json()) as {
      folders: Array<{ name: string }>;
      nextCursor: string | null;
    };
    expect(invalidBody.folders.map((f) => f.name)).toEqual(['FolderA', 'FolderB']);
    expect(invalidBody.nextCursor).toBeTruthy();

    // Using that cursor (encoded with name/asc) with a different sortBy must return 400
    const mismatchRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/${parentId}/children?limit=2&sortBy=updated_at&sortDir=desc&cursor=${encodeURIComponent(
          invalidBody.nextCursor!
        )}`,
        { headers: authHeaders() }
      ),
      testEnv
    );
    expect(mismatchRes.status).toBe(400);

    // Same on /roots
    const rootsPage1 = await app.fetch(
      new Request(
        'http://127.0.0.1:8787/api/folders/roots?limit=2&sortBy=updated_at&sortDir=desc',
        { headers: authHeaders() }
      ),
      testEnv
    );
    expect(rootsPage1.status).toBe(200);
    const rootsBody1 = (await rootsPage1.json()) as { nextCursor: string | null };
    expect(rootsBody1.nextCursor).toBeTruthy();

    const rootsMismatch = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/roots?limit=2&sortBy=name&sortDir=asc&cursor=${encodeURIComponent(
          rootsBody1.nextCursor!
        )}`,
        { headers: authHeaders() }
      ),
      testEnv
    );
    expect(rootsMismatch.status).toBe(400);
  });
});
