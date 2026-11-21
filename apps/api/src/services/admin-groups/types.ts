import type { ResourceRole, UserRole } from '../../types/api';

/**
 * P11-3 / TOM-69 tenant-admin group management.
 *
 * Groups are either SCIM-provisioned (`external_idp_id IS NOT NULL`) or created
 * manually from the admin console. SCIM-managed groups are read-only here so a
 * local rename/delete/member edit cannot silently diverge from the IdP until
 * the next SCIM reconcile. Every manual mutation writes both an
 * `admin.group.*` audit row and a tenant sync change event.
 */

export type AdminGroupSource = 'scim' | 'manual';
export type AdminGroupSourceFilter = 'all' | AdminGroupSource;
export type AdminGroupMemberStatus = 'active' | 'suspended';

export interface AdminGroupFilters {
  query: string | null;
  source: AdminGroupSourceFilter;
  limit: number;
  offset: number;
  /** TOM-73 Co-Admin group scope; restricts the list to this group. */
  scopeGroupId?: string | null;
}

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

export interface AdminGroupListResult {
  groups: AdminGroupRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  summary: AdminGroupSummary;
  aggregations: AdminGroupSummary;
}

export interface AdminGroupMember {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  role: UserRole;
  status: AdminGroupMemberStatus;
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

export interface AdminGroupDetailResult {
  group: AdminGroupRow;
  members: AdminGroupMember[];
  permissions: AdminGroupPermission[];
  scimManaged: boolean;
}

export interface AdminGroupMutationResult {
  ok: true;
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

export class AdminGroupError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminGroupError';
  }
}
