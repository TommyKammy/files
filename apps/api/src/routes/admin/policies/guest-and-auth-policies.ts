import type { Context } from 'hono';
import {
  isExternalDomainExistingGuestMode,
  validateDomainAllowlistInput,
} from '../../../services/external-guests';
import {
  IP_ALLOWLIST_MAX_ENTRIES,
  isIpAllowlistScope,
  normalizeIpAllowlistInput,
} from '../../../services/ip-allowlist';
import { normalizeSsoAllowedDomainsInput } from '../../../services/sso-policy';
import {
  BRANDING_CONTACT_INFO_MAX_LENGTH,
  BRANDING_FOOTER_NOTE_MAX_LENGTH,
  BRANDING_ORG_NAME_MAX_LENGTH,
  normalizeBrandingAccentColor,
  normalizeBrandingText,
} from '../../../services/branding';
import { isValidFileRequestMaxSizeBytes } from '../../../services/file-request-policy';
import type { AuthUser } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import {
  sysAdminRequiredResponse,
  type ExistingTenantPolicyRow,
  type PolicyPatchBody,
  type PolicyPatchState,
} from './shared';

export function applyGuestPolicyUpdates(
  c: Context<OidcHonoEnv>,
  body: PolicyPatchBody,
  user: AuthUser,
  state: PolicyPatchState
): Response | null {
  const { updates, binds } = state;

  // P10-1 external guest policies: sys_admin only, sec_admin remains read-only.
  const guestPolicyFieldsProvided =
    body.allowExternalCollaborators !== undefined ||
    body.externalDomainAllowlist !== undefined ||
    body.guestInvitationExpiryDays !== undefined ||
    body.guestSessionMaxHours !== undefined ||
    body.allowGuestElevatedRoles !== undefined ||
    body.externalDomainExistingGuestMode !== undefined;
  if (guestPolicyFieldsProvided && user.role !== 'sys_admin') {
    return sysAdminRequiredResponse(
      c,
      'Only sys_admin can change external guest policies'
    );
  }

  if (body.allowExternalCollaborators !== undefined) {
    if (typeof body.allowExternalCollaborators !== 'boolean') {
      return c.json(
        { error: 'allowExternalCollaborators must be a boolean', code: 'INVALID_GUEST_POLICY' },
        400
      );
    }
    updates.push('allow_external_collaborators = ?');
    binds.push(body.allowExternalCollaborators ? 1 : 0);
  }
  if (body.allowGuestElevatedRoles !== undefined) {
    if (typeof body.allowGuestElevatedRoles !== 'boolean') {
      return c.json(
        { error: 'allowGuestElevatedRoles must be a boolean', code: 'INVALID_GUEST_POLICY' },
        400
      );
    }
    updates.push('allow_guest_elevated_roles = ?');
    binds.push(body.allowGuestElevatedRoles ? 1 : 0);
  }
  if (body.externalDomainAllowlist !== undefined) {
    const validation = validateDomainAllowlistInput(body.externalDomainAllowlist);
    if (!validation.ok) {
      const wildcardDomains = validation.wildcard ?? [];
      return c.json(
        {
          error:
            wildcardDomains.length > 0
              ? 'ワイルドカード (*) は不可です。完全一致ドメインのみ許可されます。'
              : `Invalid external guest domain(s): ${validation.invalid.join(', ')}`,
          code:
            wildcardDomains.length > 0
              ? 'WILDCARD_DOMAIN_NOT_ALLOWED'
              : 'INVALID_DOMAIN_ALLOWLIST',
          invalidDomains: validation.invalid,
          ...(wildcardDomains.length > 0 ? { wildcardDomains } : {}),
        },
        400
      );
    }
    updates.push('external_domain_allowlist_json = ?');
    binds.push(JSON.stringify(validation.domains));
    state.effectiveDomainAllowlist = validation.domains;
  }
  if (body.externalDomainExistingGuestMode !== undefined) {
    if (!isExternalDomainExistingGuestMode(body.externalDomainExistingGuestMode)) {
      return c.json(
        {
          error:
            "externalDomainExistingGuestMode must be 'reject_new_only' or 'suspend_existing'",
          code: 'INVALID_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE',
        },
        400
      );
    }
    updates.push('external_domain_existing_guest_mode = ?');
    binds.push(body.externalDomainExistingGuestMode);
    state.effectiveExistingGuestMode = body.externalDomainExistingGuestMode;
  }
  if (body.guestInvitationExpiryDays !== undefined) {
    if (
      typeof body.guestInvitationExpiryDays !== 'number' ||
      !Number.isInteger(body.guestInvitationExpiryDays) ||
      body.guestInvitationExpiryDays < 1 ||
      body.guestInvitationExpiryDays > 365
    ) {
      return c.json(
        {
          error: 'guestInvitationExpiryDays must be integer 1..365',
          code: 'INVALID_GUEST_POLICY',
        },
        400
      );
    }
    updates.push('guest_invitation_expiry_days = ?');
    binds.push(body.guestInvitationExpiryDays);
  }
  if (body.guestSessionMaxHours !== undefined) {
    if (
      typeof body.guestSessionMaxHours !== 'number' ||
      !Number.isInteger(body.guestSessionMaxHours) ||
      body.guestSessionMaxHours < 1 ||
      body.guestSessionMaxHours > 168
    ) {
      return c.json(
        {
          error: 'guestSessionMaxHours must be integer 1..168',
          code: 'INVALID_GUEST_POLICY',
        },
        400
      );
    }
    updates.push('guest_session_max_hours = ?');
    binds.push(body.guestSessionMaxHours);
  }

  return null;
}

