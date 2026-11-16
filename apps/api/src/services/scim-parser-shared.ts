export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Entra ID sends string booleans like `"False"` in SCIM PATCH requests;
 * normalize booleans and case-insensitive true/false strings uniformly.
 */
export function parseScimBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return undefined;
}

/** Parse basic SCIM equality filters such as `userName eq "alice@example.com"`. */
export function parseScimFilterEq(
  rawFilter: string | undefined | null
): { attr: string; value: string } | null {
  if (!rawFilter) return null;
  const match = rawFilter
    .trim()
    .match(/^([a-zA-Z0-9_.:[\]-]+)\s+eq\s+(?:"([^"]*)"|'([^']*)')$/i);
  if (!match) return null;
  return {
    attr: match[1].trim(),
    value: (match[2] ?? match[3] ?? '').trim(),
  };
}

export function normalizeEmailString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.includes('@') || trimmed.length > 0 ? trimmed : null;
}

export function extractEmailFromEmailsList(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null;
  let firstCandidate: string | null = null;
  for (const item of emails) {
    if (!isRecord(item)) continue;
    const candidate = normalizeEmailString(item.value);
    if (!candidate) continue;
    if (item.primary === true) return candidate;
    if (!firstCandidate) firstCandidate = candidate;
  }
  return firstCandidate;
}

export function extractDisplayNameFromParts(nameObj: unknown): string | null {
  if (!isRecord(nameObj)) return null;
  if (typeof nameObj.formatted === 'string' && nameObj.formatted.trim()) {
    return nameObj.formatted.trim();
  }
  const given = typeof nameObj.givenName === 'string' ? nameObj.givenName.trim() : '';
  const family = typeof nameObj.familyName === 'string' ? nameObj.familyName.trim() : '';
  const combined = `${given} ${family}`.trim();
  return combined || null;
}
