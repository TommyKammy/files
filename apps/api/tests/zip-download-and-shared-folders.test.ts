import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { buildZipArchive, crc32, dedupeZipPath, sanitizeZipPath } from '../src/services/zip-builder';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-zip';

function authHeaders(
  userId = 'zip-owner',
  role: 'sys_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@zip.example.com`,
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
    LOCAL_PROXY_SECRET: 'test-hmac-zip-secret-001',
    SESSION_SECRET: 'test-session-zip-secret-001',
    ...overrides,
  } as OidcEnv;
}

/** Minimal ZIP parser for test verification (reads Local File Headers + EOCD). */
function parseZipEntries(zipBytes: Uint8Array): Array<{
  name: string;
  flags: number;
  compression: number;
  crc: number;
  data: Uint8Array;
}> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const decoder = new TextDecoder();
  const entries: Array<{
    name: string;
    flags: number;
    compression: number;
    crc: number;
    data: Uint8Array;
  }> = [];

  let offset = 0;
  while (offset + 4 <= zipBytes.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    const flags = view.getUint16(offset + 6, true);
    const compression = view.getUint16(offset + 8, true);
    const crc = view.getUint32(offset + 14, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decoder.decode(zipBytes.slice(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const data = zipBytes.slice(dataStart, dataStart + compSize);
    entries.push({ name, flags, compression, crc, data });
    offset = dataStart + compSize;
  }
  return entries;
}

describe('ZIP Builder, Workspace Bulk ZIP Download & Shared Folder Navigation', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.BUCKET.put('zip/root-a.txt', new TextEncoder().encode('hello root a'));
    await env.BUCKET.put('zip/sub-b.txt', new TextEncoder().encode('hello sub b'));
    await env.BUCKET.put('zip/jp.txt', new TextEncoder().encode('日本語コンテンツ'));
    await env.BUCKET.put('zip/secret.txt', new TextEncoder().encode('top secret'));
    await env.BUCKET.put('zip/preview-only.txt', new TextEncoder().encode('preview only data'));

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes) VALUES ('tenant-zip', 'Zip Org', 'zip-org', 10000000)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, enforce_company_only_links, require_watermark_confidential, max_link_expiration_days) VALUES ('tenant-zip', 0, 1, 30)"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('zip-owner', 'tenant-zip', 'zip-owner@zip.example.com', 'Zip Owner', 'member', 'active'),
           ('zip-viewer', 'tenant-zip', 'zip-viewer@zip.example.com', 'Zip Viewer', 'member', 'active'),
           ('zip-previewer', 'tenant-zip', 'zip-previewer@zip.example.com', 'Zip Previewer', 'member', 'active')`
      ),
      // Folder tree:
      // zip-above-root (depth 0)
      //   -> zip-root (depth 1) [shared root]
      //        -> zip-sub (depth 2)
      //        -> zip-conf-sub (depth 2, confidential)
      // zip-outside (depth 0, unrelated)
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('zip-above-root', 'tenant-zip', NULL, 'CompanyPrivateRoot', 0, 1, 'internal', 'zip-owner'),
           ('zip-root', 'tenant-zip', 'zip-above-root', 'SharedProject', 1, 1, 'internal', 'zip-owner'),
           ('zip-sub', 'tenant-zip', 'zip-root', 'SubfolderA', 2, 1, 'internal', 'zip-owner'),
           ('zip-conf-sub', 'tenant-zip', 'zip-root', 'ConfidentialSub', 2, 1, 'confidential', 'zip-owner'),
           ('zip-outside', 'tenant-zip', NULL, 'OutsideFolder', 0, 1, 'internal', 'zip-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           ('tenant-zip', 'zip-above-root', 'zip-above-root', 0),
           ('tenant-zip', 'zip-above-root', 'zip-root', 1),
           ('tenant-zip', 'zip-above-root', 'zip-sub', 2),
           ('tenant-zip', 'zip-above-root', 'zip-conf-sub', 2),
           ('tenant-zip', 'zip-root', 'zip-root', 0),
           ('tenant-zip', 'zip-root', 'zip-sub', 1),
           ('tenant-zip', 'zip-root', 'zip-conf-sub', 1),
           ('tenant-zip', 'zip-sub', 'zip-sub', 0),
           ('tenant-zip', 'zip-conf-sub', 'zip-conf-sub', 0),
           ('tenant-zip', 'zip-outside', 'zip-outside', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by, current_version_id)
         VALUES
           ('zf-1', 'tenant-zip', 'zip-root', 'readme.txt', 'txt', 'text/plain', 12, 'active', 'internal', 'zip-owner', 'zip-owner', NULL),
           ('zf-2', 'tenant-zip', 'zip-sub', 'notes.txt', 'txt', 'text/plain', 11, 'active', 'internal', 'zip-owner', 'zip-owner', NULL),
           ('zf-jp', 'tenant-zip', 'zip-sub', '仕様書.txt', 'txt', 'text/plain', 24, 'active', 'public', 'zip-owner', 'zip-owner', NULL),
           ('zf-conf', 'tenant-zip', 'zip-root', 'secret.txt', 'txt', 'text/plain', 10, 'active', 'confidential', 'zip-owner', 'zip-owner', NULL),
           ('zf-prev', 'tenant-zip', 'zip-outside', 'preview-only.txt', 'txt', 'text/plain', 17, 'active', 'internal', 'zip-owner', 'zip-owner', NULL),
           ('zf-del', 'tenant-zip', 'zip-root', 'deleted.txt', 'txt', 'text/plain', 5, 'active', 'internal', 'zip-owner', 'zip-owner', NULL),
           ('zf-pend', 'tenant-zip', 'zip-root', 'pending.txt', 'txt', 'text/plain', 5, 'pending', 'internal', 'zip-owner', 'zip-owner', NULL)`
      ),
      env.DB.prepare(
        "UPDATE files SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'zf-del'"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_versions (id, tenant_id, file_id, version_num, size_bytes, mime_type, r2_object_key, upload_status, uploaded_by)
         VALUES
           ('zfv-1', 'tenant-zip', 'zf-1', 1, 12, 'text/plain', 'zip/root-a.txt', 'completed', 'zip-owner'),
           ('zfv-2', 'tenant-zip', 'zf-2', 1, 11, 'text/plain', 'zip/sub-b.txt', 'completed', 'zip-owner'),
           ('zfv-jp', 'tenant-zip', 'zf-jp', 1, 24, 'text/plain', 'zip/jp.txt', 'completed', 'zip-owner'),
           ('zfv-conf', 'tenant-zip', 'zf-conf', 1, 10, 'text/plain', 'zip/secret.txt', 'completed', 'zip-owner'),
           ('zfv-prev', 'tenant-zip', 'zf-prev', 1, 17, 'text/plain', 'zip/preview-only.txt', 'completed', 'zip-owner'),
           ('zfv-del', 'tenant-zip', 'zf-del', 1, 5, 'text/plain', 'zip/root-a.txt', 'completed', 'zip-owner'),
           ('zfv-pend', 'tenant-zip', 'zf-pend', 1, 5, 'text/plain', 'zip/root-a.txt', 'pending', 'zip-owner')`
      ),
      env.DB.prepare("UPDATE files SET current_version_id = 'zfv-1' WHERE id = 'zf-1'"),
      env.DB.prepare("UPDATE files SET current_version_id = 'zfv-2' WHERE id = 'zf-2'"),
      env.DB.prepare("UPDATE files SET current_version_id = 'zfv-jp' WHERE id = 'zf-jp'"),
      env.DB.prepare("UPDATE files SET current_version_id = 'zfv-conf' WHERE id = 'zf-conf'"),
      env.DB.prepare("UPDATE files SET current_version_id = 'zfv-prev' WHERE id = 'zf-prev'"),
      env.DB.prepare("UPDATE files SET current_version_id = 'zfv-del' WHERE id = 'zf-del'"),
      env.DB.prepare("UPDATE files SET current_version_id = 'zfv-pend' WHERE id = 'zf-pend'"),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('zp-owner', 'tenant-zip', 'folder', 'zip-root', 'user', 'zip-owner', 'owner', 'zip-owner'),
           ('zp-viewer', 'tenant-zip', 'folder', 'zip-root', 'user', 'zip-viewer', 'viewer', 'zip-owner'),
           ('zp-previewer', 'tenant-zip', 'folder', 'zip-root', 'user', 'zip-previewer', 'previewer', 'zip-owner'),
           ('zp-file-prev', 'tenant-zip', 'file', 'zf-prev', 'user', 'zip-viewer', 'previewer', 'zip-owner')`
      ),
    ]);
  });

  it('zip-builder encodes UTF-8 filenames (bit 11), CRC32, and deduplicates/sanitizes paths', () => {
    expect(sanitizeZipPath('../../evil/\\path/日本語.txt')).toBe('evil/path/日本語.txt');

    const used = new Set<string>();
    expect(dedupeZipPath('docs/report.pdf', used)).toBe('docs/report.pdf');
    expect(dedupeZipPath('docs/report.pdf', used)).toBe('docs/report (1).pdf');

    const payload = new TextEncoder().encode('テストデータ');
    const archive = buildZipArchive([
      { path: 'フォルダ/テスト.txt', data: payload },
    ]);

    const entries = parseZipEntries(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('フォルダ/テスト.txt');
    expect(entries[0]!.flags & 0x0800).toBe(0x0800);
    expect(entries[0]!.compression).toBe(0);
    expect(entries[0]!.crc).toBe(crc32(payload));
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('テストデータ');
  });

  it('POST /api/workspace/download-zip builds recursive ZIP, enforces item.download RBAC, and audits', async () => {
    const testEnv = buildTestEnv();

    // Previewer is blocked fail-closed with 403
    const previewerRes = await app.fetch(
      new Request('http://localhost/api/workspace/download-zip', {
        method: 'POST',
        headers: authHeaders('zip-previewer'),
        body: JSON.stringify({ items: [{ type: 'folder', id: 'zip-root' }] }),
      }),
      testEnv
    );
    expect(previewerRes.status).toBe(403);

    // Viewer can download folder; preview-only file (zf-prev), deleted (zf-del), and pending (zf-pend) are excluded
    const viewerRes = await app.fetch(
      new Request('http://localhost/api/workspace/download-zip', {
        method: 'POST',
        headers: authHeaders('zip-viewer'),
        body: JSON.stringify({ items: [{ type: 'folder', id: 'zip-root' }] }),
      }),
      testEnv
    );
    expect(viewerRes.status).toBe(200);
    expect(viewerRes.headers.get('Content-Type')).toBe('application/zip');
    expect(viewerRes.headers.get('Content-Disposition')).toContain('SharedProject.zip');

    const zipBytes = new Uint8Array(await viewerRes.arrayBuffer());
    const entries = parseZipEntries(zipBytes);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual([
      'SharedProject/SubfolderA/notes.txt',
      'SharedProject/SubfolderA/仕様書.txt',
      'SharedProject/readme.txt',
      'SharedProject/secret.txt',
    ]);
    expect(names).not.toContain('SharedProject/preview-only.txt');
    expect(names).not.toContain('SharedProject/deleted.txt');
    expect(names).not.toContain('SharedProject/pending.txt');

    // Requesting zf-prev directly fails closed with 403
    const directBlocked = await app.fetch(
      new Request('http://localhost/api/workspace/download-zip', {
        method: 'POST',
        headers: authHeaders('zip-viewer'),
        body: JSON.stringify({ items: [{ type: 'file', id: 'zf-prev' }] }),
      }),
      testEnv
    );
    expect(directBlocked.status).toBe(403);

    // Verify audit log recorded
    const audit = await env.DB.prepare(
      "SELECT action, status FROM audit_logs WHERE tenant_id = 'tenant-zip' AND action = 'workspace.download_zip' AND status = 'allowed'"
    ).first<{ action: string; status: string }>();
    expect(audit?.action).toBe('workspace.download_zip');
  });

  it('POST /api/workspace/download-zip returns 413 when exceeding 100 files', async () => {
    const testEnv = buildTestEnv();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES ('zip-many', 'tenant-zip', NULL, 'ManyFiles', 0, 1, 'internal', 'zip-owner')`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES ('tenant-zip', 'zip-many', 'zip-many', 0)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES ('zp-many', 'tenant-zip', 'folder', 'zip-many', 'user', 'zip-owner', 'owner', 'zip-owner')`
      ),
    ]);

    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 101; i++) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by, current_version_id)
           VALUES (?, 'tenant-zip', 'zip-many', ?, 'txt', 'text/plain', 10, 'active', 'internal', 'zip-owner', 'zip-owner', 'zfv-1')`
        ).bind(`zf-many-${i}`, `file-${i}.txt`)
      );
    }
    await env.DB.batch(stmts);

    const res = await app.fetch(
      new Request('http://localhost/api/workspace/download-zip', {
        method: 'POST',
        headers: authHeaders('zip-owner'),
        body: JSON.stringify({ items: [{ type: 'folder', id: 'zip-many' }] }),
      }),
      testEnv
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('ZIP_LIMIT_EXCEEDED');
  });

  it('Shared folder supports subfolder navigation, relative breadcrumbs, and ZIP download with guardrails', async () => {
    const testEnv = buildTestEnv();

    // Create download-enabled shared link on zip-root with maxDownloads=1
    const createRes = await app.fetch(
      new Request('http://localhost/api/shared-links', {
        method: 'POST',
        headers: authHeaders('zip-owner'),
        body: JSON.stringify({
          targetType: 'folder',
          targetId: 'zip-root',
          accessScope: 'public',
          permissionLevel: 'download',
          maxDownloads: 1,
        }),
      }),
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { token: string };

    // 1. Root meta includes subfolders & breadcrumbs starting at SharedProject
    const rootMetaRes = await app.fetch(
      new Request(`http://localhost/api/s/${created.token}/meta`),
      testEnv
    );
    expect(rootMetaRes.status).toBe(200);
    const rootMeta = (await rootMetaRes.json()) as {
      currentFolder: { id: string; name: string };
      subfolders: Array<{ id: string; name: string }>;
      breadcrumbs: Array<{ id: string; name: string }>;
      folderFiles: Array<{ id: string; name: string }>;
    };
    expect(rootMeta.currentFolder.id).toBe('zip-root');
    expect(rootMeta.breadcrumbs).toEqual([{ id: 'zip-root', name: 'SharedProject' }]);
    expect(rootMeta.subfolders.map((s) => s.name)).toEqual(['ConfidentialSub', 'SubfolderA']);

    // 2. Navigate into SubfolderA: breadcrumbs do NOT include CompanyPrivateRoot
    const subMetaRes = await app.fetch(
      new Request(`http://localhost/api/s/${created.token}/meta?folderId=zip-sub`),
      testEnv
    );
    expect(subMetaRes.status).toBe(200);
    const subMeta = (await subMetaRes.json()) as {
      currentFolder: { id: string; name: string };
      breadcrumbs: Array<{ id: string; name: string }>;
      folderFiles: Array<{ id: string; name: string }>;
    };
    expect(subMeta.currentFolder.id).toBe('zip-sub');
    expect(subMeta.breadcrumbs).toEqual([
      { id: 'zip-root', name: 'SharedProject' },
      { id: 'zip-sub', name: 'SubfolderA' },
    ]);
    expect(subMeta.folderFiles.map((f) => f.name)).toEqual(['notes.txt', '仕様書.txt']);

    // 3. Traversal outside shared root (zip-above-root or zip-outside) is blocked with 404
    const traversalRes = await app.fetch(
      new Request(`http://localhost/api/s/${created.token}/meta?folderId=zip-above-root`),
      testEnv
    );
    expect(traversalRes.status).toBe(404);

    // 4. Download ZIP of SubfolderA (succeeds, excludes confidential, increments download_count)
    const zipRes = await app.fetch(
      new Request(`http://localhost/api/s/${created.token}/zip?folderId=zip-sub`),
      testEnv
    );
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('Content-Type')).toBe('application/zip');
    expect(zipRes.headers.get('X-Download-Count')).toBe('1');
    const subZipEntries = parseZipEntries(new Uint8Array(await zipRes.arrayBuffer()));
    expect(subZipEntries.map((e) => e.name).sort()).toEqual([
      'SubfolderA/notes.txt',
      'SubfolderA/仕様書.txt',
    ]);

    // 5. Second ZIP download exceeds maxDownloads=1 -> 403 DOWNLOAD_LIMIT_EXCEEDED
    const secondZipRes = await app.fetch(
      new Request(`http://localhost/api/s/${created.token}/zip`),
      testEnv
    );
    expect(secondZipRes.status).toBe(403);
    const limitBody = (await secondZipRes.json()) as { code: string };
    expect(limitBody.code).toBe('DOWNLOAD_LIMIT_EXCEEDED');

    // 6. View-only shared link blocks ZIP download with 403 DOWNLOAD_DISABLED
    const viewCreateRes = await app.fetch(
      new Request('http://localhost/api/shared-links', {
        method: 'POST',
        headers: authHeaders('zip-owner'),
        body: JSON.stringify({
          targetType: 'folder',
          targetId: 'zip-root',
          accessScope: 'public',
          permissionLevel: 'view',
        }),
      }),
      testEnv
    );
    const viewCreated = (await viewCreateRes.json()) as { token: string };
    const viewZipRes = await app.fetch(
      new Request(`http://localhost/api/s/${viewCreated.token}/zip`),
      testEnv
    );
    expect(viewZipRes.status).toBe(403);
    const viewBody = (await viewZipRes.json()) as { code: string };
    expect(viewBody.code).toBe('DOWNLOAD_DISABLED');
  });
});
