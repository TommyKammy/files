/**
 * Shared audit-log time-boundary and prefix helpers.
 *
 * The audit-log API accepts both full ISO timestamps and calendar days. A
 * day-only `to` value must include the whole final day; binding the raw
 * `YYYY-MM-DD` string would silently exclude every event after midnight.
 */

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

function isValidCalendarDay(
  year: string,
  month: string,
  day: string
): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Normalize a query boundary into an ISO timestamp.
 *
 * - `YYYY-MM-DD` + `from` -> `T00:00:00.000Z`
 * - `YYYY-MM-DD` + `to`   -> `T23:59:59.999Z`
 * - timezone-less `YYYY-MM-DDTHH:mm[:ss[.SSS]]` -> same instant treated as UTC
 * - anything else is returned unchanged so full ISO values keep their offset
 */
export function normalizeAuditTimeBoundary(
  raw: string | null | undefined,
  boundary: 'from' | 'to'
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const dateOnly = DATE_ONLY_PATTERN.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    if (!isValidCalendarDay(year!, month!, day!)) return value;
    return boundary === 'from'
      ? `${value}T00:00:00.000Z`
      : `${value}T23:59:59.999Z`;
  }

  const localDateTime = LOCAL_DATETIME_PATTERN.exec(value);
  if (localDateTime) {
    const [, base, seconds = '00', millis = '000'] = localDateTime;
    return `${base}:${seconds}.${millis.padEnd(3, '0')}Z`;
  }

  return value;
}

/** `true` when a normalized boundary can be compared/sorted as a timestamp. */
export function isValidAuditTimeBoundary(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** Escape LIKE metacharacters so a prefix is always a literal prefix match. */
export function escapeAuditLikePrefix(prefix: string): string {
  return prefix
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/** Parse a comma-separated prefix filter into a de-duplicated bounded list. */
export function splitAuditActionPrefixes(
  raw: string | null | undefined,
  maxPrefixes = 20,
  maxPrefixLength = 120
): string[] {
  if (!raw) return [];
  const prefixes: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const prefix = part.trim();
    if (!prefix || seen.has(prefix)) continue;
    if (prefix.length > maxPrefixLength) continue;
    seen.add(prefix);
    prefixes.push(prefix);
    if (prefixes.length >= maxPrefixes) break;
  }
  return prefixes;
}
