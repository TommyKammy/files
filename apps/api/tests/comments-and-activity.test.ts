import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-ca';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@ca.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-ca-secret-001',
    SESSION_SECRET: 'test-session-ca-secret-001',
    ...overrides,
  } as OidcEnv;
}

describe('Comments & Activity API (/api/items, /api/comments)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-ca', 'CA Org', 'ca-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-other', 'Other Org', 'other-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, advanced_roles_enabled) VALUES ('tenant-ca', 1)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('ca-owner', 'tenant-ca', 'ca-owner@ca.example.com', 'CA Owner', 'member', 'active'),
           ('ca-previewer', 'tenant-ca', 'ca-previewer@ca.example.com', 'CA Previewer', 'member', 'active'),
           ('ca-stranger', 'tenant-ca', 'ca-stranger@ca.example.com', 'CA Stranger', 'member', 'active'),
           ('ca-disabled', 'tenant-ca', 'ca-disabled@ca.example.com', 'CA Disabled', 'member', 'suspended'),
           ('ca-admin', 'tenant-ca', 'ca-admin@ca.example.com', 'CA Admin', 'sys_admin', 'active'),
           ('other-user', 'tenant-other', 'other@other.example.com', 'Other User', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, classification, created_by)
         VALUES
           ('ca-fld-root', 'tenant-ca', NULL, 'Root', 0, 'internal', 'ca-owner'),
           ('ca-fld-sub', 'tenant-ca', 'ca-fld-root', 'Sub', 1, 'internal', 'ca-owner'),
           ('ca-fld-deleted', 'tenant-ca', NULL, 'Deleted', 0, 'internal', 'ca-owner')`
      ),
      env.DB.prepare(
        "UPDATE folders SET deleted_at = datetime('now') WHERE id = 'ca-fld-deleted'"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-ca', 'ca-fld-root', 'ca-fld-root', 0),
           ('tenant-ca', 'ca-fld-root', 'ca-fld-sub', 1),
           ('tenant-ca', 'ca-fld-sub', 'ca-fld-sub', 0),
           ('tenant-ca', 'ca-fld-deleted', 'ca-fld-deleted', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES
           ('ca-file-1', 'tenant-ca', 'ca-fld-sub', 'Spec.pdf', 'pdf', 'application/pdf', 2048, 'active', 'internal', 'ca-owner', 'ca-owner'),
           ('ca-file-pending', 'tenant-ca', 'ca-fld-sub', 'Pending.bin', 'bin', 'application/octet-stream', 100, 'pending', 'internal', 'ca-owner', 'ca-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-ca-owner-root', 'tenant-ca', 'folder', 'ca-fld-root', 'user', 'ca-owner', 'owner', 'ca-owner'),
           ('perm-ca-prev-sub', 'tenant-ca', 'folder', 'ca-fld-sub', 'user', 'ca-previewer', 'previewer', 'ca-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO audit_logs (id, tenant_id, actor_id, actor_email, actor_ip, action, target_type, target_id, status, metadata_json, created_at)
         VALUES
           ('ca-audit-1', 'tenant-ca', 'ca-owner', 'ca-owner@ca.example.com', '203.0.113.9', 'file.upload', 'file', 'ca-file-1', 'allowed', '{"fileName":"Spec.pdf","ip":"203.0.113.9","secretToken":"shh"}', '2026-11-20T00:00:00.000Z')`
      ),
    ]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const testEnv = buildTestEnv();
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/ca-file-1/comments'),
      testEnv
    );
    expect(res.status).toBe(401);
  });

  it('enforces RBAC including path-only traversal denial', async () => {
    const testEnv = buildTestEnv();

    // Stranger has no access
    const strangerGet = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/ca-file-1/comments', {
        headers: authHeaders('ca-stranger'),
      }),
      testEnv
    );
    expect(strangerGet.status).toBe(403);

    const strangerPost = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/ca-file-1/comments', {
        method: 'POST',
        headers: authHeaders('ca-stranger'),
        body: JSON.stringify({ body: 'Hello' }),
      }),
      testEnv
    );
    expect(strangerPost.status).toBe(403);

    // Previewer only has path access on ca-fld-root -> 403
    const pathOnlyGet = await app.fetch(
      new Request('http://127.0.0.1/api/items/folder/ca-fld-root/comments', {
        headers: authHeaders('ca-previewer'),
      }),
      testEnv
    );
    expect(pathOnlyGet.status).toBe(403);

    const pathOnlyPost = await app.fetch(
      new Request('http://127.0.0.1/api/items/folder/ca-fld-root/comments', {
        method: 'POST',
        headers: authHeaders('ca-previewer'),
        body: JSON.stringify({ body: 'Should fail on path-only' }),
      }),
      testEnv
    );
    expect(pathOnlyPost.status).toBe(403);

    const pathOnlyActivity = await app.fetch(
      new Request('http://127.0.0.1/api/items/folder/ca-fld-root/activity', {
        headers: authHeaders('ca-previewer'),
      }),
      testEnv
    );
    expect(pathOnlyActivity.status).toBe(403);

    // Pending or deleted items -> 404
    const pendingRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/ca-file-pending/comments', {
        headers: authHeaders('ca-owner'),
      }),
      testEnv
    );
    expect(pendingRes.status).toBe(404);

    const deletedRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/folder/ca-fld-deleted/comments', {
        headers: authHeaders('ca-owner'),
      }),
      testEnv
    );
    expect(deletedRes.status).toBe(404);
  });

  it('creates comments, resolves @mentions, enforces edit/delete ownership, and logs audit', async () => {
    const testEnv = buildTestEnv();

    // Previewer can post a comment on ca-file-1 with @handle and @email mentions
    const createRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/ca-file-1/comments', {
        method: 'POST',
        headers: authHeaders('ca-previewer'),
        body: JSON.stringify({
          body: '確認お願いします @ca-owner @ca-admin@ca.example.com @ca-disabled @other-user',
        }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      comment: { id: string; body: string; authorId: string; mentions: string[] };
      mentionedUserIds: string[];
    };
    expect(created.comment.authorId).toBe('ca-previewer');
    expect(created.mentionedUserIds.sort()).toEqual(['ca-admin', 'ca-owner']);
    expect(created.comment.mentions.sort()).toEqual(['ca-admin', 'ca-owner']);

    // Owner (not author) cannot edit or delete previewer's comment
    const ownerPatch = await app.fetch(
      new Request(`http://127.0.0.1/api/comments/${created.comment.id}`, {
        method: 'PATCH',
        headers: authHeaders('ca-owner'),
        body: JSON.stringify({ body: 'Tampered' }),
      }),
      testEnv
    );
    expect(ownerPatch.status).toBe(403);

    const ownerDelete = await app.fetch(
      new Request(`http://127.0.0.1/api/comments/${created.comment.id}`, {
        method: 'DELETE',
        headers: authHeaders('ca-owner'),
      }),
      testEnv
    );
    expect(ownerDelete.status).toBe(403);

    // Author can edit and re-resolve mentions
    const authorPatch = await app.fetch(
      new Request(`http://127.0.0.1/api/comments/${created.comment.id}`, {
        method: 'PATCH',
        headers: authHeaders('ca-previewer'),
        body: JSON.stringify({ body: '更新しました @ca-owner' }),
      }),
      testEnv
    );
    expect(authorPatch.status).toBe(200);
    const patched = (await authorPatch.json()) as {
      comment: { body: string; mentions: string[] };
      mentionedUserIds: string[];
    };
    expect(patched.comment.body).toBe('更新しました @ca-owner');
    expect(patched.mentionedUserIds).toEqual(['ca-owner']);

    // GET comments returns oldest-first
    const listRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/ca-file-1/comments', {
        headers: authHeaders('ca-owner'),
      }),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      comments: Array<{ id: string; body: string }>;
      total: number;
    };
    expect(listBody.total).toBe(1);
    expect(listBody.comments[0]?.id).toBe(created.comment.id);

    // Admin can delete any comment
    const adminDelete = await app.fetch(
      new Request(`http://127.0.0.1/api/comments/${created.comment.id}`, {
        method: 'DELETE',
        headers: authHeaders('ca-admin', 'sys_admin'),
      }),
      testEnv
    );
    expect(adminDelete.status).toBe(200);

    // Deleted comment no longer appears
    const afterDeleteRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/ca-file-1/comments', {
        headers: authHeaders('ca-owner'),
      }),
      testEnv
    );
    const afterDelete = (await afterDeleteRes.json()) as {
      comments: unknown[];
      total: number;
    };
    expect(afterDelete.total).toBe(0);
    expect(afterDelete.comments).toEqual([]);
  });

  it('returns user-safe activity feed without leaking raw IP or secret tokens', async () => {
    const testEnv = buildTestEnv();

    const actRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/ca-file-1/activity', {
        headers: authHeaders('ca-previewer'),
      }),
      testEnv
    );
    expect(actRes.status).toBe(200);
    const actBody = (await actRes.json()) as {
      activities: Array<{
        id: string;
        actorDisplayName: string;
        action: string;
        actionLabel: string;
        metadata: Record<string, unknown> | null;
      }>;
    };
    expect(actBody.activities.length).toBeGreaterThanOrEqual(2);
    // Most recent first (comment.create from previous test, then file.upload)
    expect(actBody.activities[0]?.action).toBe('comment.create');
    expect(actBody.activities[0]?.actionLabel).toBe('コメントを投稿');

    const uploadEntry = actBody.activities.find((a) => a.action === 'file.upload');
    expect(uploadEntry).toBeDefined();
    expect(uploadEntry?.actionLabel).toBe('ファイルをアップロード');
    expect(uploadEntry?.metadata).toEqual({ fileName: 'Spec.pdf' });
    expect(JSON.stringify(uploadEntry)).not.toContain('203.0.113.9');
    expect(JSON.stringify(uploadEntry)).not.toContain('shh');
  });
});
