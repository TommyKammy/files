import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

function authHeaders(
  userId: string,
  tenantId = 'tenant-search',
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

describe('⌘K FTS5 Cross-Workspace Search & RBAC Filtering (TOM-12)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-search', 'Search Org', 'search-org')"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('sr-user-a', 'tenant-search', 'a@search.example.com', 'User A', 'member', 'active'),
           ('sr-user-b', 'tenant-search', 'b@search.example.com', 'User B', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('sr-folder-a', 'tenant-search', NULL, 'Team Alpha', 0, 1, 'confidential', 'sr-user-a'),
           ('sr-folder-b', 'tenant-search', NULL, 'Executive Vault', 0, 1, 'confidential', 'sr-user-b')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-search', 'sr-folder-a', 'sr-folder-a', 0),
           ('tenant-search', 'sr-folder-b', 'sr-folder-b', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('sr-perm-a', 'tenant-search', 'folder', 'sr-folder-a', 'user', 'sr-user-a', 'viewer', 'sr-user-a'),
           ('sr-perm-b', 'tenant-search', 'folder', 'sr-folder-b', 'user', 'sr-user-b', 'owner', 'sr-user-b')`
      ),
    ]);

    // Seed 25 matching confidential files in Folder B (inaccessible to User A)
    // + 2 matching files in Folder A (accessible to User A), plus 1 trashed and 1 pending
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 25; i++) {
      const fid = `sr-secret-b-${i}`;
      const name = `secret-board-plan-${i}.pdf`;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, ai_reason, created_by, updated_by)
           VALUES (?, 'tenant-search', 'sr-folder-b', ?, 'pdf', 'application/pdf', 100, 'active', 'confidential', 'Board M&A secret', 'sr-user-b', 'sr-user-b')`
        ).bind(fid, name),
        env.DB.prepare(
          `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
           VALUES (?, 'tenant-search', 'confidential', ?, 'pdf', 'Board M&A secret')`
        ).bind(fid, name)
      );
    }

    stmts.push(
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, ai_reason, created_by, updated_by)
         VALUES
           ('sr-a-1', 'tenant-search', 'sr-folder-a', 'secret-契約書-q4.pdf', 'pdf', 'application/pdf', 100, 'active', 'confidential', '契約 secret NDA', 'sr-user-a', 'sr-user-a'),
           ('sr-a-2', 'tenant-search', 'sr-folder-a', 'or-not-operator-note.txt', 'txt', 'text/plain', 50, 'active', 'internal', 'notes on secret policy', 'sr-user-a', 'sr-user-a'),
           ('sr-a-deleted', 'tenant-search', 'sr-folder-a', 'secret-deleted.pdf', 'pdf', 'application/pdf', 50, 'active', 'confidential', 'deleted secret', 'sr-user-a', 'sr-user-a'),
           ('sr-a-pending', 'tenant-search', 'sr-folder-a', 'secret-pending.pdf', 'pdf', 'application/pdf', 50, 'pending', 'confidential', 'pending secret', 'sr-user-a', 'sr-user-a')`
      ),
      env.DB.prepare("UPDATE files SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'sr-a-deleted'"),
      env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES
           ('sr-a-1', 'tenant-search', 'confidential', 'secret-契約書-q4.pdf', 'pdf', '契約 secret NDA'),
           ('sr-a-2', 'tenant-search', 'internal', 'or-not-operator-note.txt', 'txt', 'notes on secret policy')`
      )
    );

    await env.DB.batch(stmts.slice(0, 30));
    await env.DB.batch(stmts.slice(30));
  });

  it('filters search strictly by RBAC permissions, enforces LIMIT 20, supports is: qualifiers, and blocks FTS injection', async () => {
    const testEnv = buildTestEnv();

    // 1. User A searches "secret" -> must ONLY see Folder A's 2 allowed files, NEVER Folder B's 25 files or count!
    const resA = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=secret', {
        headers: authHeaders('sr-user-a'),
      }),
      testEnv
    );
    expect(resA.status).toBe(200);
    const bodyA = (await resA.json()) as {
      results: Array<{ id: string; name: string }>;
      totalHits?: number;
    };
    expect(bodyA.totalHits).toBeUndefined();
    expect(bodyA.results.map((r) => r.id).sort()).toEqual(['sr-a-1', 'sr-a-2']);

    // 2. User A searches `is:confidential secret` -> only confidential match sr-a-1
    const resConf = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=is:confidential%20契約', {
        headers: authHeaders('sr-user-a'),
      }),
      testEnv
    );
    expect(resConf.status).toBe(200);
    const bodyConf = (await resConf.json()) as { results: Array<{ id: string }> };
    expect(bodyConf.results.map((r) => r.id)).toEqual(['sr-a-1']);

    // 3. Standalone qualifier `is:internal` without keyword
    const resOnlyLabel = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=is:internal', {
        headers: authHeaders('sr-user-a'),
      }),
      testEnv
    );
    expect(resOnlyLabel.status).toBe(200);
    const bodyLabel = (await resOnlyLabel.json()) as { results: Array<{ id: string }> };
    expect(bodyLabel.results.map((r) => r.id)).toEqual(['sr-a-2']);

    // 4. User B searches "secret" with limit=20 -> sees 20 from Executive Vault
    const resB = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=secret&limit=20', {
        headers: authHeaders('sr-user-b'),
      }),
      testEnv
    );
    expect(resB.status).toBe(200);
    const bodyB = (await resB.json()) as { results: Array<{ id: string }> };
    expect(bodyB.results).toHaveLength(20);

    // 5. FTS5 syntax injection attempts & reserved words ("OR", "NOT", quotes, wildcards, column prefix) safely handled
    const injRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/search?q=${encodeURIComponent('"file_id:sr-secret-b-0" OR NOT * (near)')}`,
        { headers: authHeaders('sr-user-a') }
      ),
      testEnv
    );
    expect(injRes.status).toBe(200);
    const injBody = (await injRes.json()) as { results: Array<{ id: string }> };
    expect(injBody.results).toHaveLength(0);

    // Searching literal word "or" matches sr-a-2 cleanly instead of FTS syntax error
    const literalKeywordRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=or', {
        headers: authHeaders('sr-user-a'),
      }),
      testEnv
    );
    expect(literalKeywordRes.status).toBe(200);
    expect(
      ((await literalKeywordRes.json()) as { results: Array<{ id: string }> }).results.map(
        (r) => r.id
      )
    ).toEqual(['sr-a-2']);
  });
});
