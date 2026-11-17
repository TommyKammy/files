import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-fsm';
const USERS = {
  sys: 'fsm-sys',
  sec: 'fsm-sec',
  member: 'fsm-member',
  suspended: 'fsm-suspended',
  other: 'fsm-other',
} as const;
const GROUP = 'fsm-group';
const ROOT = 'fsm-root';
const SUB = 'fsm-sub';
const MODES = ['open', 'closed'] as const;
const ROLES = ['sys_admin', 'sec_admin', 'member'] as const;

type Mode = (typeof MODES)[number];
type Role = (typeof ROLES)[number];

function authHeaders(
  userId: string,
  role: Role = 'member',
  tenantId = TENANT
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@fsm.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-fsm-secret-001',
    SESSION_SECRET: 'test-session-fsm-secret-001',
  } as OidcEnv;
}

async function call(
  path: string,
  input: {
    method?: string;
    user?: string;
    role?: Role;
    body?: unknown;
    tenantId?: string;
  } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: input.method ?? 'GET',
      headers: authHeaders(
        input.user ?? USERS.sys,
        input.role ?? 'sys_admin',
        input.tenantId ?? TENANT
      ),
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    }),
    buildTestEnv()
  );
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

function userIdForRole(role: Role): string {
  return role === 'sys_admin'
    ? USERS.sys
    : role === 'sec_admin'
      ? USERS.sec
      : USERS.member;
}

function expectRootCreationDenied(body: Record<string, unknown>) {
  expect(body.code).toBe('ROOT_CREATION_ADMIN_ONLY');
  expect(String(body.error)).toContain('sys_admin');
}

async function setMode(mode: Mode): Promise<void> {
  await env.DB.prepare(
    'UPDATE tenant_policies SET folder_structure_mode = ? WHERE tenant_id = ?'
  )
    .bind(mode, TENANT)
    .run();
}

async function insertFolder(input: {
  id: string;
  parentId: string | null;
  name: string;
  deletedAt?: string | null;
  classification?: 'unset' | 'internal' | 'confidential' | 'public';
  ownerId?: string | null;
}): Promise<void> {
  const parent = input.parentId
    ? await env.DB.prepare(
        'SELECT depth FROM folders WHERE tenant_id = ? AND id = ?'
      )
        .bind(TENANT, input.parentId)
        .first<{ depth: number }>()
    : null;
  const depth = parent ? parent.depth + 1 : 0;
  await env.DB.prepare(
    `INSERT INTO folders
       (id, tenant_id, parent_id, name, depth, version, classification, is_pinned,
        created_by, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)`
  )
    .bind(
      input.id,
      TENANT,
      input.parentId,
      input.name,
      depth,
      input.classification ?? 'internal',
      input.ownerId ?? USERS.sys,
      input.deletedAt ?? null,
      input.deletedAt ? USERS.member : null
    )
    .run();

  const closures: Array<{ ancestor_id: string; depth: number }> = [];
  if (input.parentId) {
    const ancestors = await env.DB.prepare(
      `SELECT ancestor_id, depth FROM folder_closures
        WHERE tenant_id = ? AND descendant_id = ?`
    )
      .bind(TENANT, input.parentId)
      .all<{ ancestor_id: string; depth: number }>();
    closures.push(...ancestors.results);
  }
  const statements = [
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       VALUES (?, ?, ?, 0)`
    ).bind(TENANT, input.id, input.id),
    ...closures.map((ancestor) =>
      env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, ?)`
      ).bind(TENANT, ancestor.ancestor_id, input.id, ancestor.depth + 1)
    ),
  ];
  await env.DB.batch(statements);

  if (input.ownerId !== null) {
    await env.DB.prepare(
      `INSERT INTO permissions
         (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?)`
    )
      .bind(
        `perm-${input.id}-owner`,
        TENANT,
        input.id,
        input.ownerId ?? USERS.sys,
        USERS.sys
      )
      .run();
  }
}