export function applyAuthControlPolicyUpdates(
  c: Context<OidcHonoEnv>,
  body: PolicyPatchBody,
  user: AuthUser,
  state: PolicyPatchState
): Response | null {
  const { updates, binds } = state;

  // P12-3 / TOM-66 authentication controls. Like the external guest policy,
  // only sys_admin can write these; sec_admin keeps read-only visibility
  // through GET /api/admin/policies and /api/admin/sso/status.
  const authControlFieldsProvided =
    body.ipAllowlistEnabled !== undefined ||
    body.ipAllowlistScope !== undefined ||
    body.ipAllowlist !== undefined ||
    body.requireSsoLogin !== undefined ||
    body.ssoAllowedDomains !== undefined;
  if (authControlFieldsProvided && user.role !== 'sys_admin') {
    return sysAdminRequiredResponse(
      c,
      'Only sys_admin can change IP allowlist or SSO policies'
    );
  }

  if (body.ipAllowlistEnabled !== undefined) {
    if (typeof body.ipAllowlistEnabled !== 'boolean') {
      return c.json(
        {
          error: 'ipAllowlistEnabled must be a boolean',
          code: 'INVALID_IP_ALLOWLIST_POLICY',
        },
        400
      );
    }
    state.effectiveIpAllowlistEnabled = body.ipAllowlistEnabled;
    updates.push('ip_allowlist_enabled = ?');
    binds.push(body.ipAllowlistEnabled ? 1 : 0);
  }

  if (body.ipAllowlistScope !== undefined) {
    if (!isIpAllowlistScope(body.ipAllowlistScope)) {
      return c.json(
        {
          error: "ipAllowlistScope must be 'admin_only', 'internal_users' or 'all_access'",
          code: 'INVALID_IP_ALLOWLIST_SCOPE',
        },
        400
      );
    }
    state.effectiveIpAllowlistScope = body.ipAllowlistScope;
    updates.push('ip_allowlist_scope = ?');
    binds.push(body.ipAllowlistScope);
  }

  if (body.ipAllowlist !== undefined) {
    const validation = normalizeIpAllowlistInput(body.ipAllowlist);
    if (!validation.ok) {
      return c.json(
        {
          error:
            validation.invalidEntries.length > 0
              ? `Invalid IP allowlist entr${
                  validation.invalidEntries.length === 1 ? 'y' : 'ies'
                }: ${validation.invalidEntries.join(', ')}`
              : `An IP allowlist can contain at most ${IP_ALLOWLIST_MAX_ENTRIES} entries`,
          code: 'INVALID_IP_ALLOWLIST_ENTRY',
          invalidEntries: validation.invalidEntries,
          maxEntries: validation.maxEntries,
        },
        400
      );
    }
    state.effectiveIpAllowlist = validation.entries;
    updates.push('ip_allowlist_json = ?');
    binds.push(JSON.stringify(validation.entries));
  }

  if (body.requireSsoLogin !== undefined) {
    if (typeof body.requireSsoLogin !== 'boolean') {
      return c.json(
        {
          error: 'requireSsoLogin must be a boolean',
          code: 'INVALID_SSO_POLICY',
        },
        400
      );
    }
    updates.push('require_sso_login = ?');
    binds.push(body.requireSsoLogin ? 1 : 0);
  }

  if (body.ssoAllowedDomains !== undefined) {
    const validation = normalizeSsoAllowedDomainsInput(body.ssoAllowedDomains);
    if (!validation.ok) {
      return c.json(
        {
          error:
            validation.wildcardDomains.length > 0
              ? 'ワイルドカード (*) は不可です。完全一致ドメインのみ許可されます。'
              : `Invalid SSO allowed domain(s): ${validation.invalidDomains.join(', ')}`,
          code: 'INVALID_SSO_DOMAIN',
          invalidDomains: validation.invalidDomains,
          ...(validation.wildcardDomains.length > 0
            ? { wildcardDomains: validation.wildcardDomains }
            : {}),
        },
        400
      );
    }
    updates.push('sso_allowed_domains_json = ?');
    binds.push(JSON.stringify(validation.domains));
  }

  return null;
}

