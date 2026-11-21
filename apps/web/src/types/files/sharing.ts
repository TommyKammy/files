import type {
  AccessMode,
  Capability,
  ClassificationLabel,
  FileItem,
  InvitePolicy,
  PermissionInheritanceMode,
  ResourceRole,
} from './core';
import type { TenantBranding } from './governance';

export interface InvitePolicyInfo {
  tenantPolicy: InvitePolicy;
  folderOwnPolicy: InvitePolicy | null;
  effectivePolicy: InvitePolicy;
  inheritedFloor: InvitePolicy;
  sourceFolderId: string | null;
  sourceFolderName: string | null;
  canEditFolderPolicy?: boolean;
}

export interface WaterfallInheritanceConflict {
  permissionId: string;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  granteeType: 'user' | 'group';
  granteeId: string;
  granteeName: string | null;
  directRole: ResourceRole;
  ancestorFolderId: string;
  ancestorFolderName: string;
  ancestorRole: ResourceRole;
}

export type ShareAccessScope =
  | 'public'
  | 'company_only'
  | 'collaborators_only';

export type SharePermissionLevel = 'view' | 'download' | 'edit';

/** Directly granted folder/file returned by `GET /api/shared-items`. */
export interface SharedItemEntry {
  itemType: 'folder' | 'file';
  id: string;
  name: string;
  classification: ClassificationLabel;
  folderId: string | null;
  parentId: string | null;
  updatedAt: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  effectiveRole: ResourceRole | null;
  capabilities: Capability[];
  directRoles: ResourceRole[];
  breadcrumbs: Array<{ id: string; name: string }>;
  pathLabel: string;
  createdBy: string;
  grantedAt: string;
}

export interface EffectiveBreakdownGrant {
  granteeType: 'user' | 'group';
  granteeId: string;
  role: ResourceRole;
  inherited: boolean;
  sourceName: string | null;
  targetId: string;
}

export interface PermissionEntry {
  id: string;
  targetType: 'folder' | 'file';
  targetId: string;
  granteeType: 'user' | 'group';
  granteeId: string;
  granteeName: string | null;
  granteeEmail: string | null;
  role: ResourceRole;
  inherited: boolean;
  sourceName: string | null;
  grantedBy: string;
  createdAt: string;
  /** Non-linear composition when one grantee holds several rows. */
  synthesizedRole?: ResourceRole | null;
  synthesizedCapabilities?: Capability[];
  /** Waterfall mode: inherited or legacy child override cannot be changed here. */
  waterfallLocked?: boolean;
  ancestorFolderId?: string | null;
  ancestorFolderName?: string | null;
  ancestorRole?: ResourceRole | null;
  granteeUserType?: 'member' | 'guest';
  granteeExternalOrg?: string | null;
  granteeExpiresAt?: string | null;
  granteeLastLoginAt?: string | null;
  granteeInvitedBy?: string | null;
  granteeInvitedByName?: string | null;
  granteeStatus?: GuestInvitationStatus | null;
}

export interface PermissionsListResponse {
  targetType: 'folder' | 'file';
  targetId: string;
  permissionInheritanceMode?: PermissionInheritanceMode;
  accessMode?: AccessMode | null;
  effectiveRole: ResourceRole | null;
  capabilities: Capability[];
  effectiveCapabilities?: Capability[];
  grantedRoles: ResourceRole[];
  advancedRolesEnabled: boolean;
  canManage?: boolean;
  canInvite?: boolean;
  invitePolicy?: InvitePolicyInfo;
  grantableRoles?: ResourceRole[];
  effectiveBreakdown: EffectiveBreakdownGrant[];
  permissions: PermissionEntry[];
  guestInvitations?: GuestInvitationSummary[];
  guestPolicy?: GuestPolicyProjection;
}

export interface PrincipalCandidate {
  type: 'user' | 'group';
  id: string;
  name: string;
  email: string | null;
  department?: string | null;
  userType?: 'member' | 'guest';
  externalOrg?: string | null;
  expiresAt?: string | null;
  lastLoginAt?: string | null;
  invitedBy?: string | null;
  invitationStatus?: GuestInvitationStatus | null;
}

export type PrincipalSearchKind = 'all' | 'member' | 'guest';

