import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-sll';
const BASE_URL = 'http://127.0.0.1:8787';

function authHeaders(
  userId = 'sll-editor',
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
  tenantId = TENANT
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@sll.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-sll-secret-001',
    SESSION_SECRET: 'test-session-sll-secret-001',
    ...overrides,
  } as OidcEnv;
}

async function setSharePolicy(patch: {
  allowSharedLinkEdit?: boolean;
  allowPublicEditLinks?: boolean;
  allowViewerShareLinks?: boolean;
  enforceCompanyOnlyLinks?: boolean;
}): Promise<void> {
  const columns: Record<string, number> = {};
  if (patch.allowSharedLinkEdit !== undefined) {
    columns.allow_shared_link_edit = patch.allowSharedLinkEdit ? 1 : 0;
  }
  if (patch.allowPublicEditLinks !== undefined) {
    columns.allow_public_edit_links = patch.allowPublicEditLinks ? 1 : 0;
  }
  if (patch.allowViewerShareLinks !== undefined) {
    columns.allow_viewer_share_links = patch.allowViewerShareLinks ? 1 : 0;
  }
  if (patch.enforceCompanyOnlyLinks !== undefined) {
    columns.enforce_company_only_links = patch.enforceCompanyOnlyLinks ? 1 : 0;
  }
  const entries = Object.entries(columns);
  if (entries.length === 0) return;
  await env.DB.prepare(
    `UPDATE tenant_policies SET ${entries.map(([column]) => `${column} = ?`).join(', ')}
      WHERE tenant_id = ?`
  )
    .bind(...entries.map(([, value]) => value), TENANT)
    .run();
}

