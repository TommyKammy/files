import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-drive-lock';
const USER_ID = 'drive-editor';
const FILE_A = 'drive-file-a';
const FILE_B = 'drive-file-b';
const FILE_CONF = 'drive-file-conf';

function authHeaders(): Record<string, string> {
  return {
    'X-Dev-User-Id': USER_ID,
    'X-Dev-User-Role': 'sys_admin',
    'X-Dev-Tenant-Id': TENANT_ID,
    'X-Dev-User-Email': `${USER_ID}@example.com`,
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
    LOCAL_PROXY_SECRET: 'drive-lock-secret',
    WOPI_TOKEN_SECRET: 'drive-lock-token-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
  } as OidcEnv;
}

async function issueWopiToken(
  testEnv: OidcEnv,
  fileId: string
): Promise<string> {
  const res = await app.fetch(
    new Request(`http://127.0.0.1:8787/api/files/${fileId}/wopi-session`, {
      method: 'POST',
      headers: authHeaders(),
    }),
    testEnv
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Files Drive lock REST API and WOPI/Drive mutual exclusion', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'Drive Lock Org', 'drive-lock-org', 5000000)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES (?, ?, 'drive-editor@example.com', 'Drive Editor', 'sys_admin', 'active')`
      ).bind(USER_ID, TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           created_by, updated_by
         ) VALUES
           (?, ?, NULL, 'drive-a.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             10, 'active', 'drive-v-a', 1, 'internal', ?, ?),
           (?, ?, NULL, 'drive-b.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             10, 'active', 'drive-v-b', 1, 'internal', ?, ?),
           (?, ?, NULL, 'drive-conf.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             10, 'active', 'drive-v-conf', 1, 'confidential', ?, ?)`
      ).bind(
        FILE_A,
        TENANT_ID,
        USER_ID,
        USER_ID,
        FILE_B,
        TENANT_ID,
        USER_ID,
        USER_ID,
        FILE_CONF,
        TENANT_ID,
        USER_ID,
        USER_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, size_bytes,
           mime_type, upload_status, uploaded_by
         ) VALUES
           ('drive-v-a', ?, ?, 1, ?, 10,
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'completed', ?),
           ('drive-v-b', ?, ?, 1, ?, 10,
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'completed', ?),
           ('drive-v-conf', ?, ?, 1, ?, 10,
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'completed', ?)`
      ).bind(
        TENANT_ID,
        FILE_A,
        `tenants/${TENANT_ID}/objects/${FILE_A}/v1`,
        USER_ID,
        TENANT_ID,
        FILE_B,
        `tenants/${TENANT_ID}/objects/${FILE_B}/v1`,
        USER_ID,
        TENANT_ID,
        FILE_CONF,
        `tenants/${TENANT_ID}/objects/${FILE_CONF}/v1`,
        USER_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by
         ) VALUES
           ('drive-perm-a', ?, 'file', ?, 'user', ?, 'editor', ?),
           ('drive-perm-b', ?, 'file', ?, 'user', ?, 'editor', ?),
           ('drive-perm-conf', ?, 'file', ?, 'user', ?, 'editor', ?)`
      ).bind(
        TENANT_ID,
        FILE_A,
        USER_ID,
        USER_ID,
        TENANT_ID,
        FILE_B,
        USER_ID,
        USER_ID,
        TENANT_ID,
        FILE_CONF,
        USER_ID,
        USER_ID
      ),
    ]);
    await env.BUCKET.put(`tenants/${TENANT_ID}/objects/${FILE_A}/v1`, 'drive-a!!');
    await env.BUCKET.put(`tenants/${TENANT_ID}/objects/${FILE_B}/v1`, 'drive-b!!');
    await env.BUCKET.put(`tenants/${TENANT_ID}/objects/${FILE_CONF}/v1`, 'secret!!!');
  });

  it('acquires, reports and releases a desktop_exclusive lock', async () => {
    const testEnv = buildTestEnv();

    const acquired = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_A}/lock`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'drive-lock-a', ttlSeconds: 300 }),
      }),
      testEnv
    );
    expect(acquired.status).toBe(201);
    const body = (await acquired.json()) as {
      lock: { mode: string; lockId: string };
      syncPolicy: string;
    };
    expect(body.lock.mode).toBe('desktop_exclusive');
    expect(body.lock.lockId).toBe('drive-lock-a');
    expect(body.syncPolicy).toBe('full');

    const status = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_A}/lock-status`, {
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      lock: { lockId: string };
      readOnly: boolean;
    };
    expect(statusBody.lock.lockId).toBe('drive-lock-a');
    expect(statusBody.readOnly).toBe(true);

    const wrongUnlock = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_A}/lock`, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'wrong-lock' }),
      }),
      testEnv
    );
    expect(wrongUnlock.status).toBe(409);

    const unlocked = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_A}/lock`, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'drive-lock-a' }),
      }),
      testEnv
    );
    expect(unlocked.status).toBe(200);
    expect(((await unlocked.json()) as { released: boolean }).released).toBe(true);
  });

  it('forces WOPI CheckFileInfo read-only and rejects WOPI LOCK while desktop lock is active', async () => {
    const testEnv = buildTestEnv();
    const token = await issueWopiToken(testEnv, FILE_A);
    await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_A}/lock`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'drive-desktop-lock' }),
      }),
      testEnv
    );

    const checkFileInfo = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${FILE_A}?access_token=${encodeURIComponent(token)}`
      ),
      testEnv
    );
    expect(checkFileInfo.status).toBe(200);
    const info = (await checkFileInfo.json()) as {
      UserCanWrite: boolean;
      ReadOnly: boolean;
    };
    expect(info.UserCanWrite).toBe(false);
    expect(info.ReadOnly).toBe(true);

    const readOnlySession = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_A}/wopi-session`, {
        method: 'POST',
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(readOnlySession.status).toBe(201);
    const readOnlyBody = (await readOnlySession.json()) as {
      canWrite: boolean;
      readOnly: boolean;
      readOnlyReason: string | null;
      accessToken: string;
    };
    expect(readOnlyBody.canWrite).toBe(false);
    expect(readOnlyBody.readOnly).toBe(true);
    expect(readOnlyBody.readOnlyReason).toBe('desktop_lock');

    const desktopPutWithReadOnlyToken = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${FILE_A}/contents?access_token=${encodeURIComponent(readOnlyBody.accessToken)}`,
        {
          method: 'POST',
          headers: { 'X-WOPI-Lock': 'drive-desktop-lock' },
          body: 'desktop-blocked-write',
        }
      ),
      testEnv
    );
    expect(desktopPutWithReadOnlyToken.status).toBe(403);
    expect(
      ((await desktopPutWithReadOnlyToken.json()) as { code: string }).code
    ).toBe('WOPI_READ_ONLY');

    const desktopPutWithExistingToken = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${FILE_A}/contents?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'X-WOPI-Lock': 'drive-desktop-lock' },
          body: 'desktop-blocked-write',
        }
      ),
      testEnv
    );
    expect(desktopPutWithExistingToken.status).toBe(403);
    expect(
      ((await desktopPutWithExistingToken.json()) as { code: string }).code
    ).toBe('WOPI_DESKTOP_LOCK_ACTIVE');

    const wopiLock = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${FILE_A}?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: {
            'X-WOPI-Override': 'LOCK',
            'X-WOPI-Lock': 'wopi-lock-a',
          },
        }
      ),
      testEnv
    );
    expect(wopiLock.status).toBe(409);
    expect(wopiLock.headers.get('X-WOPI-Lock')).toBe('drive-desktop-lock');

    await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_A}/lock`, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'drive-desktop-lock' }),
      }),
      testEnv
    );
  });

  it('rejects Files Drive lock while a WOPI collaborative lock is active', async () => {
    const testEnv = buildTestEnv();
    const token = await issueWopiToken(testEnv, FILE_B);
    const wopiLock = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${FILE_B}?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: {
            'X-WOPI-Override': 'LOCK',
            'X-WOPI-Lock': 'wopi-lock-b',
          },
        }
      ),
      testEnv
    );
    expect(wopiLock.status).toBe(200);

    const webLockStatus = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_B}/lock-status`, {
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(webLockStatus.status).toBe(200);
    const webLockBody = (await webLockStatus.json()) as {
      lock: { mode: string; lockId: string };
      readOnly: boolean;
      canWrite: boolean;
      syncPolicy: string;
    };
    expect(webLockBody.lock.mode).toBe('wopi_collab');
    expect(webLockBody.lock.lockId).toBe('wopi-lock-b');
    expect(webLockBody.readOnly).toBe(false);
    expect(webLockBody.canWrite).toBe(true);
    expect(webLockBody.syncPolicy).toBe('full');

    const driveLock = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_B}/lock`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'drive-lock-b' }),
      }),
      testEnv
    );
    expect(driveLock.status).toBe(409);
    const body = (await driveLock.json()) as {
      code: string;
      readOnlyRecommended: boolean;
      webEditUrl: string;
      wopiSessionPath: string;
    };
    expect(body.code).toBe('WOPI_LOCK_ACTIVE');
    expect(body.readOnlyRecommended).toBe(true);
    expect(body.webEditUrl).toContain(FILE_B);
    expect(body.wopiSessionPath).toContain(FILE_B);

    await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${FILE_B}?access_token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: {
            'X-WOPI-Override': 'UNLOCK',
            'X-WOPI-Lock': 'wopi-lock-b',
          },
        }
      ),
      testEnv
    );
  });

  it('returns cloud_preview_only sync policy for confidential files', async () => {
    const testEnv = buildTestEnv();
    const res = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_CONF}/lock`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'drive-conf-lock' }),
      }),
      testEnv
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { syncPolicy: string };
    expect(body.syncPolicy).toBe('cloud_preview_only');

    const status = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_CONF}/lock-status`, {
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      lock: { mode: string };
      readOnly: boolean;
      syncPolicy: string;
    };
    expect(statusBody.lock.mode).toBe('desktop_exclusive');
    expect(statusBody.readOnly).toBe(true);
    expect(statusBody.syncPolicy).toBe('cloud_preview_only');

    await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_CONF}/lock`, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify({ lockId: 'drive-conf-lock' }),
      }),
      testEnv
    );
  });
});
