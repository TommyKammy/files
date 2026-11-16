export type ClassificationLabel =
  | 'confidential'
  | 'internal'
  | 'public'
  | 'unset';

export type ResourceRole =
  | 'viewer'
  | 'previewer'
  | 'editor'
  | 'co_owner'
  | 'owner';

export type UserRole = 'sys_admin' | 'sec_admin' | 'member';

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
  deleted_at?: string | null;
  deleted_by?: string | null;
  deleted_by_name?: string | null;
  deletedAt?: string;
  deletedBy?: string | null;
  deletedByName?: string | null;
  purgeAt?: string;
  daysRemaining?: number;
  effectiveRole?: ResourceRole;
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
}

export interface FolderChildrenResponse {
  folder: FolderSummary | null;
  effectiveRole: ResourceRole;
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

export interface BootstrapResponse {
  user: AuthUser;
  policy: TenantPolicyRow | null;
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
  updated_by: string | null;
  updated_at: string;
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
