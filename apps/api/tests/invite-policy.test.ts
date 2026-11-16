import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import {
  canUserInviteByPolicy,
  computeEffectivePermissionsCapabilities,
  grantableRolesForCaller,
  isRoleWithinCapabilitySubset,
  resolveEffectiveInvitePolicy,
  stricterInvitePolicy,
  type InvitePolicy,
} from '../src/services/invite-policy';
import { ROLE_CAPABILITIES } from '../src/services/capabilities';
import type { OidcEnv } from '../src/types/oidc';
import type { ResourceRole } from '../src/types/api';

const TENANT = 'tenant-inv';
const OTHER_TENANT = 'tenant-inv-other';
const ADMIN = 'inv-admin';
const SEC_ADMIN = 'inv-sec';
const OWNER = 'inv-owner';
const CO_OWNER = 'inv-coowner';
const EDITOR = 'inv-editor';
const VIEWER = 'inv-viewer';
const INVITEES = [
  'inv-target-1',
  'inv-target-2',
  'inv-target-3',
  'inv-target-4',
  'inv-target-5',
  'inv-target-6',
];
const OUTSIDER = 'inv-outsider';

type UserRole = 'sys_admin' | 'sec_admin' | 'member';

function devHeaders(
  userId: string,
  role: UserRole = 'member',
  tenantId = TENANT
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

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  path: string,
  userId: string,
  options: {
    method?: string;
    body?: unknown;
    role?: UserRole;
    tenantId?: string;
  } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: options.method ?? 'GET',
      headers: devHeaders(
        userId,
        options.role ?? 'member',
        options.tenantId ?? TENANT
      ),
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    }),
    buildTestEnv()
  );
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body: body as T };
}

let folderSequence = 0;

async function createFolderFixture(input: {
  id?: string;
  parentId?: string | null;
  ownerId?: string;
  tenantId?: string;
  grants?: Array<{ userId: string; role: ResourceRole }>;
  invitePolicy?: InvitePolicy | null;
  fileId?: string;
} = {}): Promise<string> {
  const tenantId = input.tenantId ?? TENANT;
  const id = input.id ?? `inv-folder-${++folderSequence}`;
  const ownerId = input.ownerId ?? ADMIN;
  const now = new Date().toISOString();
  let depth = 0;
  if (input.parentId) {
    const parent = await env.DB.prepare(
      'SELECT depth FROM folders WHERE tenant_id = ? AND id = ?'
    )
      .bind(tenantId, input.parentId)
      .first<{ depth: number }>();
    depth = (parent?.depth ?? 0) + 1;
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO folders (
         id, tenant_id, parent_id, name, depth, version, classification,
         is_pinned, invite_policy, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 'internal', 0, ?, ?, ?, ?)`
    ).bind(
      id,
      tenantId,
      input.parentId ?? null,
      id,
      depth,
      input.invitePolicy ?? null,
      ownerId,
      now,
      now
    ),
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       VALUES (?, ?, ?, 0)`
    ).bind(tenantId, id, id),
    env.DB.prepare(
      `INSERT INTO permissions (
         id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by
       ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?)`
    ).bind(crypto.randomUUID(), tenantId, id, ownerId, ownerId),
  ]);

  if (input.parentId) {
    const ancestors = await env.DB.prepare(
      `SELECT ancestor_id, depth FROM folder_closures
        WHERE tenant_id = ? AND descendant_id = ?`
    )
      .bind(tenantId, input.parentId)
      .all<{ ancestor_id: string; depth: number }>();
    const statements = ancestors.results.map((ancestor) =>
      env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, ?)`
      ).bind(tenantId, ancestor.ancestor_id, id, ancestor.depth + 1)
    );
    if (statements.length > 0) await env.DB.batch(statements);
  }

  if (input.grants && input.grants.length > 0) {
    await env.DB.batch(
      input.grants.map((grant) =>
        env.DB.prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by
           ) VALUES (?, ?, 'folder', ?, 'user', ?, ?, ?)`
        ).bind(
          crypto.randomUUID(),
          tenantId,
          id,
          grant.userId,
          grant.role,
          ownerId
        )
      )
    );
  }

  if (input.fileId) {
    await env.DB.prepare(
      `INSERT INTO files (
         id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
         upload_state, classification, created_by, updated_by
       ) VALUES (?, ?, ?, 'secret.txt', 'txt', 'text/plain', 10, 'active', 'internal', ?, ?)`
    )
      .bind(input.fileId, tenantId, id, ownerId, ownerId)
      .run();
  }

  return id;
}

