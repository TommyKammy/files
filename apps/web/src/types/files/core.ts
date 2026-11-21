import type {
  AdminCapability,
  AdminScope,
  FolderStructureMode,
  TenantPolicyRow,
} from './admin';
import type { TosStatus } from './governance';

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
export type UserType = 'member' | 'guest';

/** `full` = a grant applies; `path` = traversal-only ancestor. */
export type AccessMode = 'full' | 'path';

/** Additive unions every grant; waterfall locks inherited principals on children. */
export type PermissionInheritanceMode = 'additive' | 'waterfall';

/** P9-5 invitation policy; strictness increases editors < owners < admins. */
export type InvitePolicy = 'owners' | 'editors' | 'admins';

export interface AuthUser {
  id: string;
  tenantId: string;
  email: string;
  displayName: string;
  role: UserRole;
  ipAddress: string;
  userType: UserType;
  externalOrg?: string | null;
  expiresAt?: string | null;
  /** Current D1 session id (never the token hash). */
  sessionId?: string | null;
  /** TOM-73 effective admin capabilities; omitted for non-admin members. */
  adminCapabilities?: AdminCapability[];
  /** Delegation scope; null for sys_admin/sec_admin/guests/no delegation. */
  adminScope?: AdminScope | null;
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
  tosStatus?: TosStatus | null;
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

export interface FileViewerInfo {
  file: FileItem;
  effectiveRole: ResourceRole;
  capabilities?: Capability[];
  canDownload: boolean;
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

export interface SyncInvalidationSignal {
  type: 'sync.invalidate' | 'sync.security_revoke';
  seq: number | null;
  scopeFolderIds: string[];
  eventKind: string;
  revoked?: boolean;
  metadata?: Record<string, unknown>;
  timestamp: string;
}
