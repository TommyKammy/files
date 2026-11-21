import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-tm';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@tm.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-tm-secret-001',
    SESSION_SECRET: 'test-session-tm-secret-001',
    ...overrides,
  } as OidcEnv;
}

describe('Tags & Custom Metadata Templates API', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-tm', 'TM Org', 'tm-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-tm-other', 'Other TM Org', 'tm-other', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, advanced_roles_enabled) VALUES ('tenant-tm', 1)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('tm-owner', 'tenant-tm', 'tm-owner@tm.example.com', 'TM Owner', 'member', 'active'),
           ('tm-editor', 'tenant-tm', 'tm-editor@tm.example.com', 'TM Editor', 'member', 'active'),
           ('tm-previewer', 'tenant-tm', 'tm-previewer@tm.example.com', 'TM Previewer', 'member', 'active'),
           ('tm-stranger', 'tenant-tm', 'tm-stranger@tm.example.com', 'TM Stranger', 'member', 'active'),
           ('tm-sysadmin', 'tenant-tm', 'tm-sysadmin@tm.example.com', 'TM SysAdmin', 'sys_admin', 'active'),
           ('tm-secadmin', 'tenant-tm', 'tm-secadmin@tm.example.com', 'TM SecAdmin', 'sec_admin', 'active'),
           ('tm-other-user', 'tenant-tm-other', 'other@tm-other.example.com', 'Other User', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, classification, created_by)
         VALUES
           ('tm-fld-root', 'tenant-tm', NULL, 'Root', 0, 'internal', 'tm-owner'),
           ('tm-fld-sub', 'tenant-tm', 'tm-fld-root', 'Contracts', 1, 'internal', 'tm-owner'),
           ('tm-fld-secret', 'tenant-tm', NULL, 'Secret Folder', 0, 'confidential', 'tm-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-tm', 'tm-fld-root', 'tm-fld-root', 0),
           ('tenant-tm', 'tm-fld-root', 'tm-fld-sub', 1),
           ('tenant-tm', 'tm-fld-sub', 'tm-fld-sub', 0),
           ('tenant-tm', 'tm-fld-secret', 'tm-fld-secret', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES
           ('tm-file-1', 'tenant-tm', 'tm-fld-sub', 'MSA-2026.pdf', 'pdf', 'application/pdf', 2048, 'active', 'internal', 'tm-owner', 'tm-owner'),
           ('tm-file-secret', 'tenant-tm', 'tm-fld-secret', 'Secret.pdf', 'pdf', 'application/pdf', 1024, 'active', 'confidential', 'tm-owner', 'tm-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-tm-owner-root', 'tenant-tm', 'folder', 'tm-fld-root', 'user', 'tm-owner', 'owner', 'tm-owner'),
           ('perm-tm-owner-secret', 'tenant-tm', 'folder', 'tm-fld-secret', 'user', 'tm-owner', 'owner', 'tm-owner'),
           ('perm-tm-editor-sub', 'tenant-tm', 'folder', 'tm-fld-sub', 'user', 'tm-editor', 'editor', 'tm-owner'),
           ('perm-tm-prev-sub', 'tenant-tm', 'folder', 'tm-fld-sub', 'user', 'tm-previewer', 'previewer', 'tm-owner')`
      ),
    ]);
  });

  it('rejects unauthenticated requests with 401', async () => {
    const testEnv = buildTestEnv();
    const res = await app.fetch(
      new Request('http://127.0.0.1/api/tags'),
      testEnv
    );
    expect(res.status).toBe(401);
  });

  it('supports tag CRUD, normalization, max-20 limit, and RBAC enforcement', async () => {
    const testEnv = buildTestEnv();

    // Stranger cannot read or write tags
    const strangerRead = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/tags', {
        headers: authHeaders('tm-stranger'),
      }),
      testEnv
    );
    expect(strangerRead.status).toBe(403);

    // Previewer cannot add tags
    const prevWrite = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/tags', {
        method: 'POST',
        headers: authHeaders('tm-previewer'),
        body: JSON.stringify({ tag: 'urgent' }),
      }),
      testEnv
    );
    expect(prevWrite.status).toBe(403);

    // Editor can add normalized tag (trimmed + lowercased)
    const addRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/tags', {
        method: 'POST',
        headers: authHeaders('tm-editor'),
        body: JSON.stringify({ tag: '  Urgent-2026  ' }),
      }),
      testEnv
    );
    expect(addRes.status).toBe(201);
    const addJson = (await addRes.json()) as {
      tag: { tag: string; createdBy: string };
    };
    expect(addJson.tag.tag).toBe('urgent-2026');

    // Invalid tag length (> 40 chars or empty) rejected with 400
    const badLenRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/tags', {
        method: 'POST',
        headers: authHeaders('tm-editor'),
        body: JSON.stringify({ tag: 'a'.repeat(41) }),
      }),
      testEnv
    );
    expect(badLenRes.status).toBe(400);

    // Previewer can read tags
    const prevRead = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/tags', {
        headers: authHeaders('tm-previewer'),
      }),
      testEnv
    );
    expect(prevRead.status).toBe(200);
    const prevReadJson = (await prevRead.json()) as {
      tags: Array<{ tag: string }>;
    };
    expect(prevReadJson.tags.map((t) => t.tag)).toEqual(['urgent-2026']);

    // Tag a folder as well, plus a secret file the editor cannot access
    const fldTagRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/folder/tm-fld-sub/tags', {
        method: 'POST',
        headers: authHeaders('tm-editor'),
        body: JSON.stringify({ tag: 'urgent-2026' }),
      }),
      testEnv
    );
    expect(fldTagRes.status).toBe(201);

    const secretTagRes = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-secret/tags', {
        method: 'POST',
        headers: authHeaders('tm-owner'),
        body: JSON.stringify({ tag: 'urgent-2026' }),
      }),
      testEnv
    );
    expect(secretTagRes.status).toBe(201);

    // GET /api/tags returns distinct tags in tenant
    const listTagsRes = await app.fetch(
      new Request('http://127.0.0.1/api/tags', {
        headers: authHeaders('tm-previewer'),
      }),
      testEnv
    );
    expect(listTagsRes.status).toBe(200);
    const listTagsJson = (await listTagsRes.json()) as { tags: string[] };
    expect(listTagsJson.tags).toContain('urgent-2026');

    // Search by tag-only query respects RBAC (tm-editor sees tm-file-1 and tm-fld-sub, NOT tm-file-secret)
    const searchRes = await app.fetch(
      new Request('http://127.0.0.1/api/search?tag=URGENT-2026', {
        headers: authHeaders('tm-editor'),
      }),
      testEnv
    );
    expect(searchRes.status).toBe(200);
    const searchJson = (await searchRes.json()) as {
      folders: Array<{ id: string }>;
      results: Array<{ id: string }>;
    };
    expect(searchJson.results.map((r) => r.id)).toEqual(['tm-file-1']);
    expect(searchJson.folders.map((f) => f.id)).toEqual(['tm-fld-sub']);

    // Delete tag (previewer 403, editor 200)
    const prevDel = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/tags/urgent-2026', {
        method: 'DELETE',
        headers: authHeaders('tm-previewer'),
      }),
      testEnv
    );
    expect(prevDel.status).toBe(403);

    const editorDel = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/tags/urgent-2026', {
        method: 'DELETE',
        headers: authHeaders('tm-editor'),
      }),
      testEnv
    );
    expect(editorDel.status).toBe(200);

    // Enforce max 20 tags per item
    for (let i = 1; i <= 20; i++) {
      const r = await app.fetch(
        new Request('http://127.0.0.1/api/items/file/tm-file-1/tags', {
          method: 'POST',
          headers: authHeaders('tm-editor'),
          body: JSON.stringify({ tag: `tag-${i}` }),
        }),
        testEnv
      );
      expect(r.status).toBe(201);
    }
    const overLimit = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/tags', {
        method: 'POST',
        headers: authHeaders('tm-editor'),
        body: JSON.stringify({ tag: 'tag-21' }),
      }),
      testEnv
    );
    expect(overLimit.status).toBe(400);
  });

  it('supports metadata template admin CRUD, schema validation, and item metadata values', async () => {
    const testEnv = buildTestEnv();

    // Member cannot create metadata template
    const memberCreate = await app.fetch(
      new Request('http://127.0.0.1/api/admin/metadata-templates', {
        method: 'POST',
        headers: authHeaders('tm-owner', 'member'),
        body: JSON.stringify({
          key: 'contract',
          displayName: '契約情報',
          fields: [{ key: 'vendor', label: '取引先', type: 'text', required: true }],
        }),
      }),
      testEnv
    );
    expect(memberCreate.status).toBe(403);

    // Invalid enum schema (missing options) rejected with 400
    const badSchema = await app.fetch(
      new Request('http://127.0.0.1/api/admin/metadata-templates', {
        method: 'POST',
        headers: authHeaders('tm-secadmin', 'sec_admin'),
        body: JSON.stringify({
          key: 'contract',
          displayName: '契約情報',
          fields: [{ key: 'status', label: '状態', type: 'enum' }],
        }),
      }),
      testEnv
    );
    expect(badSchema.status).toBe(400);

    // sec_admin creates valid template
    const createRes = await app.fetch(
      new Request('http://127.0.0.1/api/admin/metadata-templates', {
        method: 'POST',
        headers: authHeaders('tm-secadmin', 'sec_admin'),
        body: JSON.stringify({
          key: 'contract_meta',
          displayName: '契約メタデータ',
          description: '法務確認用',
          fields: [
            { key: 'vendor', label: '取引先', type: 'text', required: true },
            { key: 'amount', label: '金額', type: 'number' },
            { key: 'expires_at', label: '契約期限', type: 'date' },
            {
              key: 'status',
              label: 'ステータス',
              type: 'enum',
              options: ['draft', 'active', 'expired'],
            },
          ],
        }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      template: { id: string; key: string; displayName: string };
    };
    const templateId = created.template.id;

    // Authenticated member can list templates
    const listRes = await app.fetch(
      new Request('http://127.0.0.1/api/metadata-templates', {
        headers: authHeaders('tm-previewer'),
      }),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      templates: Array<{ id: string; key: string }>;
    };
    expect(listJson.templates.some((t) => t.id === templateId)).toBe(true);

    // Previewer cannot save item metadata
    const prevPut = await app.fetch(
      new Request(
        `http://127.0.0.1/api/items/file/tm-file-1/metadata/${templateId}`,
        {
          method: 'PUT',
          headers: authHeaders('tm-previewer'),
          body: JSON.stringify({ values: { vendor: 'Acme' } }),
        }
      ),
      testEnv
    );
    expect(prevPut.status).toBe(403);

    // Missing required field -> 400
    const missingReq = await app.fetch(
      new Request(
        `http://127.0.0.1/api/items/file/tm-file-1/metadata/${templateId}`,
        {
          method: 'PUT',
          headers: authHeaders('tm-editor'),
          body: JSON.stringify({ values: { amount: 1000 } }),
        }
      ),
      testEnv
    );
    expect(missingReq.status).toBe(400);

    // Invalid enum option -> 400
    const badEnum = await app.fetch(
      new Request(
        `http://127.0.0.1/api/items/file/tm-file-1/metadata/${templateId}`,
        {
          method: 'PUT',
          headers: authHeaders('tm-editor'),
          body: JSON.stringify({
            values: { vendor: 'Acme', status: 'invalid-opt' },
          }),
        }
      ),
      testEnv
    );
    expect(badEnum.status).toBe(400);

    // Editor saves valid metadata
    const saveRes = await app.fetch(
      new Request(
        `http://127.0.0.1/api/items/file/tm-file-1/metadata/${templateId}`,
        {
          method: 'PUT',
          headers: authHeaders('tm-editor'),
          body: JSON.stringify({
            values: {
              vendor: 'Acme Corp',
              amount: 500000,
              expires_at: '2027-03-31',
              status: 'active',
            },
          }),
        }
      ),
      testEnv
    );
    expect(saveRes.status).toBe(200);

    // Previewer reads metadata
    const readMeta = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/metadata', {
        headers: authHeaders('tm-previewer'),
      }),
      testEnv
    );
    expect(readMeta.status).toBe(200);
    const readMetaJson = (await readMeta.json()) as {
      metadata: Array<{
        templateId: string;
        values: Record<string, string | number | null>;
      }>;
    };
    expect(readMetaJson.metadata).toHaveLength(1);
    expect(readMetaJson.metadata[0].values).toEqual({
      vendor: 'Acme Corp',
      amount: 500000,
      expires_at: '2027-03-31',
      status: 'active',
    });

    // sys_admin patches template displayName
    const patchRes = await app.fetch(
      new Request(
        `http://127.0.0.1/api/admin/metadata-templates/${templateId}`,
        {
          method: 'PATCH',
          headers: authHeaders('tm-sysadmin', 'sys_admin'),
          body: JSON.stringify({ displayName: '契約情報v2' }),
        }
      ),
      testEnv
    );
    expect(patchRes.status).toBe(200);

    // sys_admin deletes template and cascades item_metadata_values
    const delRes = await app.fetch(
      new Request(
        `http://127.0.0.1/api/admin/metadata-templates/${templateId}`,
        {
          method: 'DELETE',
          headers: authHeaders('tm-sysadmin', 'sys_admin'),
        }
      ),
      testEnv
    );
    expect(delRes.status).toBe(200);

    const readAfterDel = await app.fetch(
      new Request('http://127.0.0.1/api/items/file/tm-file-1/metadata', {
        headers: authHeaders('tm-previewer'),
      }),
      testEnv
    );
    expect(readAfterDel.status).toBe(200);
    const afterJson = (await readAfterDel.json()) as { metadata: unknown[] };
    expect(afterJson.metadata).toEqual([]);
  });
});
