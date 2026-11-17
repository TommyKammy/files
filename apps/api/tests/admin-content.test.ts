import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import {
  buildAdminContentSearchQuery,
  type AdminContentSearchQueryInput,
} from '../src/services/admin-content';
import {
  buildSafeFtsMatchExpression,
  parseSearchQuery,
} from '../src/routes/search';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-acm';
const OTHER_TENANT_ID = 'tenant-acm-other';

const SYS_ID = 'acm-sys';
const SEC_ID = 'acm-sec';
const MEMBER_ID = 'acm-member';
const OWNER_ID = 'acm-owner';
const OTHER_OWNER_ID = 'acm-other-owner';

const ROOT_FOLDER_ID = 'acm-root';
const SUB_FOLDER_ID = 'acm-sub';
const CONF_FOLDER_ID = 'acm-conf';

const F_ROADMAP = 'acm-file-roadmap';
const F_SECRET = 'acm-file-secret';
const F_PUBLIC = 'acm-file-public';
const F_PRIVATE = 'acm-file-private';
const F_ARCHIVE = 'acm-file-archive';
const F_DELETED = 'acm-file-deleted';
const F_PENDING = 'acm-file-pending';
const F_OTHER_TENANT = 'acm-file-other-tenant';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@acm.example.com`,
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
    LOCAL_PROXY_SECRET: 'admin-content-secret',
    WOPI_TOKEN_SECRET: 'admin-content-wopi-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
  } as OidcEnv;
}

async function api(
  testEnv: OidcEnv,
  path: string,
  init: RequestInit = {},
  headers = authHeaders(SYS_ID, 'sys_admin')
): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string>) },
    }),
    testEnv
  );
}

async function issueWopiToken(
  testEnv: OidcEnv,
  fileId: string,
  userId = OWNER_ID
): Promise<string> {
  const res = await api(
    testEnv,
    `/api/files/${fileId}/wopi-session`,
    { method: 'POST' },
    authHeaders(userId)
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

function searchQueryInput(
  overrides: Partial<AdminContentSearchQueryInput> = {}
): AdminContentSearchQueryInput {
  return {
    tenantId: TENANT_ID,
    targetType: 'file',
    ftsExpression: null,
    folderPrefix: null,
    classification: null,
    createdByUserId: null,
    rootFolderId: null,
    extension: null,
    lockedOnly: false,
    hasSharedLink: false,
    cursor: null,
    limit: 25,
    lockedNowIso: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

async function explain(
  testEnv: OidcEnv,
  input: AdminContentSearchQueryInput
): Promise<string[]> {
  const query = buildAdminContentSearchQuery(input);
  const plan = await testEnv.DB.prepare(
    `EXPLAIN QUERY PLAN ${query.sql}`
  )
    .bind(...query.binds)
    .all<{ detail: string }>();
  return plan.results.map((row) => row.detail);
}

describe('Admin Content Manager (P12-1 / TOM-65)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const files: Array<{
      id: string;
      folderId: string | null;
      name: string;
      extension: string;
      mimeType: string;
      size: number;
      classification: string;
      owner: string;
      updatedAt: string;
      versionId: string | null;
      uploadState?: string;
      deletedAt?: string | null;
      tenantId?: string;
    }> = [
      {
        id: F_ROADMAP,
        folderId: SUB_FOLDER_ID,
        name: 'admin-content-roadmap-alpha.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
        size: 110,
        classification: 'internal',
        owner: OWNER_ID,
        updatedAt: '2026-11-17T10:00:05.000Z',
        versionId: 'acm-v-roadmap',
      },
      {
        id: F_SECRET,
        folderId: ROOT_FOLDER_ID,
        name: 'admin-content-secret-beta.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
        size: 210,
        classification: 'confidential',
        owner: MEMBER_ID,
        updatedAt: '2026-11-17T10:00:04.000Z',
        versionId: 'acm-v-secret',
      },
      {
        id: F_PUBLIC,
        folderId: SUB_FOLDER_ID,
        name: 'admin-content-public-gamma.txt',
        extension: 'txt',
        mimeType: 'text/plain',
        size: 30,
        classification: 'public',
        owner: OWNER_ID,
        updatedAt: '2026-11-17T10:00:03.000Z',
        versionId: 'acm-v-public',
      },
      {
        id: F_PRIVATE,
        folderId: null,
        name: 'admin-content-private-delta.docx',
        extension: 'docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        size: 410,
        classification: 'unset',
        owner: MEMBER_ID,
        updatedAt: '2026-11-17T10:00:02.000Z',
        versionId: null,
      },
      {
        id: F_ARCHIVE,
        folderId: ROOT_FOLDER_ID,
        name: 'admin-content-archive-epsilon.zip',
        extension: 'zip',
        mimeType: 'application/zip',
        size: 510,
        classification: 'internal',
        owner: OWNER_ID,
        updatedAt: '2026-11-17T10:00:01.000Z',
        versionId: null,
      },
      {
        id: F_DELETED,
        folderId: SUB_FOLDER_ID,
        name: 'admin-content-roadmap-deleted.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
        size: 10,
        classification: 'internal',
        owner: OWNER_ID,
        updatedAt: '2026-11-17T10:00:00.000Z',
        versionId: null,
        deletedAt: '2026-11-17T10:00:00.000Z',
      },
      {
        id: F_PENDING,
        folderId: SUB_FOLDER_ID,
        name: 'admin-content-roadmap-pending.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
        size: 10,
        classification: 'internal',
        owner: OWNER_ID,
        updatedAt: '2026-11-17T10:00:00.000Z',
        versionId: null,
        uploadState: 'pending',
      },
      {
        id: F_OTHER_TENANT,
        tenantId: OTHER_TENANT_ID,
        folderId: null,
        name: 'admin-content-other-omega.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
        size: 10,
        classification: 'confidential',
        owner: OTHER_OWNER_ID,
        updatedAt: '2026-11-17T10:00:00.000Z',
        versionId: null,
      },
    ];

    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES
           (?, 'Admin Content Org', 'admin-content-org', 5000000),
           (?, 'Admin Content Other', 'admin-content-other', 5000000)`
      ).bind(TENANT_ID, OTHER_TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?), (?)`
      ).bind(TENANT_ID, OTHER_TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           (?, ?, 'acm-sys@acm.example.com', 'ACM Sys', 'sys_admin', 'active'),
           (?, ?, 'acm-sec@acm.example.com', 'ACM Sec', 'sec_admin', 'active'),
           (?, ?, 'acm-member@acm.example.com', 'ACM Member', 'member', 'active'),
           (?, ?, 'owner@acm.example.com', 'Content Owner', 'member', 'active'),
           (?, ?, 'other-owner@acm.example.com', 'Other Owner', 'member', 'active')`
      ).bind(
        SYS_ID,
        TENANT_ID,
        SEC_ID,
        TENANT_ID,
        MEMBER_ID,
        TENANT_ID,
        OWNER_ID,
        TENANT_ID,
        OTHER_OWNER_ID,
        OTHER_TENANT_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification,
           created_by, updated_at
         ) VALUES
           (?, ?, NULL, 'Company Docs', 0, 1, 'internal', ?, '2026-11-17T09:00:00.000Z'),
           (?, ?, ?, 'Projects', 1, 1, 'internal', ?, '2026-11-17T09:01:00.000Z'),
           (?, ?, NULL, 'Confidential', 0, 1, 'confidential', ?, '2026-11-17T09:02:00.000Z')`
      ).bind(
        ROOT_FOLDER_ID,
        TENANT_ID,
        MEMBER_ID,
        SUB_FOLDER_ID,
        TENANT_ID,
        ROOT_FOLDER_ID,
        MEMBER_ID,
        CONF_FOLDER_ID,
        TENANT_ID,
        MEMBER_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           (?, ?, ?, 0),
           (?, ?, ?, 1),
           (?, ?, ?, 0),
           (?, ?, ?, 0)`
      ).bind(
        TENANT_ID,
        ROOT_FOLDER_ID,
        ROOT_FOLDER_ID,
        TENANT_ID,
        ROOT_FOLDER_ID,
        SUB_FOLDER_ID,
        TENANT_ID,
        SUB_FOLDER_ID,
        SUB_FOLDER_ID,
        TENANT_ID,
        CONF_FOLDER_ID,
        CONF_FOLDER_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by
         ) VALUES
           ('acm-perm-roadmap-owner', ?, 'file', ?, 'user', ?, 'owner', ?),
           ('acm-perm-public-owner', ?, 'file', ?, 'user', ?, 'owner', ?),
           ('acm-perm-secret-owner', ?, 'file', ?, 'user', ?, 'owner', ?),
           ('acm-perm-private-owner', ?, 'file', ?, 'user', ?, 'owner', ?)`
      ).bind(
        TENANT_ID,
        F_ROADMAP,
        OWNER_ID,
        OWNER_ID,
        TENANT_ID,
        F_PUBLIC,
        OWNER_ID,
        OWNER_ID,
        TENANT_ID,
        F_SECRET,
        MEMBER_ID,
        MEMBER_ID,
        TENANT_ID,
        F_PRIVATE,
        MEMBER_ID,
        MEMBER_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, permission_level, created_by, revoked_at, created_at
         ) VALUES
           ('acm-link-roadmap', ?, 'acm-hash-roadmap', 'file', ?, 'company_only',
            1, 'download', ?, NULL, '2026-11-17T09:10:00.000Z'),
           ('acm-link-secret-revoked', ?, 'acm-hash-secret', 'file', ?, 'company_only',
            0, 'view', ?, '2026-11-17T09:11:00.000Z', '2026-11-17T09:11:00.000Z'),
           ('acm-link-root', ?, 'acm-hash-root', 'folder', ?, 'company_only',
            1, 'download', ?, NULL, '2026-11-17T09:12:00.000Z')`
      ).bind(
        TENANT_ID,
        F_ROADMAP,
        MEMBER_ID,
        TENANT_ID,
        F_SECRET,
        MEMBER_ID,
        TENANT_ID,
        ROOT_FOLDER_ID,
        MEMBER_ID
      ),
    ];

    for (const file of files) {
      const tenantId = file.tenantId ?? TENANT_ID;
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO files (
             id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
             upload_state, current_version_id, current_version_num,
             classification, created_by, updated_by, deleted_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
        ).bind(
          file.id,
          tenantId,
          file.folderId,
          file.name,
          file.extension,
          file.mimeType,
          file.size,
          file.uploadState ?? 'active',
          file.versionId,
          file.classification,
          file.owner,
          file.owner,
          file.deletedAt ?? null,
          file.updatedAt
        ),
        env.DB.prepare(
          `INSERT OR IGNORE INTO files_fts (
             file_id, tenant_id, classification, name, extension, ai_reason
           ) VALUES (?, ?, ?, ?, ?, 'admin content fixture')`
        ).bind(
          file.id,
          tenantId,
          file.classification,
          file.name,
          file.extension
        )
      );
      if (file.versionId) {
        statements.push(
          env.DB.prepare(
            `INSERT OR IGNORE INTO file_versions (
               id, tenant_id, file_id, version_num, r2_object_key, size_bytes,
               mime_type, upload_status, uploaded_by
             ) VALUES (?, ?, ?, 1, ?, ?, ?, 'completed', ?)`
          ).bind(
            file.versionId,
            tenantId,
            file.id,
            `tenants/${tenantId}/objects/${file.id}/v1`,
            file.size,
            file.mimeType,
            file.owner
          )
        );
      }
    }

    await env.DB.batch(statements);
    for (const fileId of [F_ROADMAP, F_SECRET, F_PUBLIC]) {
      await env.BUCKET.put(
        `tenants/${TENANT_ID}/objects/${fileId}/v1`,
        `admin content bytes for ${fileId}`
      );
    }
  });

  it('searches all tenant content ACL-independently with filters and rejects members', async () => {
    const testEnv = buildTestEnv();

    const all = await api(
      testEnv,
      '/api/admin/content/search?query=admin-content&targetType=all&limit=100'
    );
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      items: Array<{ id: string; targetType: string; owner: { email: string } }>;
    };
    expect(allBody.items.map((item) => item.id)).toEqual([
      F_ROADMAP,
      F_SECRET,
      F_PUBLIC,
      F_PRIVATE,
      F_ARCHIVE,
    ]);
    expect(allBody.items[0]?.owner.email).toBe('owner@acm.example.com');

    const sec = await api(
      testEnv,
      '/api/admin/content/search?query=admin-content&targetType=file&limit=100',
      {},
      authHeaders(SEC_ID, 'sec_admin')
    );
    expect(sec.status).toBe(200);
    expect(
      ((await sec.json()) as { items: unknown[] }).items
    ).toHaveLength(5);

    const member = await api(
      testEnv,
      '/api/admin/content/search?query=admin-content',
      {},
      authHeaders(MEMBER_ID, 'member')
    );
    expect(member.status).toBe(403);

    const byEmail = await api(
      testEnv,
      `/api/admin/content/search?targetType=file&createdBy=${encodeURIComponent('OWNER@acm.example.com')}&limit=100`
    );
    expect(byEmail.status).toBe(200);
    expect(
      ((await byEmail.json()) as { items: Array<{ id: string }> }).items.map(
        (item) => item.id
      )
    ).toEqual([F_ROADMAP, F_PUBLIC, F_ARCHIVE]);

    const byUserId = await api(
      testEnv,
      `/api/admin/content/search?targetType=file&createdBy=${OWNER_ID}&limit=100`
    );
    expect(
      ((await byUserId.json()) as { items: Array<{ id: string }> }).items.map(
        (item) => item.id
      )
    ).toEqual([F_ROADMAP, F_PUBLIC, F_ARCHIVE]);

    const confidential = await api(
      testEnv,
      '/api/admin/content/search?targetType=file&classification=confidential&limit=100'
    );
    expect(
      (
        (await confidential.json()) as {
          items: Array<{ id: string; classification: string }>;
        }
      ).items.map((item) => [item.id, item.classification])
    ).toEqual([[F_SECRET, 'confidential']]);

    const txt = await api(
      testEnv,
      '/api/admin/content/search?targetType=file&extension=.TXT&limit=100'
    );
    expect(
      ((await txt.json()) as { items: Array<{ id: string }> }).items.map(
        (item) => item.id
      )
    ).toEqual([F_PUBLIC]);

    const underRoot = await api(
      testEnv,
      `/api/admin/content/search?targetType=file&rootFolderId=${ROOT_FOLDER_ID}&limit=100`
    );
    expect(
      ((await underRoot.json()) as { items: Array<{ id: string }> }).items.map(
        (item) => item.id
      )
    ).toEqual([F_ROADMAP, F_SECRET, F_PUBLIC, F_ARCHIVE]);

    const folders = await api(
      testEnv,
      '/api/admin/content/search?targetType=folder&query=Projects&limit=100'
    );
    const folderBody = (await folders.json()) as {
      items: Array<{
        id: string;
        targetType: string;
        pathLabel: string;
        breadcrumbs: Array<{ name: string }>;
      }>;
    };
    expect(folderBody.items).toHaveLength(1);
    expect(folderBody.items[0]).toMatchObject({
      id: SUB_FOLDER_ID,
      targetType: 'folder',
    });
    expect(folderBody.items[0]?.breadcrumbs.map((crumb) => crumb.name)).toEqual([
      'Company Docs',
      'Projects',
    ]);

    const qualifier = await api(
      testEnv,
      '/api/admin/content/search?targetType=file&query=is%3Aconfidential&limit=100'
    );
    expect(
      (
        (await qualifier.json()) as {
          items: Array<{ id: string }>;
        }
      ).items.map((item) => item.id)
    ).toEqual([F_SECRET]);

    const crossTenant = await api(
      testEnv,
      '/api/admin/content/search?query=admin-content-other-omega&limit=100'
    );
    expect(
      ((await crossTenant.json()) as { items: unknown[] }).items
    ).toHaveLength(0);

    const crossTenantOwner = await api(
      testEnv,
      `/api/admin/content/search?createdBy=${OTHER_OWNER_ID}&limit=100`
    );
    expect(
      ((await crossTenantOwner.json()) as { items: unknown[] }).items
    ).toHaveLength(0);

    const injection = await api(
      testEnv,
      `/api/admin/content/search?targetType=file&query=${encodeURIComponent(
        '"file_id:acm-file-roadmap" OR NOT * (near)'
      )}&limit=100`
    );
    expect(injection.status).toBe(200);
    expect(
      ((await injection.json()) as { items: unknown[] }).items
    ).toHaveLength(0);

    const punctuationOnly = await api(
      testEnv,
      `/api/admin/content/search?targetType=file&query=${encodeURIComponent('***')}&limit=100`
    );
    expect(punctuationOnly.status).toBe(200);
    expect(
      ((await punctuationOnly.json()) as { items: unknown[] }).items
    ).toHaveLength(0);
  });

  it('paginates with a stable updatedAt + id keyset cursor', async () => {
    const testEnv = buildTestEnv();
    const collected: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 5; page += 1) {
      const suffix: string = cursor
        ? `&cursor=${encodeURIComponent(cursor)}`
        : '';
      const res = await api(
        testEnv,
        `/api/admin/content/search?targetType=file&query=admin-content&limit=2${suffix}`
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ id: string }>;
        nextCursor: string | null;
        limit: number;
      };
      expect(body.limit).toBe(2);
      collected.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    expect(collected).toEqual([
      F_ROADMAP,
      F_SECRET,
      F_PUBLIC,
      F_PRIVATE,
      F_ARCHIVE,
    ]);
    expect(new Set(collected).size).toBe(collected.length);

    const invalidCursor = await api(
      testEnv,
      '/api/admin/content/search?cursor=not-a-cursor'
    );
    expect(invalidCursor.status).toBe(400);
    expect(
      ((await invalidCursor.json()) as { code: string }).code
    ).toBe('INVALID_CURSOR');
  });

  it('filters lockedOnly/hasSharedLink and keeps the D1 shadow synced for Drive and WOPI locks', async () => {
    const testEnv = buildTestEnv();

    const acquired = await api(
      testEnv,
      `/api/files/${F_ROADMAP}/lock`,
      {
        method: 'POST',
        body: JSON.stringify({
          lockId: 'acm-drive-lock',
          ttlSeconds: 600,
        }),
      },
      authHeaders(OWNER_ID)
    );
    expect(acquired.status).toBe(201);

    const shadow = await env.DB.prepare(
      'SELECT mode, lock_id FROM active_file_locks WHERE file_id = ?'
    )
      .bind(F_ROADMAP)
      .first<{ mode: string; lock_id: string }>();
    expect(shadow).toEqual({
      mode: 'desktop_exclusive',
      lock_id: 'acm-drive-lock',
    });

    const locked = await api(
      testEnv,
      '/api/admin/content/search?targetType=file&query=admin-content&lockedOnly=1&limit=100'
    );
    const lockedBody = (await locked.json()) as {
      items: Array<{
        id: string;
        activeLock: { mode: string; lockId: string; ownerId: string } | null;
      }>;
    };
    expect(lockedBody.items).toHaveLength(1);
    expect(lockedBody.items[0]).toMatchObject({
      id: F_ROADMAP,
      activeLock: {
        mode: 'desktop_exclusive',
        lockId: 'acm-drive-lock',
        ownerId: OWNER_ID,
      },
    });

    const shared = await api(
      testEnv,
      '/api/admin/content/search?targetType=file&query=admin-content&hasSharedLink=1&limit=100'
    );
    const sharedBody = (await shared.json()) as {
      items: Array<{ id: string; activeSharedLinkCount: number }>;
    };
    expect(sharedBody.items.map((item) => item.id)).toEqual([F_ROADMAP]);
    expect(sharedBody.items[0]?.activeSharedLinkCount).toBe(1);

    const released = await api(
      testEnv,
      `/api/files/${F_ROADMAP}/lock`,
      {
        method: 'DELETE',
        body: JSON.stringify({ lockId: 'acm-drive-lock' }),
      },
      authHeaders(OWNER_ID)
    );
    expect(released.status).toBe(200);
    expect(
      await env.DB.prepare(
        'SELECT file_id FROM active_file_locks WHERE file_id = ?'
      )
        .bind(F_ROADMAP)
        .first()
    ).toBeNull();

    const unlocked = await api(
      testEnv,
      '/api/admin/content/search?targetType=file&query=admin-content&lockedOnly=1&limit=100'
    );
    expect(
      ((await unlocked.json()) as { items: unknown[] }).items
    ).toHaveLength(0);

    // A stale shadow row must never surface as a lock: live DO verification
    // filters it and self-heals the index.
    await env.DB.prepare(
      `INSERT OR REPLACE INTO active_file_locks (
         file_id, tenant_id, mode, lock_id, owner_id, owner_name,
         owner_email, expires_at, updated_at
       ) VALUES (?, ?, 'desktop_exclusive', 'stale-shadow-lock', ?, 'Stale',
                 'stale@acm.example.com', '2099-01-01T00:00:00.000Z',
                 '2026-11-17T00:00:00.000Z')`
    )
      .bind(F_ARCHIVE, TENANT_ID, OWNER_ID)
      .run();
    const staleShadow = await api(
      testEnv,
      '/api/admin/content/search?targetType=file&query=admin-content&lockedOnly=1&limit=100'
    );
    expect(
      ((await staleShadow.json()) as { items: unknown[] }).items
    ).toHaveLength(0);
    expect(
      await env.DB.prepare(
        'SELECT file_id FROM active_file_locks WHERE file_id = ?'
      )
        .bind(F_ARCHIVE)
        .first()
    ).toBeNull();

    // WOPI LOCK/UNLOCK must drive the same shadow table.
    const token = await issueWopiToken(testEnv, F_PUBLIC);
    const wopiLock = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${F_PUBLIC}?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: {
            'X-WOPI-Override': 'LOCK',
            'X-WOPI-Lock': 'acm-wopi-lock',
          },
        }
      ),
      testEnv
    );
    expect(wopiLock.status).toBe(200);
    expect(
      await env.DB.prepare(
        'SELECT mode, lock_id FROM active_file_locks WHERE file_id = ?'
      )
        .bind(F_PUBLIC)
        .first<{ mode: string; lock_id: string }>()
    ).toEqual({ mode: 'wopi_collab', lock_id: 'acm-wopi-lock' });

    const wopiUnlock = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${F_PUBLIC}?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: {
            'X-WOPI-Override': 'UNLOCK',
            'X-WOPI-Lock': 'acm-wopi-lock',
          },
        }
      ),
      testEnv
    );
    expect(wopiUnlock.status).toBe(200);
    expect(
      await env.DB.prepare(
        'SELECT file_id FROM active_file_locks WHERE file_id = ?'
      )
        .bind(F_PUBLIC)
        .first()
    ).toBeNull();
  });

  it('force-unlocks the live Durable Object lock, revokes WOPI sessions and audits the reason', async () => {
    const testEnv = buildTestEnv();

    const acquired = await api(
      testEnv,
      `/api/files/${F_ROADMAP}/lock`,
      {
        method: 'POST',
        body: JSON.stringify({ lockId: 'acm-force-lock', ttlSeconds: 600 }),
      },
      authHeaders(OWNER_ID)
    );
    expect(acquired.status).toBe(201);

    await env.DB.prepare(
      `INSERT OR IGNORE INTO wopi_sessions (
         id, tenant_id, file_id, user_id, role, can_write,
         access_token_hash, is_active, expires_at
       ) VALUES ('acm-wopi-force', ?, ?, ?, 'editor', 1, 'acm-token', 1,
                 '2099-01-01T00:00:00.000Z')`
    )
      .bind(TENANT_ID, F_ROADMAP, OWNER_ID)
      .run();

    const missingReason = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/force-unlock`,
      { method: 'POST', body: JSON.stringify({}) },
      authHeaders(SEC_ID, 'sec_admin')
    );
    expect(missingReason.status).toBe(400);
    expect(
      ((await missingReason.json()) as { code: string }).code
    ).toBe('INSPECT_REASON_REQUIRED');

    const shortReason = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/force-unlock`,
      { method: 'POST', body: JSON.stringify({ reason: 'ab' }) },
      authHeaders(SEC_ID, 'sec_admin')
    );
    expect(shortReason.status).toBe(400);
    expect(
      ((await shortReason.json()) as { code: string }).code
    ).toBe('INVALID_INSPECT_REASON');

    const forced = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/force-unlock`,
      {
        method: 'POST',
        body: JSON.stringify({
          reason: 'セキュリティインシデント対応のため強制解除',
        }),
      },
      authHeaders(SEC_ID, 'sec_admin')
    );
    expect(forced.status).toBe(200);
    const forcedBody = (await forced.json()) as {
      ok: boolean;
      released: boolean;
      lock: { mode: string; lockId: string };
      revokedWopiSessionCount: number;
    };
    expect(forcedBody).toMatchObject({
      ok: true,
      released: true,
      lock: { mode: 'desktop_exclusive', lockId: 'acm-force-lock' },
      revokedWopiSessionCount: 1,
    });

    const lockStatus = await api(
      testEnv,
      `/api/files/${F_ROADMAP}/lock-status`,
      {},
      authHeaders(OWNER_ID)
    );
    expect(
      ((await lockStatus.json()) as { lock: unknown }).lock
    ).toBeNull();

    const wopiSession = await env.DB.prepare(
      "SELECT is_active, revoked_at FROM wopi_sessions WHERE id = 'acm-wopi-force'"
    ).first<{ is_active: number; revoked_at: string | null }>();
    expect(wopiSession?.is_active).toBe(0);
    expect(wopiSession?.revoked_at).not.toBeNull();

    expect(
      await env.DB.prepare(
        'SELECT file_id FROM active_file_locks WHERE file_id = ?'
      )
        .bind(F_ROADMAP)
        .first()
    ).toBeNull();

    const audit = await env.DB.prepare(
      `SELECT status, metadata_json FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.content.force_unlock'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(TENANT_ID)
      .first<{ status: string; metadata_json: string }>();
    expect(audit?.status).toBe('allowed');
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      reason: 'セキュリティインシデント対応のため強制解除',
      lockId: 'acm-force-lock',
      mode: 'desktop_exclusive',
    });

    const syncChange = await env.DB.prepare(
      `SELECT action FROM sync_changes
        WHERE tenant_id = ? AND entity_id = ?
          AND action = 'admin.content.force_unlock'
        LIMIT 1`
    )
      .bind(TENANT_ID, F_ROADMAP)
      .first<{ action: string }>();
    expect(syncChange?.action).toBe('admin.content.force_unlock');

    const secondForce = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/force-unlock`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: '再度の強制解除テスト' }),
      },
      authHeaders(SEC_ID, 'sec_admin')
    );
    expect(secondForce.status).toBe(409);
    expect(
      ((await secondForce.json()) as { code: string }).code
    ).toBe('FILE_LOCK_NOT_FOUND');

    const crossTenantForce = await api(
      testEnv,
      `/api/admin/content/files/${F_OTHER_TENANT}/force-unlock`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'cross tenant attempt' }),
      }
    );
    expect(crossTenantForce.status).toBe(404);

    const memberForce = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/force-unlock`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'member attempt' }),
      },
      authHeaders(MEMBER_ID, 'member')
    );
    expect(memberForce.status).toBe(403);
  });

  it('returns full detail metadata and enforces all three inspection policies with audits', async () => {
    const testEnv = buildTestEnv();

    const detail = await api(
      testEnv,
      `/api/admin/content/file/${F_ROADMAP}`
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      pathLabel: string;
      breadcrumbs: Array<{ name: string }>;
      owner: { email: string };
      permissions: Array<{ granteeEmail: string | null; role: string }>;
      sharedLinks: Array<{ id: string; permissionLevel: string }>;
      versions: { total: number; items: Array<{ versionNum: number }> };
      activeLock: unknown;
      inspectPolicy: string;
    };
    expect(detailBody.breadcrumbs.map((crumb) => crumb.name)).toEqual([
      'Company Docs',
      'Projects',
    ]);
    expect(detailBody.pathLabel).toBe('マイファイル / Company Docs / Projects');
    expect(detailBody.owner.email).toBe('owner@acm.example.com');
    expect(detailBody.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          granteeEmail: 'owner@acm.example.com',
          role: 'owner',
        }),
      ])
    );
    expect(detailBody.sharedLinks).toEqual([
      expect.objectContaining({
        id: 'acm-link-roadmap',
        permissionLevel: 'download',
      }),
    ]);
    expect(detailBody.versions.total).toBe(1);
    expect(detailBody.versions.items[0]?.versionNum).toBe(1);
    expect(detailBody.activeLock).toBeNull();
    expect(detailBody.inspectPolicy).toBe('watermark_confidential');

    const secPolicyChange = await api(
      testEnv,
      '/api/admin/policies',
      {
        method: 'PATCH',
        body: JSON.stringify({ adminContentInspectPolicy: 'disabled' }),
      },
      authHeaders(SEC_ID, 'sec_admin')
    );
    expect(secPolicyChange.status).toBe(403);
    expect(
      ((await secPolicyChange.json()) as { code: string }).code
    ).toBe('SYS_ADMIN_REQUIRED');

    const invalidPolicy = await api(
      testEnv,
      '/api/admin/policies',
      {
        method: 'PATCH',
        body: JSON.stringify({ adminContentInspectPolicy: 'allow_all' }),
      }
    );
    expect(invalidPolicy.status).toBe(400);
    expect(
      ((await invalidPolicy.json()) as { code: string }).code
    ).toBe('INVALID_ADMIN_CONTENT_INSPECT_POLICY');

    const disable = await api(
      testEnv,
      '/api/admin/policies',
      {
        method: 'PATCH',
        body: JSON.stringify({ adminContentInspectPolicy: 'disabled' }),
      }
    );
    expect(disable.status).toBe(200);
    expect(
      ((await disable.json()) as { policy: { adminContentInspectPolicy: string } })
        .policy.adminContentInspectPolicy
    ).toBe('disabled');

    const readPolicies = await api(testEnv, '/api/admin/policies', {}, authHeaders(SEC_ID, 'sec_admin'));
    expect(readPolicies.status).toBe(200);
    expect(
      ((await readPolicies.json()) as { policy: { adminContentInspectPolicy: string } })
        .policy.adminContentInspectPolicy
    ).toBe('disabled');

    const missingReason = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/inspect-preview`,
      { method: 'POST', body: JSON.stringify({}) }
    );
    expect(missingReason.status).toBe(400);
    expect(
      ((await missingReason.json()) as { code: string }).code
    ).toBe('INSPECT_REASON_REQUIRED');

    const disabledInspect = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/inspect-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: '監査付きプレビュー確認' }),
      }
    );
    expect(disabledInspect.status).toBe(403);
    expect(
      ((await disabledInspect.json()) as { code: string }).code
    ).toBe('ADMIN_INSPECT_DISABLED');
    let audit = await env.DB.prepare(
      `SELECT status, metadata_json FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.content.inspect'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(TENANT_ID)
      .first<{ status: string; metadata_json: string }>();
    expect(audit?.status).toBe('blocked');
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      policyApplied: 'disabled',
      blockedReason: 'ADMIN_INSPECT_DISABLED',
    });

    await api(testEnv, '/api/admin/policies', {
      method: 'PATCH',
      body: JSON.stringify({ adminContentInspectPolicy: 'deny_confidential' }),
    });

    const confidentialBlocked = await api(
      testEnv,
      `/api/admin/content/files/${F_SECRET}/inspect-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: '機密ファイルの検査試行' }),
      }
    );
    expect(confidentialBlocked.status).toBe(403);
    expect(
      ((await confidentialBlocked.json()) as { code: string }).code
    ).toBe('CONFIDENTIAL_INSPECT_DISABLED');
    audit = await env.DB.prepare(
      `SELECT status, metadata_json FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.content.inspect'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(TENANT_ID)
      .first<{ status: string; metadata_json: string }>();
    expect(audit?.status).toBe('blocked');
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      reason: '機密ファイルの検査試行',
      policyApplied: 'deny_confidential',
      blockedReason: 'CONFIDENTIAL_INSPECT_DISABLED',
    });

    const internalAllowed = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/inspect-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: '通常ファイルの検査' }),
      }
    );
    expect(internalAllowed.status).toBe(200);
    const internalBody = (await internalAllowed.json()) as {
      policyApplied: string;
      watermarkRequired: boolean;
      url: string;
      expiresAt: string;
      disposition: string;
    };
    expect(internalBody).toMatchObject({
      policyApplied: 'deny_confidential',
      watermarkRequired: false,
      disposition: 'inline',
    });
    expect(internalBody.url).toContain('/api/storage/');
    expect(internalBody.expiresAt).toBeTruthy();

    await api(testEnv, '/api/admin/policies', {
      method: 'PATCH',
      body: JSON.stringify({
        adminContentInspectPolicy: 'watermark_confidential',
      }),
    });

    const confidentialAllowed = await api(
      testEnv,
      `/api/admin/content/files/${F_SECRET}/inspect-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: '機密ファイルの透かし検査' }),
      }
    );
    expect(confidentialAllowed.status).toBe(200);
    const confidentialBody = (await confidentialAllowed.json()) as {
      policyApplied: string;
      watermarkRequired: boolean;
      watermarkText: string | null;
      url: string;
    };
    expect(confidentialBody).toMatchObject({
      policyApplied: 'watermark_confidential',
      watermarkRequired: true,
    });
    expect(confidentialBody.watermarkText).toContain('acm-sys@acm.example.com');
    expect(confidentialBody.url).toContain('/api/storage/');

    audit = await env.DB.prepare(
      `SELECT status, metadata_json FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.content.inspect'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(TENANT_ID)
      .first<{ status: string; metadata_json: string }>();
    expect(audit?.status).toBe('allowed');
    expect(JSON.parse(audit!.metadata_json)).toMatchObject({
      reason: '機密ファイルの透かし検査',
      policyApplied: 'watermark_confidential',
      watermarkRequired: true,
    });

    const publicInspect = await api(
      testEnv,
      `/api/admin/content/files/${F_PUBLIC}/inspect-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: '公開ファイルの検査' }),
      }
    );
    expect(publicInspect.status).toBe(200);
    expect(
      ((await publicInspect.json()) as { watermarkRequired: boolean })
        .watermarkRequired
    ).toBe(false);

    const crossTenantInspect = await api(
      testEnv,
      `/api/admin/content/files/${F_OTHER_TENANT}/inspect-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'cross tenant inspect' }),
      }
    );
    expect(crossTenantInspect.status).toBe(404);

    const memberInspect = await api(
      testEnv,
      `/api/admin/content/files/${F_ROADMAP}/inspect-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'member inspect' }),
      },
      authHeaders(MEMBER_ID, 'member')
    );
    expect(memberInspect.status).toBe(403);
  });

  it('keeps EXPLAIN QUERY PLAN off full files table scans for every search mode', async () => {
    const testEnv = buildTestEnv();

    const parsed = parseSearchQuery('admin-content');
    const ftsExpression = buildSafeFtsMatchExpression({
      classificationFilter: null,
      ftsTerms: parsed.ftsTerms,
    });

    const plans: Record<string, string[]> = {
      recent: await explain(testEnv, searchQueryInput()),
      owner: await explain(
        testEnv,
        searchQueryInput({ createdByUserId: OWNER_ID })
      ),
      classification: await explain(
        testEnv,
        searchQueryInput({ classification: 'confidential' })
      ),
      fts: await explain(
        testEnv,
        searchQueryInput({ ftsExpression })
      ),
      rootFolder: await explain(
        testEnv,
        searchQueryInput({ rootFolderId: ROOT_FOLDER_ID })
      ),
    };

    for (const [name, details] of Object.entries(plans)) {
      const fullFilesScan = details.find(
        (detail) => /^SCAN files\b/.test(detail) && !detail.includes('USING')
      );
      expect(
        fullFilesScan,
        `${name} plan must not full-scan files: ${details.join(' | ')}`
      ).toBeUndefined();
    }

    expect(plans.recent.join(' | ')).toContain('idx_files_active_recent');
    expect(plans.owner.join(' | ')).toContain('idx_files_active_creator');
    expect(plans.classification.join(' | ')).toContain(
      'idx_files_classification'
    );
    expect(plans.fts.join(' | ')).toContain('VIRTUAL TABLE');
  });
});
