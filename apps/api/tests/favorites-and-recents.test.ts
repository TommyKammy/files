import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-fav-rec';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@favrec.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-favrec-secret-001',
    SESSION_SECRET: 'test-session-favrec-secret-001',
    ...overrides,
  } as OidcEnv;
}

describe('Favorites & Recents API (/api/favorites, /api/recents)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-fav-rec', 'FavRec Org', 'favrec-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, advanced_roles_enabled) VALUES ('tenant-fav-rec', 1)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('fr-owner', 'tenant-fav-rec', 'fr-owner@favrec.example.com', 'FR Owner', 'member', 'active'),
           ('fr-collab', 'tenant-fav-rec', 'fr-collab@favrec.example.com', 'FR Collab', 'member', 'active'),
           ('fr-stranger', 'tenant-fav-rec', 'fr-stranger@favrec.example.com', 'FR Stranger', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, classification, created_by)
         VALUES
           ('fr-fld-root', 'tenant-fav-rec', NULL, 'Projects', 0, 'internal', 'fr-owner'),
           ('fr-fld-sub', 'tenant-fav-rec', 'fr-fld-root', 'Q4', 1, 'confidential', 'fr-owner'),
           ('fr-fld-deleted', 'tenant-fav-rec', NULL, 'DeletedFolder', 0, 'internal', 'fr-owner')`
      ),
      env.DB.prepare(
        "UPDATE folders SET deleted_at = datetime('now') WHERE id = 'fr-fld-deleted'"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-fav-rec', 'fr-fld-root', 'fr-fld-root', 0),
           ('tenant-fav-rec', 'fr-fld-root', 'fr-fld-sub', 1),
           ('tenant-fav-rec', 'fr-fld-sub', 'fr-fld-sub', 0),
           ('tenant-fav-rec', 'fr-fld-deleted', 'fr-fld-deleted', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES
           ('fr-file-1', 'tenant-fav-rec', 'fr-fld-sub', 'Roadmap.pdf', 'pdf', 'application/pdf', 1024, 'active', 'confidential', 'fr-owner', 'fr-owner'),
           ('fr-file-2', 'tenant-fav-rec', 'fr-fld-root', 'Notes.txt', 'txt', 'text/plain', 256, 'active', 'internal', 'fr-owner', 'fr-owner'),
           ('fr-file-pending', 'tenant-fav-rec', 'fr-fld-root', 'Pending.bin', 'bin', 'application/octet-stream', 100, 'pending', 'internal', 'fr-owner', 'fr-owner'),
           ('fr-file-deleted', 'tenant-fav-rec', 'fr-fld-root', 'Old.txt', 'txt', 'text/plain', 50, 'active', 'internal', 'fr-owner', 'fr-owner')`
      ),
      env.DB.prepare(
        "UPDATE files SET deleted_at = datetime('now') WHERE id = 'fr-file-deleted'"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-fr-owner-root', 'tenant-fav-rec', 'folder', 'fr-fld-root', 'user', 'fr-owner', 'owner', 'fr-owner'),
           ('perm-fr-collab-sub', 'tenant-fav-rec', 'folder', 'fr-fld-sub', 'user', 'fr-collab', 'viewer', 'fr-owner')`
      ),
    ]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const testEnv = buildTestEnv();
    const favRes = await app.fetch(
      new Request('http://127.0.0.1/api/favorites'),
      testEnv
    );
    expect(favRes.status).toBe(401);

    const recRes = await app.fetch(
      new Request('http://127.0.0.1/api/recents'),
      testEnv
    );
    expect(recRes.status).toBe(401);
  });

  it('validates payloads and enforces RBAC + non-deleted checks on POST', async () => {
    const testEnv = buildTestEnv();

    const badType = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        method: 'POST',
        headers: authHeaders('fr-owner'),
        body: JSON.stringify({ itemType: 'link', itemId: 'fr-file-1' }),
      }),
      testEnv
    );
    expect(badType.status).toBe(400);

    const badAction = await app.fetch(
      new Request('http://127.0.0.1/api/recents/touch', {
        method: 'POST',
        headers: authHeaders('fr-owner'),
        body: JSON.stringify({ itemType: 'file', itemId: 'fr-file-1', action: 'hack' }),
      }),
      testEnv
    );
    expect(badAction.status).toBe(400);

    const pendingRes = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        method: 'POST',
        headers: authHeaders('fr-owner'),
        body: JSON.stringify({ itemType: 'file', itemId: 'fr-file-pending' }),
      }),
      testEnv
    );
    expect(pendingRes.status).toBe(404);

    const deletedRes = await app.fetch(
      new Request('http://127.0.0.1/api/recents/touch', {
        method: 'POST',
        headers: authHeaders('fr-owner'),
        body: JSON.stringify({ itemType: 'folder', itemId: 'fr-fld-deleted' }),
      }),
      testEnv
    );
    expect(deletedRes.status).toBe(404);

    const strangerFav = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        method: 'POST',
        headers: authHeaders('fr-stranger'),
        body: JSON.stringify({ itemType: 'file', itemId: 'fr-file-1' }),
      }),
      testEnv
    );
    expect(strangerFav.status).toBe(403);
  });

  it('supports idempotent add/list/delete for favorites and user isolation', async () => {
    const testEnv = buildTestEnv();

    // Owner favorites a folder and a file (twice to verify idempotency)
    for (let i = 0; i < 2; i += 1) {
      const addFolder = await app.fetch(
        new Request('http://127.0.0.1/api/favorites', {
          method: 'POST',
          headers: authHeaders('fr-owner'),
          body: JSON.stringify({ itemType: 'folder', itemId: 'fr-fld-sub' }),
        }),
        testEnv
      );
      expect(addFolder.status).toBe(200);
    }

    const addFile = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        method: 'POST',
        headers: authHeaders('fr-owner'),
        body: JSON.stringify({ itemType: 'file', itemId: 'fr-file-1' }),
      }),
      testEnv
    );
    expect(addFile.status).toBe(200);

    const ownerList = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        headers: authHeaders('fr-owner'),
      }),
      testEnv
    );
    expect(ownerList.status).toBe(200);
    const ownerData = (await ownerList.json()) as {
      items: Array<{ itemType: string; id: string; pathLabel: string }>;
    };
    expect(ownerData.items.map((x) => `${x.itemType}:${x.id}`).sort()).toEqual([
      'file:fr-file-1',
      'folder:fr-fld-sub',
    ]);
    const fileEntry = ownerData.items.find((x) => x.id === 'fr-file-1');
    expect(fileEntry?.pathLabel).toContain('Projects / Q4');

    // Stranger sees empty favorites
    const strangerList = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        headers: authHeaders('fr-stranger'),
      }),
      testEnv
    );
    expect(strangerList.status).toBe(200);
    expect(((await strangerList.json()) as { items: unknown[] }).items).toEqual([]);

    // Idempotent delete
    for (let i = 0; i < 2; i += 1) {
      const delRes = await app.fetch(
        new Request('http://127.0.0.1/api/favorites/folder/fr-fld-sub', {
          method: 'DELETE',
          headers: authHeaders('fr-owner'),
        }),
        testEnv
      );
      expect(delRes.status).toBe(200);
    }

    const afterDel = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        headers: authHeaders('fr-owner'),
      }),
      testEnv
    );
    const afterData = (await afterDel.json()) as {
      items: Array<{ itemType: string; id: string }>;
    };
    expect(afterData.items.map((x) => x.id)).toEqual(['fr-file-1']);
  });

  it('immediately hides revoked items from both /api/favorites and /api/recents', async () => {
    const testEnv = buildTestEnv();

    // Collab currently has viewer on fr-fld-sub (and inherited on fr-file-1)
    const favRes = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        method: 'POST',
        headers: authHeaders('fr-collab'),
        body: JSON.stringify({ itemType: 'file', itemId: 'fr-file-1' }),
      }),
      testEnv
    );
    expect(favRes.status).toBe(200);

    const touchRes = await app.fetch(
      new Request('http://127.0.0.1/api/recents/touch', {
        method: 'POST',
        headers: authHeaders('fr-collab'),
        body: JSON.stringify({
          itemType: 'file',
          itemId: 'fr-file-1',
          action: 'view',
        }),
      }),
      testEnv
    );
    expect(touchRes.status).toBe(200);

    // Before revocation: visible in both endpoints
    const [favBefore, recBefore] = await Promise.all([
      app.fetch(
        new Request('http://127.0.0.1/api/favorites', {
          headers: authHeaders('fr-collab'),
        }),
        testEnv
      ),
      app.fetch(
        new Request('http://127.0.0.1/api/recents?limit=50', {
          headers: authHeaders('fr-collab'),
        }),
        testEnv
      ),
    ]);
    expect(((await favBefore.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id)).toContain('fr-file-1');
    expect(((await recBefore.json()) as { items: Array<{ id: string }> }).items.map((i) => i.id)).toContain('fr-file-1');

    // Revoke fr-collab's permission
    await env.DB.prepare("DELETE FROM permissions WHERE id = 'perm-fr-collab-sub'").run();

    // Immediately hidden from both /api/favorites and /api/recents
    const [favAfter, recAfter] = await Promise.all([
      app.fetch(
        new Request('http://127.0.0.1/api/favorites', {
          headers: authHeaders('fr-collab'),
        }),
        testEnv
      ),
      app.fetch(
        new Request('http://127.0.0.1/api/recents?limit=50', {
          headers: authHeaders('fr-collab'),
        }),
        testEnv
      ),
    ]);
    expect(((await favAfter.json()) as { items: unknown[] }).items).toEqual([]);
    expect(((await recAfter.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('updates last_action on repeat touch, respects limit, and prunes recents > 200 per user', async () => {
    const testEnv = buildTestEnv();

    await app.fetch(
      new Request('http://127.0.0.1/api/recents/touch', {
        method: 'POST',
        headers: authHeaders('fr-owner'),
        body: JSON.stringify({ itemType: 'file', itemId: 'fr-file-2', action: 'view' }),
      }),
      testEnv
    );
    await app.fetch(
      new Request('http://127.0.0.1/api/recents/touch', {
        method: 'POST',
        headers: authHeaders('fr-owner'),
        body: JSON.stringify({ itemType: 'file', itemId: 'fr-file-2', action: 'download' }),
      }),
      testEnv
    );

    const recList = await app.fetch(
      new Request('http://127.0.0.1/api/recents?limit=1', {
        headers: authHeaders('fr-owner'),
      }),
      testEnv
    );
    const recData = (await recList.json()) as {
      items: Array<{ id: string; lastAction: string }>;
    };
    expect(recData.items).toHaveLength(1);
    expect(recData.items[0].lastAction).toBe('download');

    // Seed 202 older rows for fr-owner, then touch fr-file-1 to trigger pruning to 200
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 202; i += 1) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO user_recent_items (tenant_id, user_id, item_type, item_id, last_action, accessed_at)
           VALUES ('tenant-fav-rec', 'fr-owner', 'file', ?, 'view', '2020-01-01 00:00:00')`
        ).bind(`synthetic-file-${i}`)
      );
    }
    await env.DB.batch(stmts);

    const pruneTouch = await app.fetch(
      new Request('http://127.0.0.1/api/recents/touch', {
        method: 'POST',
        headers: authHeaders('fr-owner'),
        body: JSON.stringify({ itemType: 'file', itemId: 'fr-file-1', action: 'edit' }),
      }),
      testEnv
    );
    expect(pruneTouch.status).toBe(200);

    const countRow = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM user_recent_items WHERE tenant_id = 'tenant-fav-rec' AND user_id = 'fr-owner'"
    ).first<{ cnt: number }>();
    expect(countRow?.cnt).toBe(200);
  });

  it('batch hydration preserves path-only traversal, direct file grants, uploader filtering, and response shape', async () => {
    const testEnv = buildTestEnv();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('fr-path-user', 'tenant-fav-rec', 'fr-path@favrec.example.com', 'FR Path User', 'member', 'active'),
           ('fr-uploader', 'tenant-fav-rec', 'fr-uploader@favrec.example.com', 'FR Uploader', 'member', 'active')`
      ),
      // fr-path-user has viewer on fr-fld-sub (so fr-fld-root is path-only) and direct previewer on fr-file-2
      // fr-uploader has uploader on fr-fld-sub (can traverse folder, cannot preview fr-file-1)
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-fr-path-sub', 'tenant-fav-rec', 'folder', 'fr-fld-sub', 'user', 'fr-path-user', 'viewer', 'fr-owner'),
           ('perm-fr-path-file2', 'tenant-fav-rec', 'file', 'fr-file-2', 'user', 'fr-path-user', 'previewer', 'fr-owner'),
           ('perm-fr-uploader-sub', 'tenant-fav-rec', 'folder', 'fr-fld-sub', 'user', 'fr-uploader', 'uploader', 'fr-owner')`
      ),
    ]);

    // fr-path-user favorites fr-fld-root (path-only), fr-fld-sub (viewer), and fr-file-2 (direct previewer)
    for (const payload of [
      { itemType: 'folder', itemId: 'fr-fld-root' },
      { itemType: 'folder', itemId: 'fr-fld-sub' },
      { itemType: 'file', itemId: 'fr-file-2' },
    ]) {
      const fav = await app.fetch(
        new Request('http://127.0.0.1/api/favorites', {
          method: 'POST',
          headers: authHeaders('fr-path-user'),
          body: JSON.stringify(payload),
        }),
        testEnv
      );
      expect(fav.status).toBe(200);

      const rec = await app.fetch(
        new Request('http://127.0.0.1/api/recents/touch', {
          method: 'POST',
          headers: authHeaders('fr-path-user'),
          body: JSON.stringify({ ...payload, action: 'view' }),
        }),
        testEnv
      );
      expect(rec.status).toBe(200);
    }

    const [favRes, recRes] = await Promise.all([
      app.fetch(
        new Request('http://127.0.0.1/api/favorites', {
          headers: authHeaders('fr-path-user'),
        }),
        testEnv
      ),
      app.fetch(
        new Request('http://127.0.0.1/api/recents', {
          headers: authHeaders('fr-path-user'),
        }),
        testEnv
      ),
    ]);
    expect(favRes.status).toBe(200);
    expect(recRes.status).toBe(200);

    const favData = (await favRes.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const recData = (await recRes.json()) as {
      items: Array<Record<string, unknown>>;
    };

    for (const list of [favData.items, recData.items]) {
      const rootFolder = list.find((i) => i.id === 'fr-fld-root');
      expect(rootFolder).toBeDefined();
      expect(rootFolder?.effectiveRole).toBeNull();
      expect(rootFolder?.capabilities).toEqual(['folder.traverse']);
      expect(rootFolder?.parentId).toBeNull();
      expect(rootFolder?.folderId).toBeNull();
      expect(rootFolder?.pathLabel).toBe('マイファイル / Projects');

      const subFolder = list.find((i) => i.id === 'fr-fld-sub');
      expect(subFolder?.effectiveRole).toBe('viewer');
      expect(subFolder?.parentId).toBe('fr-fld-root');
      expect(subFolder?.pathLabel).toBe('マイファイル / Projects / Q4');

      const directFile = list.find((i) => i.id === 'fr-file-2');
      expect(directFile?.effectiveRole).toBe('previewer');
      expect(directFile?.capabilities).toEqual([
        'folder.list',
        'folder.traverse',
        'item.preview',
      ]);
      expect(directFile?.folderId).toBe('fr-fld-root');
      expect(directFile?.extension).toBe('txt');
      expect(directFile?.sizeBytes).toBe(256);
    }

    // Revoking fr-fld-sub removes fr-fld-sub, while fr-fld-root remains path-reachable via direct fr-file-2 grant
    await env.DB.prepare("DELETE FROM permissions WHERE id = 'perm-fr-path-sub'").run();

    const favAfterSubRevoke = (await (
      await app.fetch(
        new Request('http://127.0.0.1/api/favorites', {
          headers: authHeaders('fr-path-user'),
        }),
        testEnv
      )
    ).json()) as { items: Array<{ id: string }> };
    expect(favAfterSubRevoke.items.map((i) => i.id).sort()).toEqual([
      'fr-file-2',
      'fr-fld-root',
    ]);

    // Revoking direct fr-file-2 grant removes both fr-file-2 and path-only fr-fld-root
    await env.DB.prepare("DELETE FROM permissions WHERE id = 'perm-fr-path-file2'").run();

    const favAfterAllRevoke = (await (
      await app.fetch(
        new Request('http://127.0.0.1/api/favorites', {
          headers: authHeaders('fr-path-user'),
        }),
        testEnv
      )
    ).json()) as { items: Array<{ id: string }> };
    expect(favAfterAllRevoke.items).toEqual([]);

    // Uploader can favorite fr-fld-sub, but if a file row exists in user_favorites, item.preview check hides it
    const uploaderFavFolder = await app.fetch(
      new Request('http://127.0.0.1/api/favorites', {
        method: 'POST',
        headers: authHeaders('fr-uploader'),
        body: JSON.stringify({ itemType: 'folder', itemId: 'fr-fld-sub' }),
      }),
      testEnv
    );
    expect(uploaderFavFolder.status).toBe(200);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_favorites (tenant_id, user_id, item_type, item_id, created_at)
       VALUES ('tenant-fav-rec', 'fr-uploader', 'file', 'fr-file-1', datetime('now'))`
    ).run();

    const uploaderList = (await (
      await app.fetch(
        new Request('http://127.0.0.1/api/favorites', {
          headers: authHeaders('fr-uploader'),
        }),
        testEnv
      )
    ).json()) as { items: Array<{ itemType: string; id: string; effectiveRole: string | null }> };
    expect(uploaderList.items.map((i) => `${i.itemType}:${i.id}`)).toEqual([
      'folder:fr-fld-sub',
    ]);
    expect(uploaderList.items[0].effectiveRole).toBe('uploader');
  });
});
