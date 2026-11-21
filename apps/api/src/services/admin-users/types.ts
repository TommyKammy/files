import type { UserRole } from '../../types/api';

export type AdminUserRoleFilter = 'all' | UserRole;
export type AdminUserStatusFilter = 'all' | 'active' | 'suspended';
export type AdminUserSortBy =
  | 'email'
  | 'displayName'
  | 'department'
  | 'role'
  | 'status'
  | 'createdAt'
  | 'lastLoginAt'
  | 'usedBytes';
export type AdminUserSortDir = 'asc' | 'desc';
export type AdminUserAccountStatus = Exclude<AdminUserStatusFilter, 'all'>;

export interface AdminUserFilters {
  query: string | null;
  role: AdminUserRoleFilter;
  status: AdminUserStatusFilter;
  department: string | null;
  sortBy: AdminUserSortBy;
  sortDir: AdminUserSortDir;
  limit: number;
  offset: number;
  /** TOM-73 Co-Admin group scope; only members of this group are returned. */
  scopeGroupId?: string | null;
}

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  role: UserRole;
  status: AdminUserAccountStatus;
  storageQuotaBytes: number | null;
  usedBytes: number;
  fileCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminUserDepartmentSummary {
  department: string | null;
  count: number;
}

export interface AdminUserAggregations {
  total: number;
  byStatus: Record<AdminUserStatusFilter, number>;
  byRole: Record<UserRole, number>;
  /** Active `sys_admin` count used by the offboarding last-admin guard. */
  activeSysAdminCount?: number;
  departments: AdminUserDepartmentSummary[];
}

export interface AdminUserListResult {
  users: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  sort: { by: AdminUserSortBy; dir: AdminUserSortDir };
  summary: AdminUserAggregations;
  aggregations: AdminUserAggregations;
}

export interface AdminUserRootFolder {
  id: string;
  name: string;
  classification: string;
  createdAt: string;
}

export interface AdminUserGroup {
  id: string;
  name: string;
}

export interface AdminUserAuditLog {
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

export interface AdminUserDetailResult {
  user: AdminUserRow & { updatedAt: string };
  rootFolders: AdminUserRootFolder[];
  groups: AdminUserGroup[];
  activeSessionCount: number;
  recentAuditLogs: AdminUserAuditLog[];
}

export interface AdminUserMutationResult {
  ok: true;
  replayed?: boolean;
  user: AdminUserRow;
  sessionsRevoked?: number;
  syncSeq: number | null;
  notice: string;
}

export type AdminUserBulkAction = 'create' | 'update' | 'unchanged' | 'error';

export interface AdminUserBulkRowResult {
  rowNumber: number;
  email: string;
  action: AdminUserBulkAction;
  displayName: string | null;
  department: string | null;
  role: UserRole | null;
  storageQuotaBytes: number | null;
  userId?: string;
  code?: string;
  error?: string;
}

export interface AdminUserBulkImportResult {
  ok: true;
  dryRun: boolean;
  replayed: boolean;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  errorCount: number;
  results: AdminUserBulkRowResult[];
  syncSeq: number | null;
  notice: string;
}

export interface ParsedAdminUserCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export interface RawAdminUserRow {
  id: string;
  email: string;
  display_name: string;
  department: string | null;
  role: UserRole;
  status: AdminUserAccountStatus;
  storage_quota_bytes: number | null;
  used_bytes: number | null;
  file_count: number | null;
  last_login_at: string | null;
  created_at: string;
  updated_at?: string;
}

export interface TargetUserRow {
  id: string;
  email: string;
  display_name: string;
  department: string | null;
  role: UserRole;
  status: AdminUserAccountStatus;
  user_type: 'member' | 'guest';
  storage_quota_bytes: number | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}
