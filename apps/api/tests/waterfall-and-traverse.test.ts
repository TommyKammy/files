import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { buildSyncChangeStmt } from '../src/services/sync-changes';
import type { OidcEnv } from '../src/types/oidc';

function devHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member',
  tenantId: string
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

interface TreeIds {
  adminId: string;
  memberId: string;
  rootId: string;
  deptId: string;
  deepId: string;
  siblingId: string;
  deptSiblingId: string;
  deepFileId: string;
  rootSecretFileId: string;
  deptSecretFileId: string;
  siblingSecretFileId: string;
}

async function seedTree(input: {
  tenantId: string;
  prefix: string;
  rootName?: string;
  deptName?: string;
  deepName?: string;
  siblingName?: string;
  deptSiblingName?: string;
}): Promise<TreeIds> {
  const { tenantId, prefix } = input;
  const adminId = `${prefix}-admin`;
  const memberId = `${prefix}-member`;
  const rootId = `${prefix}-root`;
  const deptId = `${prefix}-dept`;
  const deepId = `${prefix}-deep`;
  const siblingId = `${prefix}-sibling`;
  const deptSiblingId = `${prefix}-dept-sibling`;
  const deepFileId = `${prefix}-deep-file`;
  const rootSecretFileId = `${prefix}-root-secret-file`;
  const deptSecretFileId = `${prefix}-dept-secret-file`;
  const siblingSecretFileId = `${prefix}-sibling-secret-file`;
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)`
    ).bind(tenantId, `${prefix} Org`, `${prefix}-org`),
    env.DB.prepare('INSERT INTO tenant_policies (tenant_id) VALUES (?)').bind(
      tenantId
    ),
    env.DB.prepare(
      `INSERT INTO users (id, tenant_id, email, display_name, role, status)
       VALUES
         (?, ?, ?, 'Admin User', 'sys_admin', 'active'),
         (?, ?, ?, 'Member User', 'member', 'active'),
         (?, ?, ?, 'Newcomer User', 'member', 'active')`
    ).bind(
      adminId,
      tenantId,
      `${adminId}@example.com`,
      memberId,
      tenantId,
      `${memberId}@example.com`,
      `${prefix}-newcomer`,
      tenantId,
      `${prefix}-newcomer@example.com`
    ),
    env.DB.prepare(
      `INSERT INTO groups (id, tenant_id, name) VALUES (?, ?, 'Waterfall Group')`
    ).bind(`${prefix}-group`, tenantId),
    env.DB.prepare(
      `INSERT INTO group_members (group_id, user_id) VALUES (?, ?)`
    ).bind(`${prefix}-group`, memberId),
    env.DB.prepare(
      `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by, updated_at)
       VALUES
         (?, ?, NULL, ?, 0, 1, 'internal', ?, ?),
         (?, ?, ?, ?, 1, 1, 'internal', ?, ?),
         (?, ?, ?, ?, 2, 1, 'internal', ?, ?),
         (?, ?, ?, ?, 1, 1, 'internal', ?, ?),
         (?, ?, ?, ?, 2, 1, 'internal', ?, ?)`
    ).bind(
      rootId,
      tenantId,
      input.rootName ?? 'Root',
      adminId,
      now,
      deptId,
      tenantId,
      rootId,
      input.deptName ?? 'DeptA',
      adminId,
      now,
      deepId,
      tenantId,
      deptId,
      input.deepName ?? 'DeepTarget',
      adminId,
      now,
      siblingId,
      tenantId,
      rootId,
      input.siblingName ?? 'SiblingFolder',
      adminId,
      now,
      deptSiblingId,
      tenantId,
      deptId,
      input.deptSiblingName ?? 'DeptASibling',
      adminId,
      now
    ),
    env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       VALUES
         (?, ?, ?, 0),
         (?, ?, ?, 0),
         (?, ?, ?, 1),
         (?, ?, ?, 0),
         (?, ?, ?, 1),
         (?, ?, ?, 2),
         (?, ?, ?, 0),
         (?, ?, ?, 1),
         (?, ?, ?, 0),
         (?, ?, ?, 1),
         (?, ?, ?, 2)`
    ).bind(
      tenantId,
      rootId,
      rootId,
      tenantId,
      deptId,
      deptId,
      tenantId,
      rootId,
      deptId,
      tenantId,
      deepId,
      deepId,
      tenantId,
      deptId,
      deepId,
      tenantId,
      rootId,
      deepId,
      tenantId,
      siblingId,
      siblingId,
      tenantId,
      rootId,
      siblingId,
      tenantId,
      deptSiblingId,
      deptSiblingId,
      tenantId,
      deptId,
      deptSiblingId,
      tenantId,
      rootId,
      deptSiblingId
    ),
    env.DB.prepare(
      `INSERT INTO files (
         id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
         upload_state, classification, created_by, updated_by, updated_at
       ) VALUES
         (?, ?, ?, 'Deep Target Report.pdf', 'pdf', 'application/pdf', 2048, 'active', 'internal', ?, ?, ?),
         (?, ?, ?, 'Root Secret.txt', 'txt', 'text/plain', 10, 'active', 'internal', ?, ?, ?),
         (?, ?, ?, 'Dept Secret.txt', 'txt', 'text/plain', 10, 'active', 'internal', ?, ?, ?),
         (?, ?, ?, 'Sibling Secret.txt', 'txt', 'text/plain', 10, 'active', 'internal', ?, ?, ?)`
    ).bind(
      deepFileId,
      tenantId,
      deepId,
      adminId,
      adminId,
      now,
      rootSecretFileId,
      tenantId,
      rootId,
      adminId,
      adminId,
      now,
      deptSecretFileId,
      tenantId,
      deptId,
      adminId,
      adminId,
      now,
      siblingSecretFileId,
      tenantId,
      siblingId,
      adminId,
      adminId,
      now
    ),
    env.DB.prepare(
      `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
       VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?)`
    ).bind(`${prefix}-perm-root-owner`, tenantId, rootId, adminId, adminId),
    env.DB.prepare(
      `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
       VALUES
         (?, ?, 'internal', 'Deep Target Report.pdf', 'pdf', NULL),
         (?, ?, 'internal', 'Root Secret.txt', 'txt', NULL),
         (?, ?, 'internal', 'Dept Secret.txt', 'txt', NULL),
         (?, ?, 'internal', 'Sibling Secret.txt', 'txt', NULL)`
    ).bind(
      deepFileId,
      tenantId,
      rootSecretFileId,
      tenantId,
      deptSecretFileId,
      tenantId,
      siblingSecretFileId,
      tenantId
    ),
  ]);

  return {
    adminId,
    memberId,
    rootId,
    deptId,
    deepId,
    siblingId,
    deptSiblingId,
    deepFileId,
    rootSecretFileId,
    deptSecretFileId,
    siblingSecretFileId,
  };
}

