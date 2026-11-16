import type {
  ExternalDomainExistingGuestMode,
  GuestInvitationStatus,
  GuestInvitationSummary,
  ResourceRole,
  TenantPolicyRow,
  UserType,
} from '@/types/files';

/**
 * Pure P10-1 guest policy helpers shared by the admin policy UI and the
 * `/guest/*` authentication pages.
 */

export const GUEST_BASE_ROLES: readonly ResourceRole[] = [
  'viewer',
  'previewer',
  'uploader',
  'viewer_uploader',
  'previewer_uploader',
];

const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface GuestPolicyView {
  allowExternalCollaborators: boolean;
  allowGuestElevatedRoles: boolean;
  externalDomainAllowlist: string[];
  guestInvitationExpiryDays: number;
  guestSessionMaxHours: number;
}

export const DEFAULT_GUEST_POLICY_VIEW: GuestPolicyView = {
  allowExternalCollaborators: false,
  allowGuestElevatedRoles: false,
  externalDomainAllowlist: [],
  guestInvitationExpiryDays: 14,
  guestSessionMaxHours: 24,
};

export const DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE: ExternalDomainExistingGuestMode =
  'reject_new_only';

export const WILDCARD_DOMAIN_ERROR_MESSAGE =
  'ワイルドカード (*) は不可です。完全一致ドメインのみ許可されます。';

export function normalizeExternalDomainExistingGuestMode(
  value: unknown
): ExternalDomainExistingGuestMode {
  return value === 'suspend_existing'
    ? 'suspend_existing'
    : DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE;
}

export function readExternalDomainExistingGuestMode(
  policy: TenantPolicyRow | null
): ExternalDomainExistingGuestMode {
  return normalizeExternalDomainExistingGuestMode(
    policy?.externalDomainExistingGuestMode ??
      policy?.external_domain_existing_guest_mode
  );
}

export function externalDomainExistingGuestModeLabel(
  mode: ExternalDomainExistingGuestMode
): string {
  return mode === 'suspend_existing'
    ? '許可外になった既存ゲストを即時停止'
    : '既存ゲストは維持し、新規招待・再認証のみ拒否';
}

export function findWildcardDomainInputs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.includes('*'));
}

/** Return a user-facing domain error, or null when every entry is valid. */
export function guestDomainValidationMessage(value: unknown): string | null {
  if (findWildcardDomainInputs(value).length > 0) {
    return WILDCARD_DOMAIN_ERROR_MESSAGE;
  }
  const validation = validateDomainAllowlistInput(value);
  if (validation.ok) return null;
  return `有効なドメインを入力してください（例: partner.example.com / 入力値: ${validation.invalid.join(
    ', '
  )}）`;
}

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

export function normalizeDomainAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const domain = normalizeGuestDomain(item);
    if (domain && !result.includes(domain)) result.push(domain);
  }
  return result.sort();
}

export function validateDomainAllowlistInput(
  value: unknown
):
  | { ok: true; domains: string[] }
  | { ok: false; invalid: string[]; wildcard?: string[] } {
  if (!Array.isArray(value)) return { ok: false, invalid: ['<not-an-array>'] };
  const wildcard = findWildcardDomainInputs(value);
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
  if (invalid.length > 0) {
    return {
      ok: false,
      invalid,
      ...(wildcard.length > 0 ? { wildcard } : {}),
    };
  }
  return { ok: true, domains: domains.sort() };
}

export function readGuestPolicy(policy: TenantPolicyRow | null): GuestPolicyView {
  if (!policy) return { ...DEFAULT_GUEST_POLICY_VIEW, externalDomainAllowlist: [] };
  const expiry = policy.guestInvitationExpiryDays ?? policy.guest_invitation_expiry_days;
  const session = policy.guestSessionMaxHours ?? policy.guest_session_max_hours;
  return {
    allowExternalCollaborators:
      policy.allowExternalCollaborators ??
      policy.allow_external_collaborators === 1,
    allowGuestElevatedRoles:
      policy.allowGuestElevatedRoles ?? policy.allow_guest_elevated_roles === 1,
    externalDomainAllowlist: normalizeDomainAllowlist(
      policy.externalDomainAllowlist ??
        parseDomainAllowlistJson(policy.external_domain_allowlist_json)
    ),
    guestInvitationExpiryDays:
      Number.isInteger(expiry) && Number(expiry) >= 1 && Number(expiry) <= 365
        ? Number(expiry)
        : DEFAULT_GUEST_POLICY_VIEW.guestInvitationExpiryDays,
    guestSessionMaxHours:
      Number.isInteger(session) && Number(session) >= 1 && Number(session) <= 168
        ? Number(session)
        : DEFAULT_GUEST_POLICY_VIEW.guestSessionMaxHours,
  };
}

export function isGuestRoleAllowed(
  role: ResourceRole,
  view: Pick<GuestPolicyView, 'allowGuestElevatedRoles'>,
  options: { advancedRolesEnabled: boolean; targetType: 'folder' | 'file' }
): boolean {
  if (role === 'owner' || role === 'co_owner') return false;
  if (role === 'editor') return view.allowGuestElevatedRoles;
  if (role === 'uploader' || role === 'viewer_uploader' || role === 'previewer_uploader') {
    return options.advancedRolesEnabled && options.targetType === 'folder';
  }
  return role === 'viewer' || role === 'previewer';
}

export function guestInvitationStatusLabel(status: GuestInvitationStatus): string {
  switch (status) {
    case 'pending':
      return '招待中';
    case 'accepted':
      return '承諾済み';
    case 'revoked':
      return '取消済み';
    case 'expired':
      return '期限切れ';
  }
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}${'*'.repeat(
    Math.max(3, Math.min(local.length - 1, 8))
  )}@${domain}`;
}

export function daysUntil(iso: string | null | undefined, nowMs = Date.now()): number | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.ceil((parsed - nowMs) / (24 * 3600 * 1000));
}

export function sortGuestInvitations(
  invitations: readonly GuestInvitationSummary[]
): GuestInvitationSummary[] {
  const weight: Record<GuestInvitationStatus, number> = {
    pending: 0,
    accepted: 1,
    expired: 2,
    revoked: 3,
  };
  return [...invitations].sort((a, b) => {
    const byStatus = weight[a.status] - weight[b.status];
    if (byStatus !== 0) return byStatus;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/** Digits-only, max 6 characters. Does not attempt to validate the code. */
export function sanitizeOtpInput(value: string): string {
  return value.replace(/\D+/g, '').slice(0, 6);
}

export function isValidOtp(value: string): boolean {
  return /^\d{6}$/.test(value);
}

/**
 * A single native `<input>` is required: six separate boxes break
 * `autocomplete="one-time-code"` and screen-reader navigation.
 */
export const OTP_INPUT_ATTRIBUTES = {
  type: 'text',
  inputMode: 'numeric',
  autoComplete: 'one-time-code',
  pattern: '\\d{6}',
  maxLength: 6,
  spellCheck: false,
} as const;

export function isGuestUserType(userType: UserType | null | undefined): boolean {
  return userType === 'guest';
}
