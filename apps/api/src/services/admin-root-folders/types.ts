import type { ClassificationLabel } from '../../types/api';
import type { FolderStructureMode } from '../folder-structure';

export const ROOT_PERMISSION_CHUNK = 30;
export const FILE_LOCK_CHECK_CHUNK = 20;

export interface AdminRootFolderCandidate {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  deleted_at: string | null;
}

export interface AdminRootOwnerRef {
  grantee_type: 'user' | 'group';
  grantee_id: string;
}

export interface AdminRootCoOwnerStatementBundle {
  statements: D1PreparedStatement[];
  syncStatements: D1PreparedStatement[];
}

export type AdminRootOwnerStatus = 'active' | 'suspended';

export interface AdminRootOwnerGrant {
  granteeType: 'user' | 'group';
  granteeId: string;
  name: string;
  email: string | null;
  status: AdminRootOwnerStatus;
}

export interface AdminRootCoOwnerGrant extends AdminRootOwnerGrant {
  granteeType: 'user' | 'group';
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
  owners: AdminRootOwnerGrant[];
  coOwners: AdminRootCoOwnerGrant[];
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

export interface AdminRootFolderListResult {
  roots: AdminRootFolderRecord[];
  summary: AdminRootFolderSummary;
}

export interface AdminRootFolderMutationResult {
  root: AdminRootFolderRecord;
  syncSeq: number | null;
}

export class AdminRootFolderError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminRootFolderError';
  }
}

export interface RootFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  is_pinned: number;
  version: number;
  created_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
  created_by_name: string | null;
  created_by_email: string | null;
}

export interface PermissionGrantRow {
  target_id: string;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  role: 'owner' | 'co_owner';
  name: string | null;
  email: string | null;
  status: AdminRootOwnerStatus | null;
}

export interface RootMetricRow {
  root_id: string;
  item_count: number;
  total_bytes: number;
}
