import { base64UrlToBytes, bytesToBase64Url } from './crypto-utils';

export const DAY_MS = 86_400_000;
export const DEFAULT_TRASH_LIMIT = 50;
export const MAX_TRASH_LIMIT = 200;
export const DEFAULT_TRASH_RETENTION_DAYS = 30;
export const MAX_TRASH_RETENTION_DAYS = 3650;

export type TrashSort =
  | 'deletedAt_desc'
  | 'deletedAt_asc'
  | 'name_asc'
  | 'name_desc';

export type TrashItemType = 'folder' | 'file';

export const TRASH_SORTS = new Set<TrashSort>([
  'deletedAt_desc',
  'deletedAt_asc',
  'name_asc',
  'name_desc',
]);

export interface TrashCursor {
  v: 1;
  sort: TrashSort;
  deletedAt: string;
  name: string;
  itemType: TrashItemType;
  id: string;
}

export function encodeTrashCursor(cursor: TrashCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeTrashCursor(
  raw: string,
  sort: TrashSort
): TrashCursor | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(raw))
    ) as Partial<TrashCursor> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== 1 || parsed.sort !== sort) return null;
    if (parsed.itemType !== 'folder' && parsed.itemType !== 'file') return null;
    if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
    if (typeof parsed.name !== 'string') return null;
    if (typeof parsed.deletedAt !== 'string') return null;
    const deletedAtMs = Date.parse(parsed.deletedAt);
    if (
      !Number.isFinite(deletedAtMs) ||
      new Date(deletedAtMs).toISOString() !== parsed.deletedAt
    ) {
      return null;
    }
    return {
      v: 1,
      sort,
      deletedAt: parsed.deletedAt,
      name: parsed.name,
      itemType: parsed.itemType,
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

export function parseTrashLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TRASH_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TRASH_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_TRASH_LIMIT);
}

const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseIsoInstant(
  raw: string
): { ok: true; value: string } | { ok: false; error: string } {
  if (!ISO_INSTANT_RE.test(raw)) {
    return { ok: false, error: `Invalid ISO-8601 datetime: ${raw}` };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return { ok: false, error: `Invalid ISO-8601 datetime: ${raw}` };
  }
  return { ok: true, value: new Date(ms).toISOString() };
}

export function escapeLikePattern(value: string): string {
  // SQLite LIKE with ESCAPE '\' — escape the escape character first.
  return value.replace(/[%_\\]/g, '\\$&');
}

export function buildTrashOrderBy(sort: TrashSort): string {
  const dir = sort.endsWith('_desc') ? 'DESC' : 'ASC';
  const primary = sort.startsWith('name_') ? 't.name' : 't.deleted_at';
  return `${primary} ${dir}, t.item_type ${dir}, t.id ${dir}`;
}

export function buildTrashCursorSql(
  sort: TrashSort,
  cursor: TrashCursor
): { sql: string; binds: string[] } {
  const dir = sort.endsWith('_desc') ? 'DESC' : 'ASC';
  const cmp = dir === 'DESC' ? '<' : '>';
  const primary = sort.startsWith('name_') ? 'name' : 'deletedAt';
  const primaryValue = primary === 'name' ? cursor.name : cursor.deletedAt;
  return {
    sql: `AND (
      (t.${primary === 'name' ? 'name' : 'deleted_at'} ${cmp} ?)
      OR (
        t.${primary === 'name' ? 'name' : 'deleted_at'} = ?
        AND (
          (t.item_type ${cmp} ?)
          OR (t.item_type = ? AND t.id ${cmp} ?)
        )
      )
    )`,
    binds: [
      primaryValue,
      primaryValue,
      cursor.itemType,
      cursor.itemType,
      cursor.id,
    ],
  };
}

/** Clamp the tenant retention policy to the same bounds used by the admin API. */
export function clampTrashRetentionDays(
  stored: number | null | undefined
): number {
  return Math.min(
    Math.max(stored ?? DEFAULT_TRASH_RETENTION_DAYS, 1),
    MAX_TRASH_RETENTION_DAYS
  );
}

export async function resolveTrashRetentionDays(
  db: D1Database,
  tenantId: string
): Promise<number> {
  const policy = await db
    .prepare('SELECT trash_retention_days FROM tenant_policies WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ trash_retention_days: number }>();
  return clampTrashRetentionDays(policy?.trash_retention_days);
}

export function deriveTrashDeadlines(
  deletedAt: string,
  retentionDays: number,
  nowMs: number
): { purgeAt: string; daysRemaining: number } {
  const deletedAtMs = Date.parse(deletedAt);
  const purgeAtMs = Number.isFinite(deletedAtMs)
    ? deletedAtMs + retentionDays * DAY_MS
    : nowMs;
  return {
    purgeAt: new Date(purgeAtMs).toISOString(),
    daysRemaining: Math.ceil((purgeAtMs - nowMs) / DAY_MS),
  };
}
