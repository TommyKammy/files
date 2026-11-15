import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import {
  requireSecOrSysAdmin,
  requireSysAdmin,
  resolveTargetAccess,
} from '../src/services/authorization';
import type { OidcEnv, OidcHonoEnv } from '../src/types/oidc';

function devHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
  tenantId = 'tenant-perm'
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

describe('RBAC Authorization & Permission Management (TOM-10)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-perm', 'Perm Org', 'perm-org')"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('perm-owner', 'tenant-perm', 'owner@perm.example.com', 'Owner User', 'sys_admin', 'active'),
           ('perm-coowner', 'tenant-perm', 'coowner@perm.example.com', 'CoOwner User', 'member', 'active'),
           ('perm-member', 'tenant-perm', 'member@perm.example.com', 'Member User', 'member', 'active'),
           ('perm-suspended', 'tenant-perm', 'suspended@perm.example.com', 'Suspended User', 'member', 'suspended')`
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO groups (id, tenant_id, name) VALUES ('grp-perm-viewers', 'tenant-perm', 'Audit Viewers')"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES ('grp-perm-viewers', 'perm-member')"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('f-root-p', 'tenant-perm', NULL, 'Root', 0, 1, 'confidential', 'perm-owner'),
           ('f-child-p', 'tenant-perm', 'f-root-p', 'Child', 1, 1, 'confidential', 'perm-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-perm', 'f-root-p', 'f-root-p', 0),
           ('tenant-perm', 'f-child-p', 'f-child-p', 0),
           ('tenant-perm', 'f-root-p', 'f-child-p', 1)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES ('file-p1', 'tenant-perm', 'f-child-p', 'nda.pdf', 'application/pdf', 100, 'active', 'confidential', 'perm-owner', 'perm-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('p-root-owner', 'tenant-perm', 'folder', 'f-root-p', 'user', 'perm-owner', 'owner', 'perm-owner'),
           ('p-root-group', 'tenant-perm', 'folder', 'f-root-p', 'group', 'grp-perm-viewers', 'viewer', 'perm-owner'),
           ('p-child-coowner', 'tenant-perm', 'folder', 'f-child-p', 'user', 'perm-coowner', 'co_owner', 'perm-owner')`
      ),
    ]);
  });

  it('resolves inherited user and group permissions across folder_closures', async () => {
    const memberFileAccess = await resolveTargetAccess(
      env.DB,
      { id: 'perm-member', tenantId: 'tenant-perm' },
      'file',
      'file-p1'
    );
    expect(memberFileAccess?.effectiveRole).toBe('viewer');

    const coOwnerFileAccess = await resolveTargetAccess(
      env.DB,
      { id: 'perm-coowner', tenantId: 'tenant-perm' },
      'file',
      'file-p1'
    );
    expect(coOwnerFileAccess?.effectiveRole).toBe('co_owner');
  });

  it('enforces co_owner escalation block, suspended user rejection, and last-owner lockout', async () => {
    const testEnv = buildTestEnv();

    // 1. co_owner cannot grant owner role
    const escalateRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions', {
        method: 'POST',
        headers: devHeaders('perm-coowner', 'member'),
        body: JSON.stringify({
          targetType: 'folder',
          targetId: 'f-child-p',
          granteeType: 'user',
          granteeId: 'perm-member',
          role: 'owner',
        }),
      }),
      testEnv
    );
    expect(escalateRes.status).toBe(403);

    // 2. Suspended user invitation is blocked
    const suspendedInvite = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions', {
        method: 'POST',
        headers: devHeaders('perm-owner', 'sys_admin'),
        body: JSON.stringify({
          targetType: 'folder',
          targetId: 'f-root-p',
          granteeType: 'user',
          granteeId: 'perm-suspended',
          role: 'viewer',
        }),
      }),
      testEnv
    );
    expect(suspendedInvite.status).toBe(400);

    // 3. Last owner demotion and deletion are blocked with 409
    const demoteLastOwner = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions', {
        method: 'POST',
        headers: devHeaders('perm-owner', 'sys_admin'),
        body: JSON.stringify({
          targetType: 'folder',
          targetId: 'f-root-p',
          granteeType: 'user',
          granteeId: 'perm-owner',
          role: 'editor',
        }),
      }),
      testEnv
    );
    expect(demoteLastOwner.status).toBe(409);

    const deleteLastOwner = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions/p-root-owner', {
        method: 'DELETE',
        headers: devHeaders('perm-owner', 'sys_admin'),
      }),
      testEnv
    );
    expect(deleteLastOwner.status).toBe(409);

    // 4. Granting a second owner allows subsequent demotion + UPSERT update + audit logging
    const grantSecondOwner = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions', {
        method: 'POST',
        headers: devHeaders('perm-owner', 'sys_admin'),
        body: JSON.stringify({
          targetType: 'folder',
          targetId: 'f-root-p',
          granteeType: 'user',
          granteeId: 'perm-member',
          role: 'owner',
        }),
      }),
      testEnv
    );
    expect(grantSecondOwner.status).toBe(201);
    const { permission } = (await grantSecondOwner.json()) as {
      permission: { id: string; role: string };
    };

    const demoteAfterSecond = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions', {
        method: 'POST',
        headers: devHeaders('perm-owner', 'sys_admin'),
        body: JSON.stringify({
          targetType: 'folder',
          targetId: 'f-root-p',
          granteeType: 'user',
          granteeId: 'perm-member',
          role: 'viewer',
        }),
      }),
      testEnv
    );
    expect(demoteAfterSecond.status).toBe(200);

    // 5. GET /api/permissions lists direct and inherited entries
    const listRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions?targetType=file&targetId=file-p1', {
        headers: devHeaders('perm-member', 'member'),
      }),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      effectiveRole: string;
      permissions: Array<{ inherited: boolean }>;
    };
    expect(listBody.effectiveRole).toBe('viewer');
    expect(listBody.permissions.some((p) => p.inherited)).toBe(true);

    // 6. Cleanup extra permission via DELETE and check audit logs
    const deleteExtra = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/permissions/${permission.id}`, {
        method: 'DELETE',
        headers: devHeaders('perm-owner', 'sys_admin'),
      }),
      testEnv
    );
    expect(deleteExtra.status).toBe(200);

    const audits = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE tenant_id = 'tenant-perm' AND target_id = 'f-root-p'"
    ).all<{ action: string }>();
    const actions = audits.results.map((a) => a.action);
    expect(actions).toContain('permission.grant');
    expect(actions).toContain('permission.update');
    expect(actions).toContain('permission.revoke');

    // 7. Principals search excludes suspended users
    const searchRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/principals/search?q=User', {
        headers: devHeaders('perm-member', 'member'),
      }),
      testEnv
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as {
      principals: Array<{ id: string; type: string }>;
    };
    expect(searchBody.principals.some((p) => p.id === 'perm-suspended')).toBe(false);
    expect(searchBody.principals.some((p) => p.id === 'perm-owner')).toBe(true);
  });

  it('guards admin endpoints by sys_admin / sec_admin roles', async () => {
    const adminApp = new Hono<OidcHonoEnv>();
    adminApp.use('*', async (c, next) => {
      const role = (c.req.header('X-Role') ?? 'member') as 'sys_admin' | 'sec_admin' | 'member';
      c.set('user', {
        id: 'u1',
        tenantId: 'tenant-perm',
        email: 'u1@example.com',
        displayName: 'U1',
        role,
        ipAddress: '127.0.0.1',
      });
      await next();
    });
    adminApp.get('/sys', requireSysAdmin, (c) => c.json({ ok: true }));
    adminApp.get('/sec', requireSecOrSysAdmin, (c) => c.json({ ok: true }));

    expect((await adminApp.request('/sys', { headers: { 'X-Role': 'member' } })).status).toBe(403);
    expect((await adminApp.request('/sys', { headers: { 'X-Role': 'sec_admin' } })).status).toBe(403);
    expect((await adminApp.request('/sys', { headers: { 'X-Role': 'sys_admin' } })).status).toBe(200);
    expect((await adminApp.request('/sec', { headers: { 'X-Role': 'sec_admin' } })).status).toBe(200);
  });
});
