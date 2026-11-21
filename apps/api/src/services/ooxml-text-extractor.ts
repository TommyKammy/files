export type OoxmlKind = 'docx' | 'xlsx' | 'pptx';

export const MAX_OOXML_ZIP_BYTES = 5 * 1024 * 1024; // 5 MiB
export const MAX_OOXML_ZIP_ENTRIES = 200;
export const MAX_OOXML_ENTRY_DECOMPRESSED_BYTES = 512 * 1024; // 512 KiB
export const MAX_OOXML_TEXT_CHARS = 16 * 1024; // 16 KiB

const EOCD_SIGNATURE = 0x06054b50;
const CD_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const UTF8_DECODER = new TextDecoder('utf-8');

const OOXML_MIME_MAP: Record<string, OoxmlKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const OOXML_EXT_MAP: Record<string, OoxmlKind> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
};

interface ZipEntryMeta {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Detect OOXML document kind from MIME type or filename/extension.
 */
export function detectOoxmlKind(
  mimeType?: string | null,
  fileNameOrExt?: string | null
): OoxmlKind | null {
  if (mimeType) {
    const normalizedMime = mimeType.split(';')[0].trim().toLowerCase();
    const byMime = OOXML_MIME_MAP[normalizedMime];
    if (byMime) {
      return byMime;
    }
  }
  if (fileNameOrExt) {
    const trimmed = fileNameOrExt.trim().toLowerCase();
    const dotIdx = trimmed.lastIndexOf('.');
    const ext = dotIdx >= 0 ? trimmed.slice(dotIdx + 1) : trimmed;
    const byExt = OOXML_EXT_MAP[ext];
    if (byExt) {
      return byExt;
    }
  }
  return null;
}

function findEocdOffset(bytes: Uint8Array, view: DataView): number {
  const minOffset = Math.max(0, bytes.byteLength - 22 - 65535);
  for (let i = bytes.byteLength - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen <= bytes.byteLength) {
        return i;
      }
    }
  }
  return -1;
}

function parseCentralDirectory(
  bytes: Uint8Array,
  wantEntry: (name: string) => boolean
): ZipEntryMeta[] | null {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_OOXML_ZIP_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocdOffset(bytes, view);
  if (eocdOffset < 0) {
    return null;
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const cdStartDisk = view.getUint16(eocdOffset + 6, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || cdStartDisk !== 0) {
    return null;
  }
  if (totalEntries === 0 || totalEntries > MAX_OOXML_ZIP_ENTRIES) {
    return null;
  }
  if (cdOffset + cdSize > eocdOffset || cdOffset >= bytes.byteLength) {
    return null;
  }

  const entries: ZipEntryMeta[] = [];
  let offset = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let i = 0; i < totalEntries; i++) {
    if (offset + 46 > cdEnd) {
      return null;
    }
    if (view.getUint32(offset, true) !== CD_SIGNATURE) {
      return null;
    }

    const compressionMethod = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);

    const nextOffset = offset + 46 + fileNameLen + extraLen + commentLen;
    if (nextOffset > cdEnd || nextOffset > bytes.byteLength) {
      return null;
    }

    const name = UTF8_DECODER.decode(bytes.subarray(offset + 46, offset + 46 + fileNameLen));
    if (wantEntry(name)) {
      if (uncompressedSize > MAX_OOXML_ENTRY_DECOMPRESSED_BYTES) {
        return null;
      }
      entries.push({
        name,
        compressionMethod,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
    }

    offset = nextOffset;
  }

  return entries;
}

async function inflateDeflateRawBounded(compressed: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined') {
    return null;
  }

  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const writePromise = (async () => {
    try {
      await writer.write(compressed as Uint8Array<ArrayBuffer>);
      await writer.close();
    } catch {
      // Ignore write/close errors when reader aborts early (e.g., zip-bomb or corrupt stream)
    }
  })();

  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_OOXML_ENTRY_DECOMPRESSED_BYTES) {
        await reader.cancel().catch(() => {});
        await writePromise;
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    await writePromise;
    return null;
  }

  await writePromise;

  const out = new Uint8Array(totalBytes);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return out;
}

async function readZipEntryText(
  bytes: Uint8Array,
  view: DataView,
  entry: ZipEntryMeta
): Promise<string | null> {
  const lfh = entry.localHeaderOffset;
  if (lfh + 30 > bytes.byteLength) {
    return null;
  }
  if (view.getUint32(lfh, true) !== LFH_SIGNATURE) {
    return null;
  }

  const lfhNameLen = view.getUint16(lfh + 26, true);
  const lfhExtraLen = view.getUint16(lfh + 28, true);
  const dataStart = lfh + 30 + lfhNameLen + lfhExtraLen;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > bytes.byteLength || dataStart < 0) {
    return null;
  }

  const payload = bytes.subarray(dataStart, dataEnd);

  if (entry.compressionMethod === METHOD_STORE) {
    if (payload.byteLength > MAX_OOXML_ENTRY_DECOMPRESSED_BYTES) {
      return null;
    }
    return UTF8_DECODER.decode(payload);
  }

  if (entry.compressionMethod === METHOD_DEFLATE) {
    const inflated = await inflateDeflateRawBounded(payload);
    if (!inflated) {
      return null;
    }
    return UTF8_DECODER.decode(inflated);
  }

  return null;
}

/**
 * Decode standard XML entities and numeric character references in a single pass.
 */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (full, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const codePoint = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
          return String.fromCodePoint(codePoint);
        }
        return full;
      }
    }
  });
}

function normalizeExtractedText(raw: string): string | null {
  const normalized = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!normalized) {
    return null;
  }
  return normalized.slice(0, MAX_OOXML_TEXT_CHARS).trim() || null;
}

