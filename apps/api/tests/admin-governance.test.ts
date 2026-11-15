import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

function authHeaders(
  userId = 'gov-sec',
  role: 'sys_admin' | 'sec_admin' | 'member' = 'sec_admin',
  tenantId = 'tenant-gov'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@gov.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-gov-secret-001',
    SESSION_SECRET: 'test-session-gov-secret-001',
  } as OidcEnv;
}

describe('Admin Governance, O(1) Storage Stats, Bulk AI Queue & Audit Logs (TOM-18)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-gov', 'Gov Org', 'gov-org', 500000)"
      ),
      env.DB.prepare("INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES ('tenant-gov')"),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('gov-sec', 'tenant-gov', 'gov-sec@gov.example.com', 'Sec Admin', 'sec_admin', 'active'),
           ('gov-sys', 'tenant-gov', 'gov-sys@gov.example.com', 'Sys Admin', 'sys_admin', 'active'),
           ('gov-member', 'tenant-gov', 'gov-member@gov.example.com', 'Regular Member', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('gov-folder-open', 'tenant-gov', NULL, 'Inbox', 0, 1, 'unset', 'gov-member'),
           ('gov-folder-conf', 'tenant-gov', NULL, 'Secret', 0, 1, 'confidential', 'gov-sys')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-gov', 'gov-folder-open', 'gov-folder-open', 0),
           ('tenant-gov', 'gov-folder-conf', 'gov-folder-conf', 0)`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
         VALUES
           ('tenant-gov', 'unset', 8, 800, ?),
           ('tenant-gov', 'internal', 0, 0, ?),
           ('tenant-gov', 'confidential', 0, 0, ?),
           ('tenant-gov', 'public', 0, 0, ?)`
      ).bind(nowIso, nowIso, nowIso, nowIso),
    ]);

    // Seed 8 files with AI suggestions + 1 file in a confidential folder + FTS
    const fileStmts: D1PreparedStatement[] = [];
    for (let i = 1; i <= 8; i++) {
      const fid = `gov-f-${i}`;
      const ts = new Date(Date.now() - (10 - i) * 1000).toISOString();
      const suggested = i <= 4 ? 'confidential' : 'internal';
      fileStmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, current_version_num, classification, ai_suggested_label, ai_confidence, ai_reason, created_by, updated_by, created_at, updated_at)
           VALUES (?, 'tenant-gov', 'gov-folder-open', ?, 'txt', 'text/plain', 100, 'active', 1, 'unset', ?, 0.86, 'LLM pattern match', 'gov-member', 'gov-member', ?, ?)`
        ).bind(fid, `doc-${i}.txt`, suggested, ts, ts),
        env.DB.prepare(
          `INSERT OR IGNORE INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
           VALUES (?, 'tenant-gov', 'unset', ?, 'txt', 'LLM pattern match')`
        ).bind(fid, `doc-${i}.txt`)
      );
    }
    fileStmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, current_version_num, classification, ai_suggested_label, ai_confidence, created_by, updated_by, created_at, updated_at)
         VALUES ('gov-f-locked', 'tenant-gov', 'gov-folder-conf', 'board.pdf', 'pdf', 'application/pdf', 200, 'active', 1, 'confidential', 'internal', 0.80, 'gov-sys', 'gov-sys', ?, ?)`
      ).bind(nowIso, nowIso),
      env.DB.prepare(
        `INSERT OR IGNORE INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, require_watermark, created_by, created_at
         ) VALUES ('gov-bad-link', 'tenant-gov', 'gov-bad-hash', 'file', 'gov-f-1', 'public', 1, 0, 'gov-member', ?)`
      ).bind(nowIso)
    );
    await env.DB.batch(fileStmts);
  });

  it('denies non-admin members with 403 across all admin & audit endpoints', async () => {
    const testEnv = buildTestEnv();
    const endpoints = [
      { method: 'GET', url: 'http://127.0.0.1:8787/api/admin/storage-stats' },
      { method: 'GET', url: 'http://127.0.0.1:8787/api/admin/ai-suggestions' },
      { method: 'POST', url: 'http://127.0.0.1:8787/api/admin/ai-suggestions/bulk-approve' },
      { method: 'POST', url: 'http://127.0.0.1:8787/api/admin/shared-links/gov-bad-link/revoke' },
      { method: 'GET', url: 'http://127.0.0.1:8787/api/admin/policies' },
      { method: 'GET', url: 'http://127.0.0.1:8787/api/audit-logs' },
    ];

    for (const ep of endpoints) {
      const res = await app.fetch(
        new Request(ep.url, {
          method: ep.method,
          headers: authHeaders('gov-member', 'member'),
          body: ep.method === 'POST' ? JSON.stringify({ fileIds: ['gov-f-1'] }) : undefined,
        }),
        testEnv
      );
      expect(res.status).toBe(403);
    }
  });

  it('returns O(1) storage stats and executes atomic bulk-approve (enforcing max 50 and floor rules)', async () => {
    const testEnv = buildTestEnv();

    const statsBefore = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/storage-stats', {
        headers: authHeaders('gov-sys', 'sys_admin'),
      }),
      testEnv
    );
    expect(statsBefore.status).toBe(200);
    const statsJsonBefore = (await statsBefore.json()) as {
      quotaBytes: number;
      usedBytes: number;
      byClassification: Record<string, { fileCount: number; totalBytes: number }>;
    };
    expect(statsJsonBefore.usedBytes).toBe(800);
    expect(statsJsonBefore.byClassification.unset).toEqual({ fileCount: 8, totalBytes: 800 });

    // > 50 bulk approve rejected
    const over50Res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/ai-suggestions/bulk-approve', {
        method: 'POST',
        headers: authHeaders('gov-sec', 'sec_admin'),
        body: JSON.stringify({
          fileIds: Array.from({ length: 51 }, (_, idx) => `id-${idx}`),
        }),
      }),
      testEnv
    );
    expect(over50Res.status).toBe(400);

    // Queue list filters cleanly
    const listRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/ai-suggestions?suggestedLabel=confidential&limit=10', {
        headers: authHeaders('gov-sec', 'sec_admin'),
      }),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      suggestions: Array<{ fileId: string; suggestedLabel: string }>;
    };
    expect(listJson.suggestions).toHaveLength(4);

    // Bulk approve all 8 files (spanning multiple internal 30-statement D1 batch chunks!)
    const bulkRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/ai-suggestions/bulk-approve', {
        method: 'POST',
        headers: authHeaders('gov-sec', 'sec_admin'),
        body: JSON.stringify({
          items: [
            { fileId: 'gov-f-1' }, // confidential -> must ALSO auto-revoke gov-bad-link (public)!
            { fileId: 'gov-f-2' },
            { fileId: 'gov-f-3' },
            { fileId: 'gov-f-4' },
            { fileId: 'gov-f-5' },
            { fileId: 'gov-f-6' },
            { fileId: 'gov-f-7' },
            { fileId: 'gov-f-8', label: 'public' }, // override one explicitly to public
          ],
        }),
      }),
      testEnv
    );
    expect(bulkRes.status).toBe(200);
    const bulkJson = (await bulkRes.json()) as { approvedCount: number };
    expect(bulkJson.approvedCount).toBe(8);

    const statsAfter = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/storage-stats', {
        headers: authHeaders('gov-sec', 'sec_admin'),
      }),
      testEnv
    );
    const statsJsonAfter = (await statsAfter.json()) as {
      byClassification: Record<string, { fileCount: number; totalBytes: number }>;
    };
    expect(statsJsonAfter.byClassification.unset).toEqual({ fileCount: 0, totalBytes: 0 });
    expect(statsJsonAfter.byClassification.confidential).toEqual({ fileCount: 4, totalBytes: 400 });
    expect(statsJsonAfter.byClassification.internal).toEqual({ fileCount: 3, totalBytes: 300 });
    expect(statsJsonAfter.byClassification.public).toEqual({ fileCount: 1, totalBytes: 100 });

    // Confirm FTS updated and gov-bad-link was automatically revoked when gov-f-1 became confidential
    const badLinkAfter = await env.DB.prepare(
      'SELECT revoked_at FROM shared_links WHERE id = ?'
    )
      .bind('gov-bad-link')
      .first<{ revoked_at: string | null }>();
    expect(badLinkAfter?.revoked_at).not.toBeNull();

    const ftsF1 = await env.DB.prepare(
      "SELECT classification FROM files_fts WHERE file_id = 'gov-f-1'"
    ).first<{ classification: string }>();
    expect(ftsF1?.classification).toBe('confidential');

    // Downgrading confidential ancestor file via bulk-approve is forbidden (403)
    const downgradeRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/ai-suggestions/bulk-approve', {
        method: 'POST',
        headers: authHeaders('gov-sec', 'sec_admin'),
        body: JSON.stringify({ fileIds: ['gov-f-locked'] }),
      }),
      testEnv
    );
    expect(downgradeRes.status).toBe(403);
  });

  it('paginates audit logs via keyset cursors, exports CSV, updates policy & revokes links', async () => {
    const testEnv = buildTestEnv();

    // Seed another active link and revoke via admin endpoint
    await env.DB.prepare(
      `INSERT OR IGNORE INTO shared_links (
         id, tenant_id, token_hash, target_type, target_id, access_scope,
         can_download, require_watermark, created_by, created_at
       ) VALUES ('gov-manual-revoke', 'tenant-gov', 'gov-man-hash', 'file', 'gov-f-5', 'company_only', 1, 0, 'gov-member', ?)`
    )
      .bind(new Date().toISOString())
      .run();

    const revokeRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/shared-links/gov-manual-revoke/revoke', {
        method: 'POST',
        headers: authHeaders('gov-sec', 'sec_admin'),
        body: JSON.stringify({ reason: 'Suspicious external download spike' }),
      }),
      testEnv
    );
    expect(revokeRes.status).toBe(200);

    // Update tenant policy
    const patchPolicy = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/policies', {
        method: 'PATCH',
        headers: authHeaders('gov-sys', 'sys_admin'),
        body: JSON.stringify({
          enforceCompanyOnlyLinks: true,
          aiClassificationMode: 'metadata_only',
          aiAutoApplyThreshold: 0.92,
        }),
      }),
      testEnv
    );
    expect(patchPolicy.status).toBe(200);

    // Keyset pagination across >= 10 audit logs with limit=4
    const page1Res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/audit-logs?limit=4', {
        headers: authHeaders('gov-sec', 'sec_admin'),
      }),
      testEnv
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      logs: Array<{ id: string }>;
      nextCursor: { createdAt: string; id: string } | null;
    };
    expect(page1.logs).toHaveLength(4);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/audit-logs?limit=4&cursorCreatedAt=${encodeURIComponent(page1.nextCursor!.createdAt)}&cursorId=${encodeURIComponent(page1.nextCursor!.id)}`,
        { headers: authHeaders('gov-sec', 'sec_admin') }
      ),
      testEnv
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as { logs: Array<{ id: string }> };
    expect(page2.logs).toHaveLength(4);
    // Ensure zero overlap between pages
    const ids1 = new Set(page1.logs.map((l) => l.id));
    expect(page2.logs.some((l) => ids1.has(l.id))).toBe(false);

    // CSV export
    const csvRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/audit-logs?format=csv&action=admin.shared_link_revoked', {
        headers: authHeaders('gov-sec', 'sec_admin'),
      }),
      testEnv
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('Content-Type')).toContain('text/csv');
    const csvText = await csvRes.text();
    expect(csvText).toContain('admin.shared_link_revoked');
  });
});
