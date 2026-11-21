import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-notif-mail';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@notif-mail.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-nm-secret-001',
    SESSION_SECRET: 'test-session-nm-secret-001',
    ...overrides,
  } as OidcEnv;
}

describe('Notification Email & Preferences API (/api/notifications/preferences)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-notif-mail', 'NM Org', 'nm-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, advanced_roles_enabled) VALUES ('tenant-notif-mail', 1)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('nm-owner', 'tenant-notif-mail', 'nm-owner@notif-mail.example.com', 'NM Owner', 'member', 'active'),
           ('nm-editor', 'tenant-notif-mail', 'nm-editor@notif-mail.example.com', 'NM Editor', 'member', 'active'),
           ('nm-viewer', 'tenant-notif-mail', 'nm-viewer@notif-mail.example.com', 'NM Viewer', 'member', 'active'),
           ('nm-suspended', 'tenant-notif-mail', 'nm-suspended@notif-mail.example.com', 'NM Suspended', 'member', 'suspended')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, classification, created_by)
         VALUES ('nm-fld-root', 'tenant-notif-mail', NULL, 'NM Root', 0, 'internal', 'nm-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES ('tenant-notif-mail', 'nm-fld-root', 'nm-fld-root', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES ('nm-file-1', 'tenant-notif-mail', 'nm-fld-root', 'Spec.pdf', 'pdf', 'application/pdf', 1024, 'active', 'internal', 'nm-owner', 'nm-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-nm-owner', 'tenant-notif-mail', 'folder', 'nm-fld-root', 'user', 'nm-owner', 'owner', 'nm-owner'),
           ('perm-nm-editor', 'tenant-notif-mail', 'folder', 'nm-fld-root', 'user', 'nm-editor', 'editor', 'nm-owner')`
      ),
    ]);
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM guest_mail_sink WHERE tenant_id = ?').bind(TENANT_ID),
      env.DB.prepare('DELETE FROM user_notifications WHERE tenant_id = ?').bind(TENANT_ID),
      env.DB.prepare('DELETE FROM user_notification_preferences WHERE tenant_id = ?').bind(TENANT_ID),
    ]);
  });

  it('defaults all notification preferences to true and supports partial PATCH updates', async () => {
    const testEnv = buildTestEnv();

    const getDefault = await app.fetch(
      new Request('http://127.0.0.1/api/notifications/preferences', {
        headers: authHeaders('nm-editor'),
      }),
      testEnv
    );
    expect(getDefault.status).toBe(200);
    const defaultJson = (await getDefault.json()) as {
      preferences: Record<string, boolean>;
    };
    expect(defaultJson.preferences).toEqual({
      emailOnMention: true,
      emailOnTaskAssigned: true,
      emailOnTaskResolved: true,
      emailOnShareGranted: true,
    });

    const patchRes = await app.fetch(
      new Request('http://127.0.0.1/api/notifications/preferences', {
        method: 'PATCH',
        headers: authHeaders('nm-editor'),
        body: JSON.stringify({
          emailOnMention: false,
          emailOnShareGranted: false,
        }),
      }),
      testEnv
    );
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as {
      preferences: Record<string, boolean>;
    };
    expect(patchJson.preferences).toEqual({
      emailOnMention: false,
      emailOnTaskAssigned: true,
      emailOnTaskResolved: true,
      emailOnShareGranted: false,
    });

    const invalidRes = await app.fetch(
      new Request('http://127.0.0.1/api/notifications/preferences', {
        method: 'PATCH',
        headers: authHeaders('nm-editor'),
        body: JSON.stringify({ emailOnMention: 'no' }),
      }),
      testEnv
    );
    expect(invalidRes.status).toBe(400);
  });

  it('sends notification emails by default for mention, task_assigned, task_resolved, and share_granted', async () => {
    const testEnv = buildTestEnv();

    // 1. Mention
    const commentRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/nm-file-1/comments', {
        method: 'POST',
        headers: authHeaders('nm-owner'),
        body: JSON.stringify({
          body: '@nm-editor レビューをお願いします',
        }),
      }),
      testEnv
    );
    expect(commentRes.status).toBe(201);

    // 2. Task assigned
    const taskRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/nm-file-1/tasks', {
        method: 'POST',
        headers: authHeaders('nm-owner'),
        body: JSON.stringify({
          title: '契約書を確認',
          assigneeId: 'nm-editor',
        }),
      }),
      testEnv
    );
    expect(taskRes.status).toBe(201);
    const { task } = (await taskRes.json()) as { task: { id: string } };

    // 3. Task resolved
    const resolveRes = await app.fetch(
      new Request(`http://127.0.0.1/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: authHeaders('nm-editor'),
        body: JSON.stringify({ status: 'approved', resolutionNote: 'OK' }),
      }),
      testEnv
    );
    expect(resolveRes.status).toBe(200);

    // 4. Share granted
    const grantRes = await app.fetch(
      new Request('http://127.0.0.1/api/permissions', {
        method: 'POST',
        headers: authHeaders('nm-owner'),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'nm-file-1',
          granteeType: 'user',
          granteeId: 'nm-viewer',
          role: 'viewer',
        }),
      }),
      testEnv
    );
    expect(grantRes.status).toBe(201);

    const mails = await env.DB.prepare(
      `SELECT kind, to_email, subject, body_text
         FROM guest_mail_sink
        WHERE tenant_id = ?
        ORDER BY rowid ASC`
    )
      .bind(TENANT_ID)
      .all<{ kind: string; to_email: string; subject: string; body_text: string }>();

    expect(mails.results.length).toBe(4);
    expect(mails.results.every((m) => m.kind === 'notification')).toBe(true);
    expect(mails.results.map((m) => m.to_email)).toEqual([
      'nm-editor@notif-mail.example.com',
      'nm-editor@notif-mail.example.com',
      'nm-owner@notif-mail.example.com',
      'nm-viewer@notif-mail.example.com',
    ]);
    expect(mails.results[0].subject).toContain('メンション');
    expect(mails.results[1].subject).toContain('タスクを割り当て');
    expect(mails.results[2].subject).toContain('承認');
    expect(mails.results[3].subject).toContain('共有権限');
  });

  it('suppresses email when preference is toggled OFF while still recording in-app notification', async () => {
    const testEnv = buildTestEnv();

    await app.fetch(
      new Request('http://127.0.0.1/api/notifications/preferences', {
        method: 'PATCH',
        headers: authHeaders('nm-editor'),
        body: JSON.stringify({ emailOnTaskAssigned: false }),
      }),
      testEnv
    );

    const taskRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/nm-file-1/tasks', {
        method: 'POST',
        headers: authHeaders('nm-owner'),
        body: JSON.stringify({
          title: 'メール抑制テスト',
          assigneeId: 'nm-editor',
        }),
      }),
      testEnv
    );
    expect(taskRes.status).toBe(201);

    const inApp = await env.DB.prepare(
      `SELECT id, type FROM user_notifications WHERE tenant_id = ? AND user_id = 'nm-editor'`
    )
      .bind(TENANT_ID)
      .all<{ id: string; type: string }>();
    expect(inApp.results.length).toBe(1);
    expect(inApp.results[0].type).toBe('task_assigned');

    const mails = await env.DB.prepare(
      `SELECT id FROM guest_mail_sink WHERE tenant_id = ?`
    )
      .bind(TENANT_ID)
      .all<{ id: string }>();
    expect(mails.results.length).toBe(0);
  });

  it('skips self-notifications and does not fail caller mutations if mail delivery fails', async () => {
    const localEnv = buildTestEnv();

    // Self-notification (assign task to self) -> skipped
    const selfTaskRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/nm-file-1/tasks', {
        method: 'POST',
        headers: authHeaders('nm-owner'),
        body: JSON.stringify({
          title: '自分宛タスク',
          assigneeId: 'nm-owner',
        }),
      }),
      localEnv
    );
    expect(selfTaskRes.status).toBe(201);

    const selfNotifs = await env.DB.prepare(
      `SELECT id FROM user_notifications WHERE tenant_id = ?`
    )
      .bind(TENANT_ID)
      .all();
    expect(selfNotifs.results.length).toBe(0);

    // Mail delivery fails (unreachable webhook) -> mutation still succeeds
    const brokenMailEnv = buildTestEnv({
      MAIL_WEBHOOK_URL: 'http://127.0.0.1:1/fail',
    });
    const resilientTaskRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/nm-file-1/tasks', {
        method: 'POST',
        headers: authHeaders('nm-owner'),
        body: JSON.stringify({
          title: 'メール失敗耐性テスト',
          assigneeId: 'nm-editor',
        }),
      }),
      brokenMailEnv
    );
    expect(resilientTaskRes.status).toBe(201);

    const recorded = await env.DB.prepare(
      `SELECT id FROM user_notifications WHERE tenant_id = ? AND user_id = 'nm-editor'`
    )
      .bind(TENANT_ID)
      .all();
    expect(recorded.results.length).toBe(1);
  });
});
