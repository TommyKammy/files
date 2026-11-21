import type { ClassificationLabel, ResourceRole } from '../../types/api';
import type { TrashItemType } from '../trash-items';
import type { TrashPurgeItemResult } from '../trash-purge';
import type { TrashSort } from '../trash-query';
import type { TrashBulkItemResult } from '../trash-restore';

export interface AdminTrashFilters {
  query?: string;
  type: 'all' | 'file' | 'folder';
  ownerId?: string | null;
  deletedById?: string | null;
  deletedFrom?: string | null;
  deletedTo?: string | null;
  daysRemainingMax?: number | null;
  sort: TrashSort;
  limit: number;
  cursor?: string | null;
  /** TOM-73 Co-Admin root-folder scope; limits items to this subtree. */
  scopeRootFolderId?: string | null;
}

export interface AdminTrashPerson {
  id: string;
  name: string;
  email: string | null;
}

export interface AdminTrashPermissionSummary {
  /** Effective ACL rows (direct + inherited from ancestor folders). */
  total: number;
  direct: number;
  inherited: number;
  userCount: number;
  groupCount: number;
  roles: Record<ResourceRole, number>;
  /** Active (not revoked) shared links targeting the item itself. */
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

export interface AdminTrashListResult {
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

export interface AdminTrashItemRef {
  type: TrashItemType;
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string | null;
  deletedAt: string | null;
  sourceVersion: number | null;
}

export interface AdminTrashRestoreOptions {
  targetFolderId?: string | null;
  conflictPolicy: 'fail' | 'rename';
  restoreParentChain: boolean;
}

export interface AdminTrashRestoreResult {
  results: TrashBulkItemResult[];
  succeededCount: number;
  failedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

export interface AdminTrashEmptyResult {
  results: TrashPurgeItemResult[];
  deletedCount: number;
  failedCount: number;
  skippedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

export interface AdminTrashPurgeResult {
  results: TrashPurgeItemResult[];
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}