async function createLink(
  body: Record<string, unknown>,
  headers = authHeaders()
): Promise<{
  status: number;
  token: string;
  link: {
    id: string;
    permissionLevel: 'view' | 'download' | 'edit';
    canDownload: boolean;
    requireWatermark: boolean;
    accessScope: string;
  };
  code?: string;
}> {
  const res = await app.fetch(
    new Request(`${BASE_URL}/api/shared-links`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    testEnv
  );
  const json = (await res.json().catch(() => null)) as {
    token?: string;
    link?: {
      id: string;
      permissionLevel: 'view' | 'download' | 'edit';
      canDownload: boolean;
      requireWatermark: boolean;
      accessScope: string;
    };
    code?: string;
  } | null;
  return {
    status: res.status,
    token: json?.token ?? '',
    link: json?.link as never,
    code: json?.code,
  };
}

async function unlockTokenFor(token: string, password: string): Promise<string> {
  const res = await app.fetch(
    new Request(`${BASE_URL}/api/s/${token}/verify-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
    testEnv
  );
  expect(res.status).toBe(200);
  const json = (await res.json()) as { unlockToken?: string };
  return json.unlockToken ?? '';
}

const testEnv = buildTestEnv();

describe('TOM-56 shared-link permission levels, policies, single-use preview streams', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-sll', 'SLL Org', 'sll-org', 100000000), ('tenant-sll-other', 'SLL Other', 'sll-other', 1000000)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (
           tenant_id, enforce_company_only_links, require_watermark_confidential,
           max_link_expiration_days, allow_shared_link_edit,
           allow_public_edit_links, allow_viewer_share_links
         ) VALUES ('tenant-sll', 0, 1, 30, 0, 0, 0), ('tenant-sll-other', 0, 1, 30, 0, 0, 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('sll-editor', 'tenant-sll', 'sll-editor@sll.example.com', 'SLL Editor', 'member', 'active'),
           ('sll-viewer', 'tenant-sll', 'sll-viewer@sll.example.com', 'SLL Viewer', 'member', 'active'),
           ('sll-previewer', 'tenant-sll', 'sll-previewer@sll.example.com', 'SLL Previewer', 'member', 'active'),
           ('sll-noncollab', 'tenant-sll', 'sll-noncollab@sll.example.com', 'SLL Non Collaborator', 'member', 'active'),
           ('sll-admin', 'tenant-sll', 'sll-admin@sll.example.com', 'SLL Admin', 'sys_admin', 'active'),
           ('sll-outsider', 'tenant-sll-other', 'sll-outsider@sll.example.com', 'SLL Outsider', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES ('sll-folder', 'tenant-sll', NULL, 'SLL Docs', 0, 1, 'internal', 'sll-editor')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES ('tenant-sll', 'sll-folder', 'sll-folder', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('sll-p-editor', 'tenant-sll', 'folder', 'sll-folder', 'user', 'sll-editor', 'editor', 'sll-editor'),
           ('sll-p-viewer', 'tenant-sll', 'folder', 'sll-folder', 'user', 'sll-viewer', 'viewer', 'sll-editor'),
           ('sll-p-previewer', 'tenant-sll', 'folder', 'sll-folder', 'user', 'sll-previewer', 'previewer', 'sll-editor')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           created_by, updated_by, created_at, updated_at
         ) VALUES
           ('sll-file-internal', 'tenant-sll', 'sll-folder', 'spec.pdf', 'pdf', 'application/pdf', 10, 'active', 'sll-v-internal', 1, 'internal', 'sll-editor', 'sll-editor', ?, ?),
           ('sll-file-edit', 'tenant-sll', 'sll-folder', 'editable.pdf', 'pdf', 'application/pdf', 11, 'active', 'sll-v-edit', 1, 'internal', 'sll-editor', 'sll-editor', ?, ?),
           ('sll-file-conf', 'tenant-sll', 'sll-folder', 'secret.pdf', 'pdf', 'application/pdf', 12, 'active', 'sll-v-conf', 1, 'confidential', 'sll-editor', 'sll-editor', ?, ?)`
      ).bind(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES
           ('sll-v-internal', 'tenant-sll', 'sll-file-internal', 1, 'tenants/tenant-sll/objects/sll-file-internal/v1', 10, 'application/pdf', 'completed', 'sll-editor', ?),
           ('sll-v-edit', 'tenant-sll', 'sll-file-edit', 1, 'tenants/tenant-sll/objects/sll-file-edit/v1', 11, 'application/pdf', 'completed', 'sll-editor', ?),
           ('sll-v-conf', 'tenant-sll', 'sll-file-conf', 1, 'tenants/tenant-sll/objects/sll-file-conf/v1', 12, 'application/pdf', 'completed', 'sll-editor', ?)`
      ).bind(nowIso, nowIso, nowIso),
    ]);

    await env.BUCKET.put('tenants/tenant-sll/objects/sll-file-internal/v1', '%PDF-1.4\ninternal');
    await env.BUCKET.put('tenants/tenant-sll/objects/sll-file-edit/v1', '%PDF-1.4\neditable');
    await env.BUCKET.put('tenants/tenant-sll/objects/sll-file-conf/v1', '%PDF-1.4\nconfidential');
  });

  beforeEach(async () => {
    await setSharePolicy({
      allowSharedLinkEdit: false,
      allowPublicEditLinks: false,
      allowViewerShareLinks: false,
      enforceCompanyOnlyLinks: false,
    });
  });

  it('enforces the 3x3 permission-level x access-scope matrix', async () => {
    await setSharePolicy({
      allowSharedLinkEdit: true,
      allowPublicEditLinks: true,
    });
    const scopes = ['public', 'company_only', 'collaborators_only'] as const;
    const levels = ['view', 'download', 'edit'] as const;

    for (const accessScope of scopes) {
      for (const permissionLevel of levels) {
        const body: Record<string, unknown> = {
          targetType: 'file',
          targetId: 'sll-file-internal',
          accessScope,
          permissionLevel,
          expiresInDays: 5,
        };
        if (permissionLevel === 'edit' && accessScope === 'public') {
          body.password = 'MatrixPassword1!';
        }
        const created = await createLink(body);
        expect(created.status, `${accessScope}/${permissionLevel}`).toBe(201);
        expect(created.link.permissionLevel).toBe(permissionLevel);
        expect(created.link.canDownload).toBe(permissionLevel !== 'view');

        const anonMeta = await app.fetch(
          new Request(`${BASE_URL}/api/s/${created.token}/meta`),
          testEnv
        );
        if (accessScope === 'public') {
          expect(anonMeta.status, `anon ${permissionLevel}`).toBe(200);
          const meta = (await anonMeta.json()) as {
            permissionLevel: string;
            canDownload: boolean;
            canEdit: boolean;
            composedCapabilities: string[];
          };
          expect(meta.permissionLevel).toBe(permissionLevel);
          expect(meta.canDownload).toBe(permissionLevel !== 'view');
          expect(meta.canEdit).toBe(permissionLevel === 'edit');
          if (permissionLevel === 'edit') {
            expect(meta.composedCapabilities).toEqual(
              expect.arrayContaining([
                'item.upload_new',
                'item.upload_version',
                'item.edit_content',
              ])
            );
          }
        } else {
          expect(anonMeta.status, `anon denied ${permissionLevel}`).toBe(401);
        }

        const authenticatedUserId =
          accessScope === 'collaborators_only' ? 'sll-viewer' : 'sll-editor';
        const metaRes = await app.fetch(
          new Request(`${BASE_URL}/api/s/${created.token}/meta`, {
            headers: authHeaders(authenticatedUserId),
          }),
          testEnv
        );
        expect(
          metaRes.status,
          `auth ${accessScope}/${permissionLevel}`
        ).toBe(200);
        const meta = (await metaRes.json()) as {
          canDownload: boolean;
          canEdit: boolean;
          permissionLevel: string;
        };
        expect(meta.permissionLevel).toBe(permissionLevel);
        expect(meta.canEdit).toBe(permissionLevel === 'edit');
        // Collaborator grants union with link capabilities, so an authenticated
        // editor/viewer keeps their own download capability even on a view link.
        expect(meta.canDownload).toBe(true);

        if (accessScope === 'collaborators_only') {
          const nonCollab = await app.fetch(
            new Request(`${BASE_URL}/api/s/${created.token}/meta`, {
              headers: authHeaders('sll-noncollab'),
            }),
            testEnv
          );
          expect(nonCollab.status).toBe(403);
        }
      }
    }
  });

  it('enforces edit policy, public-edit password+expiry, confidential and viewer rules', async () => {
    await setSharePolicy({ allowSharedLinkEdit: false });
    const disabled = await createLink({
      targetType: 'file',
      targetId: 'sll-file-internal',
      accessScope: 'company_only',
      permissionLevel: 'edit',
    });
    expect(disabled.status).toBe(403);
    expect(disabled.code).toBe('SHARED_LINK_EDIT_DISABLED');

    await setSharePolicy({ allowSharedLinkEdit: true, allowPublicEditLinks: false });
    const publicDisabled = await createLink({
      targetType: 'file',
      targetId: 'sll-file-internal',
      accessScope: 'public',
      permissionLevel: 'edit',
      password: 'PublicEdit1!',
      expiresInDays: 3,
    });
    expect(publicDisabled.status).toBe(403);
    expect(publicDisabled.code).toBe('PUBLIC_EDIT_LINK_DISABLED');

    await setSharePolicy({ allowSharedLinkEdit: true, allowPublicEditLinks: true });
    const noPassword = await createLink({
      targetType: 'file',
      targetId: 'sll-file-internal',
      accessScope: 'public',
      permissionLevel: 'edit',
      expiresInDays: 3,
    });
    expect(noPassword.status).toBe(400);
    expect(noPassword.code).toBe('PUBLIC_EDIT_REQUIRES_PASSWORD_AND_EXPIRY');

    const noExpiry = await createLink({
      targetType: 'file',
      targetId: 'sll-file-internal',
      accessScope: 'public',
      permissionLevel: 'edit',
      password: 'PublicEdit1!',
    });
    expect(noExpiry.status).toBe(400);
    expect(noExpiry.code).toBe('PUBLIC_EDIT_REQUIRES_PASSWORD_AND_EXPIRY');

    const confidentialEdit = await createLink({
      targetType: 'file',
      targetId: 'sll-file-conf',
      accessScope: 'company_only',
      permissionLevel: 'edit',
    });
    expect(confidentialEdit.status).toBe(403);
    expect(confidentialEdit.code).toBe('CONFIDENTIAL_EDIT_LINK_FORBIDDEN');

    const confidentialLegacy = await createLink({
      targetType: 'file',
      targetId: 'sll-file-conf',
      accessScope: 'company_only',
      canDownload: true,
    });
    expect(confidentialLegacy.status).toBe(201);
    expect(confidentialLegacy.link.permissionLevel).toBe('view');
    expect(confidentialLegacy.link.canDownload).toBe(false);
    expect(confidentialLegacy.link.requireWatermark).toBe(true);

    await setSharePolicy({ allowViewerShareLinks: false });
    const viewerDenied = await createLink(
      {
        targetType: 'file',
        targetId: 'sll-file-internal',
        accessScope: 'company_only',
        permissionLevel: 'view',
      },
      authHeaders('sll-viewer')
    );
    expect(viewerDenied.status).toBe(403);

    await setSharePolicy({ allowViewerShareLinks: true });
    const viewerView = await createLink(
      {
        targetType: 'file',
        targetId: 'sll-file-internal',
        accessScope: 'company_only',
        permissionLevel: 'view',
      },
      authHeaders('sll-viewer')
    );
    expect(viewerView.status).toBe(201);
    expect(viewerView.link.permissionLevel).toBe('view');
    expect(viewerView.link.canDownload).toBe(false);
    expect(viewerView.link.requireWatermark).toBe(true);

    for (const permissionLevel of ['download', 'edit'] as const) {
      const denied = await createLink(
        {
          targetType: 'file',
          targetId: 'sll-file-internal',
          accessScope: 'company_only',
          permissionLevel,
        },
        authHeaders('sll-viewer')
      );
      expect(denied.status).toBe(403);
      expect(denied.code).toBe('SHARED_LINK_VIEWER_VIEW_ONLY');
    }
  });

  it('projects viewer share_link.create only when allowViewerShareLinks is enabled', async () => {
    const fetchCaps = async () => {
      const [roots, children, file, bootstrap] = await Promise.all([
        app.fetch(
          new Request(`${BASE_URL}/api/folders/roots`, {
            headers: authHeaders('sll-viewer'),
          }),
          testEnv
        ),
        app.fetch(
          new Request(`${BASE_URL}/api/folders/sll-folder/children`, {
            headers: authHeaders('sll-viewer'),
          }),
          testEnv
        ),
        app.fetch(
          new Request(`${BASE_URL}/api/files/sll-file-internal`, {
            headers: authHeaders('sll-viewer'),
          }),
          testEnv
        ),
        app.fetch(
          new Request(`${BASE_URL}/api/sync/bootstrap`, {
            headers: authHeaders('sll-viewer'),
          }),
          testEnv
        ),
      ]);
      const rootsJson = (await roots.json()) as {
        folders: Array<{ id: string; capabilities: string[] }>;
      };
      const childrenJson = (await children.json()) as {
        capabilities: string[];
        folders: Array<{ capabilities: string[] }>;
      };
      const fileJson = (await file.json()) as { capabilities: string[] };
      const bootstrapJson = (await bootstrap.json()) as {
        rootFolders: Array<{ id: string; capabilities: string[] }>;
      };
      return {
        root: rootsJson.folders.find((folder) => folder.id === 'sll-folder')
          ?.capabilities ?? [],
        children: childrenJson.capabilities,
        childFolder: childrenJson.folders[0]?.capabilities ?? [],
        file: fileJson.capabilities,
        bootstrap:
          bootstrapJson.rootFolders.find((folder) => folder.id === 'sll-folder')
            ?.capabilities ?? [],
      };
    };

    await setSharePolicy({ allowViewerShareLinks: false });
    const deniedCaps = await fetchCaps();
    expect(deniedCaps.root).not.toContain('share_link.create');
    expect(deniedCaps.children).not.toContain('share_link.create');
    expect(deniedCaps.file).not.toContain('share_link.create');
    expect(deniedCaps.bootstrap).not.toContain('share_link.create');

    await setSharePolicy({ allowViewerShareLinks: true });
    const enabledCaps = await fetchCaps();
    expect(enabledCaps.root).toContain('share_link.create');
    expect(enabledCaps.children).toContain('share_link.create');
    expect(enabledCaps.file).toContain('share_link.create');
    expect(enabledCaps.bootstrap).toContain('share_link.create');
    // Viewer must still not receive management or edit capabilities.
    for (const capabilities of Object.values(enabledCaps)) {
      expect(capabilities).not.toContain('share_link.manage');
      expect(capabilities).not.toContain('item.edit_content');
      expect(capabilities).not.toContain('permission.manage');
    }
  });

  it('updates permission levels through PATCH with audit metadata', async () => {
    await setSharePolicy({ allowSharedLinkEdit: true });
    const created = await createLink({
      targetType: 'file',
      targetId: 'sll-file-internal',
      accessScope: 'company_only',
      permissionLevel: 'view',
    });
    expect(created.status).toBe(201);

    const patch = await app.fetch(
      new Request(`${BASE_URL}/api/shared-links/${created.link.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ permissionLevel: 'download' }),
      }),
      testEnv
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as {
      link: { permissionLevel: string; canDownload: boolean };
      syncChanges: Record<string, { from: unknown; to: unknown }>;
    };
    expect(patched.link.permissionLevel).toBe('download');
    expect(patched.link.canDownload).toBe(true);
    expect(patched.syncChanges.permissionLevel).toEqual({
      from: 'view',
      to: 'download',
    });

    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_logs WHERE tenant_id = 'tenant-sll' AND action = 'shared_link.update' AND target_id = 'sll-file-internal' ORDER BY created_at DESC LIMIT 1"
    ).first<{ metadata_json: string }>();
    expect(audit).toBeTruthy();
    const metadata = JSON.parse(audit!.metadata_json) as {
      permissionLevel: string;
      sync_changes: Record<string, unknown>;
    };
    expect(metadata.permissionLevel).toBe('download');
    expect(metadata.sync_changes.permissionLevel).toEqual({
      from: 'view',
      to: 'download',
    });

    const editPatch = await app.fetch(
      new Request(`${BASE_URL}/api/shared-links/${created.link.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ permissionLevel: 'edit' }),
      }),
      testEnv
    );
    expect(editPatch.status).toBe(200);
    const editJson = (await editPatch.json()) as {
      link: { permissionLevel: string; canDownload: boolean };
    };
    expect(editJson.link.permissionLevel).toBe('edit');
    expect(editJson.link.canDownload).toBe(true);

    const unauthorized = await app.fetch(
      new Request(`${BASE_URL}/api/shared-links/${created.link.id}`, {
        method: 'PATCH',
        headers: authHeaders('sll-noncollab'),
        body: JSON.stringify({ permissionLevel: 'view' }),
      }),
      testEnv
    );
    expect(unauthorized.status).toBe(403);

    await setSharePolicy({ allowSharedLinkEdit: false });
    const policyDenied = await app.fetch(
      new Request(`${BASE_URL}/api/shared-links/${created.link.id}`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ permissionLevel: 'view' }),
      }),
      testEnv
    );
    expect(policyDenied.status).toBe(200);

    await setSharePolicy({ allowViewerShareLinks: true });
    const viewerCreated = await createLink(
      {
        targetType: 'file',
        targetId: 'sll-file-internal',
        accessScope: 'company_only',
        permissionLevel: 'view',
      },
      authHeaders('sll-viewer')
    );
    expect(viewerCreated.status).toBe(201);
    const viewerWiden = await app.fetch(
      new Request(`${BASE_URL}/api/shared-links/${viewerCreated.link.id}`, {
        method: 'PATCH',
        headers: authHeaders('sll-viewer'),
        body: JSON.stringify({ permissionLevel: 'download' }),
      }),
      testEnv
    );
    expect(viewerWiden.status).toBe(403);
    expect(((await viewerWiden.json()) as { code?: string }).code).toBe(
      'SHARED_LINK_VIEWER_VIEW_ONLY'
    );
  });

  it('unions collaborator and edit-link capabilities for upload and writable WOPI', async () => {
    await setSharePolicy({ allowSharedLinkEdit: true });
    const created = await createLink({
      targetType: 'file',
      targetId: 'sll-file-edit',
      accessScope: 'company_only',
      permissionLevel: 'edit',
    });
    expect(created.status).toBe(201);

    const metaRes = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/meta`, {
        headers: authHeaders('sll-viewer'),
      }),
      testEnv
    );
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as {
      canEdit: boolean;
      composedRole: string;
      composedCapabilities: string[];
    };
    expect(meta.canEdit).toBe(true);
    expect(meta.composedRole).toBe('viewer_uploader');
    for (const capability of [
      'folder.list',
      'folder.traverse',
      'item.preview',
      'item.download',
      'item.upload_new',
      'item.upload_version',
      'item.edit_content',
    ]) {
      expect(meta.composedCapabilities).toContain(capability);
    }
    for (const forbidden of [
      'item.rename',
      'item.move',
      'item.delete',
      'folder.rename',
      'folder.move',
      'folder.delete',
      'permission.manage',
      'share_link.manage',
      'classification.edit',
    ]) {
      expect(meta.composedCapabilities).not.toContain(forbidden);
    }

    const content = Buffer.from('%PDF-1.4\nshared link version 2');
    const initRes = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/upload-init`, {
        method: 'POST',
        headers: authHeaders('sll-viewer'),
        body: JSON.stringify({
          fileName: 'editable.pdf',
          mimeType: 'application/pdf',
          sizeBytes: content.byteLength,
          conflictPolicy: 'new_version',
        }),
      }),
      testEnv
    );
    expect(initRes.status).toBe(201);
    const init = (await initRes.json()) as {
      fileId: string;
      versionId: string;
      versionNum: number;
      uploadUrl: string;
    };
    expect(init.fileId).toBe('sll-file-edit');
    expect(init.versionNum).toBe(2);

    const putRes = await app.fetch(
      new Request(`${BASE_URL}${init.uploadUrl}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: content,
      }),
      testEnv
    );
    expect(putRes.status).toBe(200);

    const pendingRow = await env.DB.prepare(
      'SELECT id, tenant_id, file_id, version_num FROM file_versions WHERE id = ?'
    )
      .bind(init.versionId)
      .first<{ id: string; tenant_id: string; file_id: string; version_num: number }>();
    expect(pendingRow).toMatchObject({
      id: init.versionId,
      tenant_id: 'tenant-sll',
      file_id: 'sll-file-edit',
      version_num: 2,
    });

    const completeRes = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/upload-complete`, {
        method: 'POST',
        headers: authHeaders('sll-viewer'),
        body: JSON.stringify({ fileId: init.fileId, versionId: init.versionId }),
      }),
      testEnv
    );
    expect(completeRes.status).toBe(200);
    const complete = (await completeRes.json()) as {
      file: { current_version_num: number };
      version: { versionNum: number };
      permissionLevel: string;
    };
    expect(complete.permissionLevel).toBe('edit');
    expect(complete.version.versionNum).toBe(2);
    expect(complete.file.current_version_num).toBe(2);

    const audit = await env.DB.prepare(
      "SELECT metadata_json FROM audit_logs WHERE tenant_id = 'tenant-sll' AND action = 'shared_link.version_upload' AND target_id = 'sll-file-edit' ORDER BY created_at DESC LIMIT 1"
    ).first<{ metadata_json: string }>();
    expect(audit).toBeTruthy();
    const metadata = JSON.parse(audit!.metadata_json) as {
      linkId: string;
      permissionLevel: string;
      versionNum: number;
    };
    expect(metadata).toMatchObject({
      linkId: created.link.id,
      permissionLevel: 'edit',
      versionNum: 2,
    });

    const wopiRes = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/wopi-session`, {
        method: 'POST',
        headers: authHeaders('sll-viewer'),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(wopiRes.status).toBe(201);
    const wopi = (await wopiRes.json()) as {
      canWrite: boolean;
      readOnly: boolean;
      permissionLevel: string;
    };
    expect(wopi.permissionLevel).toBe('edit');
    expect(wopi.canWrite).toBe(true);
    expect(wopi.readOnly).toBe(false);

    // A view link must never create a writable WOPI session even for an editor.
    const viewLink = await createLink({
      targetType: 'file',
      targetId: 'sll-file-edit',
      accessScope: 'company_only',
      permissionLevel: 'view',
    });
    const viewWopi = await app.fetch(
      new Request(`${BASE_URL}/api/s/${viewLink.token}/wopi-session`, {
        method: 'POST',
        headers: authHeaders('sll-editor'),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(viewWopi.status).toBe(201);
    const viewWopiJson = (await viewWopi.json()) as { canWrite: boolean };
    expect(viewWopiJson.canWrite).toBe(false);
  });

  it('blocks edit-link writes while a desktop_exclusive lock is held', async () => {
    await setSharePolicy({ allowSharedLinkEdit: true });
    const created = await createLink({
      targetType: 'file',
      targetId: 'sll-file-edit',
      accessScope: 'company_only',
      permissionLevel: 'edit',
    });
    expect(created.status).toBe(201);

    const lockRes = await app.fetch(
      new Request(`${BASE_URL}/api/files/sll-file-edit/lock`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'sll-lock-1', ttlSeconds: 120 }),
      }),
      testEnv
    );
    expect(lockRes.status).toBe(201);

    const blockedRes = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/upload-init`, {
        method: 'POST',
        headers: authHeaders('sll-viewer'),
        body: JSON.stringify({
          fileName: 'editable.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 33,
          conflictPolicy: 'new_version',
        }),
      }),
      testEnv
    );
    expect(blockedRes.status).toBe(409);
    expect(((await blockedRes.json()) as { code?: string }).code).toBe(
      'FILE_LOCKED'
    );

    const unlockRes = await app.fetch(
      new Request(`${BASE_URL}/api/files/sll-file-edit/lock`, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'sll-lock-1' }),
      }),
      testEnv
    );
    expect(unlockRes.status).toBe(200);
  });

  it('blocks anonymous writes on a public edit link unless policy explicitly allows them', async () => {
    await setSharePolicy({
      allowSharedLinkEdit: true,
      allowPublicEditLinks: true,
    });
    const created = await createLink({
      targetType: 'file',
      targetId: 'sll-file-edit',
      accessScope: 'public',
      permissionLevel: 'edit',
      password: 'SharedEditPass1!',
      expiresInDays: 4,
    });
    expect(created.status).toBe(201);
    const unlockToken = await unlockTokenFor(created.token, 'SharedEditPass1!');

    const anonMeta = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/meta`),
      testEnv
    );
    expect(anonMeta.status).toBe(200);
    const anonMetaJson = (await anonMeta.json()) as {
      canEdit: boolean;
      requiresAuthForEdit: boolean;
    };
    expect(anonMetaJson.canEdit).toBe(true);
    expect(anonMetaJson.requiresAuthForEdit).toBe(false);

    await setSharePolicy({ allowPublicEditLinks: false });
    const blocked = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/upload-init`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Share-Unlock': unlockToken,
        },
        body: JSON.stringify({
          fileName: 'editable.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 10,
          conflictPolicy: 'new_version',
        }),
      }),
      testEnv
    );
    expect(blocked.status).toBe(401);
    expect(((await blocked.json()) as { code?: string }).code).toBe(
      'AUTH_REQUIRED_FOR_EDIT'
    );

    const anonMetaAfter = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/meta`),
      testEnv
    );
    const anonMetaAfterJson = (await anonMetaAfter.json()) as {
      canEdit: boolean;
      requiresAuthForEdit: boolean;
    };
    expect(anonMetaAfterJson.canEdit).toBe(false);
    expect(anonMetaAfterJson.requiresAuthForEdit).toBe(true);
  });

  it('serves preview-only URLs as single-use Worker streams with DLP headers', async () => {
    const viewLink = await createLink({
      targetType: 'file',
      targetId: 'sll-file-internal',
      accessScope: 'public',
      permissionLevel: 'view',
    });
    expect(viewLink.status).toBe(201);

    const previewRes = await app.fetch(
      new Request(`${BASE_URL}/api/s/${viewLink.token}/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'preview' }),
      }),
      testEnv
    );
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as { url: string; expiresAt: string };
    expect(preview.url.startsWith('/api/storage/preview-stream?token=')).toBe(true);
    expect(preview.url).not.toContain('/api/storage/proxy');
    expect(preview.url).not.toContain('tenants/');

    const first = await app.fetch(
      new Request(`${BASE_URL}${preview.url}`),
      testEnv
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(first.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(first.headers.get('Content-Security-Policy')).toBe(
      "sandbox; default-src 'none'"
    );
    expect(first.headers.get('Accept-Ranges')).toBe('none');
    expect(first.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(first.headers.get('Content-Disposition')).toContain('inline');
    expect(await first.text()).toContain('%PDF-1.4');

    const second = await app.fetch(
      new Request(`${BASE_URL}${preview.url}`),
      testEnv
    );
    expect(second.status).toBe(410);
    const secondJson = (await second.json()) as {
      error: string;
      code: string;
    };
    expect(secondJson.code).toBe('PREVIEW_TOKEN_CONSUMED');
    expect(secondJson.error).toBe('Preview stream token expired or already used');

    const downloadRes = await app.fetch(
      new Request(`${BASE_URL}/api/s/${viewLink.token}/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'download' }),
      }),
      testEnv
    );
    expect(downloadRes.status).toBe(403);

    // Standard download links keep returning reusable signed URLs.
    const downloadLink = await createLink({
      targetType: 'file',
      targetId: 'sll-file-internal',
      accessScope: 'company_only',
      permissionLevel: 'download',
    });
    const downloadUrlRes = await app.fetch(
      new Request(`${BASE_URL}/api/s/${downloadLink.token}/url`, {
        method: 'POST',
        headers: authHeaders('sll-editor'),
        body: JSON.stringify({ intent: 'preview' }),
      }),
      testEnv
    );
    expect(downloadUrlRes.status).toBe(200);
    const downloadUrlJson = (await downloadUrlRes.json()) as { url: string };
    expect(downloadUrlJson.url.startsWith('/api/storage/preview-stream')).toBe(false);
    expect(downloadUrlJson.url.startsWith('/api/storage/proxy')).toBe(true);
  });

  it('uses the single-use stream for preview-only authenticated file content URLs', async () => {
    const previewRes = await app.fetch(
      new Request(
        `${BASE_URL}/api/files/sll-file-internal/content-url?intent=preview`,
        { headers: authHeaders('sll-previewer') }
      ),
      testEnv
    );
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as { url: string };
    expect(preview.url.startsWith('/api/storage/preview-stream?token=')).toBe(true);

    const first = await app.fetch(
      new Request(`${BASE_URL}${preview.url}`),
      testEnv
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('Content-Disposition')).toContain('inline');

    const second = await app.fetch(
      new Request(`${BASE_URL}${preview.url}`),
      testEnv
    );
    expect(second.status).toBe(410);

    const versionRes = await app.fetch(
      new Request(
        `${BASE_URL}/api/files/sll-file-internal/versions/sll-v-internal/content-url?intent=preview`,
        { headers: authHeaders('sll-previewer') }
      ),
      testEnv
    );
    expect(versionRes.status).toBe(200);
    const versionPreview = (await versionRes.json()) as { url: string };
    expect(versionPreview.url.startsWith('/api/storage/preview-stream?token=')).toBe(
      true
    );
  });

  it('keeps legacy link behaviours: backfill, password, expiry, max downloads, revocation, tenant isolation', async () => {
    // The migration backfill maps can_download=0 -> view and 1 -> download.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, permission_level, require_watermark, expires_at,
           created_by, created_at
         ) VALUES (
           'sll-legacy-view', 'tenant-sll', 'sll-legacy-view-hash', 'file', 'sll-file-internal',
           'company_only', 0, 'download', 1, NULL, 'sll-editor', ?
         )`
      ).bind(new Date().toISOString()),
      env.DB.prepare(
        `INSERT INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, permission_level, require_watermark, expires_at,
           created_by, created_at
         ) VALUES (
           'sll-legacy-download', 'tenant-sll', 'sll-legacy-download-hash', 'file', 'sll-file-internal',
           'company_only', 1, 'view', 0, NULL, 'sll-editor', ?
         )`
      ).bind(new Date().toISOString()),
    ]);
    await env.DB.prepare(
      `UPDATE shared_links
          SET permission_level = CASE WHEN can_download = 0 THEN 'view' ELSE 'download' END
        WHERE id IN ('sll-legacy-view', 'sll-legacy-download')`
    ).run();
    const legacy = await env.DB.prepare(
      "SELECT id, permission_level FROM shared_links WHERE id IN ('sll-legacy-view', 'sll-legacy-download') ORDER BY id"
    ).all<{ id: string; permission_level: string }>();
    expect(legacy.results).toEqual([
      { id: 'sll-legacy-download', permission_level: 'download' },
      { id: 'sll-legacy-view', permission_level: 'view' },
    ]);

    const created = await createLink({
      targetType: 'file',
      targetId: 'sll-file-internal',
      accessScope: 'public',
      permissionLevel: 'download',
      password: 'LegacyPassword1!',
      expiresInDays: 2,
      maxDownloads: 1,
    });
    expect(created.status).toBe(201);

    const before = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'download' }),
      }),
      testEnv
    );
    expect(before.status).toBe(401);

    const unlock = await unlockTokenFor(created.token, 'LegacyPassword1!');
    for (let attempt = 0; attempt < 2; attempt++) {
      const download = await app.fetch(
        new Request(`${BASE_URL}/api/s/${created.token}/url`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Share-Unlock': unlock,
          },
          body: JSON.stringify({ intent: 'download' }),
        }),
        testEnv
      );
      expect(download.status).toBe(attempt === 0 ? 200 : 403);
    }

    const revoke = await app.fetch(
      new Request(`${BASE_URL}/api/shared-links/${created.link.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(revoke.status).toBe(200);
    const revokedMeta = await app.fetch(
      new Request(`${BASE_URL}/api/s/${created.token}/meta`),
      testEnv
    );
    expect(revokedMeta.status).toBe(410);

    const outsiderCreate = await createLink(
      {
        targetType: 'file',
        targetId: 'sll-file-internal',
        accessScope: 'company_only',
      },
      authHeaders('sll-outsider', 'member', 'tenant-sll-other')
    );
    expect(outsiderCreate.status).toBe(404);
  });
});
