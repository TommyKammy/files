import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-tn';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@tn.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-tn-secret-001',
    SESSION_SECRET: 'test-session-tn-secret-001',
    ...overrides,
  } as OidcEnv;
}

describe('Tasks & Notifications API (/api/tasks, /api/notifications)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-tn', 'TN Org', 'tn-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-tn-other', 'Other TN Org', 'other-tn-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, advanced_roles_enabled) VALUES ('tenant-tn', 1)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('tn-owner', 'tenant-tn', 'tn-owner@tn.example.com', 'TN Owner', 'member', 'active'),
           ('tn-editor', 'tenant-tn', 'tn-editor@tn.example.com', 'TN Editor', 'member', 'active'),
           ('tn-previewer', 'tenant-tn', 'tn-previewer@tn.example.com', 'TN Previewer', 'member', 'active'),
           ('tn-stranger', 'tenant-tn', 'tn-stranger@tn.example.com', 'TN Stranger', 'member', 'active'),
           ('tn-suspended', 'tenant-tn', 'tn-suspended@tn.example.com', 'TN Suspended', 'member', 'suspended'),
           ('tn-admin', 'tenant-tn', 'tn-admin@tn.example.com', 'TN Admin', 'sys_admin', 'active'),
           ('tn-other-user', 'tenant-tn-other', 'other@other.example.com', 'Other User', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, classification, created_by)
         VALUES
           ('tn-fld-root', 'tenant-tn', NULL, 'TN Root', 0, 'internal', 'tn-owner'),
           ('tn-fld-sub', 'tenant-tn', 'tn-fld-root', 'TN Sub', 1, 'internal', 'tn-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-tn', 'tn-fld-root', 'tn-fld-root', 0),
           ('tenant-tn', 'tn-fld-root', 'tn-fld-sub', 1),
           ('tenant-tn', 'tn-fld-sub', 'tn-fld-sub', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES
           ('tn-file-1', 'tenant-tn', 'tn-fld-sub', 'Contract.pdf', 'pdf', 'application/pdf', 2048, 'active', 'internal', 'tn-owner', 'tn-owner'),
           ('tn-file-revoked', 'tenant-tn', 'tn-fld-root', 'Secret.pdf', 'pdf', 'application/pdf', 1024, 'active', 'confidential', 'tn-owner', 'tn-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-tn-owner-root', 'tenant-tn', 'folder', 'tn-fld-root', 'user', 'tn-owner', 'owner', 'tn-owner'),
           ('perm-tn-editor-sub', 'tenant-tn', 'folder', 'tn-fld-sub', 'user', 'tn-editor', 'editor', 'tn-owner'),
           ('perm-tn-prev-sub', 'tenant-tn', 'folder', 'tn-fld-sub', 'user', 'tn-previewer', 'previewer', 'tn-owner')`
      ),
    ]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const testEnv = buildTestEnv();
    const [tasksRes, myRes, notifRes] = await Promise.all([
      app.fetch(new Request('http://127.0.0.1/api/items/file/tn-file-1/tasks'), testEnv),
      app.fetch(new Request('http://127.0.0.1/api/tasks/my'), testEnv),
      app.fetch(new Request('http://127.0.0.1/api/notifications'), testEnv),
    ]);
    expect(tasksRes.status).toBe(401);
    expect(myRes.status).toBe(401);
    expect(notifRes.status).toBe(401);
  });

  it('enforces RBAC and tenant isolation on task creation and listing', async () => {
    const testEnv = buildTestEnv();

    const strangerGet = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tn-file-1/tasks', {
        headers: authHeaders('tn-stranger'),
      }),
      testEnv
    );
    expect(strangerGet.status).toBe(403);

    const previewerGet = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tn-file-1/tasks', {
        headers: authHeaders('tn-previewer'),
      }),
      testEnv
    );
    expect(previewerGet.status).toBe(200);

    const previewerPost = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tn-file-1/tasks', {
        method: 'POST',
        headers: authHeaders('tn-previewer'),
        body: JSON.stringify({ title: 'Review', assigneeId: 'tn-editor' }),
      }),
      testEnv
    );
    expect(previewerPost.status).toBe(403);

    const crossTenantAssignee = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tn-file-1/tasks', {
        method: 'POST',
        headers: authHeaders('tn-editor'),
        body: JSON.stringify({ title: 'Review', assigneeId: 'tn-other-user' }),
      }),
      testEnv
    );
    expect(crossTenantAssignee.status).toBe(404);

    const suspendedAssignee = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tn-file-1/tasks', {
        method: 'POST',
        headers: authHeaders('tn-editor'),
        body: JSON.stringify({ title: 'Review', assigneeId: 'tn-suspended' }),
      }),
      testEnv
    );
    expect(suspendedAssignee.status).toBe(400);
  });

  it('runs full task lifecycle: create -> my tasks -> approve -> notify creator', async () => {
    const testEnv = buildTestEnv();

    const createRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tn-file-1/tasks', {
        method: 'POST',
        headers: authHeaders('tn-owner'),
        body: JSON.stringify({
          title: '契約書の最終承認',
          message: '法務確認をお願いします',
          assigneeId: 'tn-editor',
          dueAt: '2026-12-01T00:00:00.000Z',
        }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const createdJson = (await createRes.json()) as {
      task: { id: string; status: string; title: string; assigneeId: string };
    };
    expect(createdJson.task.status).toBe('open');
    expect(createdJson.task.title).toBe('契約書の最終承認');

    // Assignee sees task in /api/tasks/my
    const myOpenRes = await app.fetch(
      new Request('http://127.0.0.1/api/tasks/my?status=open', {
        headers: authHeaders('tn-editor'),
      }),
      testEnv
    );
    expect(myOpenRes.status).toBe(200);
    const myOpenJson = (await myOpenRes.json()) as {
      tasks: Array<{ id: string; itemName: string | null }>;
    };
    expect(myOpenJson.tasks.some((t) => t.id === createdJson.task.id)).toBe(true);
    expect(
      myOpenJson.tasks.find((t) => t.id === createdJson.task.id)?.itemName
    ).toBe('Contract.pdf');

    // Assignee received task_assigned notification
    const editorNotifsRes = await app.fetch(
      new Request('http://127.0.0.1/api/notifications?unreadOnly=true', {
        headers: authHeaders('tn-editor'),
      }),
      testEnv
    );
    expect(editorNotifsRes.status).toBe(200);
    const editorNotifs = (await editorNotifsRes.json()) as {
      notifications: Array<{ type: string; body: string | null }>;
    };
    expect(
      editorNotifs.notifications.some(
        (n) => n.type === 'task_assigned' && n.body === '契約書の最終承認'
      )
    ).toBe(true);

    // Stranger cannot resolve the task
    const strangerPatch = await app.fetch(
      new Request(`http://127.0.0.1/api/tasks/${createdJson.task.id}`, {
        method: 'PATCH',
        headers: authHeaders('tn-stranger'),
        body: JSON.stringify({ status: 'approved' }),
      }),
      testEnv
    );
    expect(strangerPatch.status).toBe(403);

    // Assignee approves task
    const approveRes = await app.fetch(
      new Request(`http://127.0.0.1/api/tasks/${createdJson.task.id}`, {
        method: 'PATCH',
        headers: authHeaders('tn-editor'),
        body: JSON.stringify({
          status: 'approved',
          resolutionNote: '問題なし、承認します',
        }),
      }),
      testEnv
    );
    expect(approveRes.status).toBe(200);
    const approvedJson = (await approveRes.json()) as {
      task: { status: string; resolutionNote: string | null; resolvedBy: string | null };
    };
    expect(approvedJson.task.status).toBe('approved');
    expect(approvedJson.task.resolutionNote).toBe('問題なし、承認します');
    expect(approvedJson.task.resolvedBy).toBe('tn-editor');

    // Creator receives task_resolved notification
    const ownerNotifsRes = await app.fetch(
      new Request('http://127.0.0.1/api/notifications', {
        headers: authHeaders('tn-owner'),
      }),
      testEnv
    );
    expect(ownerNotifsRes.status).toBe(200);
    const ownerNotifs = (await ownerNotifsRes.json()) as {
      notifications: Array<{ type: string; body: string | null }>;
    };
    expect(
      ownerNotifs.notifications.some(
        (n) => n.type === 'task_resolved' && n.body === '契約書の最終承認'
      )
    ).toBe(true);

    // Admin can reopen the task
    const adminReopenRes = await app.fetch(
      new Request(`http://127.0.0.1/api/tasks/${createdJson.task.id}`, {
        method: 'PATCH',
        headers: authHeaders('tn-admin', 'sys_admin'),
        body: JSON.stringify({ status: 'open' }),
      }),
      testEnv
    );
    expect(adminReopenRes.status).toBe(200);
    const reopenedJson = (await adminReopenRes.json()) as {
      task: { status: string; resolvedAt: string | null };
    };
    expect(reopenedJson.task.status).toBe('open');
    expect(reopenedJson.task.resolvedAt).toBeNull();
  });

  it('filters out tasks on inaccessible items from /api/tasks/my', async () => {
    const testEnv = buildTestEnv();

    // Insert a task on tn-file-revoked assigned to tn-editor (who has no access to tn-fld-root)
    await env.DB.prepare(
      `INSERT INTO item_tasks (
         id, tenant_id, item_type, item_id, title, assignee_id, created_by, status
       ) VALUES ('task-inaccessible', 'tenant-tn', 'file', 'tn-file-revoked', 'Hidden Task', 'tn-editor', 'tn-owner', 'open')`
    ).run();

    const myRes = await app.fetch(
      new Request('http://127.0.0.1/api/tasks/my?status=all', {
        headers: authHeaders('tn-editor'),
      }),
      testEnv
    );
    expect(myRes.status).toBe(200);
    const myJson = (await myRes.json()) as {
      tasks: Array<{ id: string }>;
    };
    expect(myJson.tasks.some((t) => t.id === 'task-inaccessible')).toBe(false);
  });

  it('creates notifications on @mention and permission grant, and supports unread count + mark read', async () => {
    const testEnv = buildTestEnv();

    // Comment with @mention (and self-mention which should be skipped)
    const commentRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tn-file-1/comments', {
        method: 'POST',
        headers: authHeaders('tn-owner'),
        body: JSON.stringify({
          body: '確認お願いします @tn-previewer@tn.example.com @tn-owner@tn.example.com',
        }),
      }),
      testEnv
    );
    expect(commentRes.status).toBe(201);

    // Permission grant to user
    const grantRes = await app.fetch(
      new Request('http://127.0.0.1/api/permissions', {
        method: 'POST',
        headers: authHeaders('tn-owner'),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'tn-file-1',
          granteeType: 'user',
          granteeId: 'tn-previewer',
          role: 'viewer',
        }),
      }),
      testEnv
    );
    expect([200, 201]).toContain(grantRes.status);

    // Check unread count for tn-previewer (mention + share_granted = 2)
    const countRes = await app.fetch(
      new Request('http://127.0.0.1/api/notifications/unread-count', {
        headers: authHeaders('tn-previewer'),
      }),
      testEnv
    );
    expect(countRes.status).toBe(200);
    const countJson = (await countRes.json()) as { count: number };
    expect(countJson.count).toBeGreaterThanOrEqual(2);

    const listRes = await app.fetch(
      new Request('http://127.0.0.1/api/notifications?unreadOnly=true', {
        headers: authHeaders('tn-previewer'),
      }),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      notifications: Array<{ id: string; type: string; readAt: string | null }>;
    };
    const types = listJson.notifications.map((n) => n.type);
    expect(types).toContain('mention');
    expect(types).toContain('share_granted');

    const firstId = listJson.notifications[0]!.id;

    // Another user cannot mark tn-previewer's notification as read
    const otherReadRes = await app.fetch(
      new Request(`http://127.0.0.1/api/notifications/${firstId}/read`, {
        method: 'POST',
        headers: authHeaders('tn-stranger'),
      }),
      testEnv
    );
    expect(otherReadRes.status).toBe(404);

    // Mark one as read
    const readOneRes = await app.fetch(
      new Request(`http://127.0.0.1/api/notifications/${firstId}/read`, {
        method: 'POST',
        headers: authHeaders('tn-previewer'),
      }),
      testEnv
    );
    expect(readOneRes.status).toBe(200);

    // Mark all as read
    const readAllRes = await app.fetch(
      new Request('http://127.0.0.1/api/notifications/read-all', {
        method: 'POST',
        headers: authHeaders('tn-previewer'),
      }),
      testEnv
    );
    expect(readAllRes.status).toBe(200);

    const afterCountRes = await app.fetch(
      new Request('http://127.0.0.1/api/notifications/unread-count', {
        headers: authHeaders('tn-previewer'),
      }),
      testEnv
    );
    const afterCountJson = (await afterCountRes.json()) as { count: number };
    expect(afterCountJson.count).toBe(0);
  });
});
