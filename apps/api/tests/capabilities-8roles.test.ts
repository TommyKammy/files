import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';
import type { ResourceRole } from '../src/types/api';

const TENANT = 'tenant-cap8';
const OTHER_TENANT = 'tenant-cap8-other';

const ROLE_USERS: Record<ResourceRole, string> = {
  owner: 'cap8-owner',
  co_owner: 'cap8-coowner',
  editor: 'cap8-editor',
  viewer_uploader: 'cap8-viewer-uploader',
  previewer_uploader: 'cap8-previewer-uploader',
  viewer: 'cap8-viewer',
  previewer: 'cap8-previewer',
  uploader: 'cap8-uploader',
};

const ROLES: ResourceRole[] = [
  'owner',
  'co_owner',
  'editor',
  'viewer_uploader',
  'previewer_uploader',
  'viewer',
  'previewer',
  'uploader',
];

const ADMIN_ID = 'cap8-admin';
const OUTSIDER_ID = 'cap8-outsider';
const CROSS_TENANT_ID = 'cap8-cross';
const COMBO_ID = 'cap8-combo';
const COMBO2_ID = 'cap8-combo2';

function slug(role: ResourceRole): string {
  return role.replace(/_/g, '-');
}

function fixture(role: ResourceRole) {
  const s = slug(role);
  return {
    slug: s,
    user: ROLE_USERS[role],
    folder: `cap8-folder-${s}`,
    sub: `cap8-sub-${s}`,
    renameFolder: `cap8-ren-${s}`,
    deleteFolder: `cap8-rm-${s}`,
    moveFolder: `cap8-movesub-${s}`,
    file: `cap8-file-${s}`,
    fileName: `report-${s}.txt`,
    deleteFile: `cap8-del-${s}`,
    renameFile: `cap8-renfile-${s}`,
    moveFile: `cap8-movefile-${s}`,
    multipartFile: `cap8-mp-${s}`,
    multipartFileName: `mp-${s}.txt`,
    trashFile: `cap8-trash-${s}`,
    purgeFile: `cap8-purge-${s}`,
    version: `cap8-fv-${s}`,
    r2Key: `tenants/${TENANT}/objects/${s}/v1`,
  };
}

function devHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
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
    LOCAL_PROXY_SECRET: 'cap8-proxy-secret',
    WOPI_TOKEN_SECRET: 'cap8-wopi-secret',
    DEFAULT_TENANT_ID: TENANT,
  } as OidcEnv;
}

interface CallResult {
  status: number;
  body: Record<string, unknown>;
  res: Response;
}

async function call(
  path: string,
  userId: string,
  options: {
    method?: string;
    body?: unknown;
    role?: 'sys_admin' | 'sec_admin' | 'member';
    tenantId?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<CallResult> {
  const res = await app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...devHeaders(userId, options.role ?? 'member', options.tenantId ?? TENANT),
        ...(options.headers ?? {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    }),
    buildTestEnv()
  );
  const text = await res.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text };
    }
  }
  return { status: res.status, body, res };
}

/** Roles that hold each capability in the HTTP matrix. */
const EXPECT = {
  folderList: new Set<ResourceRole>(ROLES),
  folderCreate: new Set<ResourceRole>([
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
    'previewer_uploader',
    'uploader',
  ]),
  preview: new Set<ResourceRole>([
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
    'previewer_uploader',
    'viewer',
    'previewer',
  ]),
  download: new Set<ResourceRole>([
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
    'viewer',
  ]),
  uploadNew: new Set<ResourceRole>([
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
    'previewer_uploader',
    'uploader',
  ]),
  uploadVersion: new Set<ResourceRole>([
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
  ]),
  writeContent: new Set<ResourceRole>([
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
  ]),
  rename: new Set<ResourceRole>(['owner', 'co_owner', 'editor']),
  move: new Set<ResourceRole>(['owner', 'co_owner', 'editor']),
  delete: new Set<ResourceRole>(['owner', 'co_owner', 'editor']),
  shareCreate: new Set<ResourceRole>([
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
  ]),
  shareManage: new Set<ResourceRole>(['owner', 'co_owner', 'editor']),
  permissionView: new Set<ResourceRole>([
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
    'viewer',
  ]),
  permissionManage: new Set<ResourceRole>(['owner', 'co_owner']),
  trashRestore: new Set<ResourceRole>(['owner', 'co_owner', 'editor']),
  trashPurge: new Set<ResourceRole>(['owner', 'co_owner']),
  ownerTransfer: new Set<ResourceRole>(['owner']),
};

