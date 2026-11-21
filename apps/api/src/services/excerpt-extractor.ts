import type { ClassificationLabel } from '../types/api';
import type {
  AiClassificationMode,
  ExtractedClassificationContext,
} from '../types/classification';
import { pickStricterClassification } from '../utils/classification';
import {
  detectOoxmlKind,
  extractOoxmlText,
  MAX_OOXML_ZIP_BYTES,
} from './ooxml-text-extractor';

const R2_RANGE_BYTES = 16 * 1024; // 16 KB head range read
const MAX_EXCERPT_CHARS = 3000;

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'log',
  'ini',
  'conf',
  'toml',
  'sql',
  'env',
  'html',
  'htm',
  'svg',
  'css',
  'js',
  'ts',
  'py',
]);

const BINARY_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'zip',
  'gz',
  'tar',
  '7z',
  'rar',
  'mp4',
  'mov',
  'mp3',
  'wav',
  'exe',
  'bin',
]);

export function isPlainTextCandidate(mimeType: string, extension: string | null): boolean {
  const ext = (extension ?? '').replace(/^\./, '').toLowerCase();
  if (ext && BINARY_EXTENSIONS.has(ext)) {
    return false;
  }
  const normalizedMime = mimeType.split(';')[0].trim().toLowerCase();
  if (normalizedMime.startsWith('text/')) {
    return true;
  }
  if (
    normalizedMime === 'application/json' ||
    normalizedMime === 'application/xml' ||
    normalizedMime === 'application/yaml' ||
    normalizedMime === 'application/x-yaml' ||
    normalizedMime === 'application/sql' ||
    normalizedMime === 'image/svg+xml'
  ) {
    return true;
  }
  return Boolean(ext && TEXT_EXTENSIONS.has(ext));
}

export function sanitizeBinaryToTextExcerpt(
  bytes: Uint8Array,
  maxChars = MAX_EXCERPT_CHARS
): string | null {
  if (bytes.byteLength === 0) return null;

  let controlCount = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    const b = bytes[i];
    if (b === 0x00) {
      // NULL byte strongly indicates binary stream
      return null;
    }
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      controlCount++;
    }
  }
  if (controlCount / bytes.byteLength > 0.1) {
    return null;
  }

  const decoded = new TextDecoder('utf-8').decode(bytes);
  const normalized = decoded
    .replace(/\uFFFD+/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) return null;
  return normalized.slice(0, maxChars);
}

/**
 * Extract searchable plain-text excerpt from an R2 object (plain-text or OOXML <= 5 MiB).
 * Never throws; returns null on unsupported types, oversize files, or extraction errors.
 */
export async function extractSearchableExcerpt(
  storage: R2Bucket,
  r2Key: string,
  mimeType: string,
  fileName: string,
  sizeBytes?: number | null
): Promise<string | null> {
  try {
    const ooxmlKind = detectOoxmlKind(mimeType, fileName);
    if (ooxmlKind) {
      if (typeof sizeBytes === 'number' && sizeBytes > MAX_OOXML_ZIP_BYTES) {
        return null;
      }
      const obj = await storage.get(r2Key, {
        range: { offset: 0, length: MAX_OOXML_ZIP_BYTES + 1 },
      });
      if (!obj) {
        return null;
      }
      const buf = new Uint8Array(await obj.arrayBuffer());
      if (buf.byteLength > MAX_OOXML_ZIP_BYTES) {
        return null;
      }
      return await extractOoxmlText(buf, ooxmlKind);
    }

    const dotIdx = fileName.lastIndexOf('.');
    const extension = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : null;
    if (!isPlainTextCandidate(mimeType, extension)) {
      return null;
    }

    const obj = await storage.get(r2Key, {
      range: { offset: 0, length: R2_RANGE_BYTES },
    });
    if (!obj) {
      return null;
    }
    const buf = new Uint8Array(await obj.arrayBuffer());
    return sanitizeBinaryToTextExcerpt(buf, R2_RANGE_BYTES);
  } catch {
    return null;
  }
}

