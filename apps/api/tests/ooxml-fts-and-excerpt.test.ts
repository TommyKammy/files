import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import {
  extractClassificationContext,
  extractSearchableExcerpt,
} from '../src/services/excerpt-extractor';
import {
  extractOoxmlText,
  MAX_OOXML_ENTRY_DECOMPRESSED_BYTES,
  MAX_OOXML_TEXT_CHARS,
  MAX_OOXML_ZIP_BYTES,
  MAX_OOXML_ZIP_ENTRIES,
} from '../src/services/ooxml-text-extractor';
import { buildZipArchive } from '../src/services/zip-builder';
import type { OidcEnv } from '../src/types/oidc';

const UTF8_ENCODER = new TextEncoder();
const TENANT_ID = 'tenant-ooxml-fts';

function authHeaders(
  userId: string,
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
    LOCAL_PROXY_SECRET: 'test-ooxml-fts-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
    ...overrides,
  } as OidcEnv;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  const writePromise = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close());
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await writePromise;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

/**
 * Build a minimal ZIP archive with optional per-entry DEFLATE (method 8) and optional spoofed uncompressedSize.
 */
async function buildCustomZip(
  entries: Array<{
    path: string;
    data: Uint8Array;
    deflate?: boolean;
    spoofUncompressedSize?: number;
  }>
): Promise<Uint8Array> {
  const localParts: Uint8Array[] = [];
  const cdParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = UTF8_ENCODER.encode(entry.path);
    const compressed = entry.deflate ? await deflateRaw(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const uncompressedSize = entry.spoofUncompressedSize ?? entry.data.byteLength;

    const lfh = new Uint8Array(30 + nameBytes.byteLength);
    const lfhView = new DataView(lfh.buffer);
    lfhView.setUint32(0, 0x04034b50, true);
    lfhView.setUint16(4, 20, true);
    lfhView.setUint16(8, method, true);
    lfhView.setUint32(18, compressed.byteLength, true);
    lfhView.setUint32(22, uncompressedSize, true);
    lfhView.setUint16(26, nameBytes.byteLength, true);
    lfh.set(nameBytes, 30);

    localParts.push(lfh, compressed);

    const cdh = new Uint8Array(46 + nameBytes.byteLength);
    const cdhView = new DataView(cdh.buffer);
    cdhView.setUint32(0, 0x02014b50, true);
    cdhView.setUint16(4, 20, true);
    cdhView.setUint16(6, 20, true);
    cdhView.setUint16(10, method, true);
    cdhView.setUint32(20, compressed.byteLength, true);
    cdhView.setUint32(24, uncompressedSize, true);
    cdhView.setUint16(28, nameBytes.byteLength, true);
    cdhView.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);

    cdParts.push(cdh);
    offset += lfh.byteLength + compressed.byteLength;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of cdParts) cdSize += c.byteLength;

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);

  const totalSize = cdOffset + cdSize + 22;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  for (const p of cdParts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  out.set(eocd, pos);
  return out;
}