async function setTenantInvitePolicy(policy: InvitePolicy): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_policies (tenant_id, invite_policy)
     VALUES (?, ?)
     ON CONFLICT (tenant_id) DO UPDATE SET invite_policy = excluded.invite_policy`
  )
    .bind(TENANT, policy)
    .run();
}

async function setInheritanceMode(
  mode: 'additive' | 'waterfall'
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tenant_policies SET permission_inheritance_mode = ? WHERE tenant_id = ?`
  )
    .bind(mode, TENANT)
    .run();
}

async function setAdvancedRoles(enabled: boolean): Promise<void> {
  await env.DB.prepare(
    `UPDATE tenant_policies SET advanced_roles_enabled = ? WHERE tenant_id = ?`
  )
    .bind(enabled ? 1 : 0, TENANT)
    .run();
}

describe('Invite policy (P9-5 / TOM-58)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug)
         VALUES (?, 'Invite Org', 'invite-org'), (?, 'Other Invite Org', 'invite-other')`
      ).bind(TENANT, OTHER_TENANT),
      env.DB.prepare(
        `INSERT INTO tenant_policies (tenant_id, invite_policy)
         VALUES (?, 'owners'), (?, 'owners')
         ON CONFLICT (tenant_id) DO NOTHING`
      ).bind(TENANT, OTHER_TENANT),
      env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           (?, ?, 'admin@invite.example.com', 'Invite Admin', 'sys_admin', 'active'),
           (?, ?, 'sec@invite.example.com', 'Invite Sec', 'sec_admin', 'active'),
           (?, ?, 'owner@invite.example.com', 'Invite Owner', 'member', 'active'),
           (?, ?, 'coowner@invite.example.com', 'Invite CoOwner', 'member', 'active'),
           (?, ?, 'editor@invite.example.com', 'Invite Editor', 'member', 'active'),
           (?, ?, 'viewer@invite.example.com', 'Invite Viewer', 'member', 'active'),
           (?, ?, 'target1@invite.example.com', 'Target One', 'member', 'active'),
           (?, ?, 'target2@invite.example.com', 'Target Two', 'member', 'active'),
           (?, ?, 'target3@invite.example.com', 'Target Three', 'member', 'active'),
           (?, ?, 'target4@invite.example.com', 'Target Four', 'member', 'active'),
           (?, ?, 'target5@invite.example.com', 'Target Five', 'member', 'active'),
           (?, ?, 'target6@invite.example.com', 'Target Six', 'member', 'active')`
      ).bind(
        ADMIN,
        TENANT,
        SEC_ADMIN,
        TENANT,
        OWNER,
        TENANT,
        CO_OWNER,
        TENANT,
        EDITOR,
        TENANT,
        VIEWER,
        TENANT,
        ...INVITEES.flatMap((id) => [id, TENANT])
      ),
      env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, role, status)
         VALUES (?, ?, 'outsider@other.example.com', 'Outsider', 'member', 'active')`
      ).bind(OUTSIDER, OTHER_TENANT),
    ]);
  });

  it('enforces the 3 x 4 role matrix plus sys_admin / sec_admin under admins', async () => {
    const expected: Record<
      InvitePolicy,
      Record<string, { status: number; code?: string }>
    > = {
      owners: {
        owner: { status: 201 },
        co_owner: { status: 201 },
        editor: { status: 403, code: 'INVITE_POLICY_RESTRICTED' },
        viewer: { status: 403, code: 'FORBIDDEN' },
      },
      editors: {
        owner: { status: 201 },
        co_owner: { status: 201 },
        editor: { status: 201 },
        viewer: { status: 403, code: 'FORBIDDEN' },
      },
      admins: {
        owner: { status: 403, code: 'INVITE_POLICY_RESTRICTED' },
        co_owner: { status: 403, code: 'INVITE_POLICY_RESTRICTED' },
        editor: { status: 403, code: 'INVITE_POLICY_RESTRICTED' },
        viewer: { status: 403, code: 'FORBIDDEN' },
      },
    };

    let inviteeIndex = 0;
    for (const policy of ['owners', 'editors', 'admins'] as InvitePolicy[]) {
      await setTenantInvitePolicy(policy);
      for (const role of ['owner', 'co_owner', 'editor', 'viewer'] as ResourceRole[]) {
        const userId =
          role === 'owner'
            ? OWNER
            : role === 'co_owner'
              ? CO_OWNER
              : role === 'editor'
                ? EDITOR
                : VIEWER;
        const folderId = await createFolderFixture({
          grants: [{ userId, role }],
        });
        const invitee = INVITEES[inviteeIndex++ % INVITEES.length]!;
        const response = await call<{ code?: string }>('/api/permissions', userId, {
          method: 'POST',
          body: {
            targetType: 'folder',
            targetId: folderId,
            granteeType: 'user',
            granteeId: invitee,
            role: 'viewer',
          },
        });
        const expectation = expected[policy][role]!;
        expect(
          response.status,
          `${policy} / ${role} invite should be ${expectation.status}`
        ).toBe(expectation.status);
        if (expectation.code) {
          expect(response.body.code, `${policy} / ${role} code`).toBe(
            expectation.code
          );
        }
      }
    }

    // sys_admin with owner access can invite under admins.
    await setTenantInvitePolicy('admins');
    const adminFolder = await createFolderFixture({
      ownerId: ADMIN,
    });
    const adminInvite = await call('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: adminFolder,
        granteeType: 'user',
        granteeId: INVITEES[0],
        role: 'viewer',
      },
    });
    expect(adminInvite.status).toBe(201);

    // sys_admin acting with editor access may also invite under admins.
    const adminEditorFolder = await createFolderFixture({
      ownerId: OWNER,
      grants: [{ userId: ADMIN, role: 'editor' }],
    });
    const adminEditorInvite = await call('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: adminEditorFolder,
        granteeType: 'user',
        granteeId: INVITEES[1],
        role: 'viewer',
      },
    });
    expect(adminEditorInvite.status).toBe(201);

    // sys_admin with viewer-only access is not editor+ and cannot invite.
    const adminViewerFolder = await createFolderFixture({
      ownerId: OWNER,
      grants: [{ userId: ADMIN, role: 'viewer' }],
    });
    const adminViewerInvite = await call('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: adminViewerFolder,
        granteeType: 'user',
        granteeId: INVITEES[2],
        role: 'viewer',
      },
    });
    expect(adminViewerInvite.status).toBe(403);
    expect(adminViewerInvite.body.code).toBe('FORBIDDEN');

    // sec_admin remains blocked under admins even with owner access.
    const secFolder = await createFolderFixture({
      ownerId: SEC_ADMIN,
    });
    const secInvite = await call('/api/permissions', SEC_ADMIN, {
      method: 'POST',
      role: 'sec_admin',
      body: {
        targetType: 'folder',
        targetId: secFolder,
        granteeType: 'user',
        granteeId: INVITEES[3],
        role: 'viewer',
      },
    });
    expect(secInvite.status).toBe(403);
    expect(secInvite.body.code).toBe('INVITE_POLICY_RESTRICTED');
  });

  it('caps editor invitations to their capability subset and rejects existing updates/revokes', async () => {
    await setTenantInvitePolicy('editors');
    await setAdvancedRoles(true);
    const folderId = await createFolderFixture({
      grants: [{ userId: EDITOR, role: 'editor' }],
      fileId: 'inv-editor-file',
    });

    const allowedRoles: ResourceRole[] = [
      'viewer',
      'editor',
      'previewer',
      'viewer_uploader',
      'previewer_uploader',
      'uploader',
    ];
    for (let i = 0; i < allowedRoles.length; i++) {
      const response = await call('/api/permissions', EDITOR, {
        method: 'POST',
        body: {
          targetType: 'folder',
          targetId: folderId,
          granteeType: 'user',
          granteeId: INVITEES[i % INVITEES.length],
          role: allowedRoles[i]!,
        },
      });
      // Repeated grantees become updates and require permission.manage; use a
      // distinct target for every role in this loop.
      expect(response.status).toBe(201);
    }

    for (const role of ['co_owner', 'owner'] as ResourceRole[]) {
      const response = await call<{ code?: string }>('/api/permissions', EDITOR, {
        method: 'POST',
        body: {
          targetType: 'folder',
          targetId: folderId,
          granteeType: 'user',
          granteeId: CO_OWNER,
          role,
        },
      });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('ROLE_EXCEEDS_CALLER_CAPABILITIES');
    }

    // Existing collaborator update and revoke both require permission.manage.
    const existing = await env.DB.prepare(
      `SELECT id FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND target_id = ?
          AND grantee_type = 'user' AND grantee_id = ?`
    )
      .bind(TENANT, folderId, INVITEES[0])
      .first<{ id: string }>();
    const updateResponse = await call<{ code?: string }>(
      '/api/permissions',
      EDITOR,
      {
        method: 'POST',
        body: {
          targetType: 'folder',
          targetId: folderId,
          granteeType: 'user',
          granteeId: INVITEES[0],
          role: 'viewer',
        },
      }
    );
    expect(updateResponse.status).toBe(403);
    expect(updateResponse.body.code).toBe('MANAGE_PERMISSION_REQUIRED');

    const revokeResponse = await call<{ code?: string }>(
      `/api/permissions/${existing!.id}`,
      EDITOR,
      { method: 'DELETE' }
    );
    expect(revokeResponse.status).toBe(403);
    expect(revokeResponse.body.code).toBe('MANAGE_PERMISSION_REQUIRED');

    // Advanced roles stay folder-only for invite-only callers.
    const fileResponse = await call<{ code?: string }>('/api/permissions', EDITOR, {
      method: 'POST',
      body: {
        targetType: 'file',
        targetId: 'inv-editor-file',
        granteeType: 'user',
        granteeId: INVITEES[1],
        role: 'uploader',
      },
    });
    expect(fileResponse.status).toBe(400);
    expect(fileResponse.body.code).toBe('ROLE_FOLDER_ONLY');

    await setAdvancedRoles(false);
    const advancedResponse = await call<{ code?: string }>(
      '/api/permissions',
      EDITOR,
      {
        method: 'POST',
        body: {
          targetType: 'folder',
          targetId: folderId,
          granteeType: 'user',
          granteeId: SEC_ADMIN,
          role: 'uploader',
        },
      }
    );
    expect(advancedResponse.status).toBe(403);
    expect(advancedResponse.body.code).toBe('ADVANCED_ROLES_DISABLED');
  });

  it('keeps owner escalation, co_owner revoke and last-owner guards intact', async () => {
    await setTenantInvitePolicy('editors');
    const folderId = await createFolderFixture({
      grants: [
        { userId: OWNER, role: 'owner' },
        { userId: CO_OWNER, role: 'co_owner' },
      ],
    });

    const ownerGrant = await call<{ code?: string }>('/api/permissions', CO_OWNER, {
      method: 'POST',
      body: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: INVITEES[0],
        role: 'owner',
      },
    });
    expect(ownerGrant.status).toBe(403);
    expect(ownerGrant.body.code).toBe('OWNER_ESCALATION_BLOCKED');

    const coOwnerGrant = await call('/api/permissions', CO_OWNER, {
      method: 'POST',
      body: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: INVITEES[1],
        role: 'co_owner',
      },
    });
    expect(coOwnerGrant.status).toBe(201);

    const ownerPermission = await env.DB.prepare(
      `SELECT id FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND target_id = ?
          AND grantee_type = 'user' AND grantee_id = ? AND role = 'owner'`
    )
      .bind(TENANT, folderId, ADMIN)
      .first<{ id: string }>();
    const coOwnerRevokeOwner = await call(`/api/permissions/${ownerPermission!.id}`, CO_OWNER, {
      method: 'DELETE',
    });
    expect(coOwnerRevokeOwner.status).toBe(403);

    const ownerAddsOwner = await call('/api/permissions', OWNER, {
      method: 'POST',
      body: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: INVITEES[2],
        role: 'owner',
      },
    });
    expect(ownerAddsOwner.status).toBe(201);

    // Last owner cannot be demoted or removed.
    const soloFolder = await createFolderFixture();
    const demote = await call<{ code?: string }>('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: soloFolder,
        granteeType: 'user',
        granteeId: ADMIN,
        role: 'editor',
      },
    });
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe('LAST_OWNER_LOCKOUT');

    const soloPermission = await env.DB.prepare(
      `SELECT id FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND target_id = ?
          AND role = 'owner'`
    )
      .bind(TENANT, soloFolder)
      .first<{ id: string }>();
    const lastOwnerRevoke = await call<{ code?: string }>(
      `/api/permissions/${soloPermission!.id}`,
      ADMIN,
      { method: 'DELETE', role: 'sys_admin' }
    );
    expect(lastOwnerRevoke.status).toBe(409);
    expect(lastOwnerRevoke.body.code).toBe('LAST_OWNER_LOCKOUT');
  });

  it('enforces folder override inheritance and co_owner-only policy editing', async () => {
    await setTenantInvitePolicy('editors');
    const parentId = await createFolderFixture();
    const childId = await createFolderFixture({ parentId });
    const editorChildId = await createFolderFixture({
      parentId,
      grants: [{ userId: EDITOR, role: 'editor' }],
    });

    const parentOverride = await call<{
      invitePolicy?: { effectivePolicy?: string };
    }>(`/api/folders/${parentId}`, ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { invitePolicy: 'owners' },
    });
    expect(parentOverride.status).toBe(200);
    expect(parentOverride.body.invitePolicy?.effectivePolicy).toBe('owners');

    const parentResolved = await resolveEffectiveInvitePolicy(
      env.DB,
      TENANT,
      parentId
    );
    expect(parentResolved.ownPolicy).toBe('owners');
    expect(parentResolved.effectivePolicy).toBe('owners');
    expect(parentResolved.sourceFolderId).toBe(parentId);
    expect(parentResolved.sourceFolderName).toBe(parentId);

    const relaxChild = await call<{
      code?: string;
      inheritedFloor?: string;
    }>(`/api/folders/${childId}`, ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { invitePolicy: 'editors' },
    });
    expect(relaxChild.status).toBe(409);
    expect(relaxChild.body.code).toBe('INVITE_POLICY_CANNOT_RELAX');
    expect(relaxChild.body.inheritedFloor).toBe('owners');

    const tightenOwners = await call(`/api/folders/${childId}`, ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { invitePolicy: 'owners' },
    });
    expect(tightenOwners.status).toBe(200);

    const tightenAdmins = await call<{
      invitePolicy?: { effectivePolicy?: string };
    }>(`/api/folders/${childId}`, ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { invitePolicy: 'admins' },
    });
    expect(tightenAdmins.status).toBe(200);
    expect(tightenAdmins.body.invitePolicy?.effectivePolicy).toBe('admins');

    const reset = await call<{
      invitePolicy?: { folderOwnPolicy?: string | null; effectivePolicy?: string };
    }>(`/api/folders/${childId}`, ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { invitePolicy: null },
    });
    expect(reset.status).toBe(200);
    expect(reset.body.invitePolicy?.folderOwnPolicy).toBeNull();
    expect(reset.body.invitePolicy?.effectivePolicy).toBe('owners');

    const editorDenied = await call<{ code?: string }>(
      `/api/folders/${editorChildId}`,
      EDITOR,
      { method: 'PATCH', body: { invitePolicy: 'owners' } }
    );
    expect(editorDenied.status).toBe(403);
    expect(editorDenied.body.code).toBe('MANAGE_PERMISSION_REQUIRED');

    // A stricter parent floor blocks the child from relaxing back to editors.
    const adminsParent = await createFolderFixture({ invitePolicy: 'admins' });
    const grandchild = await createFolderFixture({ parentId: adminsParent });
    const blockedGrandchild = await call<{ inheritedFloor?: string }>(
      `/api/folders/${grandchild}`,
      ADMIN,
      {
        method: 'PATCH',
        role: 'sys_admin',
        body: { invitePolicy: 'editors' },
      }
    );
    expect(blockedGrandchild.status).toBe(409);
    expect(blockedGrandchild.body.inheritedFloor).toBe('admins');

    // Direct folder overrides resolve root -> self with the strictest policy.
    const resolved = await resolveEffectiveInvitePolicy(
      env.DB,
      TENANT,
      childId
    );
    expect(resolved.tenantPolicy).toBe('editors');
    expect(resolved.parentFloor).toBe('owners');
    expect(resolved.ownPolicy).toBeNull();
    expect(resolved.effectivePolicy).toBe('owners');
    expect(resolved.sourceFolderId).toBe(parentId);
  });

  it('prefers INVITE_POLICY_RESTRICTED over waterfall locks and keeps waterfall otherwise', async () => {
    await setTenantInvitePolicy('editors');
    await setInheritanceMode('waterfall');
    try {
      const parentId = await createFolderFixture();
      const childId = await createFolderFixture({
        parentId,
        grants: [{ userId: OWNER, role: 'owner' }],
      });

      const inheritedGrant = await call('/api/permissions', ADMIN, {
        method: 'POST',
        role: 'sys_admin',
        body: {
          targetType: 'folder',
          targetId: parentId,
          granteeType: 'user',
          granteeId: INVITEES[0],
          role: 'viewer',
        },
      });
      expect(inheritedGrant.status).toBe(201);

      const waterfallLocked = await call<{ code?: string }>(
        '/api/permissions',
        ADMIN,
        {
          method: 'POST',
          role: 'sys_admin',
          body: {
            targetType: 'folder',
            targetId: childId,
            granteeType: 'user',
            granteeId: INVITEES[0],
            role: 'viewer',
          },
        }
      );
      expect(waterfallLocked.status).toBe(409);
      expect(waterfallLocked.body.code).toBe('WATERFALL_INHERITED_LOCKED');

      // Tighten the child to admins: non-sys_admin owner is now policy-blocked.
      const override = await call(`/api/folders/${childId}`, ADMIN, {
        method: 'PATCH',
        role: 'sys_admin',
        body: { invitePolicy: 'admins' },
      });
      expect(override.status).toBe(200);

      const policyFirst = await call<{ code?: string }>(
        '/api/permissions',
        OWNER,
        {
          method: 'POST',
          body: {
            targetType: 'folder',
            targetId: childId,
            granteeType: 'user',
            granteeId: INVITEES[1],
            role: 'viewer',
          },
        }
      );
      expect(policyFirst.status).toBe(403);
      expect(policyFirst.body.code).toBe('INVITE_POLICY_RESTRICTED');

      // sys_admin passes the policy gate, then waterfall blocks the inherited user.
      const sysAdminInherited = await call<{ code?: string }>(
        '/api/permissions',
        ADMIN,
        {
          method: 'POST',
          role: 'sys_admin',
          body: {
            targetType: 'folder',
            targetId: childId,
            granteeType: 'user',
            granteeId: INVITEES[0],
            role: 'viewer',
          },
        }
      );
      expect(sysAdminInherited.status).toBe(409);
      expect(sysAdminInherited.body.code).toBe('WATERFALL_INHERITED_LOCKED');
    } finally {
      await setInheritanceMode('additive');
    }
  });

  it('isolates tenants, records audits/sync, and projects dynamic capabilities', async () => {
    await setTenantInvitePolicy('editors');
    await setAdvancedRoles(false);
    const rootId = await createFolderFixture({
      grants: [{ userId: EDITOR, role: 'editor' }],
      fileId: 'inv-dynamic-file',
    });
    const childId = await createFolderFixture({ parentId: rootId });
    const otherFolder = await createFolderFixture({
      tenantId: OTHER_TENANT,
      ownerId: OUTSIDER,
    });

    // Tenant policy is visible to sys_admin/sec_admin; sec_admin is read-only.
    const policyGet = await call<{ invitePolicy?: string; policy?: { invitePolicy?: string } }>(
      '/api/admin/policies',
      SEC_ADMIN,
      { role: 'sec_admin' }
    );
    expect(policyGet.status).toBe(200);
    expect(policyGet.body.invitePolicy).toBe('editors');
    expect(policyGet.body.policy?.invitePolicy).toBe('editors');

    const secPatch = await call<{ code?: string }>('/api/admin/policies', SEC_ADMIN, {
      method: 'PATCH',
      role: 'sec_admin',
      body: { invitePolicy: 'owners' },
    });
    expect(secPatch.status).toBe(403);
    expect(secPatch.body.code).toBe('SYS_ADMIN_REQUIRED');

    // Dynamic permission.invite capability propagates to children and files.
    const children = await call<{
      capabilities?: string[];
      folders?: Array<{ id: string; capabilities?: string[] }>;
    }>(`/api/folders/${rootId}/children`, EDITOR);
    expect(children.status).toBe(200);
    expect(children.body.capabilities).toContain('permission.invite');
    const childRow = children.body.folders?.find((folder) => folder.id === childId);
    expect(childRow?.capabilities).toContain('permission.invite');

    const fileMeta = await call<{ capabilities?: string[] }>(
      '/api/files/inv-dynamic-file',
      EDITOR
    );
    expect(fileMeta.status).toBe(200);
    expect(fileMeta.body.capabilities).toContain('permission.invite');

    const permissions = await call<{
      capabilities?: string[];
      effectiveCapabilities?: string[];
      canInvite?: boolean;
      grantableRoles?: string[];
      invitePolicy?: {
        tenantPolicy: string;
        effectivePolicy: string;
        inheritedFloor: string;
        folderOwnPolicy: string | null;
      };
    }>(`/api/permissions?targetType=folder&targetId=${rootId}`, EDITOR);
    expect(permissions.status).toBe(200);
    expect(permissions.body.canInvite).toBe(true);
    expect(permissions.body.capabilities).toContain('permission.invite');
    expect(permissions.body.effectiveCapabilities).toContain('permission.invite');
    expect(permissions.body.invitePolicy?.effectivePolicy).toBe('editors');
    expect(permissions.body.grantableRoles).toEqual(
      expect.arrayContaining(['viewer', 'editor'])
    );
    expect(permissions.body.grantableRoles).not.toContain('co_owner');
    expect(permissions.body.grantableRoles).not.toContain('owner');

    // Tightening the tenant policy removes the dynamic capability immediately.
    const policyPatch = await call<{
      invitePolicy?: string;
      policy?: { invitePolicy?: string };
    }>('/api/admin/policies', ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { invitePolicy: 'owners' },
    });
    expect(policyPatch.status).toBe(200);
    expect(policyPatch.body.invitePolicy).toBe('owners');

    const childrenAfter = await call<{ capabilities?: string[] }>(
      `/api/folders/${rootId}/children`,
      EDITOR
    );
    expect(childrenAfter.body.capabilities).not.toContain('permission.invite');

    // Invitation by an editor under the restored editors policy writes audits.
    await setTenantInvitePolicy('editors');
    const folderPolicyPatch = await call(`/api/folders/${childId}`, ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { invitePolicy: 'owners' },
    });
    expect(folderPolicyPatch.status).toBe(200);
    const grant = await call('/api/permissions', EDITOR, {
      method: 'POST',
      body: {
        targetType: 'folder',
        targetId: rootId,
        granteeType: 'user',
        granteeId: INVITEES[0],
        role: 'viewer',
      },
    });
    expect(grant.status).toBe(201);

    const audits = await env.DB.prepare(
      `SELECT action, metadata_json FROM audit_logs WHERE tenant_id = ? ORDER BY created_at ASC`
    )
      .bind(TENANT)
      .all<{ action: string; metadata_json: string | null }>();
    const actions = audits.results.map((row) => row.action);
    expect(actions).toContain('admin.policy_updated');
    expect(actions).toContain('folder.invite_policy_updated');
    expect(actions).toContain('permission.grant');
    const grantAudit = audits.results.find((row) => row.action === 'permission.grant');
    expect(grantAudit?.metadata_json).toContain('permission.invite');

    const policySync = await env.DB.prepare(
      `SELECT payload_json FROM sync_changes
        WHERE tenant_id = ? AND entity_type = 'policy'
        ORDER BY seq DESC LIMIT 1`
    )
      .bind(TENANT)
      .first<{ payload_json: string }>();
    expect(policySync?.payload_json).toContain('invitePolicy');

    const folderSync = await env.DB.prepare(
      `SELECT payload_json FROM sync_changes
        WHERE tenant_id = ? AND entity_type = 'folder' AND entity_id = ?
        ORDER BY seq DESC LIMIT 1`
    )
      .bind(TENANT, childId)
      .first<{ payload_json: string }>();
    expect(folderSync?.payload_json).toContain('invitePolicy');

    const permissionSync = await env.DB.prepare(
      `SELECT payload_json FROM sync_changes
        WHERE tenant_id = ? AND entity_type = 'permission'
        ORDER BY seq DESC LIMIT 1`
    )
      .bind(TENANT)
      .first<{ payload_json: string }>();
    expect(permissionSync?.payload_json).toContain('permission.invite');

    // Cross-tenant isolation.
    const crossGrantee = await call('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: rootId,
        granteeType: 'user',
        granteeId: OUTSIDER,
        role: 'viewer',
      },
    });
    expect(crossGrantee.status).toBe(404);

    const crossTarget = await call(`/api/folders/${otherFolder}/children`, ADMIN, {
      role: 'sys_admin',
    });
    expect(crossTarget.status).toBe(404);

    const bootstrap = await call<{
      invitePolicy?: string;
      policy?: { invitePolicy?: string };
      rootFolders?: Array<{ id: string; capabilities?: string[] }>;
    }>('/api/sync/bootstrap', EDITOR);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.invitePolicy).toBe('editors');
    expect(bootstrap.body.policy?.invitePolicy).toBe('editors');
    expect(
      bootstrap.body.rootFolders?.find((folder) => folder.id === rootId)
        ?.capabilities
    ).toContain('permission.invite');
  });

  it('keeps pure policy helpers and the static role matrix unchanged', () => {
    expect(stricterInvitePolicy('editors', 'owners')).toBe('owners');
    expect(stricterInvitePolicy('admins', 'editors')).toBe('admins');
    expect(stricterInvitePolicy('owners', 'owners')).toBe('owners');

    expect(ROLE_CAPABILITIES.editor.has('permission.invite')).toBe(false);
    expect(ROLE_CAPABILITIES.co_owner.has('permission.invite')).toBe(true);

    const editorCapabilities = [...ROLE_CAPABILITIES.editor];
    const projectedOwners = computeEffectivePermissionsCapabilities(
      editorCapabilities,
      'editor',
      'owners',
      'member'
    );
    const projectedEditors = computeEffectivePermissionsCapabilities(
      editorCapabilities,
      'editor',
      'editors',
      'member'
    );
    expect(projectedOwners).not.toContain('permission.invite');
    expect(projectedEditors).toContain('permission.invite');
    expect(ROLE_CAPABILITIES.editor.has('permission.invite')).toBe(false);

    expect(
      canUserInviteByPolicy(
        'editors',
        { effectiveRole: 'editor', capabilities: editorCapabilities },
        'member'
      )
    ).toBe(true);
    expect(
      canUserInviteByPolicy(
        'owners',
        { effectiveRole: 'editor', capabilities: editorCapabilities },
        'member'
      )
    ).toBe(false);
    expect(
      canUserInviteByPolicy(
        'admins',
        { effectiveRole: 'owner', capabilities: [...ROLE_CAPABILITIES.owner] },
        'member'
      )
    ).toBe(false);
    expect(
      canUserInviteByPolicy(
        'admins',
        { effectiveRole: 'owner', capabilities: [...ROLE_CAPABILITIES.owner] },
        'sys_admin'
      )
    ).toBe(true);

    expect(
      isRoleWithinCapabilitySubset('viewer', editorCapabilities)
    ).toBe(true);
    expect(
      isRoleWithinCapabilitySubset('co_owner', editorCapabilities)
    ).toBe(false);
    expect(
      isRoleWithinCapabilitySubset('owner', editorCapabilities)
    ).toBe(false);

    const roles = grantableRolesForCaller({
      targetType: 'folder',
      callerCapabilities: editorCapabilities,
      callerRole: 'editor',
      canManage: false,
      canInvite: true,
      advancedRolesEnabled: true,
    });
    expect(roles).toEqual(
      expect.arrayContaining([
        'editor',
        'viewer',
        'previewer',
        'viewer_uploader',
        'previewer_uploader',
        'uploader',
      ])
    );
    expect(roles).not.toContain('co_owner');
    expect(roles).not.toContain('owner');

    const fileRoles = grantableRolesForCaller({
      targetType: 'file',
      callerCapabilities: editorCapabilities,
      callerRole: 'editor',
      canManage: false,
      canInvite: true,
      advancedRolesEnabled: true,
    });
    expect(fileRoles).not.toContain('uploader');
    expect(fileRoles).not.toContain('viewer_uploader');
  });
});
