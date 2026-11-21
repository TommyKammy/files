/**
 * Zero-dependency, Cloudflare Workers-safe ZIP archive builder (STORE mode).
 *
 * Implements PKZIP 2.04g headers with:
 * - UTF-8 filename encoding via General Purpose Bit Flag bit 11 (`0x0800`)
 * - IEEE 802.3 CRC-32 checksums
 * - Safe path sanitization (prevents Zip-Slip) and collision deduplication
 */

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;

const VERSION_NEEDED = 20; // 2.0
const VERSION_MADE_BY = 20;
const FLAG_UTF8 = 0x0800; // Bit 11: UTF-8 filename & comment
const COMPRESSION_STORE = 0;

const UTF8_ENCODER = new TextEncoder();

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toDosTimeDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/**
 * Sanitize a relative archive path to prevent Zip-Slip traversal and invalid characters.
 */
export function sanitizeZipPath(rawPath: string): string {
  const segments = rawPath
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.replace(/[\x00-\x1f\x7f]/g, '').trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');

  return segments.length > 0 ? segments.join('/') : 'file';
}

/**
 * Deduplicate an archive path against `usedPaths` (case-insensitive for Windows/macOS safety),
 * preserving the file extension.
 */
export function dedupeZipPath(rawPath: string, usedPaths: Set<string>): string {
  const clean = sanitizeZipPath(rawPath);
  if (!usedPaths.has(clean.toLowerCase())) {
    usedPaths.add(clean.toLowerCase());
    return clean;
  }

  const slashIdx = clean.lastIndexOf('/');
  const dir = slashIdx >= 0 ? clean.slice(0, slashIdx + 1) : '';
  const base = slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean;
  const dotIdx = base.lastIndexOf('.');
  const stem = dotIdx > 0 && dotIdx < base.length - 1 ? base.slice(0, dotIdx) : base;
  const ext = dotIdx > 0 && dotIdx < base.length - 1 ? base.slice(dotIdx) : '';

  for (let i = 1; i < 10000; i++) {
    const candidate = `${dir}${stem} (${i})${ext}`;
    if (!usedPaths.has(candidate.toLowerCase())) {
      usedPaths.add(candidate.toLowerCase());
      return candidate;
    }
  }

  const fallback = `${dir}${stem}-${Date.now()}${ext}`;
  usedPaths.add(fallback.toLowerCase());
  return fallback;
}

export interface ZipEntryInput {
  /** Relative path inside the ZIP archive (e.g. "docs/readme.txt"). */
  path: string;
  /** Uncompressed file bytes. */
  data: Uint8Array;
  /** Optional modification timestamp; defaults to current time. */
  lastModified?: Date;
}

interface PreparedEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  dosTime: number;
  dosDate: number;
  localHeaderOffset: number;
}

/**
 * Build a complete ZIP archive in memory using STORE mode (no compression).
 */
export function buildZipArchive(
  entries: ReadonlyArray<ZipEntryInput>,
  options: { now?: Date } = {}
): Uint8Array {
  const defaultNow = options.now ?? new Date();
  const usedPaths = new Set<string>();
  const prepared: PreparedEntry[] = [];

  let localSectionSize = 0;
  let centralDirSize = 0;

  for (const entry of entries) {
    const safePath = dedupeZipPath(entry.path, usedPaths);
    const nameBytes = UTF8_ENCODER.encode(safePath);
    const { dosTime, dosDate } = toDosTimeDate(entry.lastModified ?? defaultNow);
    const crc = crc32(entry.data);

    prepared.push({
      nameBytes,
      data: entry.data,
      crc,
      dosTime,
      dosDate,
      localHeaderOffset: localSectionSize,
    });

    localSectionSize += 30 + nameBytes.length + entry.data.length;
    centralDirSize += 46 + nameBytes.length;
  }

  const eocdSize = 22;
  const totalSize = localSectionSize + centralDirSize + eocdSize;
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // 1. Write Local File Headers + File Data
  let offset = 0;
  for (const item of prepared) {
    view.setUint32(offset, LOCAL_FILE_HEADER_SIG, true);
    view.setUint16(offset + 4, VERSION_NEEDED, true);
    view.setUint16(offset + 6, FLAG_UTF8, true);
    view.setUint16(offset + 8, COMPRESSION_STORE, true);
    view.setUint16(offset + 10, item.dosTime, true);
    view.setUint16(offset + 12, item.dosDate, true);
    view.setUint32(offset + 14, item.crc, true);
    view.setUint32(offset + 18, item.data.length, true); // compressed size
    view.setUint32(offset + 22, item.data.length, true); // uncompressed size
    view.setUint16(offset + 26, item.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // extra field length
    out.set(item.nameBytes, offset + 30);
    offset += 30 + item.nameBytes.length;

    out.set(item.data, offset);
    offset += item.data.length;
  }

  // 2. Write Central Directory Headers
  const centralDirOffset = offset;
  for (const item of prepared) {
    view.setUint32(offset, CENTRAL_DIR_HEADER_SIG, true);
    view.setUint16(offset + 4, VERSION_MADE_BY, true);
    view.setUint16(offset + 6, VERSION_NEEDED, true);
    view.setUint16(offset + 8, FLAG_UTF8, true);
    view.setUint16(offset + 10, COMPRESSION_STORE, true);
    view.setUint16(offset + 12, item.dosTime, true);
    view.setUint16(offset + 14, item.dosDate, true);
    view.setUint32(offset + 16, item.crc, true);
    view.setUint32(offset + 20, item.data.length, true);
    view.setUint32(offset + 24, item.data.length, true);
    view.setUint16(offset + 28, item.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true); // extra field length
    view.setUint16(offset + 32, 0, true); // file comment length
    view.setUint16(offset + 34, 0, true); // disk number start
    view.setUint16(offset + 36, 0, true); // internal file attributes
    view.setUint32(offset + 38, 0, true); // external file attributes
    view.setUint32(offset + 42, item.localHeaderOffset, true);
    out.set(item.nameBytes, offset + 46);
    offset += 46 + item.nameBytes.length;
  }

  // 3. Write End of Central Directory Record (EOCD)
  view.setUint32(offset, END_OF_CENTRAL_DIR_SIG, true);
  view.setUint16(offset + 4, 0, true); // disk number
  view.setUint16(offset + 6, 0, true); // central dir start disk
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, centralDirSize, true);
  view.setUint32(offset + 16, centralDirOffset, true);
  view.setUint16(offset + 20, 0, true); // comment length

  return out;
}