const PATH_TENANT = 'tenant-t54-path';
const SHARED_TENANT = 'tenant-t54-shared';
const WATERFALL_TENANT = 'tenant-t54-wf';

let pathTree: TreeIds;
let sharedTree: TreeIds;
let waterfallTree: TreeIds;

describe('TOM-54 waterfall inheritance & path-only traversal', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    pathTree = await seedTree({ tenantId: PATH_TENANT, prefix: 't54p' });
    sharedTree = await seedTree({ tenantId: SHARED_TENANT, prefix: 't54s' });
    waterfallTree = await seedTree({ tenantId: WATERFALL_TENANT, prefix: 't54w' });

    await env.DB.batch([
      // Path tenant: member sees only DeepTarget, plus one directly shared
      // root-level loose file (so the root still has a reachable file path).
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES (?, ?, 'folder', ?, 'user', ?, 'viewer', ?)`
      ).bind(
        't54p-perm-deep-member',
        PATH_TENANT,
        pathTree.deepId,
        pathTree.memberId,
        pathTree.adminId
      ),
      env.DB.prepare(
        `UPDATE folders SET is_pinned = 1 WHERE tenant_id = ? AND id = ?`
      ).bind(PATH_TENANT, pathTree.rootId),
      // Shared items tenant: direct folder + two direct files (nested, root-loose).
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           (?, ?, 'folder', ?, 'user', ?, 'viewer', ?),
           (?, ?, 'file', ?, 'user', ?, 'viewer', ?),
           (?, ?, 'file', ?, 'user', ?, 'viewer', ?)`
      ).bind(
        't54s-perm-deep-member',
        SHARED_TENANT,
        sharedTree.deepId,
        sharedTree.memberId,
        sharedTree.adminId,
        't54s-perm-file-dept',
        SHARED_TENANT,
        sharedTree.deptSecretFileId,
        sharedTree.memberId,
        sharedTree.adminId,
        't54s-perm-file-loose',
        SHARED_TENANT,
        't54s-loose-file',
        sharedTree.memberId,
        sharedTree.adminId
      ),
      env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, classification, created_by, updated_by
         ) VALUES
           (?, ?, NULL, 'Root Loose Share.txt', 'txt', 'text/plain', 20, 'active', 'internal', ?, ?),
           (?, ?, ?, 'Uploader Only.txt', 'txt', 'text/plain', 20, 'active', 'internal', ?, ?)`
      ).bind(
        't54s-loose-file',
        SHARED_TENANT,
        sharedTree.adminId,
        sharedTree.adminId,
        't54s-uploader-file',
        SHARED_TENANT,
        sharedTree.deptId,
        sharedTree.adminId,
        sharedTree.adminId
      ),
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES (?, ?, 'file', ?, 'user', ?, 'uploader', ?)`
      ).bind(
        't54s-perm-file-uploader',
        SHARED_TENANT,
        't54s-uploader-file',
        sharedTree.memberId,
        sharedTree.adminId
      ),
    ]);
  });

  it('path-only roots expose Root as path and hide the pinned quick-access entry', async () => {
    const res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders/roots?limit=50', {
        headers: devHeaders(pathTree.memberId, 'member', PATH_TENANT),
      }),
      buildTestEnv()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folders: Array<{
        id: string;
        name: string;
        accessMode: string | null;
        effectiveRole: string | null;
        capabilities: string[];
      }>;
    };
    const root = body.folders.find((folder) => folder.id === pathTree.rootId);
    expect(root).toMatchObject({
      name: 'Root',
      accessMode: 'path',
      effectiveRole: null,
      capabilities: ['folder.traverse'],
    });

    // Pinned list must never expose a path-only ancestor.
    const bootstrap = await app.fetch(
      new Request('http://127.0.0.1:8787/api/sync/bootstrap', {
        headers: devHeaders(pathTree.memberId, 'member', PATH_TENANT),
      }),
      buildTestEnv()
    );
    expect(bootstrap.status).toBe(200);
    const boot = (await bootstrap.json()) as {
      rootFolders: Array<{ id: string; accessMode: string }>;
      pinnedFolders: Array<{ id: string }>;
    };
    expect(
      boot.rootFolders.find((folder) => folder.id === pathTree.rootId)?.accessMode
    ).toBe('path');
    expect(
      boot.pinnedFolders.some((folder) => folder.id === pathTree.rootId)
    ).toBe(false);
  });

  it('path-only children reveal only the ancestor chain and never files', async () => {
    const headers = devHeaders(pathTree.memberId, 'member', PATH_TENANT);
    const testEnv = buildTestEnv();

    const rootChildren = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/${pathTree.rootId}/children?limit=50&include=breadcrumbs`,
        { headers }
      ),
      testEnv
    );
    expect(rootChildren.status).toBe(200);
    const rootBody = (await rootChildren.json()) as {
      accessMode: string;
      capabilities: string[];
      files: unknown[];
      folders: Array<{
        id: string;
        name: string;
        accessMode: string;
        effectiveRole: string | null;
        capabilities: string[];
      }>;
      breadcrumbs: Array<{ id: string; accessMode: string }>;
    };
    expect(rootBody.accessMode).toBe('path');
    expect(rootBody.capabilities).toEqual(['folder.traverse']);
    expect(rootBody.files).toEqual([]);
    expect(rootBody.folders.map((folder) => folder.name)).toEqual(['DeptA']);
    expect(rootBody.folders[0]).toMatchObject({
      accessMode: 'path',
      effectiveRole: null,
      capabilities: ['folder.traverse'],
    });
    expect(rootBody.breadcrumbs.map((crumb) => crumb.accessMode)).toEqual([
      'path',
    ]);

    const deptChildren = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/${pathTree.deptId}/children?limit=50`,
        { headers }
      ),
      testEnv
    );
    const deptBody = (await deptChildren.json()) as {
      accessMode: string;
      files: unknown[];
      folders: Array<{ id: string; name: string }>;
    };
    expect(deptBody.accessMode).toBe('path');
    expect(deptBody.files).toEqual([]);
    expect(deptBody.folders.map((folder) => folder.name)).toEqual([
      'DeepTarget',
    ]);

    const deepChildren = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/${pathTree.deepId}/children?limit=50`,
        { headers }
      ),
      testEnv
    );
    const deepBody = (await deepChildren.json()) as {
      accessMode: string;
      effectiveRole: string;
      capabilities: string[];
      files: Array<{ id: string }>;
      folders: unknown[];
    };
    expect(deepBody.accessMode).toBe('full');
    expect(deepBody.effectiveRole).toBe('viewer');
    expect(deepBody.capabilities).toContain('folder.list');
    expect(deepBody.files.map((file) => file.id)).toEqual([
      pathTree.deepFileId,
    ]);
    expect(deepBody.folders).toEqual([]);

    const breadcrumbs = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/${pathTree.deepId}/breadcrumbs`,
        { headers }
      ),
      testEnv
    );
    expect(breadcrumbs.status).toBe(200);
    const crumbBody = (await breadcrumbs.json()) as {
      accessMode: string;
      effectiveRole: string;
      breadcrumbs: Array<{ name: string; accessMode: string }>;
    };
    expect(crumbBody.accessMode).toBe('full');
    expect(crumbBody.effectiveRole).toBe('viewer');
    expect(crumbBody.breadcrumbs.map((crumb) => crumb.name)).toEqual([
      'Root',
      'DeptA',
      'DeepTarget',
    ]);
    expect(crumbBody.breadcrumbs.map((crumb) => crumb.accessMode)).toEqual([
      'path',
      'path',
      'full',
    ]);
  });

  it('path-only callers leak no ancestor/sibling metadata through search, mutations, permissions or sync deltas', async () => {
    const headers = devHeaders(pathTree.memberId, 'member', PATH_TENANT);
    const testEnv = buildTestEnv();
    const before = await env.DB.prepare(
      'SELECT MAX(seq) AS max_seq FROM sync_changes WHERE tenant_id = ?'
    )
      .bind(PATH_TENANT)
      .first<{ max_seq: number | null }>();
    const sinceSeq = before?.max_seq ?? 0;

    // Search: only the authorized deep file is returned.
    const hiddenSearch = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=Secret', { headers }),
      testEnv
    );
    expect(hiddenSearch.status).toBe(200);
    const hiddenBody = (await hiddenSearch.json()) as {
      results: Array<{ id: string }>;
    };
    expect(hiddenBody.results).toEqual([]);

    const deepSearch = await app.fetch(
      new Request('http://127.0.0.1:8787/api/search?q=Deep', { headers }),
      testEnv
    );
    const deepSearchBody = (await deepSearch.json()) as {
      results: Array<{ id: string }>;
    };
    expect(deepSearchBody.results.map((row) => row.id)).toEqual([
      pathTree.deepFileId,
    ]);

    // Mutations and permission metadata on the path-only ancestor stay forbidden.
    const createRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ parentId: pathTree.rootId, name: 'Leaked' }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(403);

    const permRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/permissions?targetType=folder&targetId=${pathTree.rootId}`,
        { headers }
      ),
      testEnv
    );
    expect(permRes.status).toBe(403);

    // Real mutations happen in Root, DeptA and SiblingFolder.
    const adminHeaders = devHeaders(pathTree.adminId, 'sys_admin', PATH_TENANT);
    const createdIds: string[] = [];
    for (const [parentId, name] of [
      [pathTree.rootId, 'Root New'],
      [pathTree.deptId, 'DeptA New'],
      [pathTree.siblingId, 'Sibling New'],
    ] as const) {
      const create = await app.fetch(
        new Request('http://127.0.0.1:8787/api/folders', {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ parentId, name }),
        }),
        testEnv
      );
      expect(create.status).toBe(201);
      const createBody = (await create.json()) as { folder: { id: string } };
      createdIds.push(createBody.folder.id);
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, classification, created_by, updated_by
         ) VALUES (?, ?, ?, 'Root Delta Secret.txt', 'txt', 'text/plain', 10, 'active', 'internal', ?, ?)`
      ).bind(
        't54p-root-delta-file',
        PATH_TENANT,
        pathTree.rootId,
        pathTree.adminId,
        pathTree.adminId
      ),
      buildSyncChangeStmt(env.DB, {
        tenantId: PATH_TENANT,
        entityType: 'file',
        entityId: 't54p-root-delta-file',
        folderId: pathTree.rootId,
        action: 'file.upload',
        payload: { name: 'Root Delta Secret.txt' },
      }),
    ]);

    const grantRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions', {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          targetType: 'folder',
          targetId: pathTree.siblingId,
          granteeType: 'user',
          granteeId: 't54p-newcomer',
          role: 'viewer',
        }),
      }),
      testEnv
    );
    expect(grantRes.status).toBe(201);

    const deltaRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/sync/delta?sinceSeq=${sinceSeq}&limit=200`,
        { headers }
      ),
      testEnv
    );
    expect(deltaRes.status).toBe(200);
    const deltaBody = (await deltaRes.json()) as {
      changes: Array<{
        entityType: string;
        entityId: string;
        folderId: string | null;
      }>;
    };
    const forbiddenFolderIds = new Set([
      pathTree.rootId,
      pathTree.deptId,
      pathTree.siblingId,
      ...createdIds,
    ]);
    const leaked = deltaBody.changes.filter((change) => {
      if (change.entityType === 'policy') return false;
      if (change.entityId === pathTree.deepId) return false;
      if (change.entityId === pathTree.deepFileId) return false;
      if (change.folderId && forbiddenFolderIds.has(change.folderId)) {
        return true;
      }
      return (
        change.entityType === 'folder' &&
        (forbiddenFolderIds.has(change.entityId) ||
          createdIds.includes(change.entityId))
      );
    });
    expect(leaked).toEqual([]);
  });

  it('shared items include directly shared folders, nested files and root-level loose files with path labels', async () => {
    const res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-items?limit=50', {
        headers: devHeaders(sharedTree.memberId, 'member', SHARED_TENANT),
      }),
      buildTestEnv()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        itemType: 'folder' | 'file';
        id: string;
        name: string;
        folderId: string | null;
        parentId: string | null;
        pathLabel: string;
        effectiveRole: string;
        capabilities: string[];
        directRoles: string[];
        breadcrumbs: Array<{ id: string; name: string }>;
        classification: string;
        grantedAt: string;
      }>;
    };

    const deep = body.items.find((item) => item.id === sharedTree.deepId);
    expect(deep).toMatchObject({
      itemType: 'folder',
      name: 'DeepTarget',
      parentId: sharedTree.deptId,
      pathLabel: 'マイファイル / Root / DeptA / DeepTarget',
      effectiveRole: 'viewer',
      directRoles: ['viewer'],
    });
    expect(deep?.breadcrumbs.map((crumb) => crumb.name)).toEqual([
      'Root',
      'DeptA',
      'DeepTarget',
    ]);
    expect(deep?.capabilities).toContain('item.preview');

    const nestedFile = body.items.find(
      (item) => item.id === sharedTree.deptSecretFileId
    );
    expect(nestedFile).toMatchObject({
      itemType: 'file',
      folderId: sharedTree.deptId,
      pathLabel: 'マイファイル / Root / DeptA',
    });

    const looseFile = body.items.find(
      (item) => item.id === 't54s-loose-file'
    );
    expect(looseFile).toMatchObject({
      itemType: 'file',
      folderId: null,
      pathLabel: 'マイファイル (ルート)',
      breadcrumbs: [],
      directRoles: ['viewer'],
    });

    // `uploader` has no item.preview and must never appear in shared items.
    expect(body.items.some((item) => item.id === 't54s-uploader-file')).toBe(
      false
    );
  });

  it('additive allows child overrides while waterfall locks inherited principals, reports conflicts and permits new principals', async () => {
    const testEnv = buildTestEnv();
    const adminHeaders = devHeaders(
      waterfallTree.adminId,
      'sys_admin',
      WATERFALL_TENANT
    );
    const secHeaders = devHeaders(
      't54w-sec',
      'sec_admin',
      WATERFALL_TENANT
    );

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, role, status)
         VALUES (?, ?, ?, 'Security Officer', 'sec_admin', 'active')`
      ).bind('t54w-sec', WATERFALL_TENANT, 't54w-sec@example.com'),
      env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, classification, created_by, updated_by
         ) VALUES
           (?, ?, ?, 'root.txt', 'txt', 'text/plain', 10, 'active', 'internal', ?, ?),
           (?, ?, ?, 'dept.txt', 'txt', 'text/plain', 10, 'active', 'internal', ?, ?)`
      ).bind(
        't54w-root-file',
        WATERFALL_TENANT,
        waterfallTree.rootId,
        waterfallTree.adminId,
        waterfallTree.adminId,
        't54w-dept-file',
        WATERFALL_TENANT,
        waterfallTree.deptId,
        waterfallTree.adminId,
        waterfallTree.adminId
      ),
    ]);

    const initialPolicy = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/policies', {
        headers: adminHeaders,
      }),
      testEnv
    );
    expect(initialPolicy.status).toBe(200);
    const initialBody = (await initialPolicy.json()) as {
      policy: {
        permission_inheritance_mode: string;
        permissionInheritanceMode: string;
      };
      permissionInheritanceMode: string;
    };
    expect(initialBody.policy).toMatchObject({
      permission_inheritance_mode: 'additive',
      permissionInheritanceMode: 'additive',
    });
    expect(initialBody.permissionInheritanceMode).toBe('additive');

    const grant = async (
      payload: Record<string, string>,
      headers: Record<string, string> = adminHeaders
    ) => {
      const response = await app.fetch(
        new Request('http://127.0.0.1:8787/api/permissions', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        }),
        testEnv
      );
      return response;
    };

    // additive: same user and same group may be granted on a descendant.
    expect(
      (
        await grant({
          targetType: 'folder',
          targetId: waterfallTree.rootId,
          granteeType: 'user',
          granteeId: waterfallTree.memberId,
          role: 'viewer',
        })
      ).status
    ).toBe(201);
    expect(
      (
        await grant({
          targetType: 'folder',
          targetId: waterfallTree.rootId,
          granteeType: 'group',
          granteeId: 't54w-group',
          role: 'viewer',
        })
      ).status
    ).toBe(201);
    expect(
      (
        await grant({
          targetType: 'folder',
          targetId: waterfallTree.deptId,
          granteeType: 'user',
          granteeId: waterfallTree.memberId,
          role: 'editor',
        })
      ).status
    ).toBe(201);
    expect(
      (
        await grant({
          targetType: 'folder',
          targetId: waterfallTree.deptId,
          granteeType: 'group',
          granteeId: 't54w-group',
          role: 'editor',
        })
      ).status
    ).toBe(201);

    // sec_admin cannot change the mode.
    const secPatch = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/policies', {
        method: 'PATCH',
        headers: secHeaders,
        body: JSON.stringify({ permissionInheritanceMode: 'waterfall' }),
      }),
      testEnv
    );
    expect(secPatch.status).toBe(403);
    const secPatchBody = (await secPatch.json()) as { code?: string };
    expect(secPatchBody.code).toBe('SYS_ADMIN_REQUIRED');

    // sys_admin switches to waterfall and receives the conflict report.
    const patch = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/policies', {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({ permissionInheritanceMode: 'waterfall' }),
      }),
      testEnv
    );
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as {
      permissionInheritanceMode: string;
      policy: { permissionInheritanceMode: string };
      inheritanceConflictReport: Array<{
        targetType: string;
        targetId: string;
        granteeType: string;
        granteeId: string;
        targetName: string;
        directRole: string;
        ancestorFolderId: string;
        ancestorFolderName: string;
        ancestorRole: string;
      }>;
    };
    expect(patchBody.permissionInheritanceMode).toBe('waterfall');
    expect(patchBody.policy.permissionInheritanceMode).toBe('waterfall');
    const userConflict = patchBody.inheritanceConflictReport.find(
      (conflict) =>
        conflict.targetType === 'folder' &&
        conflict.targetId === waterfallTree.deptId &&
        conflict.granteeType === 'user' &&
        conflict.granteeId === waterfallTree.memberId
    );
    expect(userConflict).toMatchObject({
      targetName: 'DeptA',
      directRole: 'editor',
      ancestorFolderId: waterfallTree.rootId,
      ancestorFolderName: 'Root',
      ancestorRole: 'viewer',
    });
    expect(
      patchBody.inheritanceConflictReport.some(
        (conflict) =>
          conflict.targetId === waterfallTree.deptId &&
          conflict.granteeType === 'group' &&
          conflict.granteeId === 't54w-group'
      )
    ).toBe(true);

    // sec_admin can read the conflict report anytime; members cannot.
    const secConflicts = await app.fetch(
      new Request(
        'http://127.0.0.1:8787/api/admin/policies/inheritance-conflicts',
        { headers: secHeaders }
      ),
      testEnv
    );
    expect(secConflicts.status).toBe(200);
    const secConflictsBody = (await secConflicts.json()) as {
      permissionInheritanceMode: string;
      conflicts: Array<{ targetId: string }>;
    };
    expect(secConflictsBody.permissionInheritanceMode).toBe('waterfall');
    expect(
      secConflictsBody.conflicts.some(
        (conflict) => conflict.targetId === waterfallTree.deptId
      )
    ).toBe(true);

    const memberConflicts = await app.fetch(
      new Request(
        'http://127.0.0.1:8787/api/admin/policies/inheritance-conflicts',
        {
          headers: devHeaders(
            waterfallTree.memberId,
            'member',
            WATERFALL_TENANT
          ),
        }
      ),
      testEnv
    );
    expect(memberConflicts.status).toBe(403);

    // Existing child overrides remain visible in the permission list as locked.
    const listRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/permissions?targetType=folder&targetId=${waterfallTree.deptId}`,
        {
          headers: devHeaders(
            waterfallTree.memberId,
            'member',
            WATERFALL_TENANT
          ),
        }
      ),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      permissionInheritanceMode: string;
      permissions: Array<{
        granteeType: string;
        granteeId: string;
        inherited: boolean;
        waterfallLocked: boolean;
        ancestorFolderName: string | null;
      }>;
    };
    expect(listBody.permissionInheritanceMode).toBe('waterfall');
    const memberRow = listBody.permissions.find(
      (row) =>
        row.granteeType === 'user' &&
        row.granteeId === waterfallTree.memberId &&
        !row.inherited
    );
    expect(memberRow).toMatchObject({
      waterfallLocked: true,
      ancestorFolderName: 'Root',
    });
    expect(
      listBody.permissions.find(
        (row) =>
          row.granteeType === 'group' &&
          row.granteeId === 't54w-group' &&
          row.inherited
      )?.waterfallLocked
    ).toBe(true);

    // Re-granting the same user/group on the child is locked with the ancestor.
    const userLocked = await grant({
      targetType: 'folder',
      targetId: waterfallTree.deptId,
      granteeType: 'user',
      granteeId: waterfallTree.memberId,
      role: 'viewer',
    });
    expect(userLocked.status).toBe(409);
    expect(await userLocked.json()).toMatchObject({
      code: 'WATERFALL_INHERITED_LOCKED',
      ancestorFolderId: waterfallTree.rootId,
      ancestorFolderName: 'Root',
      inheritedRole: 'viewer',
    });

    const groupLocked = await grant({
      targetType: 'folder',
      targetId: waterfallTree.deptId,
      granteeType: 'group',
      granteeId: 't54w-group',
      role: 'viewer',
    });
    expect(groupLocked.status).toBe(409);
    expect(await groupLocked.json()).toMatchObject({
      code: 'WATERFALL_INHERITED_LOCKED',
      ancestorFolderName: 'Root',
    });

    // Direct file overrides are also locked by the nearest ancestor grant.
    const fileLocked = await grant({
      targetType: 'file',
      targetId: 't54w-dept-file',
      granteeType: 'user',
      granteeId: waterfallTree.memberId,
      role: 'viewer',
    });
    expect(fileLocked.status).toBe(409);
    expect(await fileLocked.json()).toMatchObject({
      code: 'WATERFALL_INHERITED_LOCKED',
      ancestorFolderId: waterfallTree.deptId,
      ancestorFolderName: 'DeptA',
    });

    // A brand-new principal with no inherited grant still succeeds.
    const newcomerGrant = await grant({
      targetType: 'folder',
      targetId: waterfallTree.deptId,
      granteeType: 'user',
      granteeId: 't54w-newcomer',
      role: 'viewer',
    });
    expect(newcomerGrant.status).toBe(201);

    const bootstrap = await app.fetch(
      new Request('http://127.0.0.1:8787/api/sync/bootstrap', {
        headers: devHeaders(
          't54w-newcomer',
          'member',
          WATERFALL_TENANT
        ),
      }),
      testEnv
    );
    expect(bootstrap.status).toBe(200);
    const bootstrapBody = (await bootstrap.json()) as {
      policy: {
        permission_inheritance_mode: string;
        permissionInheritanceMode: string;
      };
      permissionInheritanceMode: string;
      rootFolders: Array<{ id: string; accessMode: string }>;
    };
    expect(bootstrapBody.policy).toMatchObject({
      permission_inheritance_mode: 'waterfall',
      permissionInheritanceMode: 'waterfall',
    });
    expect(bootstrapBody.permissionInheritanceMode).toBe('waterfall');
    expect(
      bootstrapBody.rootFolders.find(
        (folder) => folder.id === waterfallTree.rootId
      )?.accessMode
    ).toBe('path');
  });
});
