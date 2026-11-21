import type {
  ClassificationLabel,
  FileLockInfo,
  InvitePolicy,
  PermissionInheritanceMode,
  ResourceRole,
  TrashBulkResponse,
  TrashItemType,
  TrashSort,
  TrashTypeFilter,
  UserRole,
  UserType,
} from './core';
import type { AdminSiemSettings, AdminTosPolicy } from './governance';
import type {
  FileRequestSummary,
  GuestEffectivePermission,
  GuestInvitationSummary,
  GuestMailPreview,
  GuestPolicyProjection,
  GuestSharedItemSummary,
  ShareAccessScope,
  SharePermissionLevel,
  WaterfallInheritanceConflict,
} from './sharing';

/** TOM-73 fine-grained governance capabilities delegated by sys_admin. */
export type AdminCapability =
  | 'admin.insights.read'
  | 'admin.users.read'
  | 'admin.users.suspend'
  | 'admin.users.manage'
  | 'admin.guests.manage'
  | 'admin.groups.manage'
  | 'admin.content.unlock'
  | 'admin.root_folders.read'
  | 'admin.permissions.audit'
  | 'admin.trash.manage'
  | 'admin.links.revoke'
  | 'admin.reports.run'
  | 'admin.audit.read'
  | 'admin.policies.read'
  | 'admin.policies.edit';

export interface AdminScope {
  groupId: string | null;
  rootFolderId: string | null;
}

export type AdminDelegationPreset =
  | 'helpdesk'
  | 'auditor'
  | 'group_manager'
  | 'content_operator';

/** Open keeps root creation available; closed restricts root placement to sys_admin. */
export type FolderStructureMode = 'open' | 'closed';
export type ExternalDomainExistingGuestMode =
  | 'reject_new_only'
  | 'suspend_existing';

export interface ClosedRootReport {
  totalRootFolders: number;
  missingOwnerCount: number;
  suspendedOwnerCount: number;
  roots: Array<{
    id: string;
    name: string;
    ownerMissing: boolean;
    hasSuspendedOwner: boolean;
  }>;
}

export type AiClassificationMode =
  | 'disabled'
  | 'metadata_only'
  | 'content_excerpt';

export interface AdminTrashPerson {
  id: string;
  name: string;
  email: string | null;
}

export interface AdminTrashPermissionSummary {
  total: number;
  direct: number;
  inherited: number;
  userCount: number;
  groupCount: number;
  roles: Record<ResourceRole, number>;
  sharedLinkCount: number;
}

export interface AdminTrashItem {
  type: TrashItemType;
  id: string;
  name: string;
  classification: ClassificationLabel;
  sizeBytes: number | null;
  currentVersionNum: number;
  parentFolder: { id: string; name: string } | null;
  owner: AdminTrashPerson | null;
  deletedBy: AdminTrashPerson | null;
  deletedAt: string;
  purgeAt: string;
  daysRemaining: number;
  permissionSummary: AdminTrashPermissionSummary;
}

export type AdminTrashRetentionFilter = 'all' | '7' | '1';

export interface AdminTrashFiltersState {
  query: string;
  type: TrashTypeFilter;
  ownerId: string | null;
  deletedById: string | null;
  retention: AdminTrashRetentionFilter;
  sort: TrashSort;
}

export interface AdminTrashListResponse {
  type: 'admin_trash';
  items: AdminTrashItem[];
  owners: AdminTrashPerson[];
  deleters: AdminTrashPerson[];
  hasUnknownDeleter: boolean;
  nextCursor: string | null;
  hasMore: boolean;
  trashRetentionDays: number;
  limit: number;
  sort: TrashSort;
}

export interface AdminTrashRestoreResponse extends TrashBulkResponse {
  syncSeq: number | null;
}

export interface StorageStatsResponse {
  quotaBytes: number;
  usedBytes: number;
  remainingBytes: number;
  totalFiles: number;
  byClassification: Record<
    ClassificationLabel,
    { fileCount: number; totalBytes: number }
  >;
  d1EstimatedBytes: number | null;
  quotaWarnThresholdPct?: number;
  quotaCriticalThresholdPct?: number;
}

export interface AdminSharedLinkRow {
  id: string;
  target_type: 'file' | 'folder';
  target_id: string;
  access_scope: ShareAccessScope;
  permission_level: SharePermissionLevel;
  can_download: number;
  require_watermark: number;
  failed_password_attempts: number;
  locked_until: string | null;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  created_by: string;
  creator_email: string | null;
  target_name: string | null;
  created_at: string;
}