async function insertFile(input: {
  id: string;
  folderId: string | null;
  name: string;
  deletedAt?: string | null;
  sizeBytes?: number;
  ownerId?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO files
       (id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
        upload_state, current_version_num, classification, created_by, updated_by,
        deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, 'txt', 'text/plain', ?, 'active', 1, 'internal', ?, ?, ?, ?)`
  )
    .bind(
      input.id,
      TENANT,
      input.folderId,
      input.name,
      input.sizeBytes ?? 128,
      USERS.sys,
      USERS.sys,
      input.deletedAt ?? null,
      input.deletedAt ? USERS.member : null
    )
    .run();
  if (input.ownerId !== null) {
    await env.DB.prepare(
      `INSERT INTO permissions
         (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES (?, ?, 'file', ?, 'user', ?, 'owner', ?)`
    )
      .bind(
        `perm-${input.id}-owner`,
        TENANT,
        input.id,
        input.ownerId ?? USERS.sys,
        USERS.sys
      )
      .run();
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const nowIso = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES (?, 'FSM Org', 'fsm-org', 1099511627776)"
    ).bind(TENANT),
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenant_policies (tenant_id, folder_structure_mode) VALUES (?, 'open')"
    ).bind(TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
       VALUES
         (?, ?, 'sys@fsm.example.com', 'FSM Sys', 'sys_admin', 'active'),
         (?, ?, 'sec@fsm.example.com', 'FSM Sec', 'sec_admin', 'active'),
         (?, ?, 'member@fsm.example.com', 'FSM Member', 'member', 'active'),
         (?, ?, 'suspended@fsm.example.com', 'FSM Suspended', 'member', 'suspended'),
         (?, ?, 'other@fsm.example.com', 'FSM Other', 'member', 'active')`
    ).bind(
      USERS.sys,
      TENANT,
      USERS.sec,
      TENANT,
      USERS.member,
      TENANT,
      USERS.suspended,
      TENANT,
      USERS.other,
      TENANT
    ),
    env.DB.prepare(
      'INSERT OR IGNORE INTO groups (id, tenant_id, name) VALUES (?, ?, ?)'
    ).bind(GROUP, TENANT, 'FSM Collaborators'),
    env.DB.prepare(
      'INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)'
    ).bind(GROUP, USERS.member),
    env.DB.prepare(
      `INSERT OR REPLACE INTO tenant_storage_stats
         (tenant_id, classification, file_count, total_bytes, updated_at)
       VALUES (?, 'unset', 0, 0, ?), (?, 'public', 0, 0, ?),
              (?, 'internal', 0, 0, ?), (?, 'confidential', 0, 0, ?)`
    ).bind(TENANT, nowIso, TENANT, nowIso, TENANT, nowIso, TENANT, nowIso),
  ]);

  await insertFolder({
    id: ROOT,
    parentId: null,
    name: 'FSM Shared Root',
    ownerId: USERS.member,
  });
  await insertFolder({
    id: SUB,
    parentId: ROOT,
    name: 'FSM Sub',
    ownerId: USERS.member,
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO permissions
         (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES
         ('perm-fsm-root-sec', ?, 'folder', ?, 'user', ?, 'editor', ?),
         ('perm-fsm-root-sys', ?, 'folder', ?, 'user', ?, 'editor', ?)`
    ).bind(TENANT, ROOT, USERS.sec, USERS.sys, TENANT, ROOT, USERS.sys, USERS.sys),
  ]);
  await insertFile({
    id: 'fsm-existing-file',
    folderId: SUB,
    name: 'existing.txt',
    ownerId: USERS.member,
  });

  for (const mode of MODES) {
    for (const role of ROLES) {
      const userId = userIdForRole(role);
      const suffix = `${mode}-${role}`;
      await insertFolder({
        id: `fsm-move-${suffix}`,
        parentId: SUB,
        name: `move-${suffix}`,
        ownerId: userId,
      });
      await insertFolder({
        id: `fsm-wsmove-${suffix}`,
        parentId: SUB,
        name: `wsmove-${suffix}`,
        ownerId: userId,
      });
      await insertFolder({
        id: `fsm-wscopy-${suffix}`,
        parentId: SUB,
        name: `wscopy-${suffix}`,
        ownerId: userId,
      });
      await insertFolder({
        id: `fsm-restore-folder-${suffix}`,
        parentId: SUB,
        name: `restore-folder-${suffix}`,
        deletedAt: nowIso,
        ownerId: userId,
      });
      await insertFolder({
        id: `fsm-trash-folder-${suffix}`,
        parentId: null,
        name: `trash-folder-${suffix}`,
        deletedAt: nowIso,
        ownerId: userId,
      });
      await insertFolder({
        id: `fsm-admin-trash-folder-${suffix}`,
        parentId: null,
        name: `admin-trash-folder-${suffix}`,
        deletedAt: nowIso,
        ownerId: userId,
      });
      await insertFile({
        id: `fsm-patch-file-${suffix}`,
        folderId: SUB,
        name: `patch-${suffix}.txt`,
        ownerId: userId,
      });
      await insertFile({
        id: `fsm-restore-file-${suffix}`,
        folderId: SUB,
        name: `restore-file-${suffix}.txt`,
        deletedAt: nowIso,
        ownerId: userId,
      });
    }
  }
});

describe('TOM-53 folder structure mode (open / closed)', () => {
  it('enforces ROOT_CREATION_ADMIN_ONLY across the open|closed x sys|sec|member matrix', async () => {
    for (const mode of MODES) {
      await setMode(mode);
      for (const role of ROLES) {
        const userId = userIdForRole(role);
        const allowed = mode === 'open' || role === 'sys_admin';
        const suffix = `${mode}-${role}`;

        const createRoot = await call('/api/folders', {
          method: 'POST',
          user: userId,
          role,
          body: {
            parentId: null,
            name: `matrix-root-${suffix}`,
            classification: 'internal',
          },
        });
        if (allowed) {
          expect(createRoot.status, `create ${suffix}`).toBe(201);
        } else {
          expect(createRoot.status, `create ${suffix}`).toBe(403);
          expectRootCreationDenied(createRoot.body);
        }

        const uploadInit = await call('/api/files/upload-init', {
          method: 'POST',
          user: userId,
          role,
          body: {
            folderId: null,
            fileName: `matrix-root-upload-${suffix}.txt`,
            mimeType: 'text/plain',
            sizeBytes: 32,
          },
        });
        if (allowed) {
          expect(uploadInit.status, `upload-init ${suffix}`).toBe(201);
        } else {
          expect(uploadInit.status, `upload-init ${suffix}`).toBe(403);
          expectRootCreationDenied(uploadInit.body);
        }

        const multipartInit = await call('/api/files/multipart/init', {
          method: 'POST',
          user: userId,
          role,
          body: {
            folderId: null,
            fileName: `matrix-root-multipart-${suffix}.bin`,
            mimeType: 'application/octet-stream',
            sizeBytes: 6 * 1024 * 1024,
          },
        });
        if (allowed) {
          expect(multipartInit.status, `multipart ${suffix}`).toBe(201);
        } else {
          expect(multipartInit.status, `multipart ${suffix}`).toBe(403);
          expectRootCreationDenied(multipartInit.body);
        }

        const patchFile = await call(
          `/api/files/fsm-patch-file-${suffix}`,
          {
            method: 'PATCH',
            user: userId,
            role,
            body: { folderId: null },
          }
        );
        if (allowed) {
          expect(patchFile.status, `file patch ${suffix}`).toBe(200);
        } else {
          expect(patchFile.status, `file patch ${suffix}`).toBe(403);
          expectRootCreationDenied(patchFile.body);
        }

        const moveFolder = await call(`/api/folders/fsm-move-${suffix}/move`, {
          method: 'POST',
          user: userId,
          role,
          body: { targetParentId: null },
        });
        if (allowed) {
          expect(moveFolder.status, `folder move ${suffix}`).toBe(200);
        } else {
          expect(moveFolder.status, `folder move ${suffix}`).toBe(403);
          expectRootCreationDenied(moveFolder.body);
        }

        const batchMove = await call('/api/workspace/batch-move', {
          method: 'POST',
          user: userId,
          role,
          body: {
            items: [{ type: 'folder', id: `fsm-wsmove-${suffix}` }],
            targetParentId: null,
          },
        });
        if (allowed) {
          expect(batchMove.status, `batch move ${suffix}`).toBe(200);
        } else {
          expect(batchMove.status, `batch move ${suffix}`).toBe(403);
          expectRootCreationDenied(batchMove.body);
        }

        const copy = await call('/api/workspace/copy', {
          method: 'POST',
          user: userId,
          role,
          body: {
            items: [{ type: 'folder', id: `fsm-wscopy-${suffix}` }],
            targetParentId: null,
            conflictPolicy: 'rename',
          },
        });
        if (allowed) {
          expect([201, 202], `copy ${suffix}`).toContain(copy.status);
        } else {
          expect(copy.status, `copy ${suffix}`).toBe(403);
          expectRootCreationDenied(copy.body);
        }

        const restoreFolder = await call(
          `/api/folders/fsm-restore-folder-${suffix}/restore`,
          {
            method: 'POST',
            user: userId,
            role,
            body: { targetParentId: null, conflictPolicy: 'rename' },
          }
        );
        if (allowed) {
          expect(restoreFolder.status, `folder restore ${suffix}`).toBe(200);
        } else {
          expect(restoreFolder.status, `folder restore ${suffix}`).toBe(403);
          expectRootCreationDenied(restoreFolder.body);
        }

        const restoreFile = await call(
          `/api/files/fsm-restore-file-${suffix}/restore`,
          {
            method: 'POST',
            user: userId,
            role,
            body: { targetFolderId: null, conflictPolicy: 'rename' },
          }
        );
        if (allowed) {
          expect(restoreFile.status, `file restore ${suffix}`).toBe(200);
        } else {
          expect(restoreFile.status, `file restore ${suffix}`).toBe(403);
          expectRootCreationDenied(restoreFile.body);
        }

        const trashRestore = await call('/api/trash/restore', {
          method: 'POST',
          user: userId,
          role,
          body: {
            items: [{ type: 'folder', id: `fsm-trash-folder-${suffix}` }],
            conflictPolicy: 'rename',
          },
        });
        expect(trashRestore.status, `trash restore ${suffix}`).toBe(200);
        const trashResults = trashRestore.body.results as Array<
          Record<string, unknown>
        >;
        if (allowed) {
          expect(trashResults[0]?.status, `trash item ${suffix}`).toBe(
            'succeeded'
          );
        } else {
          expect(trashResults[0]?.status, `trash item ${suffix}`).toBe('failed');
          expect(trashResults[0]?.code).toBe('ROOT_CREATION_ADMIN_ONLY');
        }

        const adminTrashRestore = await call('/api/admin/trash/restore', {
          method: 'POST',
          user: userId,
          role,
          body: {
            items: [
              { type: 'folder', id: `fsm-admin-trash-folder-${suffix}` },
            ],
            targetFolderId: null,
            conflictPolicy: 'rename',
          },
        });
        if (role === 'member') {
          expect(adminTrashRestore.status, `admin trash member ${suffix}`).toBe(
            403
          );
        } else {
          expect(adminTrashRestore.status, `admin trash ${suffix}`).toBe(200);
          const adminResults = adminTrashRestore.body.results as Array<
            Record<string, unknown>
          >;
          if (allowed) {
            expect(adminResults[0]?.status, `admin item ${suffix}`).toBe(
              'succeeded'
            );
          } else {
            expect(adminResults[0]?.status, `admin item ${suffix}`).toBe(
              'failed'
            );
            expect(adminResults[0]?.code).toBe('ROOT_CREATION_ADMIN_ONLY');
          }
        }
      }
    }
    await setMode('open');
  });

  it('switching open -> closed preserves existing roots, subfolders, files and collaborator access while blocking new root work', async () => {
    await setMode('open');
    const memberRoots = await call('/api/folders/roots?limit=100', {
      user: USERS.member,
      role: 'member',
    });
    expect(memberRoots.status).toBe(200);
    expect(
      (memberRoots.body.folders as Array<{ id: string }>).some(
        (folder) => folder.id === ROOT
      )
    ).toBe(true);

    const switchToClosed = await call('/api/admin/policies', {
      method: 'PATCH',
      user: USERS.sys,
      role: 'sys_admin',
      body: { folderStructureMode: 'closed' },
    });
    expect(switchToClosed.status).toBe(200);
    expect(switchToClosed.body.folderStructureMode).toBe('closed');
    const report = switchToClosed.body.closedModeReport as {
      totalRootFolders: number;
      missingOwnerCount: number;
      suspendedOwnerCount: number;
    };
    expect(report.totalRootFolders).toBeGreaterThanOrEqual(1);
    expect(typeof report.missingOwnerCount).toBe('number');

    const rootsAfter = await call('/api/folders/roots?limit=100', {
      user: USERS.member,
      role: 'member',
    });
    expect(rootsAfter.status).toBe(200);
    expect(
      (rootsAfter.body.folders as Array<{ id: string }>).some(
        (folder) => folder.id === ROOT
      )
    ).toBe(true);

    const childrenAfter = await call(`/api/folders/${SUB}/children`, {
      user: USERS.member,
      role: 'member',
    });
    expect(childrenAfter.status).toBe(200);
    expect(childrenAfter.body.folder).toMatchObject({ id: SUB });

    const fileAfter = await call('/api/files/fsm-existing-file', {
      user: USERS.member,
      role: 'member',
    });
    expect(fileAfter.status).toBe(200);

    const createInsideSub = await call('/api/folders', {
      method: 'POST',
      user: USERS.member,
      role: 'member',
      body: { parentId: SUB, name: 'closed-inside-sub', classification: 'internal' },
    });
    expect(createInsideSub.status).toBe(201);

    const uploadInsideSub = await call('/api/files/upload-init', {
      method: 'POST',
      user: USERS.member,
      role: 'member',
      body: {
        folderId: SUB,
        fileName: 'closed-inside-sub.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
      },
    });
    expect(uploadInsideSub.status).toBe(201);

    const secSwitch = await call('/api/admin/policies', {
      method: 'PATCH',
      user: USERS.sec,
      role: 'sec_admin',
      body: { folderStructureMode: 'open' },
    });
    expect(secSwitch.status).toBe(403);
    expect(secSwitch.body.code).toBe('SYS_ADMIN_REQUIRED');

    const invalidMode = await call('/api/admin/policies', {
      method: 'PATCH',
      user: USERS.sys,
      role: 'sys_admin',
      body: { folderStructureMode: 'hybrid' },
    });
    expect(invalidMode.status).toBe(400);

    const policyGet = await call('/api/admin/policies', {
      user: USERS.sys,
      role: 'sys_admin',
    });
    expect(policyGet.status).toBe(200);
    expect(
      (policyGet.body.policy as Record<string, unknown>).folderStructureMode
    ).toBe('closed');
    expect(policyGet.body.folderStructureMode).toBe('closed');

    const bootstrap = await call('/api/sync/bootstrap', {
      user: USERS.member,
      role: 'member',
    });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.folderStructureMode).toBe('closed');
    expect(
      (bootstrap.body.policy as Record<string, unknown>).folder_structure_mode
    ).toBe('closed');
    expect(
      (bootstrap.body.policy as Record<string, unknown>).folderStructureMode
    ).toBe('closed');

    await setMode('open');
  });

  it('keeps GET /api/admin/root-folders readable by sec_admin and rejects every mutation for sec_admin', async () => {
    await setMode('closed');
    const list = await call('/api/admin/root-folders?search=FSM', {
      user: USERS.sec,
      role: 'sec_admin',
    });
    expect(list.status).toBe(200);
    expect(
      (list.body.summary as Record<string, unknown>).folderStructureMode
    ).toBe('closed');

    const denied = await Promise.all([
      call('/api/admin/root-folders', {
        method: 'POST',
        user: USERS.sec,
        role: 'sec_admin',
        body: { name: 'Sec Denied Root', ownerUserId: USERS.member },
      }),
      call(`/api/admin/root-folders/${ROOT}/transfer-owner`, {
        method: 'POST',
        user: USERS.sec,
        role: 'sec_admin',
        body: { newOwnerUserId: USERS.other },
      }),
      call(`/api/admin/root-folders/${ROOT}/co-owners`, {
        method: 'POST',
        user: USERS.sec,
        role: 'sec_admin',
        body: { groupIds: [GROUP] },
      }),
      call(`/api/admin/root-folders/${ROOT}/archive`, {
        method: 'POST',
        user: USERS.sec,
        role: 'sec_admin',
      }),
      call(`/api/admin/root-folders/${ROOT}/restore`, {
        method: 'POST',
        user: USERS.sec,
        role: 'sec_admin',
      }),
    ]);
    for (const response of denied) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('SYS_ADMIN_REQUIRED');
    }

    const memberDenied = await call('/api/admin/root-folders', {
      user: USERS.member,
      role: 'member',
    });
    expect(memberDenied.status).toBe(403);

    await setMode('open');
  });

  it('supports admin root CRUD with owners, group co-owners, transfer guard, archive and restore', async () => {
    await setMode('closed');
    const list = await call('/api/admin/root-folders', {
      user: USERS.sys,
      role: 'sys_admin',
    });
    expect(list.status).toBe(200);
    const initialRoots = list.body.roots as Array<Record<string, unknown>>;
    const existingRoot = initialRoots.find((root) => root.id === ROOT);
    expect(existingRoot).toBeTruthy();
    expect(existingRoot?.owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ granteeId: USERS.member, status: 'active' }),
      ])
    );

    const created = await call('/api/admin/root-folders', {
      method: 'POST',
      user: USERS.sys,
      role: 'sys_admin',
      body: {
        name: 'Admin Created Root',
        classification: 'internal',
        ownerUserId: USERS.member,
        coOwnerUserIds: [USERS.sec],
        coOwnerGroupIds: [GROUP],
      },
    });
    expect(created.status).toBe(201);
    const createdRoot = created.body.root as Record<string, unknown>;
    const rootId = String(createdRoot.id);
    expect(createdRoot.owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ granteeId: USERS.member, status: 'active' }),
      ])
    );
    expect(createdRoot.coOwners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          granteeType: 'group',
          granteeId: GROUP,
        }),
        expect.objectContaining({
          granteeType: 'user',
          granteeId: USERS.sec,
        }),
      ])
    );

    const createdAudit = await env.DB.prepare(
      `SELECT action, target_id FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.root_folder.create' AND target_id = ?`
    )
      .bind(TENANT, rootId)
      .first<{ action: string; target_id: string }>();
    expect(createdAudit?.target_id).toBe(rootId);
    const createdSync = await env.DB.prepare(
      `SELECT action FROM sync_changes
        WHERE tenant_id = ? AND entity_id = ? AND action = 'folder.create'`
    )
      .bind(TENANT, rootId)
      .first<{ action: string }>();
    expect(createdSync?.action).toBe('folder.create');

    const duplicate = await call('/api/admin/root-folders', {
      method: 'POST',
      user: USERS.sys,
      role: 'sys_admin',
      body: { name: 'Admin Created Root', ownerUserId: USERS.member },
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('NAME_CONFLICT');

    const notRoot = await call(
      `/api/admin/root-folders/${SUB}/transfer-owner`,
      {
        method: 'POST',
        user: USERS.sys,
        role: 'sys_admin',
        body: { newOwnerUserId: USERS.sec },
      }
    );
    expect(notRoot.status).toBe(400);
    expect(notRoot.body.code).toBe('NOT_ROOT_FOLDER');

    // Missing owner + suspended owner detection.
    await insertFolder({
      id: 'fsm-orphan-root',
      parentId: null,
      name: 'Orphan Root',
      ownerId: null,
    });
    await insertFolder({
      id: 'fsm-suspended-root',
      parentId: null,
      name: 'Suspended Owner Root',
      ownerId: USERS.suspended,
    });
    const missingOnly = await call(
      '/api/admin/root-folders?ownerMissingOnly=1',
      { user: USERS.sys, role: 'sys_admin' }
    );
    expect(missingOnly.status).toBe(200);
    const missingRoots = missingOnly.body.roots as Array<Record<string, unknown>>;
    expect(missingRoots.some((root) => root.id === 'fsm-orphan-root')).toBe(true);
    expect(missingRoots.some((root) => root.id === ROOT)).toBe(false);

    const suspendedList = await call(
      '/api/admin/root-folders?search=Suspended%20Owner',
      { user: USERS.sys, role: 'sys_admin' }
    );
    const suspendedRoots = suspendedList.body.roots as Array<
      Record<string, unknown>
    >;
    expect(suspendedRoots.some((root) => root.hasSuspendedOwner === true)).toBe(
      true
    );

    const transfer = await call(
      `/api/admin/root-folders/${rootId}/transfer-owner`,
      {
        method: 'POST',
        user: USERS.sys,
        role: 'sys_admin',
        body: {
          newOwnerUserId: USERS.sec,
          demotePreviousOwnersTo: 'co_owner',
        },
      }
    );
    expect(transfer.status).toBe(200);
    const transferred = transfer.body.root as Record<string, unknown>;
    expect(
      (transferred.owners as Array<Record<string, unknown>>).some(
        (owner) => owner.granteeId === USERS.sec
      )
    ).toBe(true);
    expect(
      (transferred.coOwners as Array<Record<string, unknown>>).some(
        (coOwner) => coOwner.granteeId === USERS.member
      )
    ).toBe(true);

    const lastOwnerGuard = await call(
      `/api/admin/root-folders/${rootId}/transfer-owner`,
      {
        method: 'POST',
        user: USERS.sys,
        role: 'sys_admin',
        body: {
          newOwnerUserId: USERS.sec,
          demotePreviousOwnersTo: 'revoke',
        },
      }
    );
    expect(lastOwnerGuard.status).toBe(200);
    const guardedRoot = lastOwnerGuard.body.root as Record<string, unknown>;
    expect(
      (guardedRoot.owners as Array<Record<string, unknown>>).filter(
        (owner) => owner.status === 'active'
      ).length
    ).toBeGreaterThanOrEqual(1);
    expect(
      (guardedRoot.owners as Array<Record<string, unknown>>).some(
        (owner) => owner.granteeId === USERS.sec
      )
    ).toBe(true);

    const suspendedTransfer = await call(
      `/api/admin/root-folders/${rootId}/transfer-owner`,
      {
        method: 'POST',
        user: USERS.sys,
        role: 'sys_admin',
        body: { newOwnerUserId: USERS.suspended },
      }
    );
    expect(suspendedTransfer.status).toBe(400);
    expect(suspendedTransfer.body.code).toBe('SUSPENDED_USER_BLOCKED');

    const coOwnerGrant = await call(
      `/api/admin/root-folders/${rootId}/co-owners`,
      {
        method: 'POST',
        user: USERS.sys,
        role: 'sys_admin',
        body: { userIds: [USERS.sec, USERS.other], groupIds: [GROUP] },
      }
    );
    expect(coOwnerGrant.status).toBe(200);
    const coOwnerRoot = coOwnerGrant.body.root as Record<string, unknown>;
    expect(
      (coOwnerRoot.owners as Array<Record<string, unknown>>).some(
        (owner) => owner.granteeId === USERS.sec
      )
    ).toBe(true);
    expect(
      (coOwnerRoot.coOwners as Array<Record<string, unknown>>).some(
        (coOwner) =>
          coOwner.granteeType === 'group' && coOwner.granteeId === GROUP
      )
    ).toBe(true);
    expect(
      (coOwnerRoot.coOwners as Array<Record<string, unknown>>).some(
        (coOwner) => coOwner.granteeId === USERS.sec
      )
    ).toBe(false);

    const transferAudit = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.root_folder.owner_transfer' AND target_id = ?`
    )
      .bind(TENANT, rootId)
      .first<{ action: string }>();
    expect(transferAudit?.action).toBe('admin.root_folder.owner_transfer');
    const coOwnerAudit = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.root_folder.co_owner_grant' AND target_id = ?`
    )
      .bind(TENANT, rootId)
      .first<{ action: string }>();
    expect(coOwnerAudit?.action).toBe('admin.root_folder.co_owner_grant');
    const permissionSync = await env.DB.prepare(
      `SELECT action FROM sync_changes
        WHERE tenant_id = ? AND action = 'permission.grant' AND folder_id = ?`
    )
      .bind(TENANT, rootId)
      .first<{ action: string }>();
    expect(permissionSync?.action).toBe('permission.grant');

    // sys_admin intentionally has no ACL on this root; archive/restore must bypass ACL.
    await insertFile({
      id: 'fsm-admin-root-file',
      folderId: rootId,
      name: 'admin-root-file.txt',
      ownerId: USERS.sec,
      sizeBytes: 512,
    });
    const beforeMetric = await call(
      '/api/admin/root-folders?search=Admin%20Created%20Root',
      { user: USERS.sys, role: 'sys_admin' }
    );
    const metricRoot = (beforeMetric.body.roots as Array<Record<string, unknown>>)[0];
    expect(metricRoot?.itemCount).toBe(1);
    expect(metricRoot?.totalBytes).toBe(512);

    const archive = await call(`/api/admin/root-folders/${rootId}/archive`, {
      method: 'POST',
      user: USERS.sys,
      role: 'sys_admin',
    });
    expect(archive.status).toBe(200);
    const archivedRow = await env.DB.prepare(
      'SELECT deleted_at, deleted_by FROM folders WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT, rootId)
      .first<{ deleted_at: string | null; deleted_by: string | null }>();
    expect(archivedRow?.deleted_at).not.toBeNull();
    expect(archivedRow?.deleted_by).toBe(USERS.sys);
    const archiveAudit = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.root_folder.archive' AND target_id = ?`
    )
      .bind(TENANT, rootId)
      .first<{ action: string }>();
    expect(archiveAudit?.action).toBe('admin.root_folder.archive');
    const archiveSync = await env.DB.prepare(
      `SELECT action FROM sync_changes
        WHERE tenant_id = ? AND entity_id = ? AND action = 'folder.soft_delete'`
    )
      .bind(TENANT, rootId)
      .first<{ action: string }>();
    expect(archiveSync?.action).toBe('folder.soft_delete');

    const restore = await call(`/api/admin/root-folders/${rootId}/restore`, {
      method: 'POST',
      user: USERS.sys,
      role: 'sys_admin',
    });
    expect(restore.status).toBe(200);
    const restoredRoot = restore.body.root as Record<string, unknown>;
    expect(restoredRoot.deletedAt).toBeNull();
    expect(restoredRoot.owners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ granteeId: USERS.sec }),
      ])
    );
    const recheck = await env.DB.prepare(
      'SELECT deleted_at FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT, 'fsm-admin-root-file')
      .first<{ deleted_at: string | null }>();
    expect(recheck?.deleted_at).toBeNull();
    const restoreAudit = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.root_folder.restore' AND target_id = ?`
    )
      .bind(TENANT, rootId)
      .first<{ action: string }>();
    expect(restoreAudit?.action).toBe('admin.root_folder.restore');
    const restoreSync = await env.DB.prepare(
      `SELECT action FROM sync_changes
        WHERE tenant_id = ? AND entity_id = ? AND action = 'folder.restore'`
    )
      .bind(TENANT, rootId)
      .first<{ action: string }>();
    expect(restoreSync?.action).toBe('folder.restore');

    const filtered = await call(
      '/api/admin/root-folders?search=member%40fsm.example.com',
      { user: USERS.sys, role: 'sys_admin' }
    );
    expect(filtered.status).toBe(200);
    expect(
      (filtered.body.roots as Array<Record<string, unknown>>).length
    ).toBeGreaterThanOrEqual(1);

    const archivedList = await call(
      '/api/admin/root-folders?includeArchived=0',
      { user: USERS.sys, role: 'sys_admin' }
    );
    expect(
      (archivedList.body.roots as Array<Record<string, unknown>>).every(
        (root) => root.deletedAt === null
      )
    ).toBe(true);

    const lightweightList = await call(
      '/api/admin/root-folders?status=active&includeMetrics=0',
      { user: USERS.sys, role: 'sys_admin' }
    );
    expect(lightweightList.status).toBe(200);
    const lightweightRoots = lightweightList.body.roots as Array<
      Record<string, unknown>
    >;
    expect(lightweightRoots.length).toBeGreaterThanOrEqual(1);
    expect(lightweightRoots.every((r) => r.itemCount === 0 && r.totalBytes === 0)).toBe(true);

    await setMode('open');
  });
});
