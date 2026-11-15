import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

type TestEnvWithFr = OidcEnv & {
  TURNSTILE_SECRET_KEY?: string;
  FILE_REQUEST_RATE_LIMIT_PER_MIN?: string;
};

function authHeaders(
  userId = 'fr-editor',
  role: 'sys_admin' | 'member' = 'member',
  tenantId = 'tenant-fr'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@fr.example.com`,
    'Content-Type': 'application/json',
  };
}

function buildTestEnv(overrides: Partial<TestEnvWithFr> = {}): TestEnvWithFr {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-fr-secret-001',
    SESSION_SECRET: 'test-session-fr-secret-001',
    ...overrides,
  } as TestEnvWithFr;
}

describe('External File Requests / Blind Dropbox API (TOM-16)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-fr', 'Dropbox Org', 'dropbox-org', 100000)"
      ),
      env.DB.prepare("INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES ('tenant-fr')"),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('fr-editor', 'tenant-fr', 'fr-editor@fr.example.com', 'FR Editor', 'member', 'active'),
           ('fr-viewer', 'tenant-fr', 'fr-viewer@fr.example.com', 'FR Viewer', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('fr-folder-int', 'tenant-fr', NULL, 'Vendor Portal', 0, 1, 'unset', 'fr-editor'),
           ('fr-folder-conf', 'tenant-fr', NULL, 'NDA Submissions', 0, 1, 'confidential', 'fr-editor')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-fr', 'fr-folder-int', 'fr-folder-int', 0),
           ('tenant-fr', 'fr-folder-conf', 'fr-folder-conf', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('fr-p1', 'tenant-fr', 'folder', 'fr-folder-int', 'user', 'fr-editor', 'editor', 'fr-editor'),
           ('fr-p2', 'tenant-fr', 'folder', 'fr-folder-int', 'user', 'fr-viewer', 'viewer', 'fr-editor'),
           ('fr-p3', 'tenant-fr', 'folder', 'fr-folder-conf', 'user', 'fr-editor', 'editor', 'fr-editor')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES ('tenant-fr', 'internal', 0, 0), ('tenant-fr', 'confidential', 0, 0)`
      ),
    ]);
  });

  it('requires editor+ permission and blocks dangerous extensions at creation', async () => {
    const testEnv = buildTestEnv();

    const viewerDeny = await app.fetch(
      new Request('http://127.0.0.1:8787/api/file-requests', {
        method: 'POST',
        headers: authHeaders('fr-viewer'),
        body: JSON.stringify({ folderId: 'fr-folder-int', title: 'Should Fail' }),
      }),
      testEnv
    );
    expect(viewerDeny.status).toBe(403);

    const dangerousExtDeny = await app.fetch(
      new Request('http://127.0.0.1:8787/api/file-requests', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: 'fr-folder-int',
          title: 'Allow SVG',
          allowedExtensions: ['pdf', 'svg'],
        }),
      }),
      testEnv
    );
    expect(dangerousExtDeny.status).toBe(400);
  });

  it('maintains blind privacy, blocks malware/size overflow, renames duplicates & assigns safe classification', async () => {
    const queueSend = vi.fn(async () => {});
    const testEnv = buildTestEnv({ JOBS_QUEUE: { send: queueSend } as unknown as Queue });

    const createRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/file-requests', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: 'fr-folder-int',
          title: 'Q4 Vendor Invoices',
          description: 'Please upload PDF invoices',
          requireSubmitterEmail: true,
          maxFileSizeBytes: 500,
          allowedExtensions: ['pdf'],
        }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { token: string; fileRequest: { id: string } };

    // GET /api/fr/:token exposes zero internal folder IDs or existing files
    const metaRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/fr/${created.token}`),
      testEnv
    );
    expect(metaRes.status).toBe(200);
    expect(metaRes.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(metaRes.headers.get('Cache-Control')).toBe('no-store');
    const metaJson = (await metaRes.json()) as Record<string, unknown>;
    expect(metaJson.title).toBe('Q4 Vendor Invoices');
    expect(metaJson).not.toHaveProperty('folderId');
    expect(metaJson).not.toHaveProperty('tenantId');
    expect(metaJson).not.toHaveProperty('files');

    // Missing required submitterEmail -> 400
    const missingEmailRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/fr/${created.token}/upload-init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({ fileName: 'invoice.pdf', sizeBytes: 12 }),
      }),
      testEnv
    );
    expect(missingEmailRes.status).toBe(400);

    // Dangerous extension blocked even before allowlist -> 403
    const exeRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/fr/${created.token}/upload-init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({
          fileName: 'evil.html',
          sizeBytes: 12,
          submitterEmail: 'vendor@partner.example.com',
        }),
      }),
      testEnv
    );
    expect(exeRes.status).toBe(403);

    // Non-allowed safe extension -> 400
    const txtRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/fr/${created.token}/upload-init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({
          fileName: 'notes.txt',
          sizeBytes: 12,
          submitterEmail: 'vendor@partner.example.com',
        }),
      }),
      testEnv
    );
    expect(txtRes.status).toBe(400);

    // Exceeds max_file_size_bytes (500) -> 413
    const tooBigRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/fr/${created.token}/upload-init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({
          fileName: 'big.pdf',
          sizeBytes: 501,
          submitterEmail: 'vendor@partner.example.com',
        }),
      }),
      testEnv
    );
    expect(tooBigRes.status).toBe(413);

    // Valid first & duplicate submissions
    const submitFile = async (bytesText: string) => {
      const payload = new TextEncoder().encode(bytesText);
      const initRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/fr/${created.token}/upload-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
          body: JSON.stringify({
            fileName: 'proposal.pdf',
            mimeType: 'application/pdf',
            sizeBytes: payload.byteLength,
            submitterEmail: 'vendor@partner.example.com',
          }),
        }),
        testEnv
      );
      expect(initRes.status).toBe(201);
      const initJson = (await initRes.json()) as {
        fileId: string;
        versionId: string;
        submissionToken: string;
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
      };

      const putRes = await app.fetch(
        new Request(`http://127.0.0.1:8787${initJson.uploadUrl}`, {
          method: 'PUT',
          headers: initJson.requiredHeaders,
          body: payload,
        }),
        testEnv
      );
      expect(putRes.status).toBe(200);

      const completeRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/fr/${created.token}/upload-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
          body: JSON.stringify({
            fileId: initJson.fileId,
            versionId: initJson.versionId,
            submissionToken: initJson.submissionToken,
          }),
        }),
        testEnv
      );
      expect(completeRes.status).toBe(200);
      return initJson.fileId;
    };

    const id1 = await submitFile('%PDF-1.4\nv1');
    const id2 = await submitFile('%PDF-1.4\nv2');
    expect(id1).not.toBe(id2);

    // Neither queued for unset AI classification -> saved directly as 'internal'
    expect(queueSend).not.toHaveBeenCalled();

    const files = await env.DB.prepare(
      "SELECT id, name, classification FROM files WHERE id IN (?, ?) ORDER BY created_at ASC"
    )
      .bind(id1, id2)
      .all<{ id: string; name: string; classification: string }>();

    expect(files.results.map((f) => f.classification)).toEqual(['internal', 'internal']);
    const names = files.results.map((f) => f.name);
    expect(names).toContain('proposal.pdf');
    expect(names.some((n) => /^proposal_\d{14}/.test(n) && n.endsWith('.pdf'))).toBe(true);

    const frRow = await env.DB.prepare('SELECT submission_count FROM file_requests WHERE id = ?')
      .bind(created.fileRequest.id)
      .first<{ submission_count: number }>();
    expect(frRow?.submission_count).toBe(2);

    // Verify confidential folder destination inherits confidential classification
    const confCreate = await app.fetch(
      new Request('http://127.0.0.1:8787/api/file-requests', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          folderId: 'fr-folder-conf',
          title: 'NDA Dropbox',
        }),
      }),
      testEnv
    );
    const { token: confToken } = (await confCreate.json()) as { token: string };
    const confPayload = new TextEncoder().encode('Signed NDA');
    const confInit = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/fr/${confToken}/upload-init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.11' },
        body: JSON.stringify({
          fileName: 'signed-nda.pdf',
          mimeType: 'application/pdf',
          sizeBytes: confPayload.byteLength,
        }),
      }),
      testEnv
    );
    const confInitJson = (await confInit.json()) as {
      fileId: string;
      versionId: string;
      submissionToken: string;
      uploadUrl: string;
      requiredHeaders: Record<string, string>;
    };
    await app.fetch(
      new Request(`http://127.0.0.1:8787${confInitJson.uploadUrl}`, {
        method: 'PUT',
        headers: confInitJson.requiredHeaders,
        body: confPayload,
      }),
      testEnv
    );
    const confComplete = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/fr/${confToken}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.11' },
        body: JSON.stringify({
          fileId: confInitJson.fileId,
          versionId: confInitJson.versionId,
          submissionToken: confInitJson.submissionToken,
        }),
      }),
      testEnv
    );
    expect(confComplete.status).toBe(200);
    const confFile = await env.DB.prepare('SELECT classification FROM files WHERE id = ?')
      .bind(confInitJson.fileId)
      .first<{ classification: string }>();
    expect(confFile?.classification).toBe('confidential');
  });

  it('enforces per-IP rate limiting, Turnstile verification, and deactivation', async () => {
    const testEnv = buildTestEnv({
      FILE_REQUEST_RATE_LIMIT_PER_MIN: '2',
      TURNSTILE_SECRET_KEY: 'ts-secret-test',
    });

    const createRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/file-requests', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ folderId: 'fr-folder-int', title: 'Protected Drop' }),
      }),
      testEnv
    );
    const { token, fileRequest } = (await createRes.json()) as {
      token: string;
      fileRequest: { id: string };
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('turnstile/v0/siteverify')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('Unexpected fetch', { status: 500 });
    });

    try {
      // Missing Turnstile token -> 403
      const noTs = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/fr/${token}/upload-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
          body: JSON.stringify({ fileName: 'doc1.pdf', sizeBytes: 10 }),
        }),
        testEnv
      );
      expect(noTs.status).toBe(403);

      // Two valid requests succeed (rate limit = 2/min), 3rd returns 429
      for (let i = 1; i <= 2; i++) {
        const okRes = await app.fetch(
          new Request(`http://127.0.0.1:8787/api/fr/${token}/upload-init`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
            body: JSON.stringify({
              fileName: `doc${i}.pdf`,
              sizeBytes: 10,
              turnstileToken: 'valid-ts-token',
            }),
          }),
          testEnv
        );
        expect(okRes.status).toBe(201);
      }

      const rateLimited = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/fr/${token}/upload-init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' },
          body: JSON.stringify({
            fileName: 'doc3.pdf',
            sizeBytes: 10,
            turnstileToken: 'valid-ts-token',
          }),
        }),
        testEnv
      );
      expect(rateLimited.status).toBe(429);

      // Deactivate and confirm 410 Closed
      const delRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/file-requests/${fileRequest.id}`, {
          method: 'DELETE',
          headers: authHeaders(),
        }),
        testEnv
      );
      expect(delRes.status).toBe(200);

      const afterClose = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/fr/${token}`),
        testEnv
      );
      expect(afterClose.status).toBe(410);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
