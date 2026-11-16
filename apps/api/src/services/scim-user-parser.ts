import {
  SCIM_ENTERPRISE_USER_SCHEMA,
  type ScimPatchOperationInput,
} from '../types/scim';
import {
  extractDisplayNameFromParts,
  extractEmailFromEmailsList,
  isRecord,
  normalizeEmailString,
  parseScimBoolean,
} from './scim-parser-shared';

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