describe('OOXML text extraction, excerpt extractor, and FTS5 search', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'OOXML FTS Org', 'ooxml-fts-org', 50000000)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id, ai_classification_mode)
         VALUES (?, 'content_excerpt')`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('ox-owner', ?, 'ox-owner@example.com', 'Owner User', 'member', 'active'),
           ('ox-outsider', ?, 'ox-outsider@example.com', 'Outsider User', 'member', 'active')`
      ).bind(TENANT_ID, TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES ('ox-folder-sec', ?, NULL, 'Secret Docs', 0, 1, 'confidential', 'ox-owner')`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, 'ox-folder-sec', 'ox-folder-sec', 0)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES ('ox-perm-1', ?, 'folder', 'ox-folder-sec', 'user', 'ox-owner', 'owner', 'ox-owner')`
      ).bind(TENANT_ID),
    ]);
  });

  it('extracts STORE and DEFLATE .docx with Japanese text and XML entities', async () => {
    const docXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Budget &amp; Forecast &lt;2026&gt; &quot;Q1&quot; &apos;OK&apos;</w:t></w:r></w:p>
          <w:p><w:r><w:t>機密プロジェクト計画書 &#12354;&#x3044;</w:t></w:r></w:p>
        </w:body>
      </w:document>`;

    const storeZip = buildZipArchive([
      { path: 'word/document.xml', data: UTF8_ENCODER.encode(docXml) },
    ]);
    const storeText = await extractOoxmlText(storeZip, 'docx');
    expect(storeText).toBe('Budget & Forecast <2026> "Q1" \'OK\'\n機密プロジェクト計画書 あい');

    const deflateZip = await buildCustomZip([
      { path: 'word/document.xml', data: UTF8_ENCODER.encode(docXml), deflate: true },
    ]);
    const deflateText = await extractOoxmlText(deflateZip, 'docx');
    expect(deflateText).toBe('Budget & Forecast <2026> "Q1" \'OK\'\n機密プロジェクト計画書 あい');
  });

  it('extracts STORE and DEFLATE .xlsx sharedStrings and inlineStr', async () => {
    const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <si><t>売上高</t></si>
        <si><r><t>営業</t></r><r><t>利益</t></r></si>
      </sst>`;
    const sheet1Xml = `<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
        <sheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="s"><v>1</v></c>
            <c r="C1" t="inlineStr"><is><t>Inline &amp; Cell</t></is></c>
          </row>
        </sheetData>
      </worksheet>`;

    const storeZip = buildZipArchive([
      { path: 'xl/sharedStrings.xml', data: UTF8_ENCODER.encode(sharedStringsXml) },
      { path: 'xl/worksheets/sheet1.xml', data: UTF8_ENCODER.encode(sheet1Xml) },
    ]);
    expect(await extractOoxmlText(storeZip, 'xlsx')).toBe('売上高 営業利益 Inline & Cell');

    const deflateZip = await buildCustomZip([
      { path: 'xl/sharedStrings.xml', data: UTF8_ENCODER.encode(sharedStringsXml), deflate: true },
      { path: 'xl/worksheets/sheet1.xml', data: UTF8_ENCODER.encode(sheet1Xml), deflate: true },
    ]);
    expect(await extractOoxmlText(deflateZip, 'xlsx')).toBe('売上高 営業利益 Inline & Cell');
  });

  it('extracts STORE and DEFLATE .pptx slides in order', async () => {
    const slide1Xml = `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody>
          <a:p><a:r><a:t>Slide One Title</a:t></a:r></a:p>
        </p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>`;
    const slide2Xml = `<?xml version="1.0" encoding="UTF-8"?>
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody>
          <a:p><a:r><a:t>発表資料サマリー</a:t></a:r></a:p>
        </p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>`;

    const deflateZip = await buildCustomZip([
      { path: 'ppt/slides/slide2.xml', data: UTF8_ENCODER.encode(slide2Xml), deflate: true },
      { path: 'ppt/slides/slide1.xml', data: UTF8_ENCODER.encode(slide1Xml), deflate: true },
    ]);
    expect(await extractOoxmlText(deflateZip, 'pptx')).toBe('Slide One Title\n発表資料サマリー');
  });

  it('enforces zip-bomb and oversize safety limits', async () => {
    // 1. Input buffer > 5 MiB
    const oversizedBuf = new Uint8Array(MAX_OOXML_ZIP_BYTES + 1);
    expect(await extractOoxmlText(oversizedBuf, 'docx')).toBeNull();

    // 2. Entry count > 200
    const manyEntries = Array.from({ length: MAX_OOXML_ZIP_ENTRIES + 1 }, (_, i) => ({
      path: `extra/file-${i}.txt`,
      data: UTF8_ENCODER.encode('x'),
    }));
    const tooManyZip = buildZipArchive(manyEntries);
    expect(await extractOoxmlText(tooManyZip, 'docx')).toBeNull();

    // 3. Decompressed entry > 512 KiB (even with spoofed small uncompressedSize header)
    const bigPayload = UTF8_ENCODER.encode(
      `<w:document><w:body><w:p><w:r><w:t>${'A'.repeat(MAX_OOXML_ENTRY_DECOMPRESSED_BYTES + 4096)}</w:t></w:r></w:p></w:body></w:document>`
    );
    const bombZip = await buildCustomZip([
      {
        path: 'word/document.xml',
        data: bigPayload,
        deflate: true,
        spoofUncompressedSize: 100,
      },
    ]);
    expect(await extractOoxmlText(bombZip, 'docx')).toBeNull();

    // 4. Final extracted text capped at 16 KiB
    const largeText = 'Z'.repeat(30_000);
    const largeDocXml = `<w:document><w:body><w:p><w:r><w:t>${largeText}</w:t></w:r></w:p></w:body></w:document>`;
    const largeValidZip = await buildCustomZip([
      { path: 'word/document.xml', data: UTF8_ENCODER.encode(largeDocXml), deflate: true },
    ]);
    const extracted = await extractOoxmlText(largeValidZip, 'docx');
    expect(extracted).not.toBeNull();
    expect(extracted!.length).toBeLessThanOrEqual(MAX_OOXML_TEXT_CHARS);
  });

  it('populates AI classification excerpt for .docx and skips > 5 MiB', async () => {
    const docXml = `<w:document><w:body><w:p><w:r><w:t>Confidential Merger Agreement 2026</w:t></w:r></w:p></w:body></w:document>`;
    const docxBytes = await buildCustomZip([
      { path: 'word/document.xml', data: UTF8_ENCODER.encode(docXml), deflate: true },
    ]);

    const r2Key = `tenants/${TENANT_ID}/objects/ox-ai-1/v1`;
    await env.BUCKET.put(r2Key, docxBytes);

    await env.DB.prepare(
      `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
       VALUES ('ox-ai-1', ?, 'ox-folder-sec', 'merger.docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ?, 'active', 'unset', 'ox-owner', 'ox-owner')`
    )
      .bind(TENANT_ID, docxBytes.byteLength)
      .run();

    const ctx = await extractClassificationContext(env.DB, env.BUCKET, {
      tenantId: TENANT_ID,
      fileId: 'ox-ai-1',
      r2ObjectKey: r2Key,
    });

    expect(ctx).not.toBeNull();
    expect(ctx!.excerptIncluded).toBe(true);
    expect(ctx!.excerpt).toContain('Confidential Merger Agreement 2026');

    // Oversize > 5 MiB skips R2 extraction
    const skipped = await extractSearchableExcerpt(
      env.BUCKET,
      r2Key,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'huge.docx',
      MAX_OOXML_ZIP_BYTES + 1
    );
    expect(skipped).toBeNull();
  });

  it('end-to-end: uploaded .docx body text is indexed in FTS5 and searchable with RBAC', async () => {
    const testEnv = buildTestEnv();
    const docXml = `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body>
          <w:p><w:r><w:t>Project XyloQuantum991 internal briefing</w:t></w:r></w:p>
          <w:p><w:r><w:t>極秘監査レポート対象</w:t></w:r></w:p>
        </w:body>
      </w:document>`;
    const docxBytes = await buildCustomZip([
      { path: 'word/document.xml', data: UTF8_ENCODER.encode(docXml), deflate: true },
    ]);

    const initRes = await app.request(
      '/api/files/upload-init',
      {
        method: 'POST',
        headers: authHeaders('ox-owner'),
        body: JSON.stringify({
          folderId: 'ox-folder-sec',
          fileName: 'quarterly-report.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: docxBytes.byteLength,
        }),
      },
      testEnv
    );
    expect(initRes.status).toBe(201);
    const initJson = (await initRes.json()) as {
      fileId: string;
      versionId: string;
      r2ObjectKey: string;
    };

    await testEnv.BUCKET.put(initJson.r2ObjectKey, docxBytes, {
      httpMetadata: {
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    });

    const completeRes = await app.request(
      '/api/files/upload-complete',
      {
        method: 'POST',
        headers: authHeaders('ox-owner'),
        body: JSON.stringify({
          fileId: initJson.fileId,
          versionId: initJson.versionId,
        }),
      },
      testEnv
    );
    expect(completeRes.status).toBe(200);

    // Verify files.content_excerpt persisted
    const dbRow = await env.DB.prepare(
      'SELECT content_excerpt FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, initJson.fileId)
      .first<{ content_excerpt: string | null }>();
    expect(dbRow?.content_excerpt).toContain('XyloQuantum991');

    // Search by English body keyword (not in filename) as authorized owner
    const searchOwner = await app.request(
      '/api/search?q=XyloQuantum991',
      { headers: authHeaders('ox-owner') },
      testEnv
    );
    expect(searchOwner.status).toBe(200);
    const ownerJson = (await searchOwner.json()) as { results: Array<{ id: string; name: string }> };
    expect(ownerJson.results.some((r) => r.id === initJson.fileId)).toBe(true);

    // Search by Japanese body keyword as authorized owner
    const searchJa = await app.request(
      `/api/search?q=${encodeURIComponent('極秘監査レポート')}`,
      { headers: authHeaders('ox-owner') },
      testEnv
    );
    expect(searchJa.status).toBe(200);
    const jaJson = (await searchJa.json()) as { results: Array<{ id: string }> };
    expect(jaJson.results.some((r) => r.id === initJson.fileId)).toBe(true);

    // Search as unauthorized outsider -> RBAC must block!
    const searchOutsider = await app.request(
      '/api/search?q=XyloQuantum991',
      { headers: authHeaders('ox-outsider') },
      testEnv
    );
    expect(searchOutsider.status).toBe(200);
    const outsiderJson = (await searchOutsider.json()) as { results: Array<{ id: string }> };
    expect(outsiderJson.results).toHaveLength(0);
  });
});