interface PolicyRow {
  ai_classification_mode: AiClassificationMode;
  ai_auto_apply_threshold: number | null;
}

interface FileMetaRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  created_by: string;
  uploader_email: string;
}

export async function extractClassificationContext(
  db: D1Database,
  bucket: R2Bucket,
  input: {
    tenantId: string;
    fileId: string;
    r2ObjectKey: string;
    mimeType?: string;
    fileName?: string;
    extension?: string | null;
  }
): Promise<ExtractedClassificationContext | null> {
  const [policy, fileMeta] = await Promise.all([
    db
      .prepare(
        'SELECT ai_classification_mode, ai_auto_apply_threshold FROM tenant_policies WHERE tenant_id = ?'
      )
      .bind(input.tenantId)
      .first<PolicyRow>(),
    db
      .prepare(
        `SELECT f.id, f.folder_id, f.name, f.extension, f.mime_type, f.size_bytes, f.created_by,
                COALESCE(u.email, 'unknown') AS uploader_email
         FROM files f
         LEFT JOIN users u ON u.id = f.created_by
         WHERE f.tenant_id = ? AND f.id = ? AND f.deleted_at IS NULL AND f.upload_state = 'active'`
      )
      .bind(input.tenantId, input.fileId)
      .first<FileMetaRow>(),
  ]);

  if (!fileMeta) {
    return null;
  }

  const mode: AiClassificationMode = policy?.ai_classification_mode ?? 'metadata_only';
  const mimeType = fileMeta.mime_type ?? input.mimeType ?? 'application/octet-stream';
  const fileName = fileMeta.name ?? input.fileName ?? 'unknown';
  const extension = fileMeta.extension ?? input.extension ?? null;

  let folderPath = '/';
  let ancestorFloorClassification: ClassificationLabel = 'unset';

  if (fileMeta.folder_id) {
    const ancestors = await db
      .prepare(
        `SELECT f.name, f.classification
         FROM folder_closures fc
         JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.ancestor_id
         WHERE fc.tenant_id = ? AND fc.descendant_id = ? AND f.deleted_at IS NULL
         ORDER BY fc.depth DESC`
      )
      .bind(input.tenantId, fileMeta.folder_id)
      .all<{ name: string; classification: ClassificationLabel }>();

    if (ancestors.results.length > 0) {
      folderPath = `/${ancestors.results.map((r) => r.name).join('/')}`;
      for (const row of ancestors.results) {
        ancestorFloorClassification = pickStricterClassification(
          ancestorFloorClassification,
          row.classification
        );
      }
    }
  }

  const groupRows = await db
    .prepare(
      `SELECT g.name
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
       WHERE g.tenant_id = ? AND gm.user_id = ?
       ORDER BY g.name ASC LIMIT 20`
    )
    .bind(input.tenantId, fileMeta.created_by)
    .all<{ name: string }>();

  let excerpt: string | null = null;
  let excerptIncluded = false;

  if (mode === 'content_excerpt') {
    const extracted = await extractSearchableExcerpt(
      bucket,
      input.r2ObjectKey,
      mimeType,
      fileName,
      fileMeta.size_bytes
    );
    if (extracted) {
      excerpt = extracted.slice(0, MAX_EXCERPT_CHARS);
      excerptIncluded = true;
    }
  }

  return {
    tenantId: input.tenantId,
    fileId: fileMeta.id,
    fileName,
    extension,
    mimeType,
    sizeBytes: fileMeta.size_bytes,
    folderPath,
    uploaderEmail: fileMeta.uploader_email,
    uploaderGroups: groupRows.results.map((g) => g.name),
    mode,
    autoApplyThreshold: policy?.ai_auto_apply_threshold ?? null,
    ancestorFloorClassification,
    excerpt,
    excerptIncluded,
  };
}
