import {
  SCIM_ENTERPRISE_USER_SCHEMA,
  type ScimPatchOperationInput,
} from '../types/scim';

const ENTERPRISE_DEPT_COLON = `${SCIM_ENTERPRISE_USER_SCHEMA}:department`;
const ENTERPRISE_DEPT_DOT = `${SCIM_ENTERPRISE_USER_SCHEMA}.department`;

export interface NormalizedScimUserInput {
  externalIdpId: string | null;
  email: string;
  displayName: string;
  department: string | null;
  active: boolean;
}

export interface ScimUserPatchUpdates {
  externalIdpId?: string | null;
  email?: string;
  displayName?: string;
  department?: string | null;
  active?: boolean;
}

export interface ScimGroupPatchUpdates {
  displayName?: string;
  externalIdpId?: string | null;
  replaceMembers?: string[];
  addMemberIds: string[];
  removeMemberIds: string[];
}

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

function normalizeEmailString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.includes('@') || trimmed.length > 0 ? trimmed : null;
}

function extractEmailFromEmailsList(emails: unknown): string | null {
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

function extractDisplayNameFromParts(nameObj: unknown): string | null {
  if (!isRecord(nameObj)) return null;
  if (typeof nameObj.formatted === 'string' && nameObj.formatted.trim()) {
    return nameObj.formatted.trim();
  }
  const given = typeof nameObj.givenName === 'string' ? nameObj.givenName.trim() : '';
  const family = typeof nameObj.familyName === 'string' ? nameObj.familyName.trim() : '';
  const combined = `${given} ${family}`.trim();
  return combined || null;
}

function extractDepartmentFromPayload(raw: Record<string, unknown>): string | null | undefined {
  if (ENTERPRISE_DEPT_COLON in raw) {
    const val = raw[ENTERPRISE_DEPT_COLON];
    return typeof val === 'string' && val.trim() ? val.trim() : null;
  }
  if (ENTERPRISE_DEPT_DOT in raw) {
    const val = raw[ENTERPRISE_DEPT_DOT];
    return typeof val === 'string' && val.trim() ? val.trim() : null;
  }
  const extObj = raw[SCIM_ENTERPRISE_USER_SCHEMA];
  if (isRecord(extObj) && 'department' in extObj) {
    const val = extObj.department;
    return typeof val === 'string' && val.trim() ? val.trim() : null;
  }
  return undefined;
}

/** Normalize SCIM User POST/PUT payload from Okta or Entra ID. */
export function normalizeScimUserPayload(raw: unknown): NormalizedScimUserInput {
  if (!isRecord(raw)) {
    throw new Error('SCIM User payload must be a JSON object');
  }

  const email =
    extractEmailFromEmailsList(raw.emails) ??
    normalizeEmailString(raw.userName);
  if (!email) {
    throw new Error('SCIM User payload requires userName or emails[].value');
  }

  const displayName =
    (typeof raw.displayName === 'string' && raw.displayName.trim()) ||
    extractDisplayNameFromParts(raw.name) ||
    email;

  const externalIdpId =
    typeof raw.externalId === 'string' && raw.externalId.trim()
      ? raw.externalId.trim()
      : null;

  const department = extractDepartmentFromPayload(raw) ?? null;
  const active = parseScimBoolean(raw.active) ?? true;

  return {
    externalIdpId,
    email,
    displayName,
    department,
    active,
  };
}

function applyUserPatchPathValue(
  updates: ScimUserPatchUpdates,
  nameParts: { given?: string; family?: string },
  op: string,
  path: string,
  value: unknown
): void {
  const normalizedPath = path.trim();
  const lowerPath = normalizedPath.toLowerCase();

  if (lowerPath === 'active') {
    const parsed = parseScimBoolean(value);
    if (parsed !== undefined) updates.active = parsed;
    return;
  }

  if (lowerPath === 'displayname') {
    if (op !== 'remove' && typeof value === 'string' && value.trim()) {
      updates.displayName = value.trim();
    }
    return;
  }

  if (lowerPath === 'externalid') {
    if (op === 'remove' || value === null || value === '') {
      updates.externalIdpId = null;
    } else if (typeof value === 'string' && value.trim()) {
      updates.externalIdpId = value.trim();
    }
    return;
  }

  if (lowerPath === 'username') {
    const nextEmail = normalizeEmailString(value);
    if (nextEmail) updates.email = nextEmail;
    return;
  }

  if (lowerPath === 'emails' || lowerPath.startsWith('emails[')) {
    if (typeof value === 'string') {
      const nextEmail = normalizeEmailString(value);
      if (nextEmail) updates.email = nextEmail;
    } else if (Array.isArray(value)) {
      const nextEmail = extractEmailFromEmailsList(value);
      if (nextEmail) updates.email = nextEmail;
    } else if (isRecord(value)) {
      const nextEmail = normalizeEmailString(value.value);
      if (nextEmail) updates.email = nextEmail;
    }
    return;
  }

  if (
    lowerPath === ENTERPRISE_DEPT_COLON.toLowerCase() ||
    lowerPath === ENTERPRISE_DEPT_DOT.toLowerCase() ||
    lowerPath === 'department' ||
    lowerPath.endsWith(':department') ||
    lowerPath.endsWith('.department')
  ) {
    updates.department =
      op === 'remove' || value === null
        ? null
        : typeof value === 'string' && value.trim()
          ? value.trim()
          : null;
    return;
  }

  if (lowerPath === 'name.formatted' && typeof value === 'string' && value.trim()) {
    updates.displayName = updates.displayName ?? value.trim();
    return;
  }
  if (lowerPath === 'name.givenname' && typeof value === 'string') {
    nameParts.given = value.trim();
    return;
  }
  if (lowerPath === 'name.familyname' && typeof value === 'string') {
    nameParts.family = value.trim();
  }
}

function applyPathlessUserPatchObject(
  updates: ScimUserPatchUpdates,
  nameParts: { given?: string; family?: string },
  op: string,
  obj: Record<string, unknown>
): void {
  const dept = extractDepartmentFromPayload(obj);
  if (dept !== undefined) {
    updates.department = op === 'remove' ? null : dept;
  }

  for (const [key, val] of Object.entries(obj)) {
    if (key === SCIM_ENTERPRISE_USER_SCHEMA && isRecord(val)) continue;
    if (key === 'name' && isRecord(val)) {
      const combined = extractDisplayNameFromParts(val);
      if (combined) updates.displayName = updates.displayName ?? combined;
      continue;
    }
    applyUserPatchPathValue(updates, nameParts, op, key, val);
  }
}

/**
 * Parse SCIM User PATCH `Operations`, supporting case-insensitive `op`,
 * path-omitted object payloads (Okta), flattened extension URNs (Entra ID),
 * and string `"False"` booleans.
 */
export function parseScimUserPatch(raw: unknown): ScimUserPatchUpdates {
  if (!isRecord(raw) || !Array.isArray(raw.Operations)) {
    throw new Error('SCIM PatchOp payload must contain an Operations array');
  }

  const updates: ScimUserPatchUpdates = {};
  const nameParts: { given?: string; family?: string } = {};

  for (const item of raw.Operations as ScimPatchOperationInput[]) {
    if (!isRecord(item)) continue;
    const op = typeof item.op === 'string' ? item.op.trim().toLowerCase() : 'replace';
    const path = typeof item.path === 'string' ? item.path.trim() : '';

    if (!path) {
      if (isRecord(item.value)) {
        applyPathlessUserPatchObject(updates, nameParts, op, item.value);
      }
      continue;
    }

    applyUserPatchPathValue(updates, nameParts, op, path, item.value);
  }

  if (!updates.displayName && (nameParts.given || nameParts.family)) {
    const combined = `${nameParts.given ?? ''} ${nameParts.family ?? ''}`.trim();
    if (combined) updates.displayName = combined;
  }

  return updates;
}

/** Extract SCIM Group member user IDs from `{ value }` or `[{ value }]` or `["id"]`. */
export function extractGroupMemberIds(rawValue: unknown): string[] {
  const entries = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry.trim()) {
      ids.push(entry.trim());
    } else if (isRecord(entry) && typeof entry.value === 'string' && entry.value.trim()) {
      ids.push(entry.value.trim());
    }
  }
  return [...new Set(ids)];
}