export type AdminContentInspectPolicy =
  | 'disabled'
  | 'deny_confidential'
  | 'watermark_confidential';

export type AdminContentTargetType = 'file' | 'folder';
export type AdminContentSearchTargetType = 'all' | AdminContentTargetType;
export type AdminContentClassificationFilter =
  | ClassificationLabel
  | 'all';

export interface AdminContentSearchFilters {
  targetType: AdminContentSearchTargetType;
  query: string;
  classification: AdminContentClassificationFilter;
  createdBy: string;
  extension: string;
  lockedOnly: boolean;
  hasSharedLink: boolean;
}

export interface AdminContentOwner {
  id: string;
  email: string | null;
  displayName: string | null;
}

export interface AdminContentBreadcrumb {
  id: string;
  name: string;
}

export interface AdminContentSearchItem {
  targetType: AdminContentTargetType;
  id: string;
  name: string;
  folderId: string | null;
  parentId: string | null;
  pathLabel: string;
  breadcrumbs: AdminContentBreadcrumb[];
  owner: AdminContentOwner;
  classification: ClassificationLabel;
  extension: string | null;
  sizeBytes: number | null;
  currentVersionNum: number | null;
  activeSharedLinkCount: number;
  activeLock: FileLockInfo | null;
  updatedAt: string;
}

export interface AdminContentSearchResponse {
  items: AdminContentSearchItem[];
  nextCursor: string | null;
  limit: number;
  filters: {
    targetType: AdminContentSearchTargetType;
    query: string;
    createdBy: string | null;
    rootFolderId: string | null;
    classification: ClassificationLabel | null;
    extension: string | null;
    lockedOnly: boolean;
    hasSharedLink: boolean;
  };
}

export interface AdminContentPermissionItem {
  id: string;
  granteeType: 'user' | 'group';
  granteeId: string;
  granteeName: string | null;
  granteeEmail: string | null;
  role: ResourceRole;
  grantedBy: string;
  grantedByEmail: string | null;
  createdAt: string;
}

export interface AdminContentSharedLinkItem {
  id: string;
  targetType: AdminContentTargetType;
  targetId: string;
  accessScope: ShareAccessScope;
  permissionLevel: SharePermissionLevel;
  canDownload: boolean;
  requireWatermark: boolean;
  hasPassword: boolean;
  isLocked: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdBy: string;
  creatorEmail: string | null;
  createdAt: string;
}

export interface AdminContentVersionItem {
  id: string;
  versionNum: number;
  sizeBytes: number;
  mimeType: string;
  uploadStatus: string;
  uploadedBy: string;
  uploadedByEmail: string | null;
  comment: string | null;
  createdAt: string;
}

export interface AdminContentDetail {
  targetType: AdminContentTargetType;
  id: string;
  name: string;
  folderId: string | null;
  parentId: string | null;
  pathLabel: string;
  breadcrumbs: AdminContentBreadcrumb[];
  owner: AdminContentOwner;
  classification: ClassificationLabel;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  currentVersionId: string | null;
  currentVersionNum: number | null;
  createdAt: string;
  updatedAt: string;
  activeLock: FileLockInfo | null;
  permissions: AdminContentPermissionItem[];
  sharedLinks: AdminContentSharedLinkItem[];
  versions: {
    total: number;
    items: AdminContentVersionItem[];
  };
  inspectPolicy: AdminContentInspectPolicy;
}

export interface AdminContentForceUnlockResponse {
  ok: boolean;
  fileId: string;
  released: boolean;
  lock: FileLockInfo | null;
  revokedWopiSessionCount: number;
  syncSeq: number | null;
}

export interface AdminContentInspectResponse {
  ok: boolean;
  fileId: string;
  fileName: string;
  classification: ClassificationLabel;
  policyApplied: AdminContentInspectPolicy;
  watermarkRequired: boolean;
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
  watermarkText: string | null;
  versionId?: string;
  versionNum?: number;
}

export type AdminIpAllowlistScope =
  | 'admin_only'
  | 'internal_users'
  | 'all_access';

export interface AdminFileRequestRow extends FileRequestSummary {
  folderName: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
}

