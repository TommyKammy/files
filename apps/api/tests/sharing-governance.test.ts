import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker, { app } from '../src/index';
import type { JobsQueueMessage } from '../src/types/classification';
import type { OidcEnv } from '../src/types/oidc';

function authHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'member',
  tenantId = 'tenant-sg'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@sg.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-sg-secret-001',
    SESSION_SECRET: 'test-session-sg-secret-001',
    LLM_PROVIDER: 'local_openai',
    LOCAL_LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
    LOCAL_LLM_MODEL: 'qwen2.5:14b-instruct',
    MIN_SUGGESTION_CONFIDENCE: '0.70',
    ...overrides,
  } as OidcEnv;
}

describe('Sharing, Governance, XSS, AI & Search Integration Suite (TOM-20)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const nowIso = new Date().toISOString();

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-sg', 'SG Enterprise', 'sg-ent', 50000000)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies
           (tenant_id, enforce_company_only_links, require_watermark_confidential, max_link_expiration_days, ai_classification_mode, ai_auto_apply_threshold)
         VALUES ('tenant-sg', 0, 1, 30, 'metadata_only', 0.85)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('sg-admin', 'tenant-sg', 'sg-admin@sg.example.com', 'SG SecAdmin', 'sec_admin', 'active'),
           ('sg-owner', 'tenant-sg', 'sg-owner@sg.example.com', 'SG Owner', 'member', 'active'),
           ('sg-viewer', 'tenant-sg', 'sg-viewer@sg.example.com', 'SG Viewer', 'member', 'active'),
           ('sg-outsider', 'tenant-sg', 'sg-outsider@sg.example.com', 'SG NoAccess', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('sg-folder-priv', 'tenant-sg', NULL, 'BoardDocs', 0, 1, 'confidential', 'sg-owner'),
           ('sg-folder-pub', 'tenant-sg', NULL, 'Marketing', 0, 1, 'public', 'sg-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-sg', 'sg-folder-priv', 'sg-folder-priv', 0),
           ('tenant-sg', 'sg-folder-pub', 'sg-folder-pub', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('sg-perm-priv', 'tenant-sg', 'folder', 'sg-folder-priv', 'user', 'sg-owner', 'owner', 'sg-owner'),
           ('sg-perm-pub', 'tenant-sg', 'folder', 'sg-folder-pub', 'user', 'sg-owner', 'owner', 'sg-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files
           (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, current_version_id, current_version_num, classification, created_by, updated_by, created_at, updated_at)
         VALUES
           ('sg-file-conf', 'tenant-sg', 'sg-folder-priv', 'board-minutes.pdf', 'pdf', 'application/pdf', 2048, 'active', 'sg-ver-conf', 1, 'confidential', 'sg-owner', 'sg-owner', ?, ?),
           ('sg-file-unset', 'tenant-sg', 'sg-folder-pub', 'incoming-brief.txt', 'txt', 'text/plain', 1024, 'active', 'sg-ver-unset', 1, 'unset', 'sg-owner', 'sg-owner', ?, ?),
           ('sg-file-html', 'tenant-sg', 'sg-folder-pub', 'evil-widget.html', 'html', 'text/html', 128, 'active', 'sg-ver-html', 1, 'public', 'sg-owner', 'sg-owner', ?, ?),
           ('sg-file-svg', 'tenant-sg', 'sg-folder-pub', 'xss-icon.svg', 'svg', 'image/svg+xml', 128, 'active', 'sg-ver-svg', 1, 'public', 'sg-owner', 'sg-owner', ?, ?),
           ('sg-file-pub', 'tenant-sg', 'sg-folder-pub', 'brochure.pdf', 'pdf', 'application/pdf', 4096, 'active', 'sg-ver-pub', 1, 'public', 'sg-owner', 'sg-owner', ?, ?)`
      ).bind(
        nowIso,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
        nowIso,
        nowIso
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_versions
           (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by)
         VALUES
           ('sg-ver-conf', 'tenant-sg', 'sg-file-conf', 1, 'tenants/tenant-sg/sg-file-conf/1/board-minutes.pdf', 2048, 'application/pdf', 'completed', 'sg-owner'),
           ('sg-ver-unset', 'tenant-sg', 'sg-file-unset', 1, 'tenants/tenant-sg/sg-file-unset/1/incoming-brief.txt', 1024, 'text/plain', 'completed', 'sg-owner'),
           ('sg-ver-html', 'tenant-sg', 'sg-file-html', 1, 'tenants/tenant-sg/sg-file-html/1/evil-widget.html', 128, 'text/html', 'completed', 'sg-owner'),
           ('sg-ver-svg', 'tenant-sg', 'sg-file-svg', 1, 'tenants/tenant-sg/sg-file-svg/1/xss-icon.svg', 128, 'image/svg+xml', 'completed', 'sg-owner'),
           ('sg-ver-pub', 'tenant-sg', 'sg-file-pub', 1, 'tenants/tenant-sg/sg-file-pub/1/brochure.pdf', 4096, 'application/pdf', 'completed', 'sg-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
         VALUES
           ('tenant-sg', 'confidential', 1, 2048, ?),
           ('tenant-sg', 'unset', 1, 1024, ?),
           ('tenant-sg', 'public', 3, 4352, ?)`
      ).bind(nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES
           ('sg-file-conf', 'tenant-sg', 'confidential', 'board-minutes.pdf', 'pdf', 'secret board strategy'),
           ('sg-file-pub', 'tenant-sg', 'public', 'brochure.pdf', 'pdf', 'public product brochure')`
      ),
    ]);

    await env.BUCKET.put(
      'tenants/tenant-sg/sg-file-unset/1/incoming-brief.txt',
      'Files 2026 Public Product Overview'
    );
    await env.BUCKET.put(
      'tenants/tenant-sg/sg-file-html/1/evil-widget.html',
      '<script>alert("xss")</script>'
    );
    await env.BUCKET.put(
      'tenants/tenant-sg/sg-file-svg/1/xss-icon.svg',
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    );
  });

  it('rejects public share creation on confidential & unset files, enforces watermark and blocked audit log on can_download=0', async () => {
    const testEnv = buildTestEnv();

    // ① confidential / unset public share blocked
    const resConf = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders('sg-owner'),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sg-file-conf',
          accessScope: 'public',
        }),
      }),
      testEnv
    );
    expect(resConf.status).toBe(403);
    expect(((await resConf.json()) as { code: string }).code).toBe(
      'PUBLIC_SHARE_FORBIDDEN_FOR_CLASSIFICATION'
    );

    const resUnset = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders('sg-owner'),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sg-file-unset',
          accessScope: 'public',
        }),
      }),
      testEnv
    );
    expect(resUnset.status).toBe(403);

    // ② confidential company_only link forces watermark + can_download=0; DL returns 403 & logs blocked
    const createConf = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders('sg-owner'),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sg-file-conf',
          accessScope: 'company_only',
          canDownload: true,
          requireWatermark: false,
          expiresInDays: 30,
        }),
      }),
      testEnv
    );
    expect(createConf.status).toBe(201);
    const createdJson = (await createConf.json()) as {
      token: string;
      link: { canDownload: boolean; requireWatermark: boolean; expiresAt: string };
    };
    expect(createdJson.link.canDownload).toBe(false);
    expect(createdJson.link.requireWatermark).toBe(true);

    const dlDenied = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${createdJson.token}/url`, {
        method: 'POST',
        headers: authHeaders('sg-viewer'),
        body: JSON.stringify({ intent: 'download' }),
      }),
      testEnv
    );
    expect(dlDenied.status).toBe(403);
    expect(((await dlDenied.json()) as { code: string }).code).toBe(
      'DOWNLOAD_DISABLED'
    );

    const auditBlocked = await env.DB.prepare(
      `SELECT action, status FROM audit_logs
       WHERE tenant_id = 'tenant-sg' AND target_id = 'sg-file-conf'
         AND action = 'shared_link.download_blocked'
       ORDER BY created_at DESC LIMIT 1`
    ).first<{ action: string; status: string }>();
    expect(auditBlocked).toEqual({
      action: 'shared_link.download_blocked',
      status: 'blocked',
    });
  });

  it('enforces atomic max_downloads under concurrent calls & locks link after 5 password failures', async () => {
    const testEnv = buildTestEnv();

    // ③ atomic max_downloads = 2 under 5 concurrent calls
    const createMax = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders('sg-owner'),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sg-file-pub',
          accessScope: 'public',
          canDownload: true,
          maxDownloads: 2,
        }),
      }),
      testEnv
    );
    expect(createMax.status).toBe(201);
    const { token: limitToken } = (await createMax.json()) as { token: string };

    const parallelResponses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.fetch(
          new Request(`http://127.0.0.1:8787/api/s/${limitToken}/url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ intent: 'download' }),
          }),
          testEnv
        )
      )
    );
    const statuses = parallelResponses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBe(2);
    expect(statuses.filter((s) => s === 403).length).toBe(3);

    // ④ 5 failed passwords lock out even correct password
    const createPw = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders('sg-owner'),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sg-file-pub',
          accessScope: 'public',
          password: 'Correct-Share-Password-123!',
        }),
      }),
      testEnv
    );
    expect(createPw.status).toBe(201);
    const { token: pwToken } = (await createPw.json()) as { token: string };

    for (let i = 1; i <= 5; i++) {
      const badRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/s/${pwToken}/verify-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: `wrong-${i}` }),
        }),
        testEnv
      );
      expect(badRes.status).toBe(i < 5 ? 401 : 423);
    }

    const goodWhileLocked = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${pwToken}/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'Correct-Share-Password-123!' }),
      }),
      testEnv
    );
    expect(goodWhileLocked.status).toBe(423);
    expect(((await goodWhileLocked.json()) as { code: string }).code).toBe(
      'LINK_LOCKED'
    );
  });

  it('prevents Stored XSS on HTML/SVG previews & enforces local_proxy CSP sandbox + nosniff headers', async () => {
    const testEnv = buildTestEnv();

    for (const [fileId, expectedMime] of [
      ['sg-file-html', 'text/html'],
      ['sg-file-svg', 'image/svg+xml'],
    ] as const) {
      const shareRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/shared-links', {
          method: 'POST',
          headers: authHeaders('sg-owner'),
          body: JSON.stringify({
            targetType: 'file',
            targetId: fileId,
            accessScope: 'public',
            canDownload: true,
          }),
        }),
        testEnv
      );
      expect(shareRes.status).toBe(201);
      const { token } = (await shareRes.json()) as { token: string };

      const previewRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/s/${token}/url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intent: 'preview' }),
        }),
        testEnv
      );
      expect(previewRes.status).toBe(200);
      const granted = (await previewRes.json()) as {
        url: string;
        disposition: string;
        safeRenderMode: string;
      };
      // ⑤ never inline active HTML/SVG
      expect(granted.disposition).toBe('attachment');
      expect(granted.safeRenderMode).toBe('source_text');

      // ⑥ local_proxy enforces strict sandbox & nosniff headers
      const proxyRes = await app.fetch(
        new Request(new URL(granted.url, 'http://127.0.0.1:8787')),
        testEnv
      );
      expect(proxyRes.status).toBe(200);
      expect(proxyRes.headers.get('Content-Security-Policy')).toBe(
        "sandbox; default-src 'none'"
      );
      expect(proxyRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(proxyRes.headers.get('Content-Disposition')).toContain('attachment');
      expect(expectedMime).toBeTruthy();
    }
  });

  it('never auto-applies public AI suggestions, serves O(1) storage stats, and isolates unauthorized search queries', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.startsWith('http://127.0.0.1:11434/')) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    suggestedLabel: 'public',
                    confidence: 0.99,
                    reason: 'Contains product brochure keywords',
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    try {
      const testEnv = buildTestEnv();
      const ctx = createExecutionContext();
      let acked = false;
      const batch = {
        queue: 'files-jobs',
        messages: [
          {
            id: 'sg-ai-msg-1',
            timestamp: new Date(),
            attempts: 1,
            body: {
              type: 'classify_file',
              tenantId: 'tenant-sg',
              fileId: 'sg-file-unset',
              versionId: 'sg-ver-unset',
              r2ObjectKey: 'tenants/tenant-sg/sg-file-unset/1/incoming-brief.txt',
              fileName: 'incoming-brief.txt',
              extension: 'txt',
              mimeType: 'text/plain',
            } satisfies JobsQueueMessage,
            ack: () => {
              acked = true;
            },
            retry: () => undefined,
          },
        ],
        ackAll: () => undefined,
        retryAll: () => undefined,
      } as unknown as MessageBatch<JobsQueueMessage>;

      await worker.queue?.(batch, testEnv, ctx);
      await waitOnExecutionContext(ctx);
      expect(acked).toBe(true);

      // ⑦ Even at 0.99 confidence >= threshold (0.85), 'public' must NEVER be auto-applied
      const updatedFile = await env.DB.prepare(
        'SELECT classification, ai_suggested_label, ai_confidence FROM files WHERE id = ?'
      )
        .bind('sg-file-unset')
        .first<{
          classification: string;
          ai_suggested_label: string;
          ai_confidence: number;
        }>();
      expect(updatedFile?.classification).toBe('unset');
      expect(updatedFile?.ai_suggested_label).toBe('public');
      expect(updatedFile?.ai_confidence).toBeCloseTo(0.99, 2);

      // Admin storage stats O(1) aggregation matches seeded + active classifications
      const statsRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/admin/storage-stats', {
          headers: authHeaders('sg-admin', 'sec_admin'),
        }),
        testEnv
      );
      expect(statsRes.status).toBe(200);
      const stats = (await statsRes.json()) as {
        totalFiles: number;
        byClassification: Record<string, { fileCount: number }>;
      };
      expect(stats.totalFiles).toBe(5);
      expect(stats.byClassification.confidential.fileCount).toBe(1);
      expect(stats.byClassification.unset.fileCount).toBe(1);
      expect(stats.byClassification.public.fileCount).toBe(3);

      // ⑧ Unauthorized user sees zero results when searching confidential & non-shared files
      const outsiderSearch = await app.fetch(
        new Request(
          'http://127.0.0.1:8787/api/search?q=board-minutes',
          { headers: authHeaders('sg-outsider', 'member') }
        ),
        testEnv
      );
      expect(outsiderSearch.status).toBe(200);
      const searchBody = (await outsiderSearch.json()) as { results: unknown[] };
      expect(searchBody.results).toEqual([]);

      // Benchmark route strictly returns 404 outside ENVIRONMENT='local'
      const benchBlocked = await app.fetch(
        new Request('http://127.0.0.1:8787/api/__bench/case/1'),
        buildTestEnv({ ENVIRONMENT: 'staging' })
      );
      expect(benchBlocked.status).toBe(404);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
