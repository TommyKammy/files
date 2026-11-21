import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-col';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@col.example.com`,
    'Content-Type': 'application/json',
  };
}

function buildTestEnv(overrides: Partial<OidcEnv> = {}): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-col-secret-001',
    SESSION_SECRET: 'test-session-col-secret-001',
    ...overrides,
  } as OidcEnv;
}

describe('User Collections API (/api/collections)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-col', 'Col Org', 'col-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, advanced_roles_enabled) VALUES ('tenant-col', 1)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('col-owner', 'tenant-col', 'col-owner@col.example.com', 'Col Owner', 'member', 'active'),
           ('col-collab', 'tenant-col', 'col-collab@col.example.com', 'Col Collab', 'member', 'active'),
           ('col-stranger', 'tenant-col', 'col-stranger@col.example.com', 'Col Stranger', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, classification, created_by)
         VALUES
           ('col-fld-root', 'tenant-col', NULL, 'Contracts', 0, 'internal', 'col-owner'),
           ('col-fld-sub', 'tenant-col', 'col-fld-root', '2026', 1, 'confidential', 'col-owner'),
           ('col-fld-deleted', 'tenant-col', NULL, 'DeletedFolder', 0, 'internal', 'col-owner')`
      ),
      env.DB.prepare(
        "UPDATE folders SET deleted_at = datetime('now') WHERE id = 'col-fld-deleted'"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-col', 'col-fld-root', 'col-fld-root', 0),
           ('tenant-col', 'col-fld-root', 'col-fld-sub', 1),
           ('tenant-col', 'col-fld-sub', 'col-fld-sub', 0),
           ('tenant-col', 'col-fld-deleted', 'col-fld-deleted', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES
           ('col-file-1', 'tenant-col', 'col-fld-sub', 'NDA.pdf', 'pdf', 'application/pdf', 1024, 'active', 'confidential', 'col-owner', 'col-owner'),
           ('col-file-2', 'tenant-col', 'col-fld-root', 'Index.txt', 'txt', 'text/plain', 256, 'active', 'internal', 'col-owner', 'col-owner'),
           ('col-file-pending', 'tenant-col', 'col-fld-root', 'Pending.bin', 'bin', 'application/octet-stream', 100, 'pending', 'internal', 'col-owner', 'col-owner'),
           ('col-file-deleted', 'tenant-col', 'col-fld-root', 'Old.txt', 'txt', 'text/plain', 50, 'active', 'internal', 'col-owner', 'col-owner')`
      ),
      env.DB.prepare(
        "UPDATE files SET deleted_at = datetime('now') WHERE id = 'col-file-deleted'"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-col-owner-root', 'tenant-col', 'folder', 'col-fld-root', 'user', 'col-owner', 'owner', 'col-owner'),
           ('perm-col-collab-sub', 'tenant-col', 'folder', 'col-fld-sub', 'user', 'col-collab', 'viewer', 'col-owner')`
      ),
    ]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const testEnv = buildTestEnv();
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/collections'),
      testEnv
    );
    expect(res.status).toBe(401);
  });

  it('supports CRUD, name validation, and 409 duplicate name conflict', async () => {
    const testEnv = buildTestEnv();

    // Empty name -> 400
    const badEmpty = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ name: '   ' }),
      }),
      testEnv
    );
    expect(badEmpty.status).toBe(400);

    // >60 chars -> 400
    const badLong = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ name: 'a'.repeat(61) }),
      }),
      testEnv
    );
    expect(badLong.status).toBe(400);

    // Invalid color -> 400
    const badColor = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ name: 'Legal', color: 'neon-pink' }),
      }),
      testEnv
    );
    expect(badColor.status).toBe(400);

    // Create collection
    const createRes = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ name: '  重要案件  ', color: 'indigo' }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      collection: { id: string; name: string; color: string; itemCount: number };
    };
    expect(created.collection.name).toBe('重要案件');
    expect(created.collection.color).toBe('indigo');
    expect(created.collection.itemCount).toBe(0);

    // Duplicate name for same user -> 409
    const dupRes = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ name: '重要案件' }),
      }),
      testEnv
    );
    expect(dupRes.status).toBe(409);

    // Same name for another user -> 201 (per-user namespace)
    const otherUserRes = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-collab'),
        body: JSON.stringify({ name: '重要案件' }),
      }),
      testEnv
    );
    expect(otherUserRes.status).toBe(201);

    // Create second collection for col-owner and test PATCH conflict
    const secondRes = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ name: '監査用' }),
      }),
      testEnv
    );
    expect(secondRes.status).toBe(201);
    const second = (await secondRes.json()) as {
      collection: { id: string; name: string; color: string };
    };
    expect(second.collection.color).toBe('slate');

    // Rename second to first's name -> 409
    const patchConflict = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${second.collection.id}`, {
        method: 'PATCH',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ name: '重要案件' }),
      }),
      testEnv
    );
    expect(patchConflict.status).toBe(409);

    // Valid PATCH
    const patchOk = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${second.collection.id}`, {
        method: 'PATCH',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ name: '監査資料2026', color: 'emerald' }),
      }),
      testEnv
    );
    expect(patchOk.status).toBe(200);
    const patched = (await patchOk.json()) as {
      collection: { name: string; color: string };
    };
    expect(patched.collection.name).toBe('監査資料2026');
    expect(patched.collection.color).toBe('emerald');

    // Other user cannot patch or delete col-owner's collection -> 404
    const strangerPatch = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${second.collection.id}`, {
        method: 'PATCH',
        headers: authHeaders('col-stranger'),
        body: JSON.stringify({ name: 'Hijack' }),
      }),
      testEnv
    );
    expect(strangerPatch.status).toBe(404);

    // List collections for col-owner
    const listRes = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        headers: authHeaders('col-owner'),
      }),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listed = (await listRes.json()) as {
      collections: Array<{ id: string; name: string }>;
    };
    expect(listed.collections.map((c) => c.name).sort()).toEqual([
      '監査資料2026',
      '重要案件',
    ]);

    // Delete second collection
    const delRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${second.collection.id}`, {
        method: 'DELETE',
        headers: authHeaders('col-owner'),
      }),
      testEnv
    );
    expect(delRes.status).toBe(200);
  });

  it('adds/lists/removes items with RBAC checks and hides items after permission revocation', async () => {
    const testEnv = buildTestEnv();

    // Create collection for col-collab
    const createRes = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-collab'),
        body: JSON.stringify({ name: 'My Work', color: 'sky' }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const { collection } = (await createRes.json()) as {
      collection: { id: string };
    };

    // col-collab cannot add col-file-2 (in col-fld-root, no access) -> 403
    const forbiddenAdd = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        method: 'POST',
        headers: authHeaders('col-collab'),
        body: JSON.stringify({ itemType: 'file', itemId: 'col-file-2' }),
      }),
      testEnv
    );
    expect(forbiddenAdd.status).toBe(403);

    // Cannot add deleted or pending items -> 404
    const deletedAdd = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        method: 'POST',
        headers: authHeaders('col-owner'),
        body: JSON.stringify({ itemType: 'file', itemId: 'col-file-deleted' }),
      }),
      testEnv
    );
    expect(deletedAdd.status).toBe(404);

    // col-collab can add col-file-1 and col-fld-sub (viewer on col-fld-sub)
    const addFileRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        method: 'POST',
        headers: authHeaders('col-collab'),
        body: JSON.stringify({ itemType: 'file', itemId: 'col-file-1' }),
      }),
      testEnv
    );
    expect(addFileRes.status).toBe(200);

    // Idempotent duplicate add
    const addFileDupRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        method: 'POST',
        headers: authHeaders('col-collab'),
        body: JSON.stringify({ itemType: 'file', itemId: 'col-file-1' }),
      }),
      testEnv
    );
    expect(addFileDupRes.status).toBe(200);

    const addFolderRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        method: 'POST',
        headers: authHeaders('col-collab'),
        body: JSON.stringify({ itemType: 'folder', itemId: 'col-fld-sub' }),
      }),
      testEnv
    );
    expect(addFolderRes.status).toBe(200);

    // List items in collection
    const itemsRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        headers: authHeaders('col-collab'),
      }),
      testEnv
    );
    expect(itemsRes.status).toBe(200);
    const itemsData = (await itemsRes.json()) as {
      collection: { itemCount: number };
      items: Array<{ itemType: string; id: string; name: string }>;
    };
    expect(itemsData.collection.itemCount).toBe(2);
    expect(itemsData.items.map((i) => `${i.itemType}:${i.id}`).sort()).toEqual([
      'file:col-file-1',
      'folder:col-fld-sub',
    ]);

    // Revoke col-collab's permission on col-fld-sub
    await env.DB.prepare(
      "DELETE FROM permissions WHERE id = 'perm-col-collab-sub'"
    ).run();

    // Subsequent GET /items hides both revoked items immediately
    const afterRevokeRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        headers: authHeaders('col-collab'),
      }),
      testEnv
    );
    expect(afterRevokeRes.status).toBe(200);
    const afterRevokeData = (await afterRevokeRes.json()) as {
      collection: { itemCount: number };
      items: Array<{ id: string }>;
    };
    expect(afterRevokeData.items).toEqual([]);
    expect(afterRevokeData.collection.itemCount).toBe(0);

    // Restore permission, then test DELETE item & DELETE collection cascading items
    await env.DB.prepare(
      `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES ('perm-col-collab-sub', 'tenant-col', 'folder', 'col-fld-sub', 'user', 'col-collab', 'viewer', 'col-owner')`
    ).run();

    const removeItemRes = await app.fetch(
      new Request(
        `http://127.0.0.1/api/collections/${collection.id}/items/folder/col-fld-sub`,
        {
          method: 'DELETE',
          headers: authHeaders('col-collab'),
        }
      ),
      testEnv
    );
    expect(removeItemRes.status).toBe(200);

    const afterRemoveRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        headers: authHeaders('col-collab'),
      }),
      testEnv
    );
    const afterRemoveData = (await afterRemoveRes.json()) as {
      items: Array<{ id: string }>;
    };
    expect(afterRemoveData.items.map((i) => i.id)).toEqual(['col-file-1']);

    // Delete collection removes its user_collection_items rows too
    const delColRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}`, {
        method: 'DELETE',
        headers: authHeaders('col-collab'),
      }),
      testEnv
    );
    expect(delColRes.status).toBe(200);

    const remainingRows = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM user_collection_items WHERE collection_id = ?'
    )
      .bind(collection.id)
      .first<{ cnt: number }>();
    expect(remainingRows?.cnt).toBe(0);
  });

  it('batch hydration preserves path-only folder access, direct file grants, and revocation', async () => {
    const testEnv = buildTestEnv();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES ('col-path-user', 'tenant-col', 'col-path@col.example.com', 'Col Path User', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-col-path-sub', 'tenant-col', 'folder', 'col-fld-sub', 'user', 'col-path-user', 'viewer', 'col-owner'),
           ('perm-col-path-file2', 'tenant-col', 'file', 'col-file-2', 'user', 'col-path-user', 'previewer', 'col-owner')`
      ),
    ]);

    const createRes = await app.fetch(
      new Request('http://127.0.0.1/api/collections', {
        method: 'POST',
        headers: authHeaders('col-path-user'),
        body: JSON.stringify({ name: 'Path & Direct', color: 'amber' }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const { collection } = (await createRes.json()) as {
      collection: { id: string };
    };

    for (const payload of [
      { itemType: 'folder', itemId: 'col-fld-root' },
      { itemType: 'file', itemId: 'col-file-2' },
    ]) {
      const addRes = await app.fetch(
        new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
          method: 'POST',
          headers: authHeaders('col-path-user'),
          body: JSON.stringify(payload),
        }),
        testEnv
      );
      expect(addRes.status).toBe(200);
    }

    const listRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        headers: authHeaders('col-path-user'),
      }),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as {
      collection: { itemCount: number };
      items: Array<{
        id: string;
        effectiveRole: string | null;
        capabilities: string[];
        pathLabel: string;
        addedAt: string;
      }>;
    };
    expect(listData.collection.itemCount).toBe(2);

    const rootItem = listData.items.find((i) => i.id === 'col-fld-root');
    expect(rootItem?.effectiveRole).toBeNull();
    expect(rootItem?.capabilities).toEqual(['folder.traverse']);
    expect(rootItem?.pathLabel).toBe('マイファイル / Contracts');
    expect(typeof rootItem?.addedAt).toBe('string');

    const directFile = listData.items.find((i) => i.id === 'col-file-2');
    expect(directFile?.effectiveRole).toBe('previewer');
    expect(directFile?.pathLabel).toBe('マイファイル / Contracts');

    // Revoke descendant folder grant -> col-fld-root remains path-reachable via direct col-file-2 grant
    await env.DB.prepare("DELETE FROM permissions WHERE id = 'perm-col-path-sub'").run();

    const afterRevokeSubRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        headers: authHeaders('col-path-user'),
      }),
      testEnv
    );
    const afterRevokeSubData = (await afterRevokeSubRes.json()) as {
      collection: { itemCount: number };
      items: Array<{ id: string }>;
    };
    expect(afterRevokeSubData.collection.itemCount).toBe(2);
    expect(afterRevokeSubData.items.map((i) => i.id).sort()).toEqual([
      'col-file-2',
      'col-fld-root',
    ]);

    // Revoke direct file grant -> both col-file-2 and path-only col-fld-root disappear
    await env.DB.prepare("DELETE FROM permissions WHERE id = 'perm-col-path-file2'").run();

    const afterRevokeAllRes = await app.fetch(
      new Request(`http://127.0.0.1/api/collections/${collection.id}/items`, {
        headers: authHeaders('col-path-user'),
      }),
      testEnv
    );
    const afterRevokeAllData = (await afterRevokeAllRes.json()) as {
      collection: { itemCount: number };
      items: Array<{ id: string }>;
    };
    expect(afterRevokeAllData.collection.itemCount).toBe(0);
    expect(afterRevokeAllData.items).toEqual([]);
  });
});