/**
 * Parse SCIM Group PATCH `Operations`, including:
 * - `op: "Add" | "add"` / `"Replace" | "replace"` / `"Remove" | "remove"`
 * - path-omitted `{ displayName, members }`
 * - `members[value eq "<userId>"]` filter paths
 */
export function parseScimGroupPatch(raw: unknown): ScimGroupPatchUpdates {
  if (!isRecord(raw) || !Array.isArray(raw.Operations)) {
    throw new Error('SCIM Group PatchOp payload must contain an Operations array');
  }

  let displayName: string | undefined;
  let externalIdpId: string | null | undefined;
  let replaceMembers: string[] | undefined;
  const addSet = new Set<string>();
  const removeSet = new Set<string>();

  for (const item of raw.Operations as ScimPatchOperationInput[]) {
    if (!isRecord(item)) continue;
    const op = typeof item.op === 'string' ? item.op.trim().toLowerCase() : 'replace';
    const path = typeof item.path === 'string' ? item.path.trim() : '';

    if (!path) {
      if (isRecord(item.value)) {
        if (typeof item.value.displayName === 'string' && item.value.displayName.trim()) {
          displayName = item.value.displayName.trim();
        }
        if ('externalId' in item.value) {
          externalIdpId =
            typeof item.value.externalId === 'string' && item.value.externalId.trim()
              ? item.value.externalId.trim()
              : null;
        }
        if ('members' in item.value) {
          const ids = extractGroupMemberIds(item.value.members);
          if (op === 'remove') {
            for (const id of ids) {
              removeSet.add(id);
              addSet.delete(id);
            }
          } else if (op === 'add') {
            for (const id of ids) {
              addSet.add(id);
              removeSet.delete(id);
            }
          } else {
            replaceMembers = ids;
            addSet.clear();
            removeSet.clear();
          }
        }
      }
      continue;
    }

    const lowerPath = path.toLowerCase();
    if (lowerPath === 'displayname' && op !== 'remove' && typeof item.value === 'string') {
      const trimmed = item.value.trim();
      if (trimmed) displayName = trimmed;
      continue;
    }

    if (lowerPath === 'externalid') {
      externalIdpId =
        op === 'remove' || typeof item.value !== 'string' || !item.value.trim()
          ? null
          : item.value.trim();
      continue;
    }

    const memberFilterMatch = path.match(
      /^members\[\s*value\s+eq\s+(?:"([^"]+)"|'([^']+)')\s*\]$/i
    );
    if (memberFilterMatch) {
      const targetUserId = (memberFilterMatch[1] ?? memberFilterMatch[2] ?? '').trim();
      if (targetUserId && op === 'remove') {
        removeSet.add(targetUserId);
        addSet.delete(targetUserId);
      } else if (targetUserId && (op === 'add' || op === 'replace')) {
        addSet.add(targetUserId);
        removeSet.delete(targetUserId);
      }
      continue;
    }

    if (lowerPath === 'members') {
      if (op === 'remove') {
        const ids = extractGroupMemberIds(item.value);
        if (ids.length === 0 && item.value === undefined) {
          replaceMembers = [];
          addSet.clear();
          removeSet.clear();
        } else {
          for (const id of ids) {
            removeSet.add(id);
            addSet.delete(id);
            if (replaceMembers) {
              replaceMembers = replaceMembers.filter((existing) => existing !== id);
            }
          }
        }
      } else if (op === 'add') {
        for (const id of extractGroupMemberIds(item.value)) {
          addSet.add(id);
          removeSet.delete(id);
          if (replaceMembers && !replaceMembers.includes(id)) {
            replaceMembers.push(id);
          }
        }
      } else if (op === 'replace') {
        replaceMembers = extractGroupMemberIds(item.value);
        addSet.clear();
        removeSet.clear();
      }
    }
  }

  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(externalIdpId !== undefined ? { externalIdpId } : {}),
    ...(replaceMembers !== undefined ? { replaceMembers } : {}),
    addMemberIds: [...addSet],
    removeMemberIds: [...removeSet],
  };
}
