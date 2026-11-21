import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { purgeExpiredTrashForTenant } from '../src/consumers/maintenance/trash';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-legal-hold-test';
const ADMIN_ID = 'lh-admin';
const SEC_ID = 'lh-sec';
const MEMBER_ID = 'lh-member';
const HELD_USER_ID = 'lh-held-user';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': TENANT,
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
  opts: {
    method?: string;
    userId?: string;
    role?: 'sys_admin' | 'sec_admin' | 'member';
    body?: unknown;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: opts.method ?? 'GET',
      headers: authHeaders(
        opts.userId ?? ADMIN_ID,
        opts.role ?? 'sys_admin'
      ),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    buildTestEnv()
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

describe('Legal Holds & Retention Policies', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const oldDate = '2025-01-01T00:00:00.000Z';
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const expiredTrashAt = '2025-02-01T00:00:00.000Z';

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tenants (id, name, slug) VALUES (?, 'Legal Hold Tenant', 'lh-tenant')`
      ).bind(TENANT),
      env.DB.prepare(
        `INSERT INTO tenant_policies (tenant_id) VALUES (?)`
      ).bind(TENANT),
      env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, role) VALUES
         (?, ?, 'lh-admin@example.com', 'LH Admin', 'sys_admin'),
         (?, ?, 'lh-sec@example.com', 'LH Sec', 'sec_admin'),
         (?, ?, 'lh-member@example.com', 'LH Member', 'member'),
         (?, ?, 'lh-held@example.com', 'LH Held User', 'member')`
      ).bind(ADMIN_ID, TENANT, SEC_ID, TENANT, MEMBER_ID, TENANT, HELD_USER_ID, TENANT),
      // Folder hierarchy: root-folder -> sub-folder
      env.DB.prepare(
        `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by, created_at)
         VALUES
         ('lh-root', ?, NULL, 'Root', 0, 1, 'internal', ?, ?),
         ('lh-sub', ?, 'lh-root', 'Sub', 1, 1, 'internal', ?, ?),
         ('lh-ret-folder', ?, NULL, 'RetFolder', 0, 1, 'internal', ?, ?)`
      ).bind(
        TENANT, ADMIN_ID, oldDate,
        TENANT, ADMIN_ID, oldDate,
        TENANT, ADMIN_ID, recentDate
      ),
      env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth) VALUES
         (?, 'lh-root', 'lh-root', 0),
         (?, 'lh-sub', 'lh-sub', 0),
         (?, 'lh-root', 'lh-sub', 1),
         (?, 'lh-ret-folder', 'lh-ret-folder', 0)`
      ).bind(TENANT, TENANT, TENANT, TENANT),
      // Permissions so MEMBER_ID owns lh-root & lh-sub & lh-ret-folder
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
         ('perm-lh-1', ?, 'folder', 'lh-root', 'user', ?, 'owner', ?),
         ('perm-lh-2', ?, 'folder', 'lh-ret-folder', 'user', ?, 'owner', ?)`
      ).bind(TENANT, MEMBER_ID, ADMIN_ID, TENANT, MEMBER_ID, ADMIN_ID),
      // Files in trash
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by, deleted_at, deleted_by, created_at)
         VALUES
         ('file-direct-hold', ?, 'lh-root', 'direct.txt', 'txt', 'text/plain', 100, 'active', 'internal', ?, ?, ?, ?, ?),
         ('file-ancestor-hold', ?, 'lh-sub', 'ancestor.txt', 'txt', 'text/plain', 100, 'active', 'internal', ?, ?, ?, ?, ?),
         ('file-user-hold', ?, 'lh-root', 'userheld.txt', 'txt', 'text/plain', 100, 'active', 'internal', ?, ?, ?, ?, ?),
         ('file-ret-class', ?, 'lh-root', 'retclass.txt', 'txt', 'text/plain', 100, 'active', 'confidential', ?, ?, ?, ?, ?),
         ('file-ret-folder', ?, 'lh-ret-folder', 'retfolder.txt', 'txt', 'text/plain', 100, 'active', 'internal', ?, ?, ?, ?, ?),
         ('file-unprotected', ?, 'lh-root', 'free.txt', 'txt', 'text/plain', 100, 'active', 'public', ?, ?, ?, ?, ?)`
      ).bind(
        TENANT, MEMBER_ID, MEMBER_ID, expiredTrashAt, MEMBER_ID, oldDate,
        TENANT, MEMBER_ID, MEMBER_ID, expiredTrashAt, MEMBER_ID, oldDate,
        TENANT, HELD_USER_ID, HELD_USER_ID, expiredTrashAt, MEMBER_ID, oldDate,
        TENANT, MEMBER_ID, MEMBER_ID, expiredTrashAt, MEMBER_ID, recentDate,
        TENANT, MEMBER_ID, MEMBER_ID, expiredTrashAt, MEMBER_ID, recentDate,
        TENANT, MEMBER_ID, MEMBER_ID, expiredTrashAt, MEMBER_ID, oldDate
      ),
    ]);
  });

  it('rejects non-admin access to legal-holds and retention-policies endpoints', async () => {
    const res1 = await call('/api/admin/legal-holds', {
      userId: MEMBER_ID,
      role: 'member',
    });
    expect(res1.status).toBe(403);

    const res2 = await call('/api/admin/retention-policies', {
      userId: MEMBER_ID,
      role: 'member',
    });
    expect(res2.status).toBe(403);
  });

  it('blocks purge on direct legal hold and allows purge after release', async () => {
    // sec_admin creates a direct file hold
    const createRes = await call('/api/admin/legal-holds', {
      method: 'POST',
      userId: SEC_ID,
      role: 'sec_admin',
      body: {
        name: 'Direct File Hold',
        reason: 'Audit 2026',
        targetType: 'file',
        targetId: 'file-direct-hold',
      },
    });
    expect(createRes.status).toBe(201);
    const holdId = (createRes.body.legalHold as { id: string }).id;

    // User permanent purge -> 423 LEGAL_HOLD_ACTIVE
    const userPurge = await call('/api/trash/items', {
      method: 'DELETE',
      userId: MEMBER_ID,
      role: 'member',
      body: { items: [{ type: 'file', id: 'file-direct-hold' }] },
    });
    expect(userPurge.status).toBe(423);
    expect(userPurge.body.code).toBe('LEGAL_HOLD_ACTIVE');
    expect(String(userPurge.body.error)).toContain('Direct File Hold');

    // Admin permanent purge -> 423 LEGAL_HOLD_ACTIVE
    const adminPurge = await call('/api/admin/trash/items', {
      method: 'DELETE',
      userId: ADMIN_ID,
      role: 'sys_admin',
      body: { items: [{ type: 'file', id: 'file-direct-hold' }] },
    });
    expect(adminPurge.status).toBe(423);
    expect(adminPurge.body.code).toBe('LEGAL_HOLD_ACTIVE');

    // Release hold
    const releaseRes = await call(`/api/admin/legal-holds/${holdId}/release`, {
      method: 'POST',
      userId: SEC_ID,
      role: 'sec_admin',
    });
    expect(releaseRes.status).toBe(200);
    expect((releaseRes.body.legalHold as { status: string }).status).toBe('released');

    // Now user permanent purge succeeds
    const afterRelease = await call('/api/trash/items', {
      method: 'DELETE',
      userId: MEMBER_ID,
      role: 'member',
      body: { items: [{ type: 'file', id: 'file-direct-hold' }] },
    });
    expect(afterRelease.status).toBe(200);
    expect(afterRelease.body.succeededCount).toBe(1);
  });

  it('blocks purge on ancestor folder hold and user hold', async () => {
    const folderHoldRes = await call('/api/admin/legal-holds', {
      method: 'POST',
      body: {
        name: 'Root Folder Hold',
        targetType: 'folder',
        targetId: 'lh-root',
      },
    });
    expect(folderHoldRes.status).toBe(201);
    const folderHoldId = (folderHoldRes.body.legalHold as { id: string }).id;

    // file-ancestor-hold is in lh-sub, whose ancestor is lh-root
    const ancestorPurge = await call('/api/trash/items', {
      method: 'DELETE',
      userId: MEMBER_ID,
      role: 'member',
      body: { items: [{ type: 'file', id: 'file-ancestor-hold' }] },
    });
    expect(ancestorPurge.status).toBe(423);
    expect(ancestorPurge.body.code).toBe('LEGAL_HOLD_ACTIVE');

    // Release folder hold so we can test user hold independently on file-user-hold
    await call(`/api/admin/legal-holds/${folderHoldId}/release`, {
      method: 'POST',
    });

    const userHoldRes = await call('/api/admin/legal-holds', {
      method: 'POST',
      body: {
        name: 'Custodian Hold',
        targetType: 'user',
        targetId: HELD_USER_ID,
      },
    });
    expect(userHoldRes.status).toBe(201);

    const userHeldPurge = await call('/api/admin/trash/items', {
      method: 'DELETE',
      userId: ADMIN_ID,
      role: 'sys_admin',
      body: { items: [{ type: 'file', id: 'file-user-hold' }] },
    });
    expect(userHeldPurge.status).toBe(423);
    expect(userHeldPurge.body.code).toBe('LEGAL_HOLD_ACTIVE');
  });

  it('blocks purge under active retention policy and allows after disable/delete', async () => {
    const classPolicyRes = await call('/api/admin/retention-policies', {
      method: 'POST',
      body: {
        name: 'Confidential 30d',
        targetType: 'classification',
        targetValue: 'confidential',
        retentionDays: 30,
      },
    });
    expect(classPolicyRes.status).toBe(201);
    const classPolicyId = (classPolicyRes.body.retentionPolicy as { id: string }).id;

    const folderPolicyRes = await call('/api/admin/retention-policies', {
      method: 'POST',
      body: {
        name: 'RetFolder 90d',
        targetType: 'folder',
        targetValue: 'lh-ret-folder',
        retentionDays: 90,
      },
    });
    expect(folderPolicyRes.status).toBe(201);

    // file-ret-class is 2 days old -> blocked by 30d policy
    const blockedClass = await call('/api/trash/items', {
      method: 'DELETE',
      userId: MEMBER_ID,
      role: 'member',
      body: { items: [{ type: 'file', id: 'file-ret-class' }] },
    });
    expect(blockedClass.status).toBe(423);
    expect(blockedClass.body.code).toBe('RETENTION_POLICY_ACTIVE');

    // file-ret-folder is 2 days old -> blocked by 90d folder policy
    const blockedFolder = await call('/api/admin/trash/items', {
      method: 'DELETE',
      userId: ADMIN_ID,
      role: 'sys_admin',
      body: { items: [{ type: 'file', id: 'file-ret-folder' }] },
    });
    expect(blockedFolder.status).toBe(423);
    expect(blockedFolder.body.code).toBe('RETENTION_POLICY_ACTIVE');

    // Disable class policy -> purge succeeds
    const patchRes = await call(`/api/admin/retention-policies/${classPolicyId}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(patchRes.status).toBe(200);

    const afterDisable = await call('/api/trash/items', {
      method: 'DELETE',
      userId: MEMBER_ID,
      role: 'member',
      body: { items: [{ type: 'file', id: 'file-ret-class' }] },
    });
    expect(afterDisable.status).toBe(200);
    expect(afterDisable.body.succeededCount).toBe(1);
  });

  it('cron auto-purge skips held/retained items and logs trash.purge_blocked_legal_hold', async () => {
    const nowIso = new Date().toISOString();
    const cutoffIso = '2026-01-01T00:00:00.000Z';

    const result = await purgeExpiredTrashForTenant(
      env.DB,
      env.BUCKET,
      TENANT,
      cutoffIso,
      nowIso
    );

    // file-unprotected should be purged; file-user-hold and file-ret-folder must remain
    expect(result.filesPurged).toBeGreaterThanOrEqual(1);

    const remaining = await env.DB.prepare(
      `SELECT id FROM files WHERE tenant_id = ? AND id IN ('file-unprotected', 'file-user-hold', 'file-ret-folder')`
    )
      .bind(TENANT)
      .all<{ id: string }>();
    const remainingIds = remaining.results.map((r) => r.id).sort();
    expect(remainingIds).toEqual(['file-ret-folder', 'file-user-hold']);

    const auditBlocked = await env.DB.prepare(
      `SELECT target_id FROM audit_logs WHERE tenant_id = ? AND action = 'trash.purge_blocked_legal_hold'`
    )
      .bind(TENANT)
      .all<{ target_id: string }>();
    const blockedIds = auditBlocked.results.map((r) => r.target_id);
    expect(blockedIds).toContain('file-user-hold');
    expect(blockedIds).toContain('file-ret-folder');
  });
});
