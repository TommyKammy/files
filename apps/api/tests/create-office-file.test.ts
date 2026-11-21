import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { buildMinimalOfficeDocument } from '../src/services/ooxml-templates';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-create-office';

function authHeaders(
  userId = 'co-editor',
  role: 'sys_admin' | 'member' = 'member',
  tenantId = TENANT_ID
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
    LOCAL_PROXY_SECRET: 'test-create-office-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
    ...overrides,
  } as OidcEnv;
}

/**
 * Parses STORE-mode ZIP local file headers to list entry paths.
 */
function listZipEntryPaths(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const paths: string[] = [];
  let offset = 0;

  while (offset + 30 <= bytes.byteLength) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break;
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    paths.push(decoder.decode(bytes.subarray(nameStart, nameEnd)));
    offset = nameEnd + extraLen + compressedSize;
  }

  return paths;
}

describe('POST /api/files/create-office & OOXML templates', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'Create Office Org', 'create-office-org', 10000000)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('co-editor', ?, 'co-editor@example.com', 'Editor User', 'member', 'active'),
           ('co-viewer', ?, 'co-viewer@example.com', 'Viewer User', 'member', 'active'),
           ('co-outsider', ?, 'co-outsider@example.com', 'Outsider User', 'member', 'active')`
      ).bind(TENANT_ID, TENANT_ID, TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           ('co-folder-main', ?, NULL, 'Docs', 0, 1, 'internal', 'co-editor'),
           ('co-folder-deleted', ?, NULL, 'Deleted', 0, 1, 'unset', 'co-editor')`
      ).bind(TENANT_ID, TENANT_ID),
      env.DB.prepare(
        `UPDATE folders SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = 'co-folder-deleted'`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           (?, 'co-folder-main', 'co-folder-main', 0),
           (?, 'co-folder-deleted', 'co-folder-deleted', 0)`
      ).bind(TENANT_ID, TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('co-p1', ?, 'folder', 'co-folder-main', 'user', 'co-editor', 'editor', 'co-editor'),
           ('co-p2', ?, 'folder', 'co-folder-main', 'user', 'co-viewer', 'viewer', 'co-editor')`
      ).bind(TENANT_ID, TENANT_ID),
    ]);
  });

  it('builds valid minimal OOXML ZIP packages for docx, xlsx, and pptx', () => {
    const docx = buildMinimalOfficeDocument('docx');
    expect(Array.from(docx.bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(docx.extension).toBe('docx');
    expect(docx.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    expect(listZipEntryPaths(docx.bytes)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'word/document.xml',
        'word/_rels/document.xml.rels',
        'docProps/core.xml',
        'docProps/app.xml',
      ])
    );

    const xlsx = buildMinimalOfficeDocument('xlsx');
    expect(Array.from(xlsx.bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(xlsx.extension).toBe('xlsx');
    expect(xlsx.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(listZipEntryPaths(xlsx.bytes)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/worksheets/sheet1.xml',
        'xl/styles.xml',
      ])
    );

    const pptx = buildMinimalOfficeDocument('pptx');
    expect(Array.from(pptx.bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(pptx.extension).toBe('pptx');
    expect(pptx.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    expect(listZipEntryPaths(pptx.bytes)).toEqual(
      expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        'ppt/presentation.xml',
        'ppt/_rels/presentation.xml.rels',
        'ppt/slides/slide1.xml',
        'ppt/slideLayouts/slideLayout1.xml',
        'ppt/slideMasters/slideMaster1.xml',
        'ppt/theme/theme1.xml',
      ])
    );
  });

  it('creates docx/xlsx/pptx files in R2 + D1 + FTS5 + audit_logs and normalizes filenames', async () => {
    const testEnv = buildTestEnv();

    const res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-editor'),
        body: JSON.stringify({
          folderId: 'co-folder-main',
          name: 'Q4 Report',
          kind: 'docx',
        }),
      }),
      testEnv
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      file: {
        id: string;
        name: string;
        extension: string;
        mime_type: string;
        classification: string;
        upload_state: string;
        current_version_num: number;
      };
    };

    expect(body.file.name).toBe('Q4 Report.docx');
    expect(body.file.extension).toBe('docx');
    expect(body.file.classification).toBe('internal');
    expect(body.file.upload_state).toBe('active');
    expect(body.file.current_version_num).toBe(1);

    const version = await env.DB.prepare(
      'SELECT r2_object_key, upload_status FROM file_versions WHERE file_id = ?'
    )
      .bind(body.file.id)
      .first<{ r2_object_key: string; upload_status: string }>();
    expect(version?.upload_status).toBe('completed');

    const r2Obj = await env.BUCKET.get(version!.r2_object_key);
    expect(r2Obj).toBeTruthy();
    const r2Bytes = new Uint8Array(await r2Obj!.arrayBuffer());
    expect(Array.from(r2Bytes.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(listZipEntryPaths(r2Bytes)).toContain('word/document.xml');

    const ftsRow = await env.DB.prepare(
      'SELECT file_id, name FROM files_fts WHERE file_id = ?'
    )
      .bind(body.file.id)
      .first<{ file_id: string; name: string }>();
    expect(ftsRow?.name).toBe('Q4 Report.docx');

    const auditRow = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE target_id = ? AND action = 'file.create_office'"
    )
      .bind(body.file.id)
      .first<{ action: string }>();
    expect(auditRow?.action).toBe('file.create_office');

    // Creating xlsx & pptx
    const xlsxRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-editor'),
        body: JSON.stringify({
          folderId: 'co-folder-main',
          name: 'Budget.xlsx',
          kind: 'xlsx',
        }),
      }),
      testEnv
    );
    expect(xlsxRes.status).toBe(201);
    const xlsxBody = (await xlsxRes.json()) as { file: { name: string } };
    expect(xlsxBody.file.name).toBe('Budget.xlsx');

    const pptxRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-editor'),
        body: JSON.stringify({
          folderId: 'co-folder-main',
          name: 'Kickoff',
          kind: 'pptx',
        }),
      }),
      testEnv
    );
    expect(pptxRes.status).toBe(201);
    const pptxBody = (await pptxRes.json()) as { file: { name: string } };
    expect(pptxBody.file.name).toBe('Kickoff.pptx');
  });

  it('enforces RBAC, rejects missing/deleted/root folderId, rejects path separators, and returns 409 on duplicate name', async () => {
    const testEnv = buildTestEnv();

    // Viewer lacks item.upload_new -> 403
    const viewerRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-viewer'),
        body: JSON.stringify({
          folderId: 'co-folder-main',
          name: 'Forbidden',
          kind: 'docx',
        }),
      }),
      testEnv
    );
    expect(viewerRes.status).toBe(403);

    // Outsider has no access -> 404 or 403
    const outsiderRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-outsider'),
        body: JSON.stringify({
          folderId: 'co-folder-main',
          name: 'Outsider',
          kind: 'docx',
        }),
      }),
      testEnv
    );
    expect([403, 404]).toContain(outsiderRes.status);

    // Missing / root folderId -> 400
    const rootRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-editor'),
        body: JSON.stringify({
          folderId: null,
          name: 'RootDoc',
          kind: 'docx',
        }),
      }),
      testEnv
    );
    expect(rootRes.status).toBe(400);

    // Deleted folderId -> 404
    const deletedRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-editor'),
        body: JSON.stringify({
          folderId: 'co-folder-deleted',
          name: 'InDeleted',
          kind: 'docx',
        }),
      }),
      testEnv
    );
    expect(deletedRes.status).toBe(404);

    // Path separator -> 400
    const badNameRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-editor'),
        body: JSON.stringify({
          folderId: 'co-folder-main',
          name: '../evil',
          kind: 'docx',
        }),
      }),
      testEnv
    );
    expect(badNameRes.status).toBe(400);

    // Duplicate name -> 409 NAME_CONFLICT
    const dupRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/create-office', {
        method: 'POST',
        headers: authHeaders('co-editor'),
        body: JSON.stringify({
          folderId: 'co-folder-main',
          name: 'Q4 Report',
          kind: 'docx',
        }),
      }),
      testEnv
    );
    expect(dupRes.status).toBe(409);
    const dupBody = (await dupRes.json()) as { code: string };
    expect(dupBody.code).toBe('NAME_CONFLICT');
  });
});