export interface TenantPolicyRow {
  tenant_id: string;
  enforce_company_only_links: number;
  require_watermark_confidential: number;
  max_link_expiration_days: number;
  session_max_hours: number;
  trash_retention_days: number;
  ai_classification_mode: AiClassificationMode;
  ai_auto_apply_threshold: number | null;
  advanced_roles_enabled?: number;
  advancedRolesEnabled?: boolean;
  allow_shared_link_edit?: number;
  allow_public_edit_links?: number;
  allow_viewer_share_links?: number;
  allowSharedLinkEdit?: boolean;
  allowPublicEditLinks?: boolean;
  allowViewerShareLinks?: boolean;
  folder_structure_mode?: FolderStructureMode;
  folderStructureMode?: FolderStructureMode;
  permission_inheritance_mode?: PermissionInheritanceMode;
  permissionInheritanceMode?: PermissionInheritanceMode;
  invite_policy?: InvitePolicy;
  invitePolicy?: InvitePolicy;
  allow_external_collaborators?: number;
  allowExternalCollaborators?: boolean;
  external_domain_allowlist_json?: string;
  externalDomainAllowlist?: string[];
  guest_invitation_expiry_days?: number;
  guestInvitationExpiryDays?: number;
  guest_session_max_hours?: number;
  guestSessionMaxHours?: number;
  allow_guest_elevated_roles?: number;
  allowGuestElevatedRoles?: boolean;
  external_domain_existing_guest_mode?: ExternalDomainExistingGuestMode;
  externalDomainExistingGuestMode?: ExternalDomainExistingGuestMode;
  admin_content_inspect_policy?: AdminContentInspectPolicy;
  adminContentInspectPolicy?: AdminContentInspectPolicy;
  ip_allowlist_enabled?: number;
  ipAllowlistEnabled?: boolean;
  ip_allowlist_scope?: AdminIpAllowlistScope;
  ipAllowlistScope?: AdminIpAllowlistScope;
  ip_allowlist_json?: string;
  ipAllowlist?: string[];
  require_sso_login?: number;
  requireSsoLogin?: boolean;
  sso_allowed_domains_json?: string;
  ssoAllowedDomains?: string[];
  allow_file_requests?: number;
  allowFileRequests?: boolean;
  file_request_max_size_bytes?: number;
  fileRequestMaxSizeBytes?: number;
  file_request_enforce_allowed_extensions?: number;
  fileRequestEnforceAllowedExtensions?: boolean;
  branding_org_name?: string | null;
  brandingOrgName?: string | null;
  branding_contact_info?: string | null;
  brandingContactInfo?: string | null;
  branding_footer_note?: string | null;
  brandingFooterNote?: string | null;
  branding_logo_r2_key?: string | null;
  brandingLogoUrl?: string | null;
  branding_accent_color?: string | null;
  brandingAccentColor?: string | null;
  quota_warn_threshold_pct?: number;
  quotaWarnThresholdPct?: number;
  quota_critical_threshold_pct?: number;
  quotaCriticalThresholdPct?: number;
  updated_by: string | null;
  updated_at: string;
}

export interface UpdateAdminPoliciesPayload {
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
  folderStructureMode?: FolderStructureMode;
  permissionInheritanceMode?: PermissionInheritanceMode;
  invitePolicy?: InvitePolicy;
  allowExternalCollaborators?: boolean;
  externalDomainAllowlist?: string[];
  guestInvitationExpiryDays?: number;
  guestSessionMaxHours?: number;
  allowGuestElevatedRoles?: boolean;
  externalDomainExistingGuestMode?: ExternalDomainExistingGuestMode;
  adminContentInspectPolicy?: AdminContentInspectPolicy;
  ipAllowlistEnabled?: boolean;
  ipAllowlistScope?: AdminIpAllowlistScope;
  ipAllowlist?: string[];
  requireSsoLogin?: boolean;
  ssoAllowedDomains?: string[];
  allowFileRequests?: boolean;
  fileRequestMaxSizeBytes?: number;
  fileRequestEnforceAllowedExtensions?: boolean;
  brandingOrgName?: string | null;
  brandingContactInfo?: string | null;
  brandingFooterNote?: string | null;
  brandingAccentColor?: string | null;
  quotaWarnThresholdPct?: number;
  quotaCriticalThresholdPct?: number;
}

