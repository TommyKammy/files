import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

function authHeaders(
  userId = 'sl-editor',
  role: 'sys_admin' | 'member' = 'member',
  tenantId = 'tenant-sl'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@sl.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-sl-secret-001',
    SESSION_SECRET: 'test-session-sl-secret-001',
    ...overrides,
  } as OidcEnv;
}

describe('Shared Links Control, PBKDF2 Lockout & XSS Prevention (TOM-15)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-sl', 'Share Org', 'share-org', 1000000), ('tenant-sl-other', 'Other Org', 'other-sl', 1000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, enforce_company_only_links, require_watermark_confidential, max_link_expiration_days) VALUES ('tenant-sl', 0, 1, 30)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('sl-editor', 'tenant-sl', 'sl-editor@sl.example.com', 'SL Editor', 'member', 'active'),
           ('sl-previewer', 'tenant-sl', 'sl-previewer@sl.example.com', 'SL Previewer', 'member', 'active'),
           ('sl-coworker', 'tenant-sl', 'sl-coworker@sl.example.com', 'SL Coworker', 'member', 'active'),
           ('sl-suspended', 'tenant-sl', 'sl-suspended@sl.example.com', 'SL Suspended', 'member', 'suspended'),
           ('sl-outsider', 'tenant-sl-other', 'sl-outsider@other.example.com', 'SL Outsider', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES ('sl-folder', 'tenant-sl', NULL, 'ShareDocs', 0, 1, 'internal', 'sl-editor')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES ('tenant-sl', 'sl-folder', 'sl-folder', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('sl-p1', 'tenant-sl', 'folder', 'sl-folder', 'user', 'sl-editor', 'editor', 'sl-editor'),
           ('sl-p2', 'tenant-sl', 'folder', 'sl-folder', 'user', 'sl-previewer', 'previewer', 'sl-editor')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, current_version_id, current_version_num, classification, created_by, updated_by, created_at, updated_at)
         VALUES
           ('sl-file-conf', 'tenant-sl', 'sl-folder', 'board-deck.pdf', 'pdf', 'application/pdf', 12, 'active', 'sl-v-conf', 1, 'confidential', 'sl-editor', 'sl-editor', ?, ?),
           ('sl-file-unset', 'tenant-sl', 'sl-folder', 'unknown.txt', 'txt', 'text/plain', 5, 'active', 'sl-v-unset', 1, 'unset', 'sl-editor', 'sl-editor', ?, ?),
           ('sl-file-internal', 'tenant-sl', 'sl-folder', 'spec.pdf', 'pdf', 'application/pdf', 10, 'active', 'sl-v-internal', 1, 'internal', 'sl-editor', 'sl-editor', ?, ?),
           ('sl-file-html', 'tenant-sl', 'sl-folder', 'widget.html', 'html', 'text/html', 20, 'active', 'sl-v-html', 1, 'internal', 'sl-editor', 'sl-editor', ?, ?),
           ('sl-file-conf-svg', 'tenant-sl', 'sl-folder', 'diagram.svg', 'svg', 'image/svg+xml', 15, 'active', 'sl-v-svg', 1, 'confidential', 'sl-editor', 'sl-editor', ?, ?)`
      ).bind(nowIso, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso, nowIso),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES
           ('sl-v-conf', 'tenant-sl', 'sl-file-conf', 1, 'tenants/tenant-sl/objects/sl-file-conf/v1', 12, 'application/pdf', 'completed', 'sl-editor', ?),
           ('sl-v-unset', 'tenant-sl', 'sl-file-unset', 1, 'tenants/tenant-sl/objects/sl-file-unset/v1', 5, 'text/plain', 'completed', 'sl-editor', ?),
           ('sl-v-internal', 'tenant-sl', 'sl-file-internal', 1, 'tenants/tenant-sl/objects/sl-file-internal/v1', 10, 'application/pdf', 'completed', 'sl-editor', ?),
           ('sl-v-html', 'tenant-sl', 'sl-file-html', 1, 'tenants/tenant-sl/objects/sl-file-html/v1', 20, 'text/html', 'completed', 'sl-editor', ?),
           ('sl-v-svg', 'tenant-sl', 'sl-file-conf-svg', 1, 'tenants/tenant-sl/objects/sl-file-conf-svg/v1', 15, 'image/svg+xml', 'completed', 'sl-editor', ?)`
      ).bind(nowIso, nowIso, nowIso, nowIso, nowIso),
    ]);

    await env.BUCKET.put('tenants/tenant-sl/objects/sl-file-conf/v1', '%PDF-1.4\n...');
    await env.BUCKET.put('tenants/tenant-sl/objects/sl-file-internal/v1', '%PDF-1.4\n!');
    await env.BUCKET.put('tenants/tenant-sl/objects/sl-file-html/v1', '<script>alert(1)</script>');
    await env.BUCKET.put('tenants/tenant-sl/objects/sl-file-conf-svg/v1', '<svg onload=alert(1)/>');
  });

  it('rejects public shares for confidential/unset files and enforces confidential restrictions', async () => {
    const testEnv = buildTestEnv();

    const previewerRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders('sl-previewer'),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sl-file-internal',
          accessScope: 'company_only',
        }),
      }),
      testEnv
    );
    expect(previewerRes.status).toBe(403);

    for (const fileId of ['sl-file-conf', 'sl-file-unset']) {
      const pubDeny = await app.fetch(
        new Request('http://127.0.0.1:8787/api/shared-links', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            targetType: 'file',
            targetId: fileId,
            accessScope: 'public',
          }),
        }),
        testEnv
      );
      expect(pubDeny.status).toBe(403);
      const errJson = (await pubDeny.json()) as { code?: string };
      expect(errJson.code).toBe('PUBLIC_SHARE_FORBIDDEN_FOR_CLASSIFICATION');
    }

    // Confidential link with overly permissive client request -> clamped server-side
    const confRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sl-file-conf',
          accessScope: 'company_only',
          canDownload: true,
          requireWatermark: false,
          expiresInDays: 30,
        }),
      }),
      testEnv
    );
    expect(confRes.status).toBe(201);
    const confJson = (await confRes.json()) as {
      token: string;
      link: {
        canDownload: boolean;
        requireWatermark: boolean;
        expiresAt: string;
      };
    };
    expect(confJson.link.canDownload).toBe(false);
    expect(confJson.link.requireWatermark).toBe(true);
    const diffMs = Date.parse(confJson.link.expiresAt) - Date.now();
    expect(diffMs).toBeGreaterThan(0);
    expect(diffMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 5000);

    // Confidential preview works with watermark, download is blocked & audited
    const previewRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${confJson.token}/url`, {
        method: 'POST',
        headers: authHeaders('sl-coworker'),
        body: JSON.stringify({ intent: 'preview' }),
      }),
      testEnv
    );
    expect(previewRes.status).toBe(200);
    expect(previewRes.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(previewRes.headers.get('Cache-Control')).toBe('no-store');
    const previewJson = (await previewRes.json()) as {
      requireWatermark: boolean;
      watermarkText: string;
      disposition: string;
    };
    expect(previewJson.requireWatermark).toBe(true);
    expect(previewJson.watermarkText).toContain('sl-coworker@sl.example.com');
    expect(previewJson.disposition).toBe('inline');

    const dlBlockedRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${confJson.token}/url`, {
        method: 'POST',
        headers: authHeaders('sl-coworker'),
        body: JSON.stringify({ intent: 'download' }),
      }),
      testEnv
    );
    expect(dlBlockedRes.status).toBe(403);
    const auditBlocked = await env.DB.prepare(
      "SELECT status, action FROM audit_logs WHERE tenant_id = 'tenant-sl' AND target_id = 'sl-file-conf' AND action = 'shared_link.download_blocked'"
    ).first<{ status: string; action: string }>();
    expect(auditBlocked?.status).toBe('blocked');
  });

  it('enforces company_only & collaborators_only scopes cleanly', async () => {
    const testEnv = buildTestEnv();

    const collabCreate = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sl-file-internal',
          accessScope: 'collaborators_only',
        }),
      }),
      testEnv
    );
    expect(collabCreate.status).toBe(201);
    const { token } = (await collabCreate.json()) as { token: string };

    const anonRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${token}/meta`),
      testEnv
    );
    expect(anonRes.status).toBe(401);
    expect(anonRes.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(anonRes.headers.get('Cache-Control')).toBe('no-store');

    const outsiderRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${token}/meta`, {
        headers: authHeaders('sl-outsider', 'member', 'tenant-sl-other'),
      }),
      testEnv
    );
    expect(outsiderRes.status).toBe(403);

    const suspendedRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${token}/meta`, {
        headers: authHeaders('sl-suspended'),
      }),
      testEnv
    );
    expect(suspendedRes.status).toBe(403);

    const nonCollabRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${token}/meta`, {
        headers: authHeaders('sl-coworker'),
      }),
      testEnv
    );
    expect(nonCollabRes.status).toBe(403);

    const collabOkRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${token}/meta`, {
        headers: authHeaders('sl-previewer'),
      }),
      testEnv
    );
    expect(collabOkRes.status).toBe(200);
  });

  it('enforces PBKDF2 password verification, 5-failure lockout, atomic maxDownloads, and revocation', async () => {
    const testEnv = buildTestEnv();

    const createRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sl-file-internal',
          accessScope: 'public',
          password: 'CorrectHorseBattery99!',
          maxDownloads: 2,
        }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      token: string;
      link: { id: string; hasPassword: boolean };
    };
    expect(created.link.hasPassword).toBe(true);

    // Unauthenticated access without unlock fails
    const urlBeforeUnlock = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${created.token}/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'download' }),
      }),
      testEnv
    );
    expect(urlBeforeUnlock.status).toBe(401);

    // 4 wrong password attempts, then 5th locks for 15 min (423)
    for (let attempt = 1; attempt <= 4; attempt++) {
      const badRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/s/${created.token}/verify-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'wrong-password' }),
        }),
        testEnv
      );
      expect(badRes.status).toBe(401);
    }

    const fifthRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${created.token}/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      }),
      testEnv
    );
    expect(fifthRes.status).toBe(423);
    const fifthJson = (await fifthRes.json()) as { code?: string };
    expect(fifthJson.code).toBe('LINK_LOCKED');

    // Even right password is blocked during active lockout
    const lockedOutRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${created.token}/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'CorrectHorseBattery99!' }),
      }),
      testEnv
    );
    expect(lockedOutRes.status).toBe(423);

    // Create a fresh link without lockout and verify PBKDF2 unlock + atomic maxDownloads = 2
    const createRes2 = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sl-file-internal',
          accessScope: 'public',
          password: 'CorrectHorseBattery99!',
          maxDownloads: 2,
        }),
      }),
      testEnv
    );
    const created2 = (await createRes2.json()) as { token: string; link: { id: string } };

    const verifyOk = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${created2.token}/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'CorrectHorseBattery99!' }),
      }),
      testEnv
    );
    expect(verifyOk.status).toBe(200);
    const verifyJson = (await verifyOk.json()) as { unlockToken: string };
    expect(verifyJson.unlockToken).toBeTruthy();

    // Concurrent download attempts up to limit 2 (3 concurrent requests -> exactly 2 succeed)
    const downloadResults = await Promise.all(
      [1, 2, 3].map(() =>
        app.fetch(
          new Request(`http://127.0.0.1:8787/api/s/${created2.token}/url`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Share-Unlock': verifyJson.unlockToken,
            },
            body: JSON.stringify({ intent: 'download' }),
          }),
          testEnv
        )
      )
    );
    const statuses = downloadResults.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 403]);

    // Revoke link and verify 410 Gone
    const revokeRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/shared-links/${created2.link.id}`, {
        method: 'DELETE',
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${created2.token}/meta`),
      testEnv
    );
    expect(afterRevoke.status).toBe(410);
  });

  it('prevents Stored XSS on .html and .svg active content across download-disabled and internal links', async () => {
    const testEnv = buildTestEnv();

    // 1. confidential .svg -> preview blocked (can_download=0)
    const svgLinkRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sl-file-conf-svg',
          accessScope: 'company_only',
        }),
      }),
      testEnv
    );
    expect(svgLinkRes.status).toBe(201);
    const svgLink = (await svgLinkRes.json()) as { token: string };

    const svgPreviewRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${svgLink.token}/url`, {
        method: 'POST',
        headers: authHeaders('sl-coworker'),
        body: JSON.stringify({ intent: 'preview' }),
      }),
      testEnv
    );
    expect(svgPreviewRes.status).toBe(403);
    const svgErr = (await svgPreviewRes.json()) as { code?: string };
    expect(svgErr.code).toBe('ACTIVE_CONTENT_BLOCKED');

    // 2. internal .html -> never inline, forced attachment + text/plain safe source mode
    const htmlLinkRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/shared-links', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          targetType: 'file',
          targetId: 'sl-file-html',
          accessScope: 'public',
          canDownload: true,
        }),
      }),
      testEnv
    );
    expect(htmlLinkRes.status).toBe(201);
    const htmlLink = (await htmlLinkRes.json()) as { token: string };

    const htmlPreviewRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/s/${htmlLink.token}/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'preview' }),
      }),
      testEnv
    );
    expect(htmlPreviewRes.status).toBe(200);
    const htmlPreview = (await htmlPreviewRes.json()) as {
      url: string;
      disposition: string;
      safeRenderMode: string;
    };
    expect(htmlPreview.disposition).toBe('attachment');
    expect(htmlPreview.safeRenderMode).toBe('source_text');
    expect(htmlPreview.url).toContain('disposition=attachment');

    const proxyFetch = await app.fetch(
      new Request(`http://127.0.0.1:8787${htmlPreview.url}`),
      testEnv
    );
    expect(proxyFetch.status).toBe(200);
    expect(proxyFetch.headers.get('Content-Security-Policy')).toContain('sandbox');
    expect(proxyFetch.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(proxyFetch.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(proxyFetch.headers.get('Content-Disposition')).toContain('attachment');
    expect(proxyFetch.headers.get('Content-Type')).toContain('text/plain');
  });
});