describe('Eight-role capability model via HTTP (TOM-52)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'Capability 8 Org', 'cap8-org', 100000000),
                (?, 'Other Capability Org', 'cap8-other', 100000000)`
      ).bind(TENANT, OTHER_TENANT),
      env.DB.prepare('INSERT INTO tenant_policies (tenant_id) VALUES (?)').bind(TENANT),
      env.DB.prepare('INSERT INTO tenant_policies (tenant_id) VALUES (?)').bind(OTHER_TENANT),
      env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           (?, ?, 'owner@cap8.example.com', 'Owner', 'member', 'active'),
           (?, ?, 'coowner@cap8.example.com', 'CoOwner', 'member', 'active'),
           (?, ?, 'editor@cap8.example.com', 'Editor', 'member', 'active'),
           (?, ?, 'viewer-uploader@cap8.example.com', 'Viewer Uploader', 'member', 'active'),
           (?, ?, 'previewer-uploader@cap8.example.com', 'Previewer Uploader', 'member', 'active'),
           (?, ?, 'viewer@cap8.example.com', 'Viewer', 'member', 'active'),
           (?, ?, 'previewer@cap8.example.com', 'Previewer', 'member', 'active'),
           (?, ?, 'uploader@cap8.example.com', 'Uploader', 'member', 'active'),
           (?, ?, 'admin@cap8.example.com', 'Admin', 'sys_admin', 'active'),
           (?, ?, 'outsider@cap8.example.com', 'Outsider', 'member', 'active'),
           (?, ?, 'combo@cap8.example.com', 'Combo', 'member', 'active'),
           (?, ?, 'combo2@cap8.example.com', 'Combo2', 'member', 'active')`
      ).bind(
        ROLE_USERS.owner, TENANT,
        ROLE_USERS.co_owner, TENANT,
        ROLE_USERS.editor, TENANT,
        ROLE_USERS.viewer_uploader, TENANT,
        ROLE_USERS.previewer_uploader, TENANT,
        ROLE_USERS.viewer, TENANT,
        ROLE_USERS.previewer, TENANT,
        ROLE_USERS.uploader, TENANT,
        ADMIN_ID, TENANT,
        OUTSIDER_ID, TENANT,
        COMBO_ID, TENANT,
        COMBO2_ID, TENANT
      ),
      env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, role, status)
         VALUES (?, ?, 'cross@cap8.example.com', 'Cross Tenant', 'member', 'active')`
      ).bind(CROSS_TENANT_ID, OTHER_TENANT),
    ];

    // Shared destination root: everyone has editor so move/copy destination
    // capability never masks the source capability under test.
    statements.push(
      env.DB.prepare(
        `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES ('cap8-dest', ?, NULL, 'Shared Destination', 0, 1, 'internal', ?)`
      ).bind(TENANT, ROLE_USERS.owner),
      env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, 'cap8-dest', 'cap8-dest', 0)`
      ).bind(TENANT)
    );

    for (const [index, role] of ROLES.entries()) {
      const f = fixture(role);
      statements.push(
        env.DB.prepare(
          `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
           VALUES (?, ?, NULL, ?, 0, 1, 'internal', ?),
                  (?, ?, ?, ?, 1, 1, 'internal', ?),
                  (?, ?, ?, ?, 1, 1, 'internal', ?),
                  (?, ?, ?, ?, 1, 1, 'internal', ?),
                  (?, ?, ?, ?, 1, 1, 'internal', ?)`
        ).bind(
          f.folder, TENANT, `Capability ${role}`, ROLE_USERS.owner,
          f.sub, TENANT, f.folder, `Sub ${role}`, ROLE_USERS.owner,
          f.renameFolder, TENANT, f.folder, `Rename ${role}`, ROLE_USERS.owner,
          f.deleteFolder, TENANT, f.folder, `Delete ${role}`, ROLE_USERS.owner,
          f.moveFolder, TENANT, f.folder, `Move ${role}`, ROLE_USERS.owner
        ),
        env.DB.prepare(
          `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
           VALUES (?, ?, ?, 0), (?, ?, ?, 0), (?, ?, ?, 1),
                  (?, ?, ?, 0), (?, ?, ?, 1),
                  (?, ?, ?, 0), (?, ?, ?, 1),
                  (?, ?, ?, 0), (?, ?, ?, 1)`
        ).bind(
          TENANT, f.folder, f.folder,
          TENANT, f.sub, f.sub,
          TENANT, f.folder, f.sub,
          TENANT, f.renameFolder, f.renameFolder,
          TENANT, f.folder, f.renameFolder,
          TENANT, f.deleteFolder, f.deleteFolder,
          TENANT, f.folder, f.deleteFolder,
          TENANT, f.moveFolder, f.moveFolder,
          TENANT, f.folder, f.moveFolder
        ),
        // Role grant on the role's own root folder.
        env.DB.prepare(
          `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
           VALUES (?, ?, 'folder', ?, 'user', ?, ?, ?)`
        ).bind(
          `cap8-p-role-${index}`,
          TENANT,
          f.folder,
          f.user,
          role,
          ROLE_USERS.owner
        ),
        // Move/copy destination editor grant for this user.
        env.DB.prepare(
          `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
           VALUES (?, ?, 'folder', 'cap8-dest', 'user', ?, 'editor', ?)`
        ).bind(`cap8-p-dest-${index}`, TENANT, f.user, ROLE_USERS.owner),
        // Active file with a completed version (WOPI / content-url / search).
        env.DB.prepare(
          `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
                              upload_state, current_version_id, current_version_num, classification,
                              created_by, updated_by)
           VALUES (?, ?, ?, ?, 'txt', 'text/plain', 11, 'active', ?, 1, 'internal', ?, ?)`
        ).bind(
          f.file,
          TENANT,
          f.folder,
          f.fileName,
          f.version,
          ROLE_USERS.owner,
          ROLE_USERS.owner
        ),
        env.DB.prepare(
          `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key,
                                      size_bytes, mime_type, upload_status, uploaded_by)
           VALUES (?, ?, ?, 1, ?, 11, 'text/plain', 'completed', ?)`
        ).bind(f.version, TENANT, f.file, f.r2Key, ROLE_USERS.owner),
        env.DB.prepare(
          `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
           VALUES (?, ?, 'internal', ?, 'txt', '')`
        ).bind(f.file, TENANT, f.fileName),
        // Extra active files for delete/rename/move, and trashed files for
        // restore/purge.
        env.DB.prepare(
          `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
                              upload_state, current_version_num, classification, created_by, updated_by,
                              deleted_at, deleted_by)
           VALUES
             (?, ?, ?, ?, 'txt', 'text/plain', 5, 'active', 1, 'internal', ?, ?, NULL, NULL),
             (?, ?, ?, ?, 'txt', 'text/plain', 5, 'active', 1, 'internal', ?, ?, NULL, NULL),
             (?, ?, ?, ?, 'txt', 'text/plain', 5, 'active', 1, 'internal', ?, ?, NULL, NULL),
             (?, ?, ?, ?, 'txt', 'text/plain', 5, 'active', 1, 'internal', ?, ?, NULL, NULL),
             (?, ?, ?, ?, 'txt', 'text/plain', 5, 'active', 1, 'internal', ?, ?, '2026-11-10T00:00:00.000Z', ?),
             (?, ?, ?, ?, 'txt', 'text/plain', 5, 'active', 1, 'internal', ?, ?, '2026-11-10T00:00:00.000Z', ?)`
        ).bind(
          f.deleteFile, TENANT, f.folder, `delete-${f.slug}.txt`, ROLE_USERS.owner, ROLE_USERS.owner,
          f.renameFile, TENANT, f.folder, `rename-${f.slug}.txt`, ROLE_USERS.owner, ROLE_USERS.owner,
          f.moveFile, TENANT, f.folder, `move-${f.slug}.txt`, ROLE_USERS.owner, ROLE_USERS.owner,
          f.multipartFile, TENANT, f.folder, f.multipartFileName, ROLE_USERS.owner, ROLE_USERS.owner,
          f.trashFile, TENANT, f.folder, `trash-${f.slug}.txt`, ROLE_USERS.owner, ROLE_USERS.owner, ROLE_USERS.owner,
          f.purgeFile, TENANT, f.folder, `purge-${f.slug}.txt`, ROLE_USERS.owner, ROLE_USERS.owner, ROLE_USERS.owner
        )
      );
    }

    // ---- Non-linear composition fixtures ---------------------------------
    // combo: viewer at parent + uploader at child (and the reverse order).
    // combo2: viewer at parent + previewer at child.
    statements.push(
      env.DB.prepare(
        `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('cap8-combo-root-a', ?, NULL, 'Combo A', 0, 1, 'internal', ?),
           ('cap8-combo-child-a', ?, 'cap8-combo-root-a', 'Combo A Child', 1, 1, 'internal', ?),
           ('cap8-combo-root-b', ?, NULL, 'Combo B', 0, 1, 'internal', ?),
           ('cap8-combo-child-b', ?, 'cap8-combo-root-b', 'Combo B Child', 1, 1, 'internal', ?),
           ('cap8-combo-root-c', ?, NULL, 'Combo C', 0, 1, 'internal', ?),
           ('cap8-combo-child-c', ?, 'cap8-combo-root-c', 'Combo C Child', 1, 1, 'internal', ?),
           ('cap8-combo-root-d', ?, NULL, 'Combo D', 0, 1, 'internal', ?),
           ('cap8-combo-child-d', ?, 'cap8-combo-root-d', 'Combo D Child', 1, 1, 'internal', ?)`
      ).bind(
        TENANT, ROLE_USERS.owner,
        TENANT, ROLE_USERS.owner,
        TENANT, ROLE_USERS.owner,
        TENANT, ROLE_USERS.owner,
        TENANT, ROLE_USERS.owner,
        TENANT, ROLE_USERS.owner,
        TENANT, ROLE_USERS.owner,
        TENANT, ROLE_USERS.owner
      ),
      env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           (?, 'cap8-combo-root-a', 'cap8-combo-root-a', 0),
           (?, 'cap8-combo-child-a', 'cap8-combo-child-a', 0),
           (?, 'cap8-combo-root-a', 'cap8-combo-child-a', 1),
           (?, 'cap8-combo-root-b', 'cap8-combo-root-b', 0),
           (?, 'cap8-combo-child-b', 'cap8-combo-child-b', 0),
           (?, 'cap8-combo-root-b', 'cap8-combo-child-b', 1),
           (?, 'cap8-combo-root-c', 'cap8-combo-root-c', 0),
           (?, 'cap8-combo-child-c', 'cap8-combo-child-c', 0),
           (?, 'cap8-combo-root-c', 'cap8-combo-child-c', 1),
           (?, 'cap8-combo-root-d', 'cap8-combo-root-d', 0),
           (?, 'cap8-combo-child-d', 'cap8-combo-child-d', 0),
           (?, 'cap8-combo-root-d', 'cap8-combo-child-d', 1)`
      ).bind(
        TENANT, TENANT, TENANT, TENANT, TENANT, TENANT,
        TENANT, TENANT, TENANT, TENANT, TENANT, TENANT
      ),
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('cap8-combo-p1', ?, 'folder', 'cap8-combo-root-a', 'user', ?, 'viewer', ?),
           ('cap8-combo-p2', ?, 'folder', 'cap8-combo-child-a', 'user', ?, 'uploader', ?),
           ('cap8-combo-p3', ?, 'folder', 'cap8-combo-root-b', 'user', ?, 'uploader', ?),
           ('cap8-combo-p4', ?, 'folder', 'cap8-combo-child-b', 'user', ?, 'viewer', ?),
           ('cap8-combo-p5', ?, 'folder', 'cap8-combo-root-c', 'user', ?, 'previewer', ?),
           ('cap8-combo-p6', ?, 'folder', 'cap8-combo-child-c', 'user', ?, 'uploader', ?),
           ('cap8-combo-p7', ?, 'folder', 'cap8-combo-root-d', 'user', ?, 'viewer', ?),
           ('cap8-combo-p8', ?, 'folder', 'cap8-combo-child-d', 'user', ?, 'previewer', ?)`
      ).bind(
        TENANT, COMBO_ID, ROLE_USERS.owner,
        TENANT, COMBO_ID, ROLE_USERS.owner,
        TENANT, COMBO_ID, ROLE_USERS.owner,
        TENANT, COMBO_ID, ROLE_USERS.owner,
        TENANT, COMBO_ID, ROLE_USERS.owner,
        TENANT, COMBO_ID, ROLE_USERS.owner,
        TENANT, COMBO2_ID, ROLE_USERS.owner,
        TENANT, COMBO2_ID, ROLE_USERS.owner
      ),
      env.DB.prepare(
        `UPDATE folders SET is_pinned = 1 WHERE id = 'cap8-combo-child-a'`
      ),
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
                            upload_state, current_version_id, current_version_num, classification,
                            created_by, updated_by)
         VALUES
           ('cap8-combo-file-a', ?, 'cap8-combo-child-a', 'combo-a.txt', 'txt', 'text/plain', 7,
            'active', 'cap8-combo-v-a', 1, 'internal', ?, ?),
           ('cap8-combo-file-c', ?, 'cap8-combo-child-c', 'combo-c.txt', 'txt', 'text/plain', 7,
            'active', 'cap8-combo-v-c', 1, 'internal', ?, ?)`
      ).bind(
        TENANT, ROLE_USERS.owner, ROLE_USERS.owner,
        TENANT, ROLE_USERS.owner, ROLE_USERS.owner
      ),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key,
                                    size_bytes, mime_type, upload_status, uploaded_by)
         VALUES
           ('cap8-combo-v-a', ?, 'cap8-combo-file-a', 1, ?, 7, 'text/plain', 'completed', ?),
           ('cap8-combo-v-c', ?, 'cap8-combo-file-c', 1, ?, 7, 'text/plain', 'completed', ?)`
      ).bind(
        TENANT, `tenants/${TENANT}/objects/combo-a/v1`, ROLE_USERS.owner,
        TENANT, `tenants/${TENANT}/objects/combo-c/v1`, ROLE_USERS.owner
      )
    );

    // One sync delta row per role file to verify uploader file-delta isolation.
    for (const [index, role] of ROLES.entries()) {
      const f = fixture(role);
      statements.push(
        env.DB.prepare(
          `INSERT INTO sync_changes (tenant_id, entity_type, entity_id, folder_id, target_user_id,
                                     action, payload_json, created_at)
           VALUES (?, 'file', ?, ?, NULL, 'file.update', ?, ?)`
        ).bind(
          TENANT,
          f.file,
          f.folder,
          JSON.stringify({ index }),
          `2026-11-16T00:00:0${index}.000Z`
        )
      );
    }

    for (let i = 0; i < statements.length; i += 40) {
      await env.DB.batch(statements.slice(i, i + 40));
    }

    for (const role of ROLES) {
      const f = fixture(role);
      await env.BUCKET.put(f.r2Key, new TextEncoder().encode('hello world'));
    }
    await env.BUCKET.put(
      `tenants/${TENANT}/objects/combo-a/v1`,
      new TextEncoder().encode('combo-a')
    );
    await env.BUCKET.put(
      `tenants/${TENANT}/objects/combo-c/v1`,
      new TextEncoder().encode('combo-c')
    );
  });

  it('defaults advanced_roles_enabled to false and rejects advanced grants', async () => {
    const policy = await call('/api/admin/policies', ADMIN_ID, { role: 'sys_admin' });
    expect(policy.status).toBe(200);
    expect(
      (policy.body.policy as { advancedRolesEnabled: boolean }).advancedRolesEnabled
    ).toBe(false);

    const disabled = await call('/api/permissions', ROLE_USERS.owner, {
      method: 'POST',
      body: {
        targetType: 'folder',
        targetId: `cap8-folder-${slug('owner')}`,
        granteeType: 'user',
        granteeId: ADMIN_ID,
        role: 'uploader',
      },
    });
    expect(disabled.status).toBe(403);
    expect(disabled.body.code).toBe('ADVANCED_ROLES_DISABLED');

    // Folder-only check wins over the policy gate.
    const fileTarget = await call('/api/permissions', ROLE_USERS.owner, {
      method: 'POST',
      body: {
        targetType: 'file',
        targetId: `cap8-file-${slug('owner')}`,
        granteeType: 'user',
        granteeId: ADMIN_ID,
        role: 'viewer_uploader',
      },
    });
    expect(fileTarget.status).toBe(400);
    expect(fileTarget.body.code).toBe('ROLE_FOLDER_ONLY');

    const invalidRole = await call('/api/permissions', ROLE_USERS.owner, {
      method: 'POST',
      body: {
        targetType: 'folder',
        targetId: `cap8-folder-${slug('owner')}`,
        granteeType: 'user',
        granteeId: ADMIN_ID,
        role: 'superuser',
      },
    });
    expect(invalidRole.status).toBe(400);
  });

  describe('after enabling advanced roles', () => {
    beforeAll(async () => {
      const updated = await call('/api/admin/policies', ADMIN_ID, {
        method: 'PATCH',
        role: 'sys_admin',
        body: { advancedRolesEnabled: true },
      });
      expect(updated.status).toBe(200);
      expect(
        (updated.body.policy as { advancedRolesEnabled: boolean }).advancedRolesEnabled
      ).toBe(true);

      const audit = await env.DB.prepare(
        `SELECT action FROM audit_logs
          WHERE tenant_id = ? AND action = 'admin.policy_updated'
          ORDER BY created_at DESC LIMIT 1`
      )
        .bind(TENANT)
        .first<{ action: string }>();
      expect(audit?.action).toBe('admin.policy_updated');
    });

    it('grants folder-only advanced roles after enabling the policy', async () => {
      const granted = await call('/api/permissions', ROLE_USERS.owner, {
        method: 'POST',
        body: {
          targetType: 'folder',
          targetId: `cap8-folder-${slug('owner')}`,
          granteeType: 'user',
          granteeId: ADMIN_ID,
          role: 'viewer_uploader',
        },
      });
      expect([200, 201]).toContain(granted.status);
      expect(
        (granted.body.permission as { role: string }).role
      ).toBe('viewer_uploader');

      const stored = await env.DB.prepare(
        `SELECT role FROM permissions
          WHERE tenant_id = ? AND grantee_id = ? AND target_type = 'folder'
            AND target_id = ?`
      )
        .bind(TENANT, ADMIN_ID, `cap8-folder-${slug('owner')}`)
        .first<{ role: string }>();
      expect(stored?.role).toBe('viewer_uploader');
    });

    it('all 8 roles can list children and receive effectiveRole + capabilities', async () => {
      for (const role of ROLES) {
        const f = fixture(role);
        const res = await call(`/api/folders/${f.folder}/children`, f.user);
        expect(res.status, `${role} folder.list`).toBe(200);
        expect(res.body.effectiveRole, `${role} effectiveRole`).toBe(role);
        expect(Array.isArray(res.body.capabilities), `${role} capabilities`).toBe(true);
        // Preview-less roles may navigate folders but get no file listing.
        expect(
          (res.body.files as unknown[]).length > 0,
          `${role} file listing visibility`
        ).toBe(role !== 'uploader');

        // Root listing also carries the composed role and capabilities.
        const roots = await call('/api/folders/roots', f.user);
        expect(roots.status, `${role} roots`).toBe(200);
        const root = (roots.body.folders as Array<Record<string, unknown>>).find(
          (folder) => folder.id === f.folder
        );
        expect(root?.effectiveRole, `${role} root role`).toBe(role);
        expect(Array.isArray(root?.capabilities), `${role} root caps`).toBe(true);

        // Bootstrap uses the same composition.
        const bootstrap = await call('/api/sync/bootstrap', f.user);
        expect(bootstrap.status, `${role} bootstrap`).toBe(200);
        const rootFolder = (
          bootstrap.body.rootFolders as Array<Record<string, unknown>>
        ).find((folder) => folder.id === f.folder);
        expect(rootFolder?.effectiveRole, `${role} bootstrap role`).toBe(role);
        expect(
          Array.isArray(rootFolder?.capabilities),
          `${role} bootstrap caps`
        ).toBe(true);

        // Breadcrumbs expose the same composed access.
        const breadcrumbs = await call(`/api/folders/${f.folder}/breadcrumbs`, f.user);
        expect(breadcrumbs.status, `${role} breadcrumbs`).toBe(200);
        expect(breadcrumbs.body.effectiveRole, `${role} breadcrumb role`).toBe(role);
        expect(
          Array.isArray(breadcrumbs.body.capabilities),
          `${role} breadcrumb caps`
        ).toBe(true);
      }
    });

    it('folder.create is limited to the documented roles', async () => {
      for (const role of ROLES) {
        const f = fixture(role);
        const res = await call('/api/folders', f.user, {
          method: 'POST',
          body: { parentId: f.folder, name: `created-${f.slug}` },
        });
        expect(res.status, `${role} folder.create`).toBe(
          EXPECT.folderCreate.has(role) ? 201 : 403
        );
      }
    });

    it('file metadata + content-url enforce item.preview / item.download', async () => {
      for (const role of ROLES) {
        const f = fixture(role);
        const meta = await call(`/api/files/${f.file}`, f.user);
        if (!EXPECT.preview.has(role)) {
          expect(meta.status, `${role} must not preview`).toBe(403);
        } else {
          expect(meta.status, `${role} preview`).toBe(200);
          expect(meta.body.effectiveRole, `${role} file role`).toBe(role);
          expect(meta.body.canDownload, `${role} canDownload`).toBe(
            EXPECT.download.has(role)
          );
          expect(Array.isArray(meta.body.capabilities)).toBe(true);
        }

        const preview = await call(
          `/api/files/${f.file}/content-url?intent=preview`,
          f.user
        );
        expect(preview.status, `${role} content preview`).toBe(
          EXPECT.preview.has(role) ? 200 : 403
        );

        const download = await call(
          `/api/files/${f.file}/content-url?intent=download`,
          f.user
        );
        expect(download.status, `${role} content download`).toBe(
          EXPECT.download.has(role) ? 200 : 403
        );

        const versions = await call(`/api/files/${f.file}/versions`, f.user);
        expect(versions.status, `${role} version list`).toBe(
          EXPECT.preview.has(role) ? 200 : 403
        );
      }
    });

    it('new uploads require item.upload_new while overwrites require item.upload_version', async () => {
      for (const role of ROLES) {
        const f = fixture(role);

        const fresh = await call('/api/files/upload-init', f.user, {
          method: 'POST',
          body: {
            folderId: f.folder,
            fileName: `new-${f.slug}.txt`,
            mimeType: 'text/plain',
            sizeBytes: 5,
          },
        });
        expect(fresh.status, `${role} upload_new`).toBe(
          EXPECT.uploadNew.has(role) ? 201 : 403
        );

        const overwrite = await call('/api/files/upload-init', f.user, {
          method: 'POST',
          body: {
            folderId: f.folder,
            fileName: f.fileName,
            mimeType: 'text/plain',
            sizeBytes: 5,
            conflictPolicy: 'new_version',
          },
        });
        expect(overwrite.status, `${role} upload_version`).toBe(
          EXPECT.uploadVersion.has(role) ? 201 : 403
        );

        // Multipart new-version init is gated by the same capability.
        const multipart = await call('/api/files/multipart/init', f.user, {
          method: 'POST',
          body: {
            folderId: f.folder,
            fileName: f.multipartFileName,
            mimeType: 'text/plain',
            sizeBytes: 6 * 1024 * 1024,
            conflictPolicy: 'new_version',
          },
        });
        if (EXPECT.uploadVersion.has(role)) {
          expect(multipart.status, `${role} multipart overwrite`).toBe(201);
        } else {
          expect(multipart.status, `${role} multipart overwrite`).toBe(403);
        }
      }

      // Full v1 flow for the new-upload-only roles: init -> R2 PUT -> complete.
      for (const role of ['uploader', 'previewer_uploader', 'viewer_uploader'] as ResourceRole[]) {
        const f = fixture(role);
        const init = await call('/api/files/upload-init', f.user, {
          method: 'POST',
          body: {
            folderId: f.folder,
            fileName: `full-flow-${f.slug}.txt`,
            mimeType: 'text/plain',
            sizeBytes: 5,
          },
        });
        expect(init.status, `${role} full flow init`).toBe(201);
        const uploadUrl = String(init.body.uploadUrl);
        const put = await app.fetch(
          new Request(`http://127.0.0.1:8787${uploadUrl}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: new TextEncoder().encode('hello'),
          }),
          buildTestEnv()
        );
        expect(put.status, `${role} full flow put`).toBe(200);
        const complete = await call('/api/files/upload-complete', f.user, {
          method: 'POST',
          body: { fileId: init.body.fileId, versionId: init.body.versionId },
        });
        expect(complete.status, `${role} full flow complete`).toBe(200);
        expect(
          (complete.body.file as { upload_state: string }).upload_state
        ).toBe('active');
      }
    });

    it('WOPI sessions, DLP and writes follow item.preview / item.edit_content', async () => {
      for (const role of ROLES) {
        const f = fixture(role);
        const session = await call(`/api/files/${f.file}/wopi-session`, f.user, {
          method: 'POST',
        });

        if (!EXPECT.preview.has(role)) {
          expect(session.status, `${role} wopi session denied`).toBe(403);
          continue;
        }
        expect(session.status, `${role} wopi session`).toBe(201);
        expect(session.body.canWrite, `${role} wopi canWrite`).toBe(
          EXPECT.writeContent.has(role)
        );
        expect(session.body.readOnly).toBe(!EXPECT.writeContent.has(role));

        const token = String(session.body.accessToken);
        const checkInfo = await app.fetch(
          new Request(
            `http://127.0.0.1:8787/wopi/files/${f.file}?access_token=${encodeURIComponent(token)}`
          ),
          buildTestEnv()
        );
        expect(checkInfo.status, `${role} CheckFileInfo`).toBe(200);
        const info = (await checkInfo.json()) as {
          UserCanWrite: boolean;
          ReadOnly: boolean;
          DisablePrint: boolean;
          DisableExport: boolean;
          DisableCopy: boolean;
        };
        expect(info.UserCanWrite, `${role} UserCanWrite`).toBe(
          EXPECT.writeContent.has(role)
        );
        const previewOnly = EXPECT.preview.has(role) && !EXPECT.download.has(role);
        expect(info.DisablePrint, `${role} DisablePrint`).toBe(previewOnly);
        expect(info.DisableExport, `${role} DisableExport`).toBe(previewOnly);
        expect(info.DisableCopy, `${role} DisableCopy`).toBe(previewOnly);

        // PutFile without write capability must be rejected as read-only.
        if (!EXPECT.writeContent.has(role)) {
          const put = await app.fetch(
            new Request(
              `http://127.0.0.1:8787/wopi/files/${f.file}/contents?access_token=${encodeURIComponent(token)}`,
              {
                method: 'POST',
                headers: { 'X-WOPI-Lock': `lock-${f.slug}` },
                body: new TextEncoder().encode('blocked'),
              }
            ),
            buildTestEnv()
          );
          expect(put.status, `${role} PutFile blocked`).toBe(403);
        }
      }

      // viewer_uploader can lock and write through WOPI (edit_content).
      const f = fixture('viewer_uploader');
      const session = await call(`/api/files/${f.file}/wopi-session`, f.user, {
        method: 'POST',
      });
      expect(session.status).toBe(201);
      expect(session.body.canWrite).toBe(true);
      const token = String(session.body.accessToken);
      const lock = await app.fetch(
        new Request(
          `http://127.0.0.1:8787/wopi/files/${f.file}?access_token=${encodeURIComponent(token)}`,
          {
            method: 'POST',
            headers: {
              'X-WOPI-Override': 'LOCK',
              'X-WOPI-Lock': 'cap8-vu-lock',
            },
          }
        ),
        buildTestEnv()
      );
      expect(lock.status).toBe(200);

      const put = await app.fetch(
        new Request(
          `http://127.0.0.1:8787/wopi/files/${f.file}/contents?access_token=${encodeURIComponent(token)}`,
          {
            method: 'POST',
            headers: { 'X-WOPI-Lock': 'cap8-vu-lock' },
            body: new TextEncoder().encode('viewer-uploader-write'),
          }
        ),
        buildTestEnv()
      );
      expect(put.status).toBe(200);
      expect(put.headers.get('X-WOPI-ItemVersion')).toBeTruthy();
    });

    it('rename / move / delete require item & folder lifecycle capabilities', async () => {
      for (const role of ROLES) {
        const f = fixture(role);
        const renameFile = await call(`/api/files/${f.renameFile}`, f.user, {
          method: 'PATCH',
          body: { name: `renamed-${f.slug}.txt` },
        });
        expect(renameFile.status, `${role} item.rename`).toBe(
          EXPECT.rename.has(role) ? 200 : 403
        );

        const moveFile = await call(`/api/files/${f.moveFile}`, f.user, {
          method: 'PATCH',
          body: { folderId: 'cap8-dest' },
        });
        expect(moveFile.status, `${role} item.move`).toBe(
          EXPECT.move.has(role) ? 200 : 403
        );

        const deleteFile = await call(`/api/files/${f.deleteFile}`, f.user, {
          method: 'DELETE',
        });
        expect(deleteFile.status, `${role} item.delete`).toBe(
          EXPECT.delete.has(role) ? 200 : 403
        );

        const renameFolder = await call(`/api/folders/${f.renameFolder}`, f.user, {
          method: 'PATCH',
          body: { name: `renamed-${f.slug}` },
        });
        expect(renameFolder.status, `${role} folder.rename`).toBe(
          EXPECT.rename.has(role) ? 200 : 403
        );

        const moveFolder = await call(`/api/folders/${f.moveFolder}/move`, f.user, {
          method: 'POST',
          body: { targetParentId: 'cap8-dest' },
        });
        expect(moveFolder.status, `${role} folder.move`).toBe(
          EXPECT.move.has(role) ? 200 : 403
        );

        const deleteFolder = await call(`/api/folders/${f.deleteFolder}`, f.user, {
          method: 'DELETE',
        });
        expect(deleteFolder.status, `${role} folder.delete`).toBe(
          EXPECT.delete.has(role) ? 200 : 403
        );
      }
    });

    it('share links separate create from manage and keep viewer_uploader links display-only', async () => {
      for (const role of ROLES) {
        const f = fixture(role);
        const created = await call('/api/shared-links', f.user, {
          method: 'POST',
          body: {
            targetType: 'folder',
            targetId: f.folder,
            accessScope: 'company_only',
          },
        });
        expect(created.status, `${role} share_link.create`).toBe(
          EXPECT.shareCreate.has(role) ? 201 : 403
        );

        const list = await call(
          `/api/shared-links?targetType=folder&targetId=${f.folder}`,
          f.user
        );
        expect(list.status, `${role} share_link.manage`).toBe(
          EXPECT.shareManage.has(role) ? 200 : 403
        );

        if (role === 'viewer_uploader' && created.status === 201) {
          const link = created.body.link as {
            canDownload: boolean;
            requireWatermark: boolean;
          };
          expect(link.canDownload).toBe(false);
          expect(link.requireWatermark).toBe(true);

          // The creator can revoke their own display-only link.
          const revoked = await call(
            `/api/shared-links/${String((created.body.link as { id: string }).id)}`,
            f.user,
            { method: 'DELETE' }
          );
          expect(revoked.status, 'viewer_uploader revoke own link').toBe(200);
        }
      }
    });

    it('permissions list/grant enforce permission.view and permission.manage', async () => {
      for (const role of ROLES) {
        const f = fixture(role);
        const list = await call(
          `/api/permissions?targetType=folder&targetId=${f.folder}`,
          f.user
        );
        expect(list.status, `${role} permission.view`).toBe(
          EXPECT.permissionView.has(role) ? 200 : 403
        );

        const grant = await call('/api/permissions', f.user, {
          method: 'POST',
          body: {
            targetType: 'folder',
            targetId: f.folder,
            granteeType: 'user',
            granteeId: OUTSIDER_ID,
            role: 'viewer',
          },
        });
        expect(grant.status, `${role} permission.manage`).toBe(
          EXPECT.permissionManage.has(role) ? 201 : 403
        );
      }
    });

    it('owner-only guards still hold (last owner, owner escalation, cross tenant)', async () => {
      const ownerFolder = `cap8-folder-${slug('owner')}`;
      const escalate = await call('/api/permissions', ROLE_USERS.co_owner, {
        method: 'POST',
        body: {
          targetType: 'folder',
          targetId: `cap8-folder-${slug('co_owner')}`,
          granteeType: 'user',
          granteeId: OUTSIDER_ID,
          role: 'owner',
        },
      });
      expect(escalate.status).toBe(403);
      expect(escalate.body.code).toBe('OWNER_ESCALATION_BLOCKED');

      const demoteLastOwner = await call('/api/permissions', ROLE_USERS.owner, {
        method: 'POST',
        body: {
          targetType: 'folder',
          targetId: ownerFolder,
          granteeType: 'user',
          granteeId: ROLE_USERS.owner,
          role: 'editor',
        },
      });
      expect(demoteLastOwner.status).toBe(409);
      expect(demoteLastOwner.body.code).toBe('LAST_OWNER_LOCKOUT');

      const crossTenant = await call(
        `/api/folders/${ownerFolder}/children`,
        CROSS_TENANT_ID,
        { tenantId: OTHER_TENANT }
      );
      expect(crossTenant.status).toBe(404);

      // owner.transfer / folder.delete_root are owner-exclusive in API output.
      const ownerMeta = await call(
        `/api/files/${fixture('owner').file}`,
        ROLE_USERS.owner
      );
      expect(ownerMeta.status).toBe(200);
      expect(ownerMeta.body.capabilities).toContain('owner.transfer');
      expect(ownerMeta.body.capabilities).toContain('folder.delete_root');

      const coOwnerMeta = await call(
        `/api/files/${fixture('co_owner').file}`,
        ROLE_USERS.co_owner
      );
      expect(coOwnerMeta.status).toBe(200);
      expect(coOwnerMeta.body.capabilities).not.toContain('owner.transfer');
      expect(coOwnerMeta.body.capabilities).not.toContain('folder.delete_root');
    });

    it('trash restore and purge require their dedicated capabilities', async () => {
      for (const role of ROLES) {
        const f = fixture(role);

        const restore = await call(`/api/files/${f.trashFile}/restore`, f.user, {
          method: 'POST',
        });
        expect(restore.status, `${role} trash.restore`).toBe(
          EXPECT.trashRestore.has(role) ? 200 : 403
        );

        const purge = await call('/api/trash/items', f.user, {
          method: 'DELETE',
          body: { items: [{ type: 'file', id: f.purgeFile }] },
        });
        expect(purge.status, `${role} trash purge request`).toBe(200);
        expect(
          purge.body.succeededCount,
          `${role} trash.purge`
        ).toBe(EXPECT.trashPurge.has(role) ? 1 : 0);
      }
    });

    it('uploader users cannot see file search hits or file sync deltas', async () => {
      for (const role of ROLES) {
        const f = fixture(role);
        const search = await call('/api/search?q=report', f.user);
        expect(search.status, `${role} search`).toBe(200);
        const ids = (search.body.results as Array<{ id: string }>).map((r) => r.id);
        expect(
          ids.includes(f.file),
          `${role} search visibility`
        ).toBe(EXPECT.preview.has(role));

        const delta = await call('/api/sync/delta?sinceSeq=0&limit=200', f.user);
        expect(delta.status, `${role} delta`).toBe(200);
        const changed = (
          delta.body.changes as Array<{ entityType: string; entityId: string }>
        ).some(
          (change) => change.entityType === 'file' && change.entityId === f.file
        );
        expect(changed, `${role} file delta visibility`).toBe(
          EXPECT.preview.has(role)
        );
      }
    });
  });

  it('composes viewer + uploader into viewer_uploader regardless of grant order', async () => {
    // Child A: viewer at parent, uploader at child.
    const childA = await call('/api/folders/cap8-combo-child-a/children', COMBO_ID);
    expect(childA.status).toBe(200);
    expect(childA.body.effectiveRole).toBe('viewer_uploader');
    const capsA = childA.body.capabilities as string[];
    for (const capability of [
      'item.preview',
      'item.download',
      'item.upload_new',
      'item.upload_version',
      'item.edit_content',
    ]) {
      expect(capsA, `child-a ${capability}`).toContain(capability);
    }

    // Child B: uploader at parent, viewer at child (reverse order).
    const childB = await call('/api/folders/cap8-combo-child-b/children', COMBO_ID);
    expect(childB.status).toBe(200);
    expect(childB.body.effectiveRole).toBe('viewer_uploader');
    expect(childB.body.capabilities).toEqual(capsA);

    // Root grants are composed on their own.
    const roots = await call('/api/folders/roots', COMBO_ID);
    expect(roots.status).toBe(200);
    const byId = new Map(
      (roots.body.folders as Array<Record<string, unknown>>).map((folder) => [
        String(folder.id),
        folder,
      ])
    );
    expect(byId.get('cap8-combo-root-a')?.effectiveRole).toBe('viewer');
    expect(byId.get('cap8-combo-root-b')?.effectiveRole).toBe('uploader');
    expect(byId.get('cap8-combo-root-c')?.effectiveRole).toBe('previewer');
    expect(byId.get('cap8-combo-root-a')?.capabilities).toContain('item.download');
    expect(
      byId.get('cap8-combo-root-b')?.capabilities as string[]
    ).not.toContain('item.preview');

    // Bootstrap pinned folder uses ancestor composition.
    const bootstrap = await call('/api/sync/bootstrap', COMBO_ID);
    expect(bootstrap.status).toBe(200);
    const pinned = (
      bootstrap.body.pinnedFolders as Array<Record<string, unknown>>
    ).find((folder) => folder.id === 'cap8-combo-child-a');
    expect(pinned?.effectiveRole).toBe('viewer_uploader');
    expect(pinned?.capabilities).toContain('item.upload_version');

    // The composed scope can actually preview/download/edit content.
    const content = await call(
      '/api/files/cap8-combo-file-a/content-url?intent=download',
      COMBO_ID
    );
    expect(content.status).toBe(200);
    const session = await call(
      '/api/files/cap8-combo-file-a/wopi-session',
      COMBO_ID,
      { method: 'POST' }
    );
    expect(session.status).toBe(201);
    expect(session.body.canWrite).toBe(true);

    // A new version upload is allowed because viewer_uploader has upload_version.
    const overwrite = await call('/api/files/upload-init', COMBO_ID, {
      method: 'POST',
      body: {
        folderId: 'cap8-combo-child-a',
        fileName: 'combo-a.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        conflictPolicy: 'new_version',
      },
    });
    expect(overwrite.status).toBe(201);
  });

  it('composes previewer + uploader into previewer_uploader (no download/version/write)', async () => {
    const childC = await call('/api/folders/cap8-combo-child-c/children', COMBO_ID);
    expect(childC.status).toBe(200);
    expect(childC.body.effectiveRole).toBe('previewer_uploader');
    const caps = childC.body.capabilities as string[];
    expect(caps).toContain('item.preview');
    expect(caps).toContain('item.upload_new');
    expect(caps).not.toContain('item.download');
    expect(caps).not.toContain('item.upload_version');
    expect(caps).not.toContain('item.edit_content');
    expect(caps).not.toContain('share_link.create');
    expect(caps).not.toContain('permission.view');

    const preview = await call(
      '/api/files/cap8-combo-file-c/content-url?intent=preview',
      COMBO_ID
    );
    expect(preview.status).toBe(200);
    const download = await call(
      '/api/files/cap8-combo-file-c/content-url?intent=download',
      COMBO_ID
    );
    expect(download.status).toBe(403);

    const session = await call(
      '/api/files/cap8-combo-file-c/wopi-session',
      COMBO_ID,
      { method: 'POST' }
    );
    expect(session.status).toBe(201);
    expect(session.body.canWrite).toBe(false);
    expect(session.body.readOnlyReason).toBe('dlp');

    const token = String(session.body.accessToken);
    const info = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/cap8-combo-file-c?access_token=${encodeURIComponent(token)}`
      ),
      buildTestEnv()
    );
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as {
      DisablePrint: boolean;
      DisableExport: boolean;
      DisableCopy: boolean;
    };
    expect(infoBody.DisablePrint).toBe(true);
    expect(infoBody.DisableExport).toBe(true);
    expect(infoBody.DisableCopy).toBe(true);

    const put = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/cap8-combo-file-c/contents?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'X-WOPI-Lock': 'combo-c-lock' },
          body: new TextEncoder().encode('blocked'),
        }
      ),
      buildTestEnv()
    );
    expect(put.status).toBe(403);

    // New upload is allowed.
    const fresh = await call('/api/files/upload-init', COMBO_ID, {
      method: 'POST',
      body: {
        folderId: 'cap8-combo-child-c',
        fileName: 'combo-c-new.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
      },
    });
    expect(fresh.status).toBe(201);

    // New version of the existing file is not.
    const overwrite = await call('/api/files/upload-init', COMBO_ID, {
      method: 'POST',
      body: {
        folderId: 'cap8-combo-child-c',
        fileName: 'combo-c.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        conflictPolicy: 'new_version',
      },
    });
    expect(overwrite.status).toBe(403);
  });

  it('composes viewer + previewer into viewer', async () => {
    const childD = await call('/api/folders/cap8-combo-child-d/children', COMBO2_ID);
    expect(childD.status).toBe(200);
    expect(childD.body.effectiveRole).toBe('viewer');
    expect(childD.body.capabilities).toContain('item.download');
    expect(childD.body.capabilities).not.toContain('item.upload_new');
  });

  it('ignores advanced direct file grants defensively', async () => {
    // The API rejects these grants; a legacy/corrupt row must not widen access.
    await env.DB.prepare(
      `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES ('cap8-defensive-file-grant', ?, 'file', ?, 'user', ?, 'uploader', ?)`
    )
      .bind(TENANT, fixture('owner').file, COMBO2_ID, ROLE_USERS.owner)
      .run();

    const stored = await env.DB.prepare(
      "SELECT role FROM permissions WHERE id = 'cap8-defensive-file-grant'"
    ).first<{ role: string }>();
    expect(stored?.role).toBe('uploader');

    const file = await call(`/api/files/${fixture('owner').file}`, COMBO2_ID);
    expect(file.status).toBe(403);
    const preview = await call(
      `/api/files/${fixture('owner').file}/content-url?intent=preview`,
      COMBO2_ID
    );
    expect(preview.status).toBe(403);
  });

  it('restricts workspace-root folder deletion to folder.delete_root (owner)', async () => {
    const editorRoot = await call(`/api/folders/${fixture('editor').folder}`, ROLE_USERS.editor, {
      method: 'DELETE',
    });
    expect(editorRoot.status).toBe(403);

    const coOwnerRoot = await call(
      `/api/folders/${fixture('co_owner').folder}`,
      ROLE_USERS.co_owner,
      { method: 'DELETE' }
    );
    expect(coOwnerRoot.status).toBe(403);

    const ownerRoot = await call(`/api/folders/${fixture('owner').folder}`, ROLE_USERS.owner, {
      method: 'DELETE',
    });
    expect(ownerRoot.status).toBe(200);
  });
});