export interface TenantPolicyResponse {
  policy: TenantPolicyRow | null;
  folderStructureMode?: FolderStructureMode;
  permissionInheritanceMode?: PermissionInheritanceMode;
  invitePolicy?: InvitePolicy;
  closedModeReport?: ClosedRootReport;
  inheritanceConflictReport?: WaterfallInheritanceConflict[];
  externalDomainPolicy?: AdminGuestDomainPolicyResult;
}

export interface AdminGuestDomainPolicyResult {
  mode: ExternalDomainExistingGuestMode;
  affectedGuestCount: number;
  suspendedGuestIds: string[];
}

/* ------------------------------------------------------------------ */
/* P10-3 / TOM-61 admin guest lifecycle governance                     */
/* ------------------------------------------------------------------ */

export type AdminGuestStatusFilter =
  | 'all'
  | 'active'
  | 'suspended'
  | 'expired'
  | 'pending_invite'
  | 'offboarded';
export type AdminGuestSortBy =
  | 'createdAt'
  | 'lastLoginAt'
  | 'expiresAt'
  | 'email'
  | 'externalOrg';
export type AdminGuestSortDir = 'asc' | 'desc';
export type AdminGuestLifecycleStatus = Exclude<AdminGuestStatusFilter, 'all'>;

export interface AdminGuestRow {
  id: string;
  email: string;
  displayName: string;
  externalOrg: string | null;
  invitedBy: string | null;
  invitedByName: string | null;
  invitedByEmail: string | null;
  expiresAt: string | null;
  lastLoginAt: string | null;
  accountStatus: 'active' | 'suspended';
  status: AdminGuestLifecycleStatus;
  offboardedAt: string | null;
  offboardedBy: string | null;
  domain: string | null;
  allowedByPolicy: boolean;
  pendingInvitationCount: number;
  createdAt: string;
}

export interface AdminGuestDomainSummary {
  domain: string;
  count: number;
  active: number;
  suspended: number;
  expired: number;
  allowedByPolicy: boolean;
}

export interface AdminGuestInviterSummary {
  inviterId: string;
  inviterName: string;
  inviterEmail: string | null;
  count: number;
  active: number;
  suspended: number;
  expired: number;
}

export interface AdminGuestAggregations {
  total: number;
  byStatus: Record<AdminGuestStatusFilter, number>;
  byDomain: AdminGuestDomainSummary[];
  byInviter: AdminGuestInviterSummary[];
  disallowedDomainGuestCount: number;
}

export interface AdminGuestListQuery {
  query?: string;
  status?: AdminGuestStatusFilter;
  domain?: string;
  invitedBy?: string;
  expiresBefore?: string;
  sortBy?: AdminGuestSortBy;
  sortDir?: AdminGuestSortDir;
  limit?: number;
  offset?: number;
  format?: 'json' | 'csv';
}

export interface AdminGuestListResponse {
  guests: AdminGuestRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  sort: { by: AdminGuestSortBy; dir: AdminGuestSortDir };
  summary: AdminGuestAggregations;
  aggregations: AdminGuestAggregations;
}

export interface AdminGuestDetailGuest {
  id: string;
  email: string;
  displayName: string;
  userType: 'guest';
  externalOrg: string | null;
  accountStatus: 'active' | 'suspended';
  status: AdminGuestLifecycleStatus;
  expiresAt: string | null;
  lastLoginAt: string | null;
  invitedBy: string | null;
  invitedByName: string | null;
  invitedByEmail: string | null;
  offboardedAt: string | null;
  offboardedBy: string | null;
  domain: string | null;
  domainAllowedByPolicy: boolean;
  createdAt: string;
}

export interface AdminGuestSharedItem extends GuestSharedItemSummary {
  /** Confidential items are metadata-only; never render a download action. */
  dlpProtected: boolean;
}

