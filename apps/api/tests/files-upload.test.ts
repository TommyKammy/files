import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { issueSignedStorageUrl } from '../src/services/storage-url-provider';
import type { OidcEnv } from '../src/types/oidc';

function authHeaders(
  userId = 'up-editor',
  role: 'sys_admin' | 'member' = 'member',
  tenantId = 'tenant-upload'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-proxy-secret',
    ...overrides,
  } as OidcEnv;
}

describe('Storage URL Provider & Single Upload API (TOM-13)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-upload', 'Upload Org', 'upload-org', 5000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, require_watermark_confidential) VALUES ('tenant-upload', 1)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('up-editor', 'tenant-upload', 'editor@upload.example.com', 'Editor User', 'member', 'active'),
           ('up-previewer', 'tenant-upload', 'preview@upload.example.com', 'Preview User', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('up-folder-unset', 'tenant-upload', NULL, 'Inbox', 0, 1, 'unset', 'up-editor'),
           ('up-folder-conf', 'tenant-upload', NULL, 'Secret Vault', 0, 1, 'confidential', 'up-editor')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-upload', 'up-folder-unset', 'up-folder-unset', 0),
           ('tenant-upload', 'up-folder-conf', 'up-folder-conf', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('up-p1', 'tenant-upload', 'folder', 'up-folder-unset', 'user', 'up-editor', 'editor', 'up-editor'),
           ('up-p2', 'tenant-upload', 'folder', 'up-folder-conf', 'user', 'up-editor', 'editor', 'up-editor'),
           ('up-p3', 'tenant-upload', 'folder', 'up-folder-conf', 'user', 'up-previewer', 'previewer', 'up-editor')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES ('tenant-upload', 'unset', 0, 0), ('tenant-upload', 'confidential', 0, 0)`
      ),
    ]);
  });

  it('completes local_proxy upload lifecycle, enforces CSP sandbox & XSS prevention, and enqueues AI only for unset', async () => {
    const queueSend = vi.fn(async () => {});
    const testEnv = buildTestEnv({ JOBS_QUEUE: { send: queueSend } as unknown as Queue });
    const payloadBytes = new TextEncoder().encode('Hello confidential contract body!');

    // 1. Upload into confidential folder -> inherits confidential, does NOT enqueue AI
    const confInitRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-init', {
        method: 'POST',
        headers: authHeaders('up-editor'),
        body: JSON.stringify({
          folderId: 'up-folder-conf',
          fileName: 'xss-test.html',
          mimeType: 'text/html',
          sizeBytes: payloadBytes.byteLength,
        }),
      }),
      testEnv
    );
    expect(confInitRes.status).toBe(201);
    const confInit = (await confInitRes.json()) as {
      fileId: string;
      versionId: string;
      r2ObjectKey: string;
      classification: string;
      uploadUrl: string;
    };
    expect(confInit.classification).toBe('confidential');
    expect(confInit.r2ObjectKey).toBe(`tenants/tenant-upload/objects/${confInit.fileId}/v1`);

    // Tampered proxy claim (altering maxSize) returns 403
    const tamperedUrl = confInit.uploadUrl.replace(/maxSize=\d+/, 'maxSize=9999999');
    expect(tamperedUrl).not.toBe(confInit.uploadUrl);
    expect(
      (
        await app.fetch(
          new Request(`http://127.0.0.1:8787${tamperedUrl}`, {
            method: 'PUT',
            body: payloadBytes,
          }),
          testEnv
        )
      ).status
    ).toBe(403);

    // Oversized body over signed maxSize returns 413
    expect(
      (
        await app.fetch(
          new Request(`http://127.0.0.1:8787${confInit.uploadUrl}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/html' },
            body: new Uint8Array(payloadBytes.byteLength + 10),
          }),
          testEnv
        )
      ).status
    ).toBe(413);

    // Valid PUT via local proxy writes R2 object
    const putRes = await app.fetch(
      new Request(`http://127.0.0.1:8787${confInit.uploadUrl}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/html' },
        body: payloadBytes,
      }),
      testEnv
    );
    expect(putRes.status).toBe(200);

    // Finalize upload-complete -> becomes active, stats incremented, NOT queued for AI (already confidential)
    const confCompleteRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-complete', {
        method: 'POST',
        headers: authHeaders('up-editor'),
        body: JSON.stringify({ fileId: confInit.fileId, versionId: confInit.versionId }),
      }),
      testEnv
    );
    expect(confCompleteRes.status).toBe(200);
    const confComplete = (await confCompleteRes.json()) as {
      file: { upload_state: string; size_bytes: number };
      aiClassificationQueued: boolean;
    };
    expect(confComplete.file.upload_state).toBe('active');
    expect(confComplete.aiClassificationQueued).toBe(false);
    expect(queueSend).toHaveBeenCalledTimes(0);

    // Preview URL for .html forces attachment disposition + sandbox CSP + watermark payload for confidential
    const previewRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${confInit.fileId}/content-url?intent=preview`, {
        headers: authHeaders('up-previewer'),
      }),
      testEnv
    );
    expect(previewRes.status).toBe(200);
    const previewBody = (await previewRes.json()) as {
      url: string;
      disposition: string;
      requireWatermark: boolean;
      watermarkText: string;
    };
    expect(previewBody.disposition).toBe('attachment'); // Stored XSS defense for .html!
    expect(previewBody.requireWatermark).toBe(true);
    expect(previewBody.watermarkText).toContain('up-previewer@example.com');

    // Previewer requesting download returns 403
    expect(
      (
        await app.fetch(
          new Request(
            `http://127.0.0.1:8787/api/files/${confInit.fileId}/content-url?intent=download`,
            { headers: authHeaders('up-previewer') }
          ),
          testEnv
        )
      ).status
    ).toBe(403);

    // Fetching signed GET proxy object enforces sandbox CSP, nosniff, no-store
    const getProxyRes = await app.fetch(
      new Request(`http://127.0.0.1:8787${previewBody.url}`),
      testEnv
    );
    expect(getProxyRes.status).toBe(200);
    expect(getProxyRes.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
    expect(getProxyRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(getProxyRes.headers.get('Cache-Control')).toBe('no-store');
    expect(getProxyRes.headers.get('Content-Disposition')).toContain('attachment;');

    // 2. Upload into unset folder -> enqueues JOBS_QUEUE classification job!
    const unsetBytes = new TextEncoder().encode('Normal PDF content');
    const unsetInit = (await (
      await app.fetch(
        new Request('http://127.0.0.1:8787/api/files/upload-init', {
          method: 'POST',
          headers: authHeaders('up-editor'),
          body: JSON.stringify({
            folderId: 'up-folder-unset',
            fileName: 'memo.pdf',
            mimeType: 'application/pdf',
            sizeBytes: unsetBytes.byteLength,
          }),
        }),
        testEnv
      )
    ).json()) as { fileId: string; versionId: string; uploadUrl: string };

    await app.fetch(
      new Request(`http://127.0.0.1:8787${unsetInit.uploadUrl}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: unsetBytes,
      }),
      testEnv
    );
    const unsetCompleteRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-complete', {
        method: 'POST',
        headers: authHeaders('up-editor'),
        body: JSON.stringify({ fileId: unsetInit.fileId, versionId: unsetInit.versionId }),
      }),
      testEnv
    );
    expect(unsetCompleteRes.status).toBe(200);
    expect(
      ((await unsetCompleteRes.json()) as { aiClassificationQueued: boolean }).aiClassificationQueued
    ).toBe(true);
    expect(queueSend).toHaveBeenCalledTimes(1);
  });

  it('rejects quota exceeded and cleans up mismatched objects at upload-complete', async () => {
    const testEnv = buildTestEnv();

    // Quota in tenant-upload is 5000 bytes; exceeding remaining quota fails init with 413
    const tooLargeRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-init', {
        method: 'POST',
        headers: authHeaders('up-editor'),
        body: JSON.stringify({
          folderId: 'up-folder-unset',
          fileName: 'huge.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: 5001,
        }),
      }),
      testEnv
    );
    expect(tooLargeRes.status).toBe(413);

    // Mismatch test: declare 100 bytes at init, write 10 bytes to R2 directly, complete must delete R2 & return 400
    const misInit = (await (
      await app.fetch(
        new Request('http://127.0.0.1:8787/api/files/upload-init', {
          method: 'POST',
          headers: authHeaders('up-editor'),
          body: JSON.stringify({
            folderId: 'up-folder-unset',
            fileName: 'lie.bin',
            mimeType: 'application/octet-stream',
            sizeBytes: 100,
          }),
        }),
        testEnv
      )
    ).json()) as { fileId: string; versionId: string; r2ObjectKey: string };

    await env.BUCKET.put(misInit.r2ObjectKey, '1234567890'); // 10 bytes instead of 100
    const mismatchComplete = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-complete', {
        method: 'POST',
        headers: authHeaders('up-editor'),
        body: JSON.stringify({ fileId: misInit.fileId, versionId: misInit.versionId }),
      }),
      testEnv
    );
    expect(mismatchComplete.status).toBe(400);
    expect(await env.BUCKET.head(misInit.r2ObjectKey)).toBeNull();
  });

  it('generates SigV4 presigned URLs in s3_presigned mode', async () => {
    const s3Env = buildTestEnv({
      STORAGE_MODE: 's3_presigned',
      R2_ACCOUNT_ID: '0123456789abcdef',
      R2_BUCKET_NAME: 'files-staging',
      R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });

    const signedPut = await issueSignedStorageUrl(s3Env, {
      method: 'PUT',
      objectKey: 'tenants/t1/objects/f1/v1',
      tenantId: 't1',
      expiresInSeconds: 300,
      contentType: 'application/pdf',
    });
    expect(signedPut.url).toContain('0123456789abcdef.r2.cloudflarestorage.com/files-staging/');
    expect(signedPut.url).toContain('X-Amz-Signature=');

    const signedGet = await issueSignedStorageUrl(s3Env, {
      method: 'GET',
      objectKey: 'tenants/t1/objects/f1/v1',
      tenantId: 't1',
      expiresInSeconds: 300,
      disposition: 'inline',
      filename: 'xss.svg',
      contentType: 'image/svg+xml',
    });
    expect(signedGet.url).toContain('response-content-disposition=attachment');
    expect(signedGet.url).toContain('X-Amz-Signature=');
  });
});
