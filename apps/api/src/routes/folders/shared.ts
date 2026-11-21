import { bytesToBase64Url, base64UrlToBytes } from '../../services/crypto-utils';
import { FolderServiceError } from '../../services/folder-closure-service';
import type { ClassificationLabel } from '../../types/api';

export type FolderSortBy = 'name' | 'updated_at' | 'size_bytes' | 'classification';
export type FolderSortDir = 'asc' | 'desc';

const VALID_SORT_BY = new Set<FolderSortBy>([
  'name',
  'updated_at',
  'size_bytes',
  'classification',
]);
const VALID_SORT_DIR = new Set<FolderSortDir>(['asc', 'desc']);

export interface ChildrenCursor {
  phase: 'folders' | 'files';
  isPinned?: number;
  sortBy?: FolderSortBy;
  sortDir?: FolderSortDir;
  sortVal?: string | number;
  name?: string;
  id?: string;
}

export interface ChildFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string;
  size_bytes: number;
  current_version_num: number;
  meta_version: number;
  classification: ClassificationLabel;
  ai_suggested_label: ClassificationLabel | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  updated_at: string;
}

export const FOLDER_CHILD_COLS =
  'id, tenant_id, parent_id, name, depth, version, classification, is_pinned, invite_policy, created_by, deleted_at, created_at, updated_at';
export const FILE_CHILD_COLS =
  'id, folder_id, name, extension, mime_type, size_bytes, current_version_num, meta_version, classification, ai_suggested_label, ai_confidence, ai_reason, updated_at';

export function encodeCursor(cursor: ChildrenCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeCursor(raw: string | undefined): ChildrenCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw))) as ChildrenCursor;
    if (parsed.phase !== 'folders' && parsed.phase !== 'files') return null;
    if (
      parsed.isPinned !== undefined &&
      parsed.isPinned !== 0 &&
      parsed.isPinned !== 1
    ) {
      return null;
    }
    if (parsed.sortBy !== undefined && !VALID_SORT_BY.has(parsed.sortBy)) {
      return null;
    }
    if (parsed.sortDir !== undefined && !VALID_SORT_DIR.has(parsed.sortDir)) {
      return null;
    }
    if (
      parsed.sortVal !== undefined &&
      typeof parsed.sortVal !== 'string' &&
      !(typeof parsed.sortVal === 'number' && Number.isFinite(parsed.sortVal))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseFolderSort(
  rawBy: string | undefined,
  rawDir: string | undefined
): { sortBy: FolderSortBy; sortDir: FolderSortDir } {
  const sortBy =
    rawBy && VALID_SORT_BY.has(rawBy as FolderSortBy)
      ? (rawBy as FolderSortBy)
      : 'name';
  const sortDir =
    rawDir && VALID_SORT_DIR.has(rawDir as FolderSortDir)
      ? (rawDir as FolderSortDir)
      : 'asc';
  return { sortBy, sortDir };
}

export function classificationRank(label: string | null | undefined): number {
  switch (label) {
    case 'confidential':
      return 3;
    case 'internal':
      return 2;
    case 'public':
      return 1;
    default:
      return 0;
  }
}

export function buildSortSql(
  sortBy: FolderSortBy,
  sortDir: FolderSortDir,
  tableAlias = ''
): {
  expr: string;
  dirSql: 'ASC' | 'DESC';
  op: '>' | '<';
  orderByClause: string;
  keysetTuple: string;
} {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const dirSql = sortDir === 'desc' ? 'DESC' : 'ASC';
  const op = sortDir === 'desc' ? '<' : '>';
  let expr: string;
  switch (sortBy) {
    case 'updated_at':
      expr = `${prefix}updated_at`;
      break;
    case 'size_bytes':
      expr = `${prefix}size_bytes`;
      break;
    case 'classification':
      expr = `CASE ${prefix}classification WHEN 'confidential' THEN 3 WHEN 'internal' THEN 2 WHEN 'public' THEN 1 ELSE 0 END`;
      break;
    case 'name':
    default:
      expr = `${prefix}name`;
      break;
  }
  return {
    expr,
    dirSql,
    op,
    orderByClause: `${expr} ${dirSql}, ${prefix}id ${dirSql}`,
    keysetTuple: `(${expr}, ${prefix}id) ${op} (?, ?)`,
  };
}

export function extractSortVal(
  row: {
    name: string;
    updated_at: string;
    classification?: string | null;
    size_bytes?: number;
  },
  sortBy: FolderSortBy
): string | number {
  switch (sortBy) {
    case 'updated_at':
      return row.updated_at;
    case 'classification':
      return classificationRank(row.classification);
    case 'size_bytes':
      return row.size_bytes ?? 0;
    case 'name':
    default:
      return row.name;
  }
}

export function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 100);
}

export function handleFolderError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response },
  err: unknown
): Response {
  if (err instanceof FolderServiceError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.latest ? { latest: err.latest } : {}),
        ...(err.details ?? {}),
      },
      err.status
    );
  }
  throw err;
}