export interface AdminGuestAuditLog {
  id: string;
  action: string;
  status: 'allowed' | 'blocked';
  actorEmail: string | null;
  actorIp: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminGuestDetailResponse {
  guest: AdminGuestDetailGuest;
  invitations: GuestInvitationSummary[];
  permissions: {
    direct: GuestEffectivePermission[];
    inherited: GuestEffectivePermission[];
    directCount: number;
    inheritedCount: number;
  };
  effectivePermissions: GuestEffectivePermission[];
  sharedItems: AdminGuestSharedItem[];
  recentAuditLogs: AdminGuestAuditLog[];
  accessSummary: {
    folderCount: number;
    fileCount: number;
    itemCount: number;
    invitationCount: number;
  };
  pendingInvitationId: string | null;
  guestPolicy: GuestPolicyProjection & {
    externalDomainExistingGuestMode: ExternalDomainExistingGuestMode;
  };
  dlp: {
    confidentialMetadataOnly: boolean;
    notice: string;
  };
}

export interface AdminGuestMutationResponse {
  ok: boolean;
  replayed?: boolean;
  guest: {
    id: string;
    status: 'active' | 'suspended';
    offboardedAt: string | null;
    expiresAt?: string | null;
  };
  sessionsRevoked?: number;
  invitationsRevoked?: number;
  otpChallengesConsumed?: number;
  permissionsDeleted?: number;
  notice?: string;
}

export interface AdminGuestResendInviteResponse {
  ok: boolean;
  replayed?: boolean;
  guestId: string;
  invitationId: string;
  email: string;
  expiresAt: string;
  resendCount: number;
  mailPreview?: GuestMailPreview | null;
  notice?: string;
}

/* ------------------------------------------------------------------ */
/* P11-2 / TOM-64 admin internal member administration                 */
/* ------------------------------------------------------------------ */

export type AdminMemberRoleFilter = 'all' | UserRole;
export type AdminMemberStatusFilter = 'all' | 'active' | 'suspended';
export type AdminMemberSortBy =
  | 'email'
  | 'displayName'
  | 'department'
  | 'role'
  | 'status'
  | 'createdAt'
  | 'lastLoginAt'
  | 'usedBytes';
export type AdminMemberSortDir = 'asc' | 'desc';
export type AdminMemberAccountStatus = Exclude<
  AdminMemberStatusFilter,
  'all'
>;

export interface AdminMemberRow {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  role: UserRole;
  status: AdminMemberAccountStatus;
  storageQuotaBytes: number | null;
  usedBytes: number;
  fileCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminMemberDepartmentSummary {
  department: string | null;
  count: number;
}

export interface AdminMemberAggregations {
  total: number;
  byStatus: Record<AdminMemberStatusFilter, number>;
  byRole: Record<UserRole, number>;
  /** Active sys_admin count for the last-admin offboarding guard. */
  activeSysAdminCount?: number;
  departments: AdminMemberDepartmentSummary[];
}

export interface AdminMemberListQuery {
  query?: string;
  role?: AdminMemberRoleFilter;
  status?: AdminMemberStatusFilter;
  department?: string;
  sortBy?: AdminMemberSortBy;
  sortDir?: AdminMemberSortDir;
  limit?: number;
  offset?: number;
  format?: 'json' | 'csv';
}

export interface AdminMemberListResponse {
  users: AdminMemberRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  sort: { by: AdminMemberSortBy; dir: AdminMemberSortDir };
  summary: AdminMemberAggregations;
  aggregations: AdminMemberAggregations;
}

export interface AdminMemberRootFolder {
  id: string;
  name: string;
  classification: string;
  createdAt: string;
}

export interface AdminMemberGroup {
  id: string;
  name: string;
}

export interface AdminMemberAuditLog {
  id: string;
  action: string;
  status: 'allowed' | 'blocked';
  actorEmail: string | null;
  actorIp: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminMemberDetailResponse {
  user: AdminMemberRow & { updatedAt: string };
  rootFolders: AdminMemberRootFolder[];
  groups: AdminMemberGroup[];
  activeSessionCount: number;
  recentAuditLogs: AdminMemberAuditLog[];
}

/* ------------------------------------------------------------------ */
/* P12-2 / TOM-71 active sessions & forced sign-out                    */
/* ------------------------------------------------------------------ */

export type AdminSessionUserTypeFilter = 'all' | 'member' | 'guest';

export interface AdminSessionRow {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  userRole: UserRole;
  userType: UserType;
  userStatus: 'active' | 'suspended';
  externalOrg: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface AdminSessionSummary {
  activeTotal: number;
  memberSessions: number;
  guestSessions: number;
  distinctUsers: number;
}

export interface AdminSessionListResponse {
  sessions: AdminSessionRow[];
  summary: AdminSessionSummary;
  nextCursor: string | null;
  limit: number;
}

export interface AdminSessionListQuery {
  userId?: string;
  userType?: AdminSessionUserTypeFilter;
  ip?: string;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export type AdminSsoProviderId = 'okta' | 'entra_id';

export interface AdminSsoDiscoveryProbe {
  ok: boolean;
  jwksUri: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  error: string | null;
}

export interface AdminSsoProviderStatus {
  provider: AdminSsoProviderId;
  issuer: string;
  /** Masked server-side; the full client id is never returned. */
  clientIdMasked: string;
  clientSecretConfigured: boolean;
  jwksUri: string | null;
  discovery?: AdminSsoDiscoveryProbe;
}

export interface AdminSsoStatusResponse {
  providers: AdminSsoProviderStatus[];
  callbackUrl: string;
  environment: string;
  allowDevAuth: boolean;
  requireSsoLogin: boolean;
  ssoAllowedDomains: string[];
  clientIp: string;
}

export interface AdminSessionRevokeResponse {
  ok: boolean;
  sessionId: string;
  userId: string;
  userEmail: string;
  revokedAt: string;
  alreadyRevoked: boolean;
}

export interface AdminUserSessionsRevokeResponse {
  ok: boolean;
  userId: string;
  userEmail: string;
  revokedCount: number;
  keepCurrentSession: boolean;
  revokedAt: string;
}

export interface AdminTenantSessionsRevokeResponse {
  ok: boolean;
  revokedCount: number;
  keepCurrentSession: boolean;
  revokedAt: string;
}

export interface AdminMemberMutationResponse {
  ok: boolean;
  replayed?: boolean;
  user: AdminMemberRow;
  sessionsRevoked?: number;
  syncSeq: number | null;
  notice?: string;
}

export interface AdminMemberCreateInput {
  email: string;
  displayName: string;
  department?: string | null;
  role?: UserRole;
  storageQuotaBytes?: number | null;
}

export interface AdminMemberUpdateInput {
  displayName?: string;
  department?: string | null;
  role?: UserRole;
  storageQuotaBytes?: number | null;
}

export type AdminMemberBulkAction =
  | 'create'
  | 'update'
  | 'unchanged'
  | 'error';

export interface AdminMemberBulkRowResult {
  rowNumber: number;
  email: string;
  action: AdminMemberBulkAction;
  displayName: string | null;
  department: string | null;
  role: UserRole | null;
  storageQuotaBytes: number | null;
  userId?: string;
  code?: string;
  error?: string;
}

export interface AdminMemberBulkImportResponse {
  ok: boolean;
  dryRun: boolean;
  replayed: boolean;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  errorCount: number;
  results: AdminMemberBulkRowResult[];
  syncSeq: number | null;
  notice: string;
}

/* ------------------------------------------------------------------ */
/* P11-4 / TOM-70 member offboarding                                   */
/* ------------------------------------------------------------------ */

export type AdminOffboardingSharedLinksAction = 'transfer_owner' | 'revoke_all';
export type AdminOffboardingFileRequestsAction =
  | 'transfer_owner'
  | 'deactivate_all';
export type AdminOffboardingUserAction = 'suspend' | 'keep_status';

export interface AdminOffboardingOwnedFolder {
  id: string;
  name: string;
  classification: string;
  parentId: string | null;
  isRoot: boolean;
  soleOwner: boolean;
  effectiveOwnerCount: number;
  createdAt: string;
}

export interface AdminOffboardingDirectPermissions {
  total: number;
  folder: number;
  file: number;
  folderCount: number;
  fileCount: number;
}

export interface AdminOffboardingSharedLink {
  id: string;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string | null;
  accessScope: string;
  canDownload: boolean;
  requireWatermark: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface AdminOffboardingFileRequest {
  id: string;
  folderId: string;
  folderName: string | null;
  title: string;
  submissionCount: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface AdminOffboardingHeldLock {
  fileId: string;
  fileName: string | null;
  mode: 'wopi_collab' | 'desktop_exclusive';
  lockId: string;
  expiresAt: string;
}

export interface AdminOffboardingTransferCandidate {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface AdminOffboardingPreviewResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: UserRole;
    status: 'active' | 'suspended';
    userType: 'member' | 'guest';
    offboardedAt: string | null;
  };
  ownedFolders: AdminOffboardingOwnedFolder[];
  ownedFolderCount: number;
  soleOwnerCount: number;
  directPermissions: AdminOffboardingDirectPermissions;
  activeSharedLinks: AdminOffboardingSharedLink[];
  activeFileRequests: AdminOffboardingFileRequest[];
  heldLocks: AdminOffboardingHeldLock[];
  activeSessionCount: number;
  activeWopiSessionCount: number;
  groupMembershipCount: number;
  transferCandidates: AdminOffboardingTransferCandidate[];
  generatedAt: string;
}

export interface AdminOffboardingInput {
  transferToUserId: string | null;
  sharedLinksAction: AdminOffboardingSharedLinksAction;
  fileRequestsAction: AdminOffboardingFileRequestsAction;
  userAction: AdminOffboardingUserAction;
  revokeDirectPermissions: boolean;
  removeGroupMemberships: boolean;
  releaseHeldLocks: boolean;
  confirmation: string;
}

export interface AdminOffboardingSummary {
  ownedFolderCount: number;
  transferredFolderCount: number;
  soleOwnerFolderCount: number;
  directPermissionsRevoked: number;
  groupMembershipsRemoved: number;
  sharedLinksTransferred: number;
  sharedLinksRevoked: number;
  fileRequestsTransferred: number;
  fileRequestsDeactivated: number;
  sessionsRevoked: number;
  wopiSessionsRevoked: number;
  locksReleased: number;
  statusChanged: boolean;
}

export interface AdminOffboardingResponse {
  ok: boolean;
  replayed: boolean;
  user: AdminMemberRow;
  transferTarget: AdminOffboardingTransferCandidate | null;
  options: {
    sharedLinksAction: AdminOffboardingSharedLinksAction;
    fileRequestsAction: AdminOffboardingFileRequestsAction;
    userAction: AdminOffboardingUserAction;
    revokeDirectPermissions: boolean;
    removeGroupMemberships: boolean;
    releaseHeldLocks: boolean;
  };
  summary: AdminOffboardingSummary;
  syncSeq: number | null;
  notice: string;
}

/* ------------------------------------------------------------------ */
/* P11-3 / TOM-69 admin group & SCIM token management                  */
/* ------------------------------------------------------------------ */

export type AdminGroupSource = 'scim' | 'manual';
export type AdminGroupSourceFilter = 'all' | AdminGroupSource;

export interface AdminGroupRow {
  id: string;
  name: string;
  source: AdminGroupSource;
  externalIdpId: string | null;
  memberCount: number;
  permissionCount: number;
  createdAt: string;
}

export interface AdminGroupSummary {
  total: number;
  manualCount: number;
  scimCount: number;
}

export interface AdminGroupListQuery {
  query?: string;
  source?: AdminGroupSourceFilter;
  limit?: number;
  offset?: number;
}

export interface AdminGroupListResponse {
  groups: AdminGroupRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  summary: AdminGroupSummary;
  aggregations?: AdminGroupSummary;
}

export interface AdminGroupMember {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  role: UserRole;
  status: 'active' | 'suspended';
  addedAt: string;
}

export interface AdminGroupPermission {
  id: string;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  targetPath: string;
  role: ResourceRole;
  grantedBy: string | null;
  grantedByName: string | null;
  createdAt: string;
}

export interface AdminGroupDetailResponse {
  group: AdminGroupRow;
  members: AdminGroupMember[];
  permissions: AdminGroupPermission[];
  scimManaged: boolean;
}

export interface AdminGroupMutationResponse {
  ok: boolean;
  group?: AdminGroupRow;
  groupId: string;
  deletedPermissions?: number;
  deletedMembers?: number;
  addedUserIds?: string[];
  addedCount?: number;
  alreadyMemberUserIds?: string[];
  memberCount?: number;
  syncSeq: number | null;
  notice: string;
}

export type AdminScimTokenStatus = 'active' | 'revoked';

export interface AdminScimTokenRow {
  id: string;
  name: string;
  idpIssuer: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: AdminScimTokenStatus;
}

export interface AdminScimTokenListResponse {
  tokens: AdminScimTokenRow[];
  total: number;
  activeCount: number;
  revokedCount: number;
  endpoint: '/scim/v2';
}

export interface AdminScimTokenMutationResponse {
  ok: boolean;
  token?: string;
  scimToken: AdminScimTokenRow;
  revokedTokenId?: string;
  alreadyRevoked?: boolean;
  notice: string;
}

export interface AdminScimTokenCreateInput {
  name: string;
  idpIssuer: string;
}

export interface AdminRootFolderOwner {
  granteeType: 'user' | 'group';
  granteeId: string;
  name: string;
  email: string | null;
  status: 'active' | 'suspended';
}

export interface AdminRootFolderRecord {
  id: string;
  name: string;
  classification: ClassificationLabel;
  isPinned: boolean;
  version: number;
  createdBy: string;
  createdByName: string;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
  owners: AdminRootFolderOwner[];
  coOwners: AdminRootFolderOwner[];
  itemCount: number;
  totalBytes: number;
  ownerMissing: boolean;
  hasSuspendedOwner: boolean;
}

export interface AdminRootFolderSummary {
  totalRootFolders: number;
  activeRootFolders: number;
  archivedRootFolders: number;
  missingOwnerCount: number;
  suspendedOwnerCount: number;
  totalBytes: number;
  folderStructureMode: FolderStructureMode;
}

export interface AdminRootFolderListResponse {
  roots: AdminRootFolderRecord[];
  summary: AdminRootFolderSummary;
}

export type AdminBulkItemStatus = 'succeeded' | 'skipped' | 'failed';

export interface AdminBulkItemResult {
  folderId: string;
  folderName: string;
  status: AdminBulkItemStatus;
  code?: string;
  message?: string;
}

export interface AdminBulkSummary {
  requested: number;
  succeeded: number;
  skipped: number;
  failed: number;
  executable: number;
}

export interface AdminBulkResponse {
  operation: string;
  dryRun: boolean;
  replayed: boolean;
  results: AdminBulkItemResult[];
  summary: AdminBulkSummary;
  syncSeq: number | null;
}

export interface AdminBulkCoOwnerPayload {
  folderIds: string[];
  userIds?: string[];
  groupIds?: string[];
  dryRun?: boolean;
  idempotencyKey?: string;
}

export interface AdminBulkTransferOwnerPayload {
  folderIds: string[];
  newOwnerUserId: string;
  demotePreviousOwnersTo?: 'co_owner' | 'editor' | 'revoke';
  dryRun?: boolean;
  idempotencyKey?: string;
}

export interface AdminBulkLifecyclePayload {
  folderIds: string[];
  dryRun?: boolean;
  idempotencyKey?: string;
}

/* ------------------------------------------------------------------ */
/* P13-1 / TOM-73 Co-Admin delegations                                 */
/* ------------------------------------------------------------------ */

export interface AdminDelegationRow {
  id: string;
  tenantId: string;
  userId: string;
  preset: AdminDelegationPreset | null;
  permissions: AdminCapability[];
  scopeGroupId: string | null;
  scopeRootFolderId: string | null;
  note: string | null;
  grantedBy: string;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  userEmail: string | null;
  userStatus: 'active' | 'suspended' | null;
  groupName: string | null;
  rootFolderName: string | null;
  grantedByName: string | null;
}

export interface AdminDelegationPresetInfo {
  id: AdminDelegationPreset;
  capabilities: AdminCapability[];
}

export interface AdminDelegationCapabilityInfo {
  id: AdminCapability;
  label: string;
}

export interface AdminDelegationListResponse {
  delegations: AdminDelegationRow[];
  presets: AdminDelegationPresetInfo[];
  capabilities: AdminDelegationCapabilityInfo[];
}

export interface AdminDelegationMutationResponse {
  ok?: boolean;
  delegation: AdminDelegationRow;
}

export interface AdminDelegationInput {
  userId: string;
  preset?: AdminDelegationPreset | null;
  permissions?: AdminCapability[];
  scopeGroupId?: string | null;
  scopeRootFolderId?: string | null;
  note?: string | null;
}

export interface AdminDelegationUpdateInput {
  preset?: AdminDelegationPreset | null;
  permissions?: AdminCapability[];
  scopeGroupId?: string | null;
  scopeRootFolderId?: string | null;
  note?: string | null;
}

export interface AdminSettingsBundleResponse {
  policies: TenantPolicyResponse | null;
  sharedLinks: { links: AdminSharedLinkRow[] } | null;
  ssoStatus: AdminSsoStatusResponse | null;
  tos: { tos: AdminTosPolicy } | null;
  siem: { siem: AdminSiemSettings } | null;
  sessions: AdminSessionListResponse | null;
  guestInvitations: { invitations: GuestInvitationSummary[] } | null;
}