export function applyWorkspacePolicyUpdates(
  c: Context<OidcHonoEnv>,
  body: PolicyPatchBody,
  user: AuthUser,
  existingRow: ExistingTenantPolicyRow | null,
  state: PolicyPatchState
): Response | null {
  const { updates, binds } = state;

  // P13-4 / TOM-72 tenant-wide file-request governance, branding and quota
  // warning thresholds. sec_admin keeps read-only access through GET.
  const fileRequestGovernanceProvided =
    body.allowFileRequests !== undefined ||
    body.fileRequestMaxSizeBytes !== undefined ||
    body.fileRequestEnforceAllowedExtensions !== undefined;
  const brandingProvided =
    body.brandingOrgName !== undefined ||
    body.brandingContactInfo !== undefined ||
    body.brandingFooterNote !== undefined ||
    body.brandingAccentColor !== undefined;
  const quotaProvided =
    body.quotaWarnThresholdPct !== undefined ||
    body.quotaCriticalThresholdPct !== undefined;
  if (
    (fileRequestGovernanceProvided || brandingProvided || quotaProvided) &&
    user.role !== 'sys_admin'
  ) {
    return sysAdminRequiredResponse(
      c,
      'Only sys_admin can change file-request, branding or quota policies'
    );
  }

  if (body.allowFileRequests !== undefined) {
    if (typeof body.allowFileRequests !== 'boolean') {
      return c.json(
        {
          error: 'allowFileRequests must be a boolean',
          code: 'INVALID_FILE_REQUEST_POLICY',
        },
        400
      );
    }
    updates.push('allow_file_requests = ?');
    binds.push(body.allowFileRequests ? 1 : 0);
  }
  if (body.fileRequestMaxSizeBytes !== undefined) {
    if (!isValidFileRequestMaxSizeBytes(body.fileRequestMaxSizeBytes)) {
      return c.json(
        {
          error: 'fileRequestMaxSizeBytes must be a positive integer',
          code: 'INVALID_FILE_REQUEST_POLICY',
        },
        400
      );
    }
    updates.push('file_request_max_size_bytes = ?');
    binds.push(body.fileRequestMaxSizeBytes);
  }
  if (body.fileRequestEnforceAllowedExtensions !== undefined) {
    if (typeof body.fileRequestEnforceAllowedExtensions !== 'boolean') {
      return c.json(
        {
          error: 'fileRequestEnforceAllowedExtensions must be a boolean',
          code: 'INVALID_FILE_REQUEST_POLICY',
        },
        400
      );
    }
    updates.push('file_request_enforce_allowed_extensions = ?');
    binds.push(body.fileRequestEnforceAllowedExtensions ? 1 : 0);
  }

  for (const [field, column, maxLength] of [
    ['brandingOrgName', 'branding_org_name', BRANDING_ORG_NAME_MAX_LENGTH],
    ['brandingContactInfo', 'branding_contact_info', BRANDING_CONTACT_INFO_MAX_LENGTH],
    ['brandingFooterNote', 'branding_footer_note', BRANDING_FOOTER_NOTE_MAX_LENGTH],
  ] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'string') {
      return c.json(
        {
          error: `${field} must be a string or null`,
          code: 'INVALID_BRANDING',
        },
        400
      );
    }
    updates.push(`${column} = ?`);
    binds.push(normalizeBrandingText(value, maxLength));
  }

  if (body.brandingAccentColor !== undefined) {
    const normalizedAccent = normalizeBrandingAccentColor(body.brandingAccentColor);
    if (!normalizedAccent.ok) {
      return c.json(
        {
          error: normalizedAccent.error,
          code: 'INVALID_BRANDING',
        },
        400
      );
    }
    updates.push('branding_accent_color = ?');
    binds.push(normalizedAccent.value);
  }

  let effectiveQuotaWarn = existingRow?.quota_warn_threshold_pct ?? 80;
  let effectiveQuotaCritical = existingRow?.quota_critical_threshold_pct ?? 90;
  if (body.quotaWarnThresholdPct !== undefined) {
    if (
      typeof body.quotaWarnThresholdPct !== 'number' ||
      !Number.isInteger(body.quotaWarnThresholdPct) ||
      body.quotaWarnThresholdPct < 50 ||
      body.quotaWarnThresholdPct > 99
    ) {
      return c.json(
        {
          error: 'quotaWarnThresholdPct must be integer 50..99',
          code: 'INVALID_QUOTA_THRESHOLDS',
        },
        400
      );
    }
    effectiveQuotaWarn = body.quotaWarnThresholdPct;
    updates.push('quota_warn_threshold_pct = ?');
    binds.push(body.quotaWarnThresholdPct);
  }
  if (body.quotaCriticalThresholdPct !== undefined) {
    if (
      typeof body.quotaCriticalThresholdPct !== 'number' ||
      !Number.isInteger(body.quotaCriticalThresholdPct) ||
      body.quotaCriticalThresholdPct < 51 ||
      body.quotaCriticalThresholdPct > 100
    ) {
      return c.json(
        {
          error: 'quotaCriticalThresholdPct must be integer 51..100',
          code: 'INVALID_QUOTA_THRESHOLDS',
        },
        400
      );
    }
    effectiveQuotaCritical = body.quotaCriticalThresholdPct;
    updates.push('quota_critical_threshold_pct = ?');
    binds.push(body.quotaCriticalThresholdPct);
  }
  if (quotaProvided && effectiveQuotaWarn >= effectiveQuotaCritical) {
    return c.json(
      {
        error: 'quotaWarnThresholdPct must be lower than quotaCriticalThresholdPct',
        code: 'INVALID_QUOTA_THRESHOLDS',
      },
      400
    );
  }

  return null;
}
