export type ClassificationLabel =
  | 'confidential'
  | 'internal'
  | 'public'
  | 'unset';

export type ResourceRole =
  | 'owner'
  | 'co_owner'
  | 'editor'
  | 'viewer_uploader'
  | 'previewer_uploader'
  | 'viewer'
  | 'previewer'
  | 'uploader';

/** Capability matrix shared with `apps/api/src/services/capabilities.ts`. */
export type Capability =
  | 'folder.list'
  | 'folder.traverse'
  | 'folder.create'
  | 'folder.rename'
  | 'folder.move'
  | 'folder.delete'
  | 'folder.delete_root'
  | 'folder.settings'
  | 'item.preview'
  | 'item.download'
  | 'item.upload_new'
  | 'item.upload_version'
  | 'item.edit_content'
  | 'item.rename'
  | 'item.move'
  | 'item.delete'
  | 'metadata.edit'
  | 'classification.edit'
  | 'permission.view'
  | 'permission.invite'
  | 'permission.manage'
  | 'share_link.create'
  | 'share_link.manage'
  | 'trash.restore'
  | 'trash.purge'
  | 'owner.transfer';

export type UserRole = 'sys_admin' | 'sec_admin' | 'member';

/** `full` = a grant applies; `path` = traversal-only ancestor. */
export type AccessMode = 'full' | 'path';

/** Additive unions every grant; waterfall locks inherited principals on children. */
export type PermissionInheritanceMode = 'additive' | 'waterfall';

/** P9-5 invitation policy; strictness increases editors < owners < admins. */
export type InvitePolicy = 'owners' | 'editors' | 'admins';

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

/** Open keeps root creation available; closed restricts root placement to sys_admin. */
export type FolderStructureMode = 'open' | 'closed';

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

export type ShareAccessScope =
  | 'public'
  | 'company_only'
  | 'collaborators_only';

export type AiClassificationMode =
  | 'disabled'
  | 'metadata_only'
  | 'content_excerpt';

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: UserRole;
  ipAddress: string;
}

