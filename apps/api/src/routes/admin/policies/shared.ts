import type { Context } from 'hono';
import {
  buildClosedRootReport,
  getFolderStructureMode,
  type FolderStructureMode,
} from '../../../services/folder-structure';
import {
  findWaterfallInheritanceConflicts,
  getPermissionInheritanceMode,
  type PermissionInheritanceMode,
} from '../../../services/permission-inheritance';
import {
  getTenantInvitePolicy,
  type InvitePolicy,
} from '../../../services/invite-policy';
import {
  DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE,
  parseDomainAllowlistJson,
  type ExternalDomainExistingGuestMode,
} from '../../../services/external-guests';
import {
  DEFAULT_ADMIN_CONTENT_INSPECT_POLICY,
  isAdminContentInspectPolicy,
} from '../../../services/admin-content';
import {
  isIpAllowlistScope,
  parseIpAllowlistJson,
  type IpAllowlistScope,
} from '../../../services/ip-allowlist';
import { parseSsoAllowedDomainsJson } from '../../../services/sso-policy';
import { buildBrandingLogoUrl } from '../../../services/branding';
import type { AiClassificationMode } from '../../../types/classification';
import type { OidcHonoEnv } from '../../../types/oidc';

export interface PolicyPatchBody {
  enforceCompanyOnlyLinks?: boolean;
  requireWatermarkConfidential?: boolean;
  maxLinkExpirationDays?: number;
  sessionMaxHours?: number;
  trashRetentionDays?: number;
  aiClassificationMode?: AiClassificationMode;
  aiAutoApplyThreshold?: number | null;
  advancedRolesEnabled?: boolean;
  allowSharedLinkEdit?: boolean;
  allowPublicEditLinks?: boolean;
  allowViewerShareLinks?: boolean;
  folderStructureMode?: unknown;
  permissionInheritanceMode?: unknown;
  invitePolicy?: unknown;
  allowExternalCollaborators?: unknown;
  externalDomainAllowlist?: unknown;
  guestInvitationExpiryDays?: unknown;
  guestSessionMaxHours?: unknown;
  allowGuestElevatedRoles?: unknown;
  externalDomainExistingGuestMode?: unknown;
  adminContentInspectPolicy?: unknown;
  ipAllowlistEnabled?: unknown;
  ipAllowlistScope?: unknown;
  ipAllowlist?: unknown;
  requireSsoLogin?: unknown;
  ssoAllowedDomains?: unknown;
  allowFileRequests?: unknown;
  fileRequestMaxSizeBytes?: unknown;
  fileRequestEnforceAllowedExtensions?: unknown;
  brandingOrgName?: unknown;
  brandingContactInfo?: unknown;
  brandingFooterNote?: unknown;
  brandingAccentColor?: unknown;
  quotaWarnThresholdPct?: unknown;
  quotaCriticalThresholdPct?: unknown;
}

export interface ExistingTenantPolicyRow {
  external_domain_allowlist_json: string | null;
  external_domain_existing_guest_mode: string | null;
  ip_allowlist_enabled: number | null;
  ip_allowlist_scope: string | null;
  ip_allowlist_json: string | null;
  require_sso_login: number | null;
  sso_allowed_domains_json: string | null;
  quota_warn_threshold_pct: number | null;
  quota_critical_threshold_pct: number | null;
}

export interface PolicyPatchState {
  updates: string[];
  binds: unknown[];
  effectiveDomainAllowlist: string[];
  effectiveExistingGuestMode: ExternalDomainExistingGuestMode;
  effectiveIpAllowlistEnabled: boolean;
  effectiveIpAllowlistScope: IpAllowlistScope;
  effectiveIpAllowlist: string[];
}

export function sysAdminRequiredResponse(
  c: Context<OidcHonoEnv>,
  message: string
): Response {
  return c.json({ error: message, code: 'SYS_ADMIN_REQUIRED' }, 403);
}

export function parseFolderStructureMode(value: unknown): FolderStructureMode | null {
  return value === 'open' || value === 'closed' ? value : null;
}