function extractDocxXmlText(xml: string): string {
  const parts: string[] = [];
  const tokenRe = /(<\/w:p>|<\/w:tr>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml)) !== null) {
    if (match[2] !== undefined) {
      parts.push(decodeXmlEntities(match[2]));
    } else if (match[1].startsWith('<w:tab')) {
      parts.push(' ');
    } else {
      parts.push('\n');
    }
  }
  return parts.join('');
}

function extractPptxSlideXmlText(xml: string): string {
  const parts: string[] = [];
  const tokenRe = /(<\/a:p>|<a:br\b[^>]*\/?>|<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(xml)) !== null) {
    if (match[2] !== undefined) {
      parts.push(decodeXmlEntities(match[2]));
    } else {
      parts.push('\n');
    }
  }
  return parts.join('');
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRe.exec(xml)) !== null) {
    const inner = siMatch[1];
    const tParts: string[] = [];
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRe.exec(inner)) !== null) {
      tParts.push(decodeXmlEntities(tMatch[1]));
    }
    strings.push(tParts.join(''));
  }
  return strings;
}

function extractXlsxSheetXmlText(xml: string, sharedStrings: string[]): string {
  const parts: string[] = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const rowValues: string[] = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1];
      const cellBody = cellMatch[2];
      const typeMatch = /\bt\s*=\s*["']([^"']+)["']/.exec(attrs);
      const cellType = typeMatch?.[1] ?? '';

      if (cellType === 's') {
        const vMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cellBody);
        if (vMatch) {
          const idx = Number.parseInt(vMatch[1].trim(), 10);
          if (Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length) {
            const val = sharedStrings[idx];
            if (val) rowValues.push(val);
          }
        }
      } else if (cellType === 'inlineStr') {
        const tParts: string[] = [];
        const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let tMatch: RegExpExecArray | null;
        while ((tMatch = tRe.exec(cellBody)) !== null) {
          tParts.push(decodeXmlEntities(tMatch[1]));
        }
        const joined = tParts.join('');
        if (joined) rowValues.push(joined);
      } else if (cellType === 'str') {
        const vMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cellBody);
        if (vMatch) {
          const val = decodeXmlEntities(vMatch[1]);
          if (val) rowValues.push(val);
        }
      }
    }
    if (rowValues.length > 0) {
      parts.push(rowValues.join(' '));
    }
  }
  return parts.join('\n');
}

function compareNumberedXmlPaths(a: string, b: string): number {
  const numA = Number.parseInt(/(\d+)\.xml$/i.exec(a)?.[1] ?? '0', 10);
  const numB = Number.parseInt(/(\d+)\.xml$/i.exec(b)?.[1] ?? '0', 10);
  if (numA !== numB) {
    return numA - numB;
  }
  return a.localeCompare(b);
}

/**
 * Extract plain text from an OOXML (.docx, .xlsx, .pptx) ZIP buffer.
 * Enforces strict size, entry count, and per-entry decompression limits.
 */
export async function extractOoxmlText(
  input: Uint8Array | ArrayBuffer,
  kind: OoxmlKind
): Promise<string | null> {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_OOXML_ZIP_BYTES) {
      return null;
    }

    const wantEntry = (name: string): boolean => {
      if (kind === 'docx') {
        return name === 'word/document.xml';
      }
      if (kind === 'xlsx') {
        return (
          name === 'xl/sharedStrings.xml' ||
          /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)
        );
      }
      return /^ppt\/slides\/slide\d+\.xml$/i.test(name);
    };

    const entries = parseCentralDirectory(bytes, wantEntry);
    if (!entries || entries.length === 0) {
      return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (kind === 'docx') {
      const docEntry = entries.find((e) => e.name === 'word/document.xml');
      if (!docEntry) return null;
      const xml = await readZipEntryText(bytes, view, docEntry);
      if (!xml) return null;
      return normalizeExtractedText(extractDocxXmlText(xml));
    }

    if (kind === 'xlsx') {
      const sharedEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
      let sharedStrings: string[] = [];
      if (sharedEntry) {
        const sharedXml = await readZipEntryText(bytes, view, sharedEntry);
        if (sharedXml === null) return null;
        sharedStrings = parseSharedStrings(sharedXml);
      }

      const sheetEntries = entries
        .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
        .sort((a, b) => compareNumberedXmlPaths(a.name, b.name));

      const sheetTexts: string[] = [];
      for (const sheet of sheetEntries) {
        const sheetXml = await readZipEntryText(bytes, view, sheet);
        if (sheetXml === null) return null;
        const extracted = extractXlsxSheetXmlText(sheetXml, sharedStrings).trim();
        if (extracted) {
          sheetTexts.push(extracted);
        }
        if (sheetTexts.join('\n').length >= MAX_OOXML_TEXT_CHARS) {
          break;
        }
      }

      if (sheetTexts.length === 0 && sharedStrings.length > 0) {
        return normalizeExtractedText(sharedStrings.join('\n'));
      }
      return normalizeExtractedText(sheetTexts.join('\n'));
    }

    // pptx
    const slideEntries = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
      .sort((a, b) => compareNumberedXmlPaths(a.name, b.name));

    const slideTexts: string[] = [];
    for (const slide of slideEntries) {
      const slideXml = await readZipEntryText(bytes, view, slide);
      if (slideXml === null) return null;
      const extracted = extractPptxSlideXmlText(slideXml).trim();
      if (extracted) {
        slideTexts.push(extracted);
      }
      if (slideTexts.join('\n').length >= MAX_OOXML_TEXT_CHARS) {
        break;
      }
    }

    return normalizeExtractedText(slideTexts.join('\n'));
  } catch {
    return null;
  }
}
