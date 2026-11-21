import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

function authHeaders(
  userId: string,
  tenantId = 'tenant-search-enh',
  role: 'sys_admin' | 'member' = 'member'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@example.com`,
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

interface SearchFolderDto {
  id: string;
  parentId: string | null;
  parentName: string | null;
  name: string;
  depth: number;
  classification: string;
  updatedAt: string;
}

interface SearchFileDto {
  id: string;
  folderId: string | null;
  folderName: string | null;
  name: string;
  extension: string | null;
  sizeBytes: number;
  classification: string;
  updatedAt: string;
}

interface SearchResponseDto {
  query: string;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  folders: SearchFolderDto[];
  results: SearchFileDto[];
}

describe('Expanded Search API (pagination, folder search, rich filters, RBAC)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-search-enh', 'Search Enhanced Org', 'search-enh')"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('se-alice', 'tenant-search-enh', 'alice@se.example.com', 'Alice', 'member', 'active'),
           ('se-bob', 'tenant-search-enh', 'bob@se.example.com', 'Bob', 'member', 'active'),
           ('se-uploader', 'tenant-search-enh', 'uploader@se.example.com', 'Uploader', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO groups (id, tenant_id, name)
         VALUES ('se-grp-eng', 'tenant-search-enh', 'Engineering')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, user_id)
         VALUES ('se-grp-eng', 'se-alice')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by, updated_at)
         VALUES
           ('se-root-a', 'tenant-search-enh', NULL, 'Project Alpha', 0, 1, 'internal', 'se-alice', '2026-10-01T10:00:00.000Z'),
           ('se-sub-a1', 'tenant-search-enh', 'se-root-a', 'Alpha Specs', 1, 1, 'confidential', 'se-alice', '2026-10-15T10:00:00.000Z'),
           ('se-sub-grp', 'tenant-search-enh', NULL, 'Eng 100% Shared', 0, 1, 'public', 'se-bob', '2026-10-20T10:00:00.000Z'),
           ('se-deleted-f', 'tenant-search-enh', NULL, 'Alpha Deleted Folder', 0, 1, 'internal', 'se-alice', '2026-10-21T10:00:00.000Z'),
           ('se-secret-b', 'tenant-search-enh', NULL, 'Bob Secret Vault', 0, 1, 'confidential', 'se-bob', '2026-10-22T10:00:00.000Z')`
      ),
      env.DB.prepare(
        "UPDATE folders SET deleted_at = '2026-10-25T00:00:00.000Z' WHERE id = 'se-deleted-f'"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-search-enh', 'se-root-a', 'se-root-a', 0),
           ('tenant-search-enh', 'se-root-a', 'se-sub-a1', 1),
           ('tenant-search-enh', 'se-sub-a1', 'se-sub-a1', 0),
           ('tenant-search-enh', 'se-sub-grp', 'se-sub-grp', 0),
           ('tenant-search-enh', 'se-deleted-f', 'se-deleted-f', 0),
           ('tenant-search-enh', 'se-secret-b', 'se-secret-b', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('se-perm-1', 'tenant-search-enh', 'folder', 'se-root-a', 'user', 'se-alice', 'owner', 'se-alice'),
           ('se-perm-2', 'tenant-search-enh', 'folder', 'se-sub-grp', 'group', 'se-grp-eng', 'viewer', 'se-bob'),
           ('se-perm-3', 'tenant-search-enh', 'folder', 'se-secret-b', 'user', 'se-bob', 'owner', 'se-bob'),
           ('se-perm-4', 'tenant-search-enh', 'folder', 'se-root-a', 'user', 'se-uploader', 'uploader', 'se-alice')`
      ),
    ]);

    // Seed 32 matching files for Alice across se-root-a and se-sub-a1 so pagination (>25) is tested
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 32; i++) {
      const id = `se-file-${String(i).padStart(2, '0')}`;
      const isSub = i < 10;
      const folderId = isSub ? 'se-sub-a1' : 'se-root-a';
      const ext = i % 2 === 0 ? 'pdf' : 'docx';
      const cls = i < 5 ? 'confidential' : i < 20 ? 'internal' : 'public';
      const sizeBytes = 1000 + i * 500;
      const day = String((i % 28) + 1).padStart(2, '0');
      const updatedAt = `2026-10-${day}T12:00:00.000Z`;
      const name = `alpha-report-${String(i).padStart(2, '0')}.${ext}`;
      const owner = i === 0 ? 'se-bob' : 'se-alice';

      stmts.push(
        env.DB.prepare(
          `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by, updated_at)
           VALUES (?, 'tenant-search-enh', ?, ?, ?, 'application/octet-stream', ?, 'active', ?, ?, ?, ?)`
        ).bind(id, folderId, name, ext, sizeBytes, cls, owner, owner, updatedAt),
        env.DB.prepare(
          `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
           VALUES (?, 'tenant-search-enh', ?, ?, ?, 'quarterly report')`
        ).bind(id, cls, name, ext)
      );
    }

    // Add a file in Bob's secret vault that matches "alpha" — Alice must NEVER see it
    stmts.push(
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by, updated_at)
         VALUES ('se-bob-secret-file', 'tenant-search-enh', 'se-secret-b', 'alpha-ma-secret.pdf', 'pdf', 'application/pdf', 9999, 'active', 'confidential', 'se-bob', 'se-bob', '2026-10-28T12:00:00.000Z')`
      ),
      env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES ('se-bob-secret-file', 'tenant-search-enh', 'confidential', 'alpha-ma-secret.pdf', 'pdf', 'secret')`
      )
    );

    await env.DB.batch(stmts.slice(0, 35));
    await env.DB.batch(stmts.slice(35));
  });

  it('supports default limit 25, max 100, and offset pagination with hasMore/nextOffset', async () => {
    const testEnv = buildTestEnv();

    // Page 1 (default limit 25)
    const p1Res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=alpha&type=file', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    expect(p1Res.status).toBe(200);
    const p1 = (await p1Res.json()) as SearchResponseDto;
    expect(p1.limit).toBe(25);
    expect(p1.offset).toBe(0);
    expect(p1.results).toHaveLength(25);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextOffset).toBe(25);
    expect(p1.folders).toEqual([]);

    // Page 2 (offset 25 -> remaining 7 of 32)
    const p2Res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=alpha&type=file&offset=25', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    expect(p2Res.status).toBe(200);
    const p2 = (await p2Res.json()) as SearchResponseDto;
    expect(p2.offset).toBe(25);
    expect(p2.results).toHaveLength(7);
    expect(p2.hasMore).toBe(false);
    expect(p2.nextOffset).toBeNull();

    // Disjoint IDs across pages
    const ids1 = new Set(p1.results.map((r) => r.id));
    for (const r of p2.results) {
      expect(ids1.has(r.id)).toBe(false);
      expect(r.id).not.toBe('se-bob-secret-file');
    }

    // Clamping limit > 100 to 100, negative offset to 0
    const maxRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=alpha&type=file&limit=500&offset=-10', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const maxBody = (await maxRes.json()) as SearchResponseDto;
    expect(maxBody.limit).toBe(100);
    expect(maxBody.offset).toBe(0);
    expect(maxBody.results).toHaveLength(32);
    expect(maxBody.hasMore).toBe(false);
    expect(maxBody.nextOffset).toBeNull();
  });

  it('searches folders with strict RBAC (group grants included, unauthorized & deleted excluded) and LIKE escaping', async () => {
    const testEnv = buildTestEnv();

    // type=all returns both matching folders and files
    const allRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=alpha&type=all', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const allBody = (await allRes.json()) as SearchResponseDto;
    expect(allBody.folders.map((f) => f.id).sort()).toEqual(['se-root-a', 'se-sub-a1']);
    expect(allBody.results.length).toBe(25);

    // type=folder returns only folders, results=[]
    const folderOnlyRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=alpha&type=folder', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const folderOnly = (await folderOnlyRes.json()) as SearchResponseDto;
    expect(folderOnly.results).toEqual([]);
    expect(folderOnly.folders.map((f) => f.id).sort()).toEqual(['se-root-a', 'se-sub-a1']);
    expect(folderOnly.folders.find((f) => f.id === 'se-sub-a1')?.parentName).toBe('Project Alpha');

    // Group-granted folder is visible to Alice
    const grpRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=100&type=folder', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const grpBody = (await grpRes.json()) as SearchResponseDto;
    expect(grpBody.folders.map((f) => f.id)).toEqual(['se-sub-grp']);

    // Alice cannot see Bob's secret vault folder
    const secretRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=Secret&type=folder', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const secretBody = (await secretRes.json()) as SearchResponseDto;
    expect(secretBody.folders).toEqual([]);
  });

  it('supports filter-only searches (empty q) across classification, extension, folderId, dates, size, and ownerId', async () => {
    const testEnv = buildTestEnv();

    // 1. classification=confidential with empty q
    const clsRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?classification=confidential', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const clsBody = (await clsRes.json()) as SearchResponseDto;
    expect(clsBody.folders.map((f) => f.id)).toEqual(['se-sub-a1']);
    expect(clsBody.results).toHaveLength(5);
    expect(clsBody.results.every((r) => r.classification === 'confidential')).toBe(true);

    // 2. extension=.PDF (normalized) with empty q -> files only, folders=[]
    const extRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?extension=.PDF', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const extBody = (await extRes.json()) as SearchResponseDto;
    expect(extBody.folders).toEqual([]);
    expect(extBody.results).toHaveLength(16);
    expect(extBody.results.every((r) => r.extension === 'pdf')).toBe(true);

    // 3. folderId subtree filter (se-sub-a1 has 10 files)
    const subRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?folderId=se-sub-a1&type=file', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const subBody = (await subRes.json()) as SearchResponseDto;
    expect(subBody.results).toHaveLength(10);
    expect(subBody.results.every((r) => r.folderId === 'se-sub-a1')).toBe(true);

    // Unauthorized folderId returns empty results without leaking
    const unauthFolderRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?folderId=se-secret-b', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const unauthFolderBody = (await unauthFolderRes.json()) as SearchResponseDto;
    expect(unauthFolderBody.folders).toEqual([]);
    expect(unauthFolderBody.results).toEqual([]);

    // 4. updatedFrom / updatedTo date range
    const dateRes = await app.fetch(
      new Request(
        'http://127.0.0.1:8787/api/search?type=file&updatedFrom=2026-10-25&updatedTo=2026-10-28',
        { headers: authHeaders('se-alice') }
      ),
      testEnv
    );
    const dateBody = (await dateRes.json()) as SearchResponseDto;
    expect(dateBody.results.length).toBeGreaterThan(0);
    for (const r of dateBody.results) {
      expect(r.updatedAt >= '2026-10-25T00:00:00.000Z').toBe(true);
      expect(r.updatedAt <= '2026-10-28T23:59:59.999Z').toBe(true);
    }

    // 5. minSize / maxSize (bytes) -> skips folders
    const sizeRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?minSize=15000&maxSize=16500', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const sizeBody = (await sizeRes.json()) as SearchResponseDto;
    expect(sizeBody.folders).toEqual([]);
    expect(sizeBody.results.length).toBe(4);
    for (const r of sizeBody.results) {
      expect(r.sizeBytes).toBeGreaterThanOrEqual(15000);
      expect(r.sizeBytes).toBeLessThanOrEqual(16500);
    }

    // 6. ownerId filter
    const ownerRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?type=file&ownerId=se-bob', {
        headers: authHeaders('se-alice'),
      }),
      testEnv
    );
    const ownerBody = (await ownerRes.json()) as SearchResponseDto;
    expect(ownerBody.results.map((r) => r.id)).toEqual(['se-file-00']);
  });

  it('enforces uploader no-file-listing rule (FILE_PREVIEW_ROLE_SQL)', async () => {
    const testEnv = buildTestEnv();

    const upRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=alpha', {
        headers: authHeaders('se-uploader'),
      }),
      testEnv
    );
    expect(upRes.status).toBe(200);
    const upBody = (await upRes.json()) as SearchResponseDto;
    expect(upBody.results).toEqual([]);
    expect(upBody.folders.map((f) => f.id).sort()).toEqual(['se-root-a', 'se-sub-a1']);
  });
});