export interface DevAuthAccount {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface DevAuthAccountsResponse {
  enabled: boolean;
  tenantId?: string;
  accounts: DevAuthAccount[];
}

export interface FolderSummary {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  is_pinned: number;
  version: number;
  updated_at: string;
  invite_policy?: InvitePolicy | null;
  invitePolicy?: InvitePolicy | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_by_name?: string | null;
  deletedAt?: string;
  deletedBy?: string | null;
  deletedByName?: string | null;
  purgeAt?: string;
  daysRemaining?: number;
  effectiveRole?: ResourceRole;
  capabilities?: Capability[];
  accessMode?: AccessMode | null;
  optimistic?: boolean;
}

export interface FileItem {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  current_version_num: number;
  meta_version?: number;
  classification: ClassificationLabel;
  ai_suggested_label: ClassificationLabel | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  updated_at: string;
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_by_name?: string | null;
  deletedAt?: string;
  deletedBy?: string | null;
  deletedByName?: string | null;
  purgeAt?: string;
  daysRemaining?: number;
  upload_state?: 'pending' | 'active' | 'failed';
  upload_progress?: number;
  optimistic?: boolean;
  effectiveRole?: ResourceRole;
  capabilities?: Capability[];
}

export interface FolderChildrenResponse {
  folder: FolderSummary | null;
  accessMode?: AccessMode | null;
  effectiveRole: ResourceRole | null;
  capabilities?: Capability[];
  folders: FolderSummary[];
  files: FileItem[];
  nextCursor: string | null;
  breadcrumbs?: BreadcrumbItem[];
}

export type TrashItemType = 'file' | 'folder';
export type TrashTypeFilter = 'all' | 'file' | 'folder';
export type TrashSort =
  | 'deletedAt_desc'
  | 'deletedAt_asc'
  | 'name_asc'
  | 'name_desc';

export interface TrashItemMeta {
  type: TrashItemType;
  deleted_at: string | null;
  deleted_by: string | null;
  deleted_by_name: string | null;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName: string | null;
  purgeAt: string;
  daysRemaining: number;
}

export interface TrashFolderItem
  extends Omit<
      FolderSummary,
      | 'deleted_at'
      | 'deleted_by'
      | 'deleted_by_name'
      | 'deletedAt'
      | 'deletedBy'
      | 'deletedByName'
      | 'purgeAt'
      | 'daysRemaining'
    >,
    TrashItemMeta {
  type: 'folder';
}

export interface TrashFileItem
  extends Omit<
      FileItem,
      | 'deleted_at'
      | 'deleted_by'
      | 'deleted_by_name'
      | 'deletedAt'
      | 'deletedBy'
      | 'deletedByName'
      | 'purgeAt'
      | 'daysRemaining'
    >,
    TrashItemMeta {
  type: 'file';
}

export type TrashItem = TrashFolderItem | TrashFileItem;

export interface TrashDeleter {
  id: string;
  name: string;
}

export interface TrashFilters {
  query: string;
  type: TrashTypeFilter;
  /** User id, the `unknown` sentinel for legacy NULL deleted_by rows, or null. */
  deletedBy: string | null;
  deletedFrom: string | null;
  deletedTo: string | null;
  sort: TrashSort;
}

export interface TrashListResponse {
  type: 'trash';
  limit: number;
  sort: TrashSort;
  folders: TrashFolderItem[];
  files: TrashFileItem[];
  items: TrashItem[];
  nextCursor: string | null;
  hasMore: boolean;
  trashRetentionDays: number;
  deleters: TrashDeleter[];
  hasUnknownDeleter: boolean;
}

export interface TrashBulkItemRef {
  type: TrashItemType;
  id: string;
}

export type TrashBulkItemStatus = 'succeeded' | 'failed' | 'skipped';

export interface TrashBulkItemResult {
  type: TrashItemType;
  id: string;
  ok: boolean;
  status: TrashBulkItemStatus;
  name?: string;
  code?: string;
  error?: string;
  purgedFileCount?: number;
  purgedFolderCount?: number;
  file?: FileItem;
  folder?: FolderSummary;
}

export interface TrashBulkResponse {
  ok: boolean;
  results: TrashBulkItemResult[];
  succeededCount: number;
  failedCount: number;
  skippedCount?: number;
}

export interface TrashEmptyResponse {
  ok: boolean;
  deletedCount: number;
  failedCount: number;
  skippedCount: number;
  results: TrashBulkItemResult[];
}

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

export interface RestoreBreadcrumb {
  id: string;
  name: string;
  classification: ClassificationLabel;
  depth: number;
  version: number;
}

export interface RestoreDestinationContext {
  id: string | null;
  name: string;
  path: string;
  breadcrumbs: RestoreBreadcrumb[];
  classification: ClassificationLabel;
  isDeleted: boolean;
  deletedAncestorCount: number;
  accessible: boolean;
}

export interface TrashRestoreConflict {
  hasConflict: boolean;
  suggestedName: string | null;
}

export interface TrashRestoreContextResponse {
  type: TrashItemType;
  item: {
    id: string;
    type: TrashItemType;
    name: string;
    classification: ClassificationLabel;
    folderId: string | null;
    parentId: string | null;
  };
  itemEffectiveRole: ResourceRole | null;
  originalLocation: RestoreDestinationContext;
  destination: RestoreDestinationContext;
  conflict: TrashRestoreConflict;
  classification: {
    floor: ClassificationLabel;
    willUpgrade: boolean;
    upgradeCount: number;
  };
  restoreParentChainAvailable: boolean;
  restoreParentChainDefault: boolean;
  destinationChecks: {
    circular: boolean;
    maxDepthExceeded: boolean;
    targetDeleted: boolean;
    canRestoreToRoot: boolean;
  };
}

export interface RestoreFileOptionsPayload {
  targetFolderId?: string | null;
  conflictPolicy?: 'fail' | 'rename';
  restoreParentChain?: boolean;
  expectedVersion?: number;
  newName?: string;
}

export interface RestoreFolderOptionsPayload {
  targetParentId?: string | null;
  conflictPolicy?: 'fail' | 'rename';
  restoreParentChain?: boolean;
}

export interface RestoreFileOptionsResponse {
  ok: boolean;
  file: FileItem;
  destination: RestoreDestinationContext;
  restoredAncestorIds: string[];
  affectedFolderIds: Array<string | null>;
}

export interface RestoreFolderOptionsResponse {
  ok: boolean;
  folder: FolderSummary;
  restoredAt: string;
  destination: RestoreDestinationContext;
  restoredAncestorIds: string[];
  affectedFolderIds: Array<string | null>;
}

export interface BootstrapResponse {
  user: AuthUser;
  policy: TenantPolicyRow | null;
  folderStructureMode?: FolderStructureMode;
  permissionInheritanceMode?: PermissionInheritanceMode;
  invitePolicy?: InvitePolicy;
  rootFolders: FolderSummary[];
  pinnedFolders: FolderSummary[];
  currentSeq: number;
  purgedBeforeSeq: number;
}

export type SyncEntityType =
  | 'folder'
  | 'file'
  | 'permission'
  | 'shared_link'
  | 'policy'
  | 'user';

export interface SyncDeltaItem {
  seq: number;
  entityType: SyncEntityType;
  entityId: string;
  folderId: string | null;
  targetUserId: string | null;
  action: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface SyncDeltaResponse {
  resetRequired: boolean;
  currentSeq: number;
  purgedBeforeSeq: number;
  nextSeq: number;
  hasMore: boolean;
  changes: SyncDeltaItem[];
}

export interface BreadcrumbItem {
  id: string;
  name: string;
  classification: ClassificationLabel;
  depth: number;
  accessMode?: AccessMode | null;
  effectiveRole?: ResourceRole | null;
  capabilities?: Capability[];
}

export interface SearchResultItem {
  id: string;
  folderId: string | null;
  folderName: string | null;
  name: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number;
  classification: ClassificationLabel;
  aiSuggestedLabel: ClassificationLabel | null;
  aiConfidence: number | null;
  updatedAt: string;
}

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
}

export interface FileViewerInfo {
  file: FileItem;
  effectiveRole: ResourceRole;
  capabilities?: Capability[];
  canDownload: boolean;
}

export interface PrincipalCandidate {
  type: 'user' | 'group';
  id: string;
  name: string;
  email: string | null;
}

export interface SharedLinkSummary {
  id: string;
  targetType: 'file' | 'folder';
  targetId: string;
  accessScope: ShareAccessScope;
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
}

export interface PublicShareFileMeta {
  id: string;
  name: string;
  extension?: string | null;
  mimeType: string | null;
  sizeBytes: number;
  classification: ClassificationLabel;
}

export interface PublicShareMeta {
  targetType: 'file' | 'folder';
  accessScope: ShareAccessScope;
  canDownload: boolean;
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
  folderFiles: PublicShareFileMeta[];
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
}

export interface PublicFileRequestMeta {
  title: string;
  description: string | null;
  requireSubmitterEmail: boolean;
  maxFileSizeBytes: number;
  allowedExtensions: string[] | null;
  expiresAt: string | null;
  turnstileEnabled: boolean;
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
}

export interface AiSuggestionItem {
  fileId: string;
  folderId: string | null;
  folderName: string | null;
  name: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number;
  currentClassification: ClassificationLabel;
  suggestedLabel: ClassificationLabel;
  confidence: number | null;
  reason: string | null;
  uploaderEmail: string | null;
  updatedAt: string;
}

export interface AdminSharedLinkRow {
  id: string;
  target_type: 'file' | 'folder';
  target_id: string;
  access_scope: ShareAccessScope;
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
  folder_structure_mode?: FolderStructureMode;
  folderStructureMode?: FolderStructureMode;
  permission_inheritance_mode?: PermissionInheritanceMode;
  permissionInheritanceMode?: PermissionInheritanceMode;
  invite_policy?: InvitePolicy;
  invitePolicy?: InvitePolicy;
  updated_by: string | null;
  updated_at: string;
}

export interface TenantPolicyResponse {
  policy: TenantPolicyRow | null;
  folderStructureMode?: FolderStructureMode;
  permissionInheritanceMode?: PermissionInheritanceMode;
  invitePolicy?: InvitePolicy;
  closedModeReport?: ClosedRootReport;
  inheritanceConflictReport?: WaterfallInheritanceConflict[];
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

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  actorIp: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  classificationSnapshot: ClassificationLabel | null;
  status: 'allowed' | 'blocked';
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface UploadTaskProgress {
  mode: 'single' | 'multipart';
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  completedParts?: number;
  totalParts?: number;
  fileId?: string;
  versionId?: string;
}

export type OutboxMutationKind =
  | 'folder.create'
  | 'folder.patch'
  | 'folder.move'
  | 'folder.soft_delete'
  | 'folder.restore'
  | 'file.patch'
  | 'file.move'
  | 'file.classification'
  | 'file.soft_delete'
  | 'file.restore'
  | 'workspace.batch_move'
  | 'workspace.copy';

export interface WorkspaceBatchItemRef {
  type: 'file' | 'folder';
  id: string;
  expectedVersion?: number;
}

export type WorkspaceConflictPolicy = 'fail' | 'rename';

export interface BatchMoveWorkspaceResponse {
  ok: boolean;
  movedFolders: FolderSummary[];
  movedFiles: FileItem[];
  skippedIds: string[];
  classificationJobQueued: boolean;
}

export interface CopyWorkspaceResponse {
  ok: boolean;
  queued: boolean;
  jobId?: string;
  jobIds?: string[];
  totalItems: number;
  copiedFolders: FolderSummary[];
  copiedFiles: FileItem[];
}

export interface WorkspaceJobStatus {
  id: string;
  jobType: 'copy_subtree';
  status: 'queued' | 'running' | 'completed' | 'failed';
  totalItems: number;
  processedItems: number;
  targetFolderId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceClipboardMode = 'copy' | 'cut';

export interface WorkspaceClipboardItem {
  type: 'file' | 'folder';
  id: string;
  name: string;
  parentId: string | null;
  classification: ClassificationLabel;
  version: number;
  sizeBytes?: number;
  mimeType?: string | null;
  effectiveRole?: ResourceRole;
}

export interface WorkspaceClipboardState {
  mode: WorkspaceClipboardMode;
  items: WorkspaceClipboardItem[];
  tenantId: string;
  userId: string;
  updatedAt: number;
}

export interface OutboxMutationRecord {
  id: string;
  entityType: 'folder' | 'file';
  entityId: string;
  involvedEntityKeys?: string[];
  kind: OutboxMutationKind;
  payload: Record<string, unknown>;
  expectedVersion?: number;
  createdAt: number;
  retryCount: number;
  rollback?: {
    folder?: FolderSummary | null;
    file?: FileItem | null;
    folders?: FolderSummary[];
    files?: FileItem[];
    tempFolderIds?: string[];
    tempFileIds?: string[];
    targetParentId?: string | null;
    existedBefore?: boolean;
    parentId?: string | null;
  };
}

export interface WorkspaceToastItem {
  id: string;
  kind: 'info' | 'undo' | 'warning' | 'error';
  message: string;
  undoLabel?: string;
  canUndo?: boolean;
}

export interface SyncWsTicketResponse {
  ticket: string;
  wsUrl: string;
  expiresInSeconds: number;
  expiresAt: string;
}

export type FileVersionUploadStatus = 'pending' | 'completed' | 'failed';

/**
 * Public historical-version shape returned by `GET /api/files/:id/versions`.
 * `r2_object_key` is intentionally never exposed by the API.
 */
export interface FileVersionItem {
  id: string;
  versionNum: number;
  sizeBytes: number;
  mimeType: string;
  uploadedBy: string;
  uploadedByName: string | null;
  createdAt: string;
  uploadStatus: FileVersionUploadStatus;
  isCurrent: boolean;
  /** Present on the freshly created version returned by a restore. */
  comment?: string | null;
  restoredFromVersionId?: string | null;
  restoredFromVersionNum?: number | null;
}

export interface FileVersionListResponse {
  versions: FileVersionItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export type FileLockMode = 'wopi_collab' | 'desktop_exclusive';

export interface FileLockInfo {
  fileId: string;
  tenantId: string;
  mode: FileLockMode;
  lockId: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string | null;
  sessionId: string | null;
  acquiredAt: number;
  expiresAt: number;
  updatedAt: number;
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

export interface SyncInvalidationSignal {
  type: 'sync.invalidate' | 'sync.security_revoke';
  seq: number | null;
  scopeFolderIds: string[];
  eventKind: string;
  revoked?: boolean;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
