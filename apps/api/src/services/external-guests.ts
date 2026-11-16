import { ADVANCED_RESOURCE_ROLES, isResourceRole } from './capabilities';
import type { ResourceRole } from '../types/api';

/**
 * P10-1 / TOM-59 external guest policy helpers.
 *
 * Policy defaults are fail-closed: external collaborators are disabled and the
 * domain allowlist is empty. An empty allowlist therefore rejects every
 * external domain until an administrator explicitly adds one.
 */

export interface GuestPolicy {
  allowExternalCollaborators: boolean;
  externalDomainAllowlist: string[];
  guestInvitationExpiryDays: number;
  guestSessionMaxHours: number;
  allowGuestElevatedRoles: boolean;
}

export const DEFAULT_GUEST_POLICY: GuestPolicy = {
  allowExternalCollaborators: false,
  externalDomainAllowlist: [],
  guestInvitationExpiryDays: 14,
  guestSessionMaxHours: 24,
  allowGuestElevatedRoles: false,
};

export const GUEST_BASE_ROLES: readonly ResourceRole[] = [
  'viewer',
  'previewer',
  'uploader',
  'viewer_uploader',
  'previewer_uploader',
];

export const GUEST_ALWAYS_FORBIDDEN_ROLES: readonly ResourceRole[] = [
  'owner',
  'co_owner',
];

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lowercase and trim a single domain. Returns null when it is not a domain. */
export function normalizeGuestDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('@')) value = value.slice(1);
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (!value || value.length > 253) return null;
  const labels = value.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => DOMAIN_LABEL_RE.test(label))) return null;
  return value;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return normalizeGuestDomain(email.slice(at + 1));
}

export function parseDomainAllowlistJson(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return normalizeDomainAllowlist(parsed);
}

/** Accepts an array (API) and normalizes/deduplicates it. Invalid entries are dropped. */
export function normalizeDomainAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const domain = normalizeGuestDomain(item);
    if (domain && !result.includes(domain)) result.push(domain);
  }
  return result.sort();
}

/**
 * Validate an administrator-provided allowlist. Every entry must be a plain
 * domain (no scheme, path, wildcard or email address).
 */
export function validateDomainAllowlistInput(
  value: unknown
):
  | { ok: true; domains: string[] }
  | { ok: false; invalid: string[] } {
  if (!Array.isArray(value)) {
    return { ok: false, invalid: ['<not-an-array>'] };
  }
  const invalid: string[] = [];
  const domains: string[] = [];
  for (const item of value) {
    const domain = normalizeGuestDomain(item);
    if (!domain) {
      invalid.push(typeof item === 'string' ? item : String(item));
      continue;
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, domains: domains.sort() };
}

export function isGuestEmailDomainAllowed(
  email: string,
  allowlist: readonly string[]
): boolean {
  if (allowlist.length === 0) return false;
  const domain = emailDomain(email);
  if (!domain) return false;
  return allowlist.includes(domain);
}

export function readGuestPolicyFromRow(
  row: Record<string, unknown> | null | undefined
): GuestPolicy {
  if (!row) return { ...DEFAULT_GUEST_POLICY, externalDomainAllowlist: [] };
  const expiry = Number(row.guest_invitation_expiry_days);
  const session = Number(row.guest_session_max_hours);
  return {
    allowExternalCollaborators: row.allow_external_collaborators === 1,
    externalDomainAllowlist: parseDomainAllowlistJson(
      row.external_domain_allowlist_json
    ),
    guestInvitationExpiryDays:
      Number.isInteger(expiry) && expiry >= 1 && expiry <= 365
        ? expiry
        : DEFAULT_GUEST_POLICY.guestInvitationExpiryDays,
    guestSessionMaxHours:
      Number.isInteger(session) && session >= 1 && session <= 168
        ? session
        : DEFAULT_GUEST_POLICY.guestSessionMaxHours,
    allowGuestElevatedRoles: row.allow_guest_elevated_roles === 1,
  };
}

export async function getGuestPolicy(
  db: D1Database,
  tenantId: string
): Promise<GuestPolicy> {
  const row = await db
    .prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?')
    .bind(tenantId)
    .first<Record<string, unknown>>();
  return readGuestPolicyFromRow(row);
}

export interface GuestRoleRestrictionOptions {
  allowGuestElevatedRoles: boolean;
  advancedRolesEnabled: boolean;
  targetType: 'folder' | 'file';
}

export interface GuestRoleRestrictionError {
  status: 400 | 403;
  code: 'GUEST_ROLE_FORBIDDEN' | 'ROLE_FOLDER_ONLY' | 'ADVANCED_ROLES_DISABLED';
  message: string;
}

/**
 * Guest role restriction shared by `POST /api/guests/invitations` and the
 * existing `POST /api/permissions` grant path.
 *
 * - owner / co_owner: always forbidden
 * - editor: only with `allow_guest_elevated_roles = 1`
 * - uploader family: folder-only and gated by `advanced_roles_enabled`
 */
export function guestRoleRestriction(
  role: ResourceRole,
  options: GuestRoleRestrictionOptions
): GuestRoleRestrictionError | null {
  if (!isResourceRole(role)) {
    return {
      status: 403,
      code: 'GUEST_ROLE_FORBIDDEN',
      message: 'Unknown role cannot be granted to a guest',
    };
  }
  if (role === 'owner' || role === 'co_owner') {
    return {
      status: 403,
      code: 'GUEST_ROLE_FORBIDDEN',
      message: `Guest accounts cannot receive the "${role}" role`,
    };
  }
  if (role === 'editor' && !options.allowGuestElevatedRoles) {
    return {
      status: 403,
      code: 'GUEST_ROLE_FORBIDDEN',
      message:
        'Guest accounts can only receive the editor role when allowGuestElevatedRoles is enabled',
    };
  }
  if (ADVANCED_RESOURCE_ROLES.has(role)) {
    if (options.targetType !== 'folder') {
      return {
        status: 400,
        code: 'ROLE_FOLDER_ONLY',
        message: 'Advanced roles can only be granted on folders',
      };
    }
    if (!options.advancedRolesEnabled) {
      return {
        status: 403,
        code: 'ADVANCED_ROLES_DISABLED',
        message: 'Advanced roles are disabled for this tenant',
      };
    }
  }
  return null;
}

/** Number of seconds until the guest session must end (>= 0). */
export function guestSessionMaxAgeSeconds(
  nowMs: number,
  sessionMaxHours: number,
  guestExpiresAt: string | null | undefined
): number | null {
  const sessionEnd = nowMs + Math.max(1, sessionMaxHours) * 3600 * 1000;
  const guestEnd = guestExpiresAt ? Date.parse(guestExpiresAt) : Number.NaN;
  if (Number.isNaN(guestEnd)) return Math.floor((sessionEnd - nowMs) / 1000);
  if (guestEnd <= nowMs) return null;
  return Math.max(1, Math.floor((Math.min(sessionEnd, guestEnd) - nowMs) / 1000));
}

export function generateSixDigitOtp(): string {
  const buffer = new Uint32Array(1);
  // Rejection sampling removes modulo bias while staying cryptographically random.
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return String(buffer[0] % 1_000_000).padStart(6, '0');
}
