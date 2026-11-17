import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { ensureLocalDevDocxContent } from '../src/services/wopi-local-docx';
import type { FileRow } from '../src/services/file-upload-common';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-wopi-local-docx';
const USER_ID = 'wopi-local-docx-user';
const FILE_ID = 'file-9001';

function authHeaders(): Record<string, string> {
  return {
    'X-Dev-User-Id': USER_ID,
    'X-Dev-User-Role': 'member',
    'X-Dev-Tenant-Id': TENANT_ID,
    'X-Dev-User-Email': 'local-docx@example.com',
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
    LOCAL_PROXY_SECRET: 'wopi-local-docx-secret',
    WOPI_TOKEN_SECRET: 'wopi-local-docx-token-secret',
    COLLABORA_URL: 'http://localhost:9980',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
  } as OidcEnv;
}

describe('WOPI local dev .docx materialization', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'WOPI Local Docx', 'wopi-local-docx', 5000000)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES (?, ?, 'local-docx@example.com', 'Local Docx', 'member', 'active')`
      ).bind(USER_ID, TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           created_by, updated_by
         ) VALUES (?, ?, NULL, 'seed.docx', 'docx',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           12, 'active', NULL, 1, 'internal', ?, ?)`
      ).bind(FILE_ID, TENANT_ID, USER_ID, USER_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by
         ) VALUES ('wopi-local-docx-perm', ?, 'file', ?, 'user', ?, 'editor', ?)`
      ).bind(TENANT_ID, FILE_ID, USER_ID, USER_ID),
    ]);
  });

  it('materializes benchmark seed content and issues a WOPI session', async () => {
    const file = (await env.DB.prepare('SELECT * FROM files WHERE id = ?')
      .bind(FILE_ID)
      .first<FileRow>())!;
    const ensured = await ensureLocalDevDocxContent(env as OidcEnv, file, null, null);
    expect(ensured.currentVersion).toBeTruthy();
    const object = await env.BUCKET.get(ensured.currentVersion!.r2_object_key);
    expect(object).toBeTruthy();
    const bytes = new Uint8Array(await object!.arrayBuffer());
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const versionRow = await env.DB.prepare(
      'SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ?'
    )
      .bind(TENANT_ID, FILE_ID)
      .first<{ id: string }>();
    expect(versionRow?.id).toBe(ensured.currentVersion!.id);
    const updated = await env.DB.prepare('SELECT * FROM files WHERE id = ?')
      .bind(FILE_ID)
      .first<FileRow>();
    expect(updated?.current_version_id).toBe(ensured.currentVersion!.id);

    const res = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_ID}/wopi-session`, {
        method: 'POST',
        headers: authHeaders(),
      }),
      buildTestEnv()
    );
    expect(res.status).toBe(201);
  });
});
