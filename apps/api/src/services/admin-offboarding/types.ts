import { AdminBulkIdempotencyError } from '../admin-bulk-idempotency';
import type { AdminUserRow } from '../admin-users';

/**
 * P11-4 / TOM-70 internal member offboarding.
 *
 * An offboarding is a logical deactivation: users, files and audit history stay
 * in place, while ownership of directly-owned folders/link/request artefacts is
 * transferred to an active successor. Pre-existing `users.offboarded_at` /
 * `users.offboarded_by` columns from migration 0014 are reused, so no schema
 * change is required.
 *
 * The critical invariant is grant-before-revoke: every successor `owner` grant
 * is emitted before the leaver's direct permissions are deleted. A partial
 * failure therefore leaves duplicate ownership rather than an ownerless folder.
 */

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
  role: 'sys_admin' | 'sec_admin' | 'member';
}

export interface AdminOffboardingPreview {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: 'sys_admin' | 'sec_admin' | 'member';
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

export interface AdminOffboardingResult {
  ok: true;
  replayed: boolean;
  user: AdminUserRow;
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

export class AdminOffboardingError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminOffboardingError';
  }
}

export { AdminBulkIdempotencyError };