export function projectPolicy(
  policy: Record<string, unknown>,
  folderStructureMode: FolderStructureMode,
  permissionInheritanceMode: PermissionInheritanceMode,
  invitePolicy: InvitePolicy
): Record<string, unknown> {
  // Never project ciphertext (or any secret material) to API consumers. The
  // dedicated /api/admin/siem endpoint exposes only `secretConfigured`.
  const {
    siem_webhook_secret_encrypted: _omitSiemSecret,
    ...safePolicy
  } = policy;
  return {
    ...safePolicy,
    // camelCase projection for API consumers; the raw snake_case column stays
    // for D1/backwards-compatible readers.
    advancedRolesEnabled: policy.advanced_roles_enabled === 1,
    allowSharedLinkEdit: policy.allow_shared_link_edit === 1,
    allowPublicEditLinks: policy.allow_public_edit_links === 1,
    allowViewerShareLinks: policy.allow_viewer_share_links === 1,
    allowExternalCollaborators: policy.allow_external_collaborators === 1,
    externalDomainAllowlist: parseDomainAllowlistJson(
      policy.external_domain_allowlist_json
    ),
    guestInvitationExpiryDays: Number(policy.guest_invitation_expiry_days ?? 14),
    guestSessionMaxHours: Number(policy.guest_session_max_hours ?? 24),
    allowGuestElevatedRoles: policy.allow_guest_elevated_roles === 1,
    externalDomainExistingGuestMode:
      policy.external_domain_existing_guest_mode === 'suspend_existing'
        ? 'suspend_existing'
        : DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE,
    folderStructureMode,
    permissionInheritanceMode,
    invitePolicy,
    adminContentInspectPolicy: isAdminContentInspectPolicy(
      policy.admin_content_inspect_policy
    )
      ? policy.admin_content_inspect_policy
      : DEFAULT_ADMIN_CONTENT_INSPECT_POLICY,
    ipAllowlistEnabled: policy.ip_allowlist_enabled === 1,
    ipAllowlistScope: isIpAllowlistScope(policy.ip_allowlist_scope)
      ? policy.ip_allowlist_scope
      : 'admin_only',
    ipAllowlist: parseIpAllowlistJson(policy.ip_allowlist_json),
    requireSsoLogin: policy.require_sso_login === 1,
    ssoAllowedDomains: parseSsoAllowedDomainsJson(
      policy.sso_allowed_domains_json
    ),
    // P13-4 / TOM-72 file-request governance, branding and quota warnings.
    allowFileRequests: policy.allow_file_requests !== 0,
    fileRequestMaxSizeBytes: Number(
      policy.file_request_max_size_bytes ?? 104857600
    ),
    fileRequestEnforceAllowedExtensions:
      policy.file_request_enforce_allowed_extensions === 1,
    brandingOrgName: policy.branding_org_name ?? null,
    brandingContactInfo: policy.branding_contact_info ?? null,
    brandingFooterNote: policy.branding_footer_note ?? null,
    brandingLogoUrl: buildBrandingLogoUrl(
      String(policy.tenant_id ?? ''),
      (policy.branding_logo_r2_key as string | null | undefined) ?? null
    ),
    brandingAccentColor: policy.branding_accent_color ?? null,
    quotaWarnThresholdPct: Number(policy.quota_warn_threshold_pct ?? 80),
    quotaCriticalThresholdPct: Number(
      policy.quota_critical_threshold_pct ?? 90
    ),
  };
}

export async function loadTenantPoliciesPayload(
  db: D1Database,
  tenantId: string
) {
  const [policy, folderStructureMode, permissionInheritanceMode, invitePolicy] =
    await Promise.all([
      db
        .prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?')
        .bind(tenantId)
        .first<Record<string, unknown>>(),
      getFolderStructureMode(db, tenantId),
      getPermissionInheritanceMode(db, tenantId),
      getTenantInvitePolicy(db, tenantId),
    ]);
  const [closedModeReport, inheritanceConflictReport] = await Promise.all([
    folderStructureMode === 'closed'
      ? buildClosedRootReport(db, tenantId)
      : Promise.resolve(null),
    findWaterfallInheritanceConflicts(db, tenantId),
  ]);
  return {
    policy: policy
      ? projectPolicy(
          policy,
          folderStructureMode,
          permissionInheritanceMode,
          invitePolicy
        )
      : null,
    folderStructureMode,
    permissionInheritanceMode,
    invitePolicy,
    ...(closedModeReport ? { closedModeReport } : {}),
    inheritanceConflictReport,
  };
}
