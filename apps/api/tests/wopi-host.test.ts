import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-wopi-host';
const EDITOR_ID = 'host-editor';
const VIEWER_ID = 'host-viewer';
const PREVIEWER_ID = 'host-previewer';
const FILE_ID = 'host-file';
const CONF_FILE_ID = 'host-conf-file';
const FILE_KEY = `tenants/${TENANT_ID}/objects/${FILE_ID}/v1`;
const CONF_KEY = `tenants/${TENANT_ID}/objects/${CONF_FILE_ID}/v1`;

function authHeaders(userId = EDITOR_ID): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': 'member',
    'X-Dev-Tenant-Id': TENANT_ID,
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
    LOCAL_PROXY_SECRET: 'wopi-host-secret',
    WOPI_TOKEN_SECRET: 'wopi-host-token-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
  } as OidcEnv;
}

async function issueToken(
  testEnv: OidcEnv,
  fileId = FILE_ID,
  userId = EDITOR_ID
): Promise<string> {
  const res = await app.fetch(
    new Request(`http://127.0.0.1:8787/api/files/${fileId}/wopi-session`, {
      method: 'POST',
      headers: authHeaders(userId),
    }),
    testEnv
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

async function wopiRequest(
  testEnv: OidcEnv,
  fileId: string,
  token: string,
  init: RequestInit = {},
  suffix = ''
): Promise<Response> {
  const headers = new Headers(init.headers);
  return await app.fetch(
    new Request(
      `http://127.0.0.1:8787/wopi/files/${fileId}${suffix}?access_token=${encodeURIComponent(token)}`,
      { ...init, headers }
    ),
    testEnv
  );
}

describe('WOPI Host endpoints (CheckFileInfo / GetFile / Lock / PutFile)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'WOPI Host Org', 'wopi-host-org', 5000000)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           (?, ?, 'editor@example.com', 'Host Editor', 'member', 'active'),
           (?, ?, 'viewer@example.com', 'Host Viewer', 'member', 'active'),
           (?, ?, 'previewer@example.com', 'Host Previewer', 'member', 'active')`
      ).bind(
        EDITOR_ID,
        TENANT_ID,
        VIEWER_ID,
        TENANT_ID,
        PREVIEWER_ID,
        TENANT_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           created_by, updated_by
         ) VALUES
           (?, ?, NULL, 'host.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             15, 'active', 'host-v1', 1, 'internal', ?, ?),
           (?, ?, NULL, 'secret.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             15, 'active', 'host-cv1', 1, 'confidential', ?, ?)`
      ).bind(
        FILE_ID,
        TENANT_ID,
        EDITOR_ID,
        EDITOR_ID,
        CONF_FILE_ID,
        TENANT_ID,
        EDITOR_ID,
        EDITOR_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, size_bytes,
           mime_type, upload_status, uploaded_by
         ) VALUES
           ('host-v1', ?, ?, 1, ?, 15,
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             'completed', ?),
           ('host-cv1', ?, ?, 1, ?, 15,
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             'completed', ?)`
      ).bind(
        TENANT_ID,
        FILE_ID,
        FILE_KEY,
        EDITOR_ID,
        TENANT_ID,
        CONF_FILE_ID,
        CONF_KEY,
        EDITOR_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by
         ) VALUES
           ('host-p-editor', ?, 'file', ?, 'user', ?, 'editor', ?),
           ('host-p-viewer', ?, 'file', ?, 'user', ?, 'viewer', ?),
           ('host-p-previewer', ?, 'file', ?, 'user', ?, 'previewer', ?),
           ('host-p-conf', ?, 'file', ?, 'user', ?, 'editor', ?)`
      ).bind(
        TENANT_ID,
        FILE_ID,
        EDITOR_ID,
        EDITOR_ID,
        TENANT_ID,
        FILE_ID,
        VIEWER_ID,
        EDITOR_ID,
        TENANT_ID,
        FILE_ID,
        PREVIEWER_ID,
        EDITOR_ID,
        TENANT_ID,
        CONF_FILE_ID,
        EDITOR_ID,
        EDITOR_ID
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (
           tenant_id, classification, file_count, total_bytes
         ) VALUES (?, 'internal', 1, 15), (?, 'confidential', 1, 15)`
      ).bind(TENANT_ID, TENANT_ID),
    ]);
    await env.BUCKET.put(FILE_KEY, 'host-document!!');
    await env.BUCKET.put(CONF_KEY, 'secret-document');
  });

  it('returns WOPI CheckFileInfo with write/read-only and DLP flags', async () => {
    const testEnv = buildTestEnv();
    const editorToken = await issueToken(testEnv);
    const editorInfo = await wopiRequest(testEnv, FILE_ID, editorToken);
    expect(editorInfo.status).toBe(200);
    const editorBody = (await editorInfo.json()) as Record<string, unknown>;
    expect(editorBody.UserCanWrite).toBe(true);
    expect(editorBody.ReadOnly).toBe(false);
    expect(editorBody.DisablePrint).toBe(false);
    expect(editorBody.SupportsLocks).toBe(true);

    const previewerToken = await issueToken(testEnv, FILE_ID, PREVIEWER_ID);
    const previewerInfo = await wopiRequest(testEnv, FILE_ID, previewerToken);
    const previewerBody = (await previewerInfo.json()) as Record<string, unknown>;
    expect(previewerBody.UserCanWrite).toBe(false);
    expect(previewerBody.ReadOnly).toBe(true);
    expect(previewerBody.DisablePrint).toBe(true);
    expect(previewerBody.DisableExport).toBe(true);
    expect(previewerBody.DisableCopy).toBe(true);
    expect(String(previewerBody.WatermarkText)).toContain('previewer@example.com');

    const confToken = await issueToken(testEnv, CONF_FILE_ID, EDITOR_ID);
    const confInfo = await wopiRequest(testEnv, CONF_FILE_ID, confToken);
    const confBody = (await confInfo.json()) as Record<string, unknown>;
    expect(confBody.DisablePrint).toBe(true);
    expect(confBody.DisableExport).toBe(true);
    expect(confBody.DisableCopy).toBe(true);

    const noToken = await app.fetch(
      new Request(`http://127.0.0.1:8787/wopi/files/${FILE_ID}`),
      testEnv
    );
    expect(noToken.status).toBe(401);
  });

  it('streams GetFile content and rejects a token for another file', async () => {
    const testEnv = buildTestEnv();
    const token = await issueToken(testEnv);
    const getFile = await wopiRequest(testEnv, FILE_ID, token, {}, '/contents');
    expect(getFile.status).toBe(200);
    expect(new TextDecoder().decode(await getFile.arrayBuffer())).toBe('host-document!!');
    expect(getFile.headers.get('X-WOPI-ItemVersion')).toBe('host-v1');

    const mismatch = await wopiRequest(testEnv, CONF_FILE_ID, token);
    expect(mismatch.status).toBe(403);
  });

  it('serializes WOPI locks, blocks read-only PutFile, and finalizes a draft on UNLOCK', async () => {
    const testEnv = buildTestEnv();
    const editorToken = await issueToken(testEnv);
    const viewerToken = await issueToken(testEnv, FILE_ID, VIEWER_ID);
    const lockHeaders = {
      'X-WOPI-Override': 'LOCK',
      'X-WOPI-Lock': 'host-lock-a',
    };

    const locked = await wopiRequest(testEnv, FILE_ID, editorToken, {
      method: 'POST',
      headers: lockHeaders,
    });
    expect(locked.status).toBe(200);

    const conflict = await wopiRequest(testEnv, FILE_ID, editorToken, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'host-lock-b' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get('X-WOPI-Lock')).toBe('host-lock-a');

    const getLock = await wopiRequest(testEnv, FILE_ID, editorToken, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'GET_LOCK' },
    });
    expect(getLock.status).toBe(200);
    expect(getLock.headers.get('X-WOPI-Lock')).toBe('host-lock-a');

    const refresh = await wopiRequest(testEnv, FILE_ID, editorToken, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'REFRESH_LOCK',
        'X-WOPI-Lock': 'host-lock-a',
      },
    });
    expect(refresh.status).toBe(200);

    const viewerPut = await wopiRequest(testEnv, FILE_ID, viewerToken, {
      method: 'POST',
      headers: { 'X-WOPI-Lock': 'host-lock-a' },
      body: 'viewer-write',
    }, '/contents');
    expect(viewerPut.status).toBe(403);

    const noLockPut = await wopiRequest(testEnv, FILE_ID, editorToken, {
      method: 'POST',
      body: 'unlocked-write',
    }, '/contents');
    expect(noLockPut.status).toBe(409);

    const put = await wopiRequest(testEnv, FILE_ID, editorToken, {
      method: 'POST',
      headers: {
        'X-WOPI-Lock': 'host-lock-a',
        'X-WOPI-MaxExpectedSize': '1024',
      },
      body: 'latest collabora bytes',
    }, '/contents');
    expect(put.status).toBe(200);

    const versionBeforeUnlock = await testEnv.DB.prepare(
      'SELECT current_version_num FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, FILE_ID)
      .first<{ current_version_num: number }>();
    expect(versionBeforeUnlock?.current_version_num).toBe(1);

    const unlocked = await wopiRequest(testEnv, FILE_ID, editorToken, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'UNLOCK',
        'X-WOPI-Lock': 'host-lock-a',
      },
    });
    expect(unlocked.status).toBe(200);

    const versionAfterUnlock = await testEnv.DB.prepare(
      'SELECT current_version_num, size_bytes FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, FILE_ID)
      .first<{ current_version_num: number; size_bytes: number }>();
    expect(versionAfterUnlock?.current_version_num).toBe(2);
    expect(versionAfterUnlock?.size_bytes).toBe('latest collabora bytes'.length);

    const getDraftContent = await wopiRequest(
      testEnv,
      FILE_ID,
      editorToken,
      {},
      '/contents'
    );
    expect(new TextDecoder().decode(await getDraftContent.arrayBuffer())).toBe('latest collabora bytes');
  });

  it('supports UNLOCK_AND_RELOCK with matching old lock and rejects mismatched tokens', async () => {
    const testEnv = buildTestEnv();
    const token = await issueToken(testEnv);
    await wopiRequest(testEnv, FILE_ID, token, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'relock-a' },
    });

    const wrong = await wopiRequest(testEnv, FILE_ID, token, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'UNLOCK_AND_RELOCK',
        'X-WOPI-OldLock': 'wrong',
        'X-WOPI-Lock': 'relock-b',
      },
    });
    expect(wrong.status).toBe(409);
    expect(wrong.headers.get('X-WOPI-Lock')).toBe('relock-a');

    const relocked = await wopiRequest(testEnv, FILE_ID, token, {
      method: 'POST',
      headers: {
        'X-WOPI-Override': 'UNLOCK_AND_RELOCK',
        'X-WOPI-OldLock': 'relock-a',
        'X-WOPI-Lock': 'relock-b',
      },
    });
    expect(relocked.status).toBe(200);
    expect(relocked.headers.get('X-WOPI-Lock')).toBe('relock-b');

    await wopiRequest(testEnv, FILE_ID, token, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': 'relock-b' },
    });
  });
});