export interface SharedLinkSummary {
  id: string;
  targetType: 'file' | 'folder';
  targetId: string;
  accessScope: ShareAccessScope;
  permissionLevel: SharePermissionLevel;
  canDownload: boolean;
  requireWatermark: boolean;
  hasPassword: boolean;
  failedPasswordAttempts: number;
  isLocked: boolean;
  lockedUntil: string | null;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdBy: string;
  createdAt: string;
  shareUrl?: string | null;
}

export interface CreateSharedLinkPayload {
  targetType: 'file' | 'folder';
  targetId: string;
  accessScope: ShareAccessScope;
  permissionLevel?: SharePermissionLevel;
  canDownload?: boolean;
  requireWatermark?: boolean;
  password?: string;
  expiresAt?: string;
  expiresInDays?: number;
  maxDownloads?: number;
}

export interface UpdateSharedLinkPayload {
  permissionLevel?: SharePermissionLevel;
  accessScope?: ShareAccessScope;
  requireWatermark?: boolean;
  password?: string;
  expiresAt?: string;
  expiresInDays?: number;
  maxDownloads?: number | null;
}

export interface SharedLinkUpdateResponse {
  link: SharedLinkSummary | null;
  syncChanges: Record<string, { from: unknown; to: unknown }>;
}

export interface SharedLinkUploadInitResponse {
  fileId: string;
  versionId: string;
  versionNum: number;
  fileName: string;
  classification: ClassificationLabel;
  isNewVersion: boolean;
  permissionLevel: 'edit';
  uploadUrl: string;
  method: 'PUT';
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

export interface SharedLinkUploadCompleteResponse {
  ok: boolean;
  permissionLevel: 'edit';
  file: FileItem;
  version: { id: string; versionNum: number };
}

export interface PublicShareFileMeta {
  id: string;
  name: string;
  extension?: string | null;
  mimeType: string | null;
  sizeBytes: number;
  classification: ClassificationLabel;
}

export interface PublicShareSubfolderMeta {
  id: string;
  name: string;
  classification: ClassificationLabel;
}

export interface PublicShareMeta {
  targetType: 'file' | 'folder';
  accessScope: ShareAccessScope;
  permissionLevel: SharePermissionLevel;
  canDownload: boolean;
  canEdit: boolean;
  composedRole: ResourceRole | null;
  composedCapabilities: Capability[];
  requiresAuthForEdit: boolean;
  anonymousEditBlocked?: boolean;
  editDisabledByPolicy?: boolean;
  requireWatermark: boolean;
  requiresPassword: boolean;
  unlocked: boolean;
  isLocked: boolean;
  lockedUntil: string | null;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  file: PublicShareFileMeta | null;
  folder: {
    id: string;
    name: string;
    classification: ClassificationLabel;
  } | null;
  currentFolder?: {
    id: string;
    name: string;
    classification: ClassificationLabel;
  } | null;
  subfolders?: PublicShareSubfolderMeta[];
  breadcrumbs?: Array<{ id: string; name: string }>;
  folderFiles: PublicShareFileMeta[];
  branding?: TenantBranding;
}

export interface PublicShareUrlResponse {
  url: string;
  expiresAt: string;
  expiresInSeconds: number;
  disposition: 'inline' | 'attachment';
  safeRenderMode: 'source_text' | 'standard';
  requireWatermark: boolean;
  watermarkText: string | null;
  viewerIdentifier: string;
  downloadCount: number;
  maxDownloads: number | null;
  file: PublicShareFileMeta;
}

export interface FileRequestSummary {
  id: string;
  folderId: string;
  title: string;
  description: string | null;
  requireSubmitterEmail: boolean;
  maxFileSizeBytes: number;
  allowedExtensions: string[] | null;
  submissionCount: number;
  expiresAt: string | null;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  requestUrl?: string | null;
}

export interface PublicFileRequestMeta {
  title: string;
  description: string | null;
  requireSubmitterEmail: boolean;
  maxFileSizeBytes: number;
  allowedExtensions: string[] | null;
  expiresAt: string | null;
  turnstileEnabled: boolean;
  turnstileSiteKey?: string | null;
  branding?: TenantBranding;
}

export type GuestInvitationStatus =
  | 'pending'
  | 'accepted'
  | 'revoked'
  | 'expired';

export interface GuestInvitationSummary {
  id: string;
  userId: string | null;
  email: string;
  displayName: string;
  externalOrg: string | null;
  invitedBy: string;
  invitedByName?: string | null;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string | null;
  role: ResourceRole;
  status: GuestInvitationStatus;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  resendCount: number;
  lastSentAt: string | null;
  createdAt: string;
  updatedAt: string;
  mailPreview?: GuestMailPreview | null;
}

export interface GuestMailPreview {
  subject: string;
  bodyPreview: string;
}

export interface GuestPolicyProjection {
  allowExternalCollaborators: boolean;
  externalDomainAllowlist: string[];
  allowGuestElevatedRoles: boolean;
  guestGrantableRoles: ResourceRole[];
  guestInvitationExpiryDays: number;
}

export interface GuestEffectivePermission {
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string | null;
  role: ResourceRole;
  inherited: boolean;
  inheritedFromName: string | null;
  synthesizedRole: ResourceRole | null;
  capabilities: Capability[];
}

export interface GuestSharedItemSummary {
  itemType: 'folder' | 'file';
  id: string;
  name: string;
  classification: ClassificationLabel;
  pathLabel: string;
  effectiveRole: ResourceRole | null;
  synthesizedRole: ResourceRole | null;
  capabilities: Capability[];
  folderId: string | null;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  updatedAt: string | null;
}

export interface GuestSummaryResponse {
  guest: {
    id: string;
    email: string;
    displayName: string;
    userType: 'guest';
    externalOrg: string | null;
    status: 'active' | 'suspended';
    expiresAt: string | null;
    lastLoginAt: string | null;
    invitedBy: string | null;
    invitedByName: string | null;
  };
  invitations: GuestInvitationSummary[];
  effectivePermissions: GuestEffectivePermission[];
  sharedItems: GuestSharedItemSummary[];
  guestPolicy: GuestPolicyProjection;
  accessSummary: {
    folderCount: number;
    fileCount: number;
    itemCount: number;
    invitationCount: number;
  };
}

export interface GuestInvitationListResponse {
  invitations: GuestInvitationSummary[];
}

export interface CreateGuestInvitationPayload {
  email: string;
  displayName?: string;
  externalOrg?: string | null;
  targetType: 'folder' | 'file';
  targetId: string;
  role: ResourceRole;
}

export interface GuestInviteMeta {
  id: string;
  status: GuestInvitationStatus;
  valid: boolean;
  expired: boolean;
  revoked: boolean;
  used: boolean;
  tenantName: string;
  emailMasked: string;
  displayName: string;
  externalOrg: string | null;
  targetType: 'folder' | 'file';
  targetName: string | null;
  role: ResourceRole;
  expiresAt: string;
  invitedByName: string | null;
  acceptedAt: string | null;
  canAccept: boolean;
  reason: string | null;
  branding?: TenantBranding;
}

export interface GuestAcceptResponse {
  ok: boolean;
  email: string;
  emailMasked: string;
  targetName: string | null;
  otpExpiresAt: string;
}

export interface GuestOtpRequestResponse {
  ok: boolean;
  email: string;
  emailMasked: string;
  otpExpiresAt: string;
}

export interface GuestOtpVerifyResponse {
  ok: boolean;
  user: {
    id: string;
    tenantId: string;
    email: string;
    displayName: string;
    role: 'sys_admin' | 'sec_admin' | 'member';
    userType: 'member' | 'guest';
    externalOrg: string | null;
    expiresAt: string | null;
  };
}

export interface WopiSessionResponse {
  sessionId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  classification: 'unset' | 'confidential' | 'internal' | 'public';
  role: ResourceRole;
  capabilities?: Capability[];
  canWrite: boolean;
  readOnly: boolean;
  readOnlyReason: 'desktop_lock' | 'dlp' | 'permission' | null;
  lockMode: 'wopi_collab';
  accessToken: string;
  accessTokenExpiresAt: string;
  wopiFileUrl: string;
  wopiSrc: string;
  wopiActionUrl: string | null;
  collaboraOrigin: string | null;
}
