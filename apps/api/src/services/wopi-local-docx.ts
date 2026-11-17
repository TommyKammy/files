import { buildR2ObjectKey, type FileRow } from './file-upload-common';
import type { WopiDraftRow } from './wopi-drafts';
import type { OidcEnv } from '../types/oidc';

const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ZIP_LOCAL_HEADER_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

export interface LocalDocxVersionRef {
  id: string;
  r2_object_key: string;
}

export interface LocalDocxEnsureResult {
  currentVersion: LocalDocxVersionRef | null;
  activeDraft: WopiDraftRow | null;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

interface ZipEntryInput {
  path: string;
  data: Uint8Array;
}

/**
 * Minimal STORE-method (uncompressed) ZIP writer. DOCX is a ZIP container and
 * Collabora only needs a structurally valid package, not DEFLATE compression.
 */
function buildStoreZip(entries: ZipEntryInput[], modifiedAt: Date): Uint8Array {
  const encoder = new TextEncoder();
  const { dosTime, dosDate } = toDosDateTime(modifiedAt);
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length + entry.data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    localChunks.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    central.set(nameBytes, 46);
    centralChunks.push(central);

    localOffset += local.length;
  }

  const centralDirectory = concatBytes(centralChunks);
  const endOfCentralDirectory = new Uint8Array(22);
  const endView = new DataView(endOfCentralDirectory.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return concatBytes([...localChunks, centralDirectory, endOfCentralDirectory]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Builds a small but valid WordprocessingML package for local Collabora use. */
export function createMinimalDocx(fileName: string, modifiedAt = new Date()): Uint8Array {
  const title = escapeXml(fileName || 'Local document');
  const bodyText = escapeXml(
    `Local development document for ${fileName || 'Files'}. Edit and save with Collabora Online.`
  );
  const timestamp = modifiedAt.toISOString();
  const encoder = new TextEncoder();

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const packageRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:t xml:space="preserve">${bodyText}</w:t>
      </w:r>
    </w:p>
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${title}</dc:title>
  <dc:creator>Files</dc:creator>
  <cp:lastModifiedBy>Files</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified>
</cp:coreProperties>`;

  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Files</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>16.0000</AppVersion>
</Properties>`;

  return buildStoreZip(
    [
      { path: '[Content_Types].xml', data: encoder.encode(contentTypes) },
      { path: '_rels/.rels', data: encoder.encode(packageRels) },
      { path: 'word/document.xml', data: encoder.encode(documentXml) },
      {
        path: 'word/_rels/document.xml.rels',
        data: encoder.encode(documentRels),
      },
      { path: 'docProps/core.xml', data: encoder.encode(coreXml) },
      { path: 'docProps/app.xml', data: encoder.encode(appXml) },
    ],
    modifiedAt
  );
}

async function objectStartsWithZipMagic(
  bucket: R2Bucket,
  objectKey: string
): Promise<boolean> {
  const object = await bucket.get(objectKey, {
    range: { offset: 0, length: ZIP_LOCAL_HEADER_MAGIC.length },
  });
  if (!object) return false;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length < ZIP_LOCAL_HEADER_MAGIC.length) return false;
  return ZIP_LOCAL_HEADER_MAGIC.every((byte, index) => bytes[index] === byte);
}

async function deactivateDraft(
  db: D1Database,
  draftId: string,
  nowIso: string
): Promise<void> {
  await db
    .prepare(
      'UPDATE wopi_drafts SET is_active = 0, updated_at = ? WHERE id = ?'
    )
    .bind(nowIso, draftId)
    .run();
}

async function resolveVersionTarget(
  env: Pick<OidcEnv, 'DB'>,
  file: FileRow,
  currentVersion: LocalDocxVersionRef | null
): Promise<{ version: LocalDocxVersionRef; versionNum: number }> {
  if (currentVersion) {
    return {
      version: currentVersion,
      versionNum: Math.max(1, file.current_version_num || 1),
    };
  }

  const latest = await env.DB.prepare(
    `SELECT id, r2_object_key, version_num FROM file_versions
      WHERE tenant_id = ? AND file_id = ?
      ORDER BY version_num DESC LIMIT 1`
  )
    .bind(file.tenant_id, file.id)
    .first<{ id: string; r2_object_key: string; version_num: number }>();

  if (latest) {
    return {
      version: { id: latest.id, r2_object_key: latest.r2_object_key },
      versionNum: latest.version_num,
    };
  }

  const versionNum = Math.max(1, file.current_version_num || 1);
  return {
    version: {
      id: crypto.randomUUID(),
      r2_object_key: buildR2ObjectKey(file.tenant_id, file.id, versionNum),
    },
    versionNum,
  };
}

/**
 * Local-dev-only guard for Collabora: makes sure the file has a real OOXML
 * `.docx` object on disk. Benchmark seeds and broken local fixtures get a
 * generated package; non-ZIP drafts are retired so Collabora opens the
 * document rather than failing to parse arbitrary bytes.
 */
export async function ensureLocalDevDocxContent(
  env: Pick<OidcEnv, 'DB' | 'BUCKET'>,
  file: FileRow,
  currentVersion: LocalDocxVersionRef | null,
  activeDraft: WopiDraftRow | null
): Promise<LocalDocxEnsureResult> {
  const nowIso = new Date().toISOString();

  if (
    activeDraft &&
    (await objectStartsWithZipMagic(env.BUCKET, activeDraft.r2_object_key))
  ) {
    return { currentVersion, activeDraft };
  }

  if (
    currentVersion &&
    (await objectStartsWithZipMagic(env.BUCKET, currentVersion.r2_object_key))
  ) {
    if (activeDraft) {
      await deactivateDraft(env.DB, activeDraft.id, nowIso);
    }
    return { currentVersion, activeDraft: null };
  }

  const content = createMinimalDocx(file.name, new Date(nowIso));
  const target = await resolveVersionTarget(env, file, currentVersion);

  await env.BUCKET.put(target.version.r2_object_key, content, {
    httpMetadata: { contentType: DOCX_MIME_TYPE },
  });

  await env.DB.prepare(
    `INSERT INTO file_versions (
       id, tenant_id, file_id, version_num, r2_object_key, r2_upload_id,
       size_bytes, mime_type, upload_status, uploaded_by, comment, created_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'completed', ?, 'Local dev Collabora seed', ?)
     ON CONFLICT (id) DO UPDATE SET
       r2_object_key = excluded.r2_object_key,
       size_bytes = excluded.size_bytes,
       mime_type = excluded.mime_type,
       upload_status = 'completed'`
  )
    .bind(
      target.version.id,
      file.tenant_id,
      file.id,
      target.versionNum,
      target.version.r2_object_key,
      content.byteLength,
      DOCX_MIME_TYPE,
      file.created_by,
      nowIso
    )
    .run();

  await env.DB.prepare(
    `UPDATE files
        SET current_version_id = ?, current_version_num = ?, size_bytes = ?,
            mime_type = ?, upload_state = 'active', updated_at = ?
      WHERE tenant_id = ? AND id = ?`
  )
    .bind(
      target.version.id,
      target.versionNum,
      content.byteLength,
      DOCX_MIME_TYPE,
      nowIso,
      file.tenant_id,
      file.id
    )
    .run();

  if (activeDraft) {
    await deactivateDraft(env.DB, activeDraft.id, nowIso);
  }

  return { currentVersion: target.version, activeDraft: null };
}

export function isDocxFile(file: Pick<FileRow, 'extension' | 'name'>): boolean {
  return (
    file.extension === 'docx' || file.name.toLowerCase().endsWith('.docx')
  );
}
