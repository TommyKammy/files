import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { MULTIPART_MAX_BYTES } from '../src/services/file-upload-common';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  computeMultipartPlan,
  initiateMultipartUpload,
  MAX_MULTIPART_PARTS,
} from '../src/services/multipart-storage-provider';
import { issueSignedMultipartPartUrl } from '../src/services/storage-url-provider';
import type { OidcEnv } from '../src/types/oidc';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function authHeaders(
  userId = 'mp-editor',
  role: 'sys_admin' | 'member' = 'member',
  tenantId = 'tenant-mp'
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
    LOCAL_PROXY_SECRET: 'test-hmac-mp-secret',
    ...overrides,
  } as OidcEnv;
}

describe('Large-File S3 Multipart Upload API (TOM-14)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        'INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES (?, ?, ?, ?)'
      ).bind('tenant-mp', 'Multipart Org', 'mp-org', 50 * MIB),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES ('tenant-mp')"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES ('mp-editor', 'tenant-mp', 'editor@mp.example.com', 'MP Editor', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES ('mp-folder-unset', 'tenant-mp', NULL, 'Large Uploads', 0, 1, 'unset', 'mp-editor')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES ('tenant-mp', 'mp-folder-unset', 'mp-folder-unset', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES ('mp-p1', 'tenant-mp', 'folder', 'mp-folder-unset', 'user', 'mp-editor', 'editor', 'mp-editor')`
      ),
      env.DB.prepare(
        "INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes) VALUES ('tenant-mp', 'unset', 0, 0)"
      ),
    ]);
  });

  it('computes dynamic multipart plan within <= 9,500 parts up to 4.995 TiB', () => {
    const plan100M = computeMultipartPlan(100 * MIB);
    expect(plan100M.partSizeBytes).toBe(16 * MIB);
    expect(plan100M.totalParts).toBe(7);

    const plan200G = computeMultipartPlan(200 * GIB);
    expect(plan200G.partSizeBytes).toBe(32 * MIB);
    expect(plan200G.totalParts).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);

    const plan500G = computeMultipartPlan(500 * GIB);
    expect(plan500G.partSizeBytes).toBe(64 * MIB);
    expect(plan500G.totalParts).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);

    const planMax = computeMultipartPlan(MULTIPART_MAX_BYTES);
    expect(planMax.totalParts).toBeLessThanOrEqual(MAX_MULTIPART_PARTS);
    expect(planMax.partSizeBytes * planMax.totalParts).toBeGreaterThanOrEqual(MULTIPART_MAX_BYTES);
  });

  it('rejects < 5 MiB files and quota overflow on /init', async () => {
    const testEnv = buildTestEnv();

    const tooSmallRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/init', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: 'mp-folder-unset',
          fileName: 'small.bin',
          sizeBytes: 4 * MIB,
        }),
      }),
      testEnv
    );
    expect(tooSmallRes.status).toBe(400);
    const smallBody = (await tooSmallRes.json()) as { code?: string };
    expect(smallBody.code).toBe('USE_SINGLE_UPLOAD');

    const overQuotaRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/init', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: 'mp-folder-unset',
          fileName: 'huge.bin',
          sizeBytes: 60 * MIB,
        }),
      }),
      testEnv
    );
    expect(overQuotaRes.status).toBe(413);
  });

  it('completes 2-part R2 local_proxy upload, validates /part-urls bounds, verifies size & FTS', async () => {
    const queueSend = vi.fn(async () => {});
    const testEnv = buildTestEnv({ JOBS_QUEUE: { send: queueSend } as unknown as Queue });
    const totalSize = 17 * MIB; // 16 MiB part 1 + 1 MiB part 2

    const initRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/init', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: 'mp-folder-unset',
          fileName: 'model-weights.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: totalSize,
        }),
      }),
      testEnv
    );
    expect(initRes.status).toBe(201);
    const initJson = (await initRes.json()) as {
      fileId: string;
      versionId: string;
      uploadId: string;
      r2ObjectKey: string;
      partSizeBytes: number;
      totalParts: number;
      parts: Array<{ partNumber: number; url: string }>;
    };
    expect(initJson.totalParts).toBe(2);
    expect(initJson.partSizeBytes).toBe(16 * MIB);
    expect(initJson.parts).toHaveLength(2);

    // Validate /part-urls rejects out-of-range and >100 batches
    const invalidPartRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/part-urls', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileId: initJson.fileId,
          versionId: initJson.versionId,
          partNumbers: [3],
        }),
      }),
      testEnv
    );
    expect(invalidPartRes.status).toBe(400);

    const tooManyPartsRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/part-urls', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileId: initJson.fileId,
          versionId: initJson.versionId,
          partNumbers: Array.from({ length: 101 }, (_, i) => i + 1),
        }),
      }),
      testEnv
    );
    expect(tooManyPartsRes.status).toBe(400);

    const refreshRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/part-urls', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileId: initJson.fileId,
          versionId: initJson.versionId,
          partNumbers: [2],
        }),
      }),
      testEnv
    );
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      parts: Array<{ partNumber: number; url: string }>;
    };

    // Upload part 1 (16 MiB)
    const part1Buf = new Uint8Array(16 * MIB);
    part1Buf[0] = 0x41;
    const put1Res = await app.fetch(
      new Request(`http://127.0.0.1:8787${initJson.parts[0].url}`, {
        method: 'PUT',
        body: part1Buf,
      }),
      testEnv
    );
    expect(put1Res.status).toBe(200);
    const put1Json = (await put1Res.json()) as { partNumber: number; etag: string };

    // Upload part 2 (1 MiB) using refreshed URL
    const part2Buf = new Uint8Array(1 * MIB);
    part2Buf[0] = 0x42;
    const put2Res = await app.fetch(
      new Request(`http://127.0.0.1:8787${refreshed.parts[0].url}`, {
        method: 'PUT',
        body: part2Buf,
      }),
      testEnv
    );
    expect(put2Res.status).toBe(200);
    const put2Json = (await put2Res.json()) as { partNumber: number; etag: string };

    // Complete upload
    const completeRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/complete', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileId: initJson.fileId,
          versionId: initJson.versionId,
          parts: [
            { partNumber: 1, etag: put1Json.etag },
            { partNumber: 2, etag: put2Json.etag },
          ],
        }),
      }),
      testEnv
    );
    expect(completeRes.status).toBe(200);
    const completeJson = (await completeRes.json()) as {
      file: { upload_state: string; size_bytes: number };
      aiClassificationQueued: boolean;
    };
    expect(completeJson.file.upload_state).toBe('active');
    expect(completeJson.file.size_bytes).toBe(totalSize);
    expect(completeJson.aiClassificationQueued).toBe(true);
    expect(queueSend).toHaveBeenCalledTimes(1);

    const headObj = await env.BUCKET.head(initJson.r2ObjectKey);
    expect(headObj?.size).toBe(totalSize);

    const ftsHit = await env.DB.prepare(
      "SELECT file_id FROM files_fts WHERE files_fts MATCH 'model'"
    ).first<{ file_id: string }>();
    expect(ftsHit?.file_id).toBe(initJson.fileId);

    const statRow = await env.DB.prepare(
      "SELECT file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = 'tenant-mp' AND classification = 'unset'"
    ).first<{ file_count: number; total_bytes: number }>();
    expect(statRow).toEqual({ file_count: 1, total_bytes: totalSize });
  });

  it('aborts pending multipart upload and cleans up DB rows + audit log', async () => {
    const testEnv = buildTestEnv();
    const initRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/init', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: 'mp-folder-unset',
          fileName: 'aborted-archive.tar.gz',
          sizeBytes: 10 * MIB,
        }),
      }),
      testEnv
    );
    expect(initRes.status).toBe(201);
    const initJson = (await initRes.json()) as { fileId: string; versionId: string };

    const abortRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/abort', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileId: initJson.fileId,
          versionId: initJson.versionId,
        }),
      }),
      testEnv
    );
    expect(abortRes.status).toBe(200);

    const danglingFile = await env.DB.prepare('SELECT id FROM files WHERE id = ?')
      .bind(initJson.fileId)
      .first();
    expect(danglingFile).toBeNull();

    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE target_id = ? AND action = 'file.multipart_abort'"
    )
      .bind(initJson.fileId)
      .first<{ action: string }>();
    expect(audit?.action).toBe('file.multipart_abort');
  });

  it('rejects size mismatch on /complete and deletes the assembled R2 object', async () => {
    const testEnv = buildTestEnv();
    // Claim 10 MiB at init, upload a single 5 MiB part, and complete
    const initRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/init', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: 'mp-folder-unset',
          fileName: 'tampered-size.bin',
          sizeBytes: 10 * MIB,
        }),
      }),
      testEnv
    );
    expect(initRes.status).toBe(201);
    const initJson = (await initRes.json()) as {
      fileId: string;
      versionId: string;
      r2ObjectKey: string;
      parts: Array<{ url: string }>;
    };

    const putRes = await app.fetch(
      new Request(`http://127.0.0.1:8787${initJson.parts[0].url}`, {
        method: 'PUT',
        body: new Uint8Array(5 * MIB),
      }),
      testEnv
    );
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { etag: string };

    const completeRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/multipart/complete', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          fileId: initJson.fileId,
          versionId: initJson.versionId,
          parts: [{ partNumber: 1, etag: putJson.etag }],
        }),
      }),
      testEnv
    );
    expect(completeRes.status).toBe(400);
    const errJson = (await completeRes.json()) as { code?: string };
    expect(errJson.code).toBe('SIZE_MISMATCH');

    const objAfterReject = await env.BUCKET.head(initJson.r2ObjectKey);
    expect(objAfterReject).toBeNull();
  });

  it('supports s3_presigned multipart S3 XML API calls and SigV4 part signing', async () => {
    const s3Env = buildTestEnv({
      STORAGE_MODE: 's3_presigned',
      R2_ACCOUNT_ID: 'acc-123',
      R2_BUCKET_NAME: 'files-bucket',
      R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });

    const recorded: Array<{ url: string; method: string; body: string }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const body =
        typeof init?.body === 'string'
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : '';
      recorded.push({ url, method, body });

      if (method === 'POST' && url.includes('?uploads')) {
        return new Response(
          '<InitiateMultipartUploadResult><UploadId>s3-up-999</UploadId></InitiateMultipartUploadResult>',
          { status: 200 }
        );
      }
      if (method === 'POST' && url.includes('?uploadId=s3-up-999')) {
        return new Response('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>', {
          status: 200,
        });
      }
      if (method === 'DELETE' && url.includes('?uploadId=s3-up-999')) {
        return new Response(null, { status: 204 });
      }
      return new Response('Unexpected S3 call', { status: 500 });
    });

    try {
      const uploadId = await initiateMultipartUpload(
        s3Env,
        'tenants/tenant-mp/objects/f1/v1',
        'application/octet-stream'
      );
      expect(uploadId).toBe('s3-up-999');

      const signedPart = await issueSignedMultipartPartUrl(s3Env, {
        objectKey: 'tenants/tenant-mp/objects/f1/v1',
        tenantId: 'tenant-mp',
        uploadId,
        partNumber: 2,
        maxSizeBytes: 16 * MIB,
        expiresInSeconds: 600,
      });
      expect(signedPart.url).toContain('partNumber=2');
      expect(signedPart.url).toContain('uploadId=s3-up-999');
      expect(signedPart.url).toContain('X-Amz-Signature=');

      await completeMultipartUpload(s3Env, 'tenants/tenant-mp/objects/f1/v1', uploadId, [
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 1, etag: 'etag-1' },
      ]);
      const completeCall = recorded.find(
        (r) => r.method === 'POST' && r.url.includes('?uploadId=s3-up-999')
      );
      const completeBody = completeCall?.body ?? '';
      // Verify parts were sorted (1 before 2) and ETags normalized
      expect(completeBody).toContain('<PartNumber>1</PartNumber><ETag>&quot;etag-1&quot;</ETag>');
      expect(completeBody.indexOf('<PartNumber>1</PartNumber>')).toBeLessThan(
        completeBody.indexOf('<PartNumber>2</PartNumber>')
      );

      await abortMultipartUpload(s3Env, 'tenants/tenant-mp/objects/f1/v1', uploadId);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
