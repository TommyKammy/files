import { buildAdminAuditPresetHref } from '@/lib/admin-console-nav';
import type {
  AdminMemberAggregations,
  AdminMemberBulkAction,
  AdminMemberBulkImportResponse,
  AdminMemberBulkRowResult,
  AdminMemberListQuery,
  AdminMemberRow,
  AdminMemberSortBy,
  AdminMemberSortDir,
  AdminMemberStatusFilter,
  UserRole,
} from '@/types/files';

/**
 * Pure P11-2 / TOM-64 helpers for the admin member console. Keeping RBAC,
 * filter/sort serialization, quota formatting and CSV samples here makes the
 * UI rules unit-testable without rendering React.
 */

export const ADMIN_MEMBER_STATUS_LABELS: Record<
  AdminMemberStatusFilter,
  string
> = {
  all: 'すべて',
  active: '有効',
  suspended: '停止中',
};

export const ADMIN_MEMBER_ROLE_LABELS: Record<UserRole, string> = {
  sys_admin: 'システム管理者',
  sec_admin: 'セキュリティ管理者',
  member: 'メンバー',
};

export const ADMIN_MEMBER_SORT_LABELS: Record<AdminMemberSortBy, string> = {
  email: 'メール',
  displayName: '表示名',
  department: '部署',
  role: 'ロール',
  status: '状態',
  createdAt: '作成日時',
  lastLoginAt: '最終ログイン',
  usedBytes: '使用量',
};

export const ADMIN_MEMBER_BULK_ACTION_LABELS: Record<
  AdminMemberBulkAction,
  string
> = {
  create: '作成',
  update: '更新',
  unchanged: '変更なし',
  error: 'エラー',
};

export function memberStatusLabel(status: AdminMemberStatusFilter): string {
  return ADMIN_MEMBER_STATUS_LABELS[status];
}

export function memberStatusBadgeClass(
  status: AdminMemberStatusFilter
): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'suspended':
      return 'bg-red-50 text-red-700 border-red-200';
    default:
      return 'bg-slate-100 text-slate-600 border-slate-300';
  }
}

export function memberRoleLabel(role: UserRole): string {
  return ADMIN_MEMBER_ROLE_LABELS[role];
}

export function memberRoleBadgeClass(role: UserRole): string {
  switch (role) {
    case 'sys_admin':
      return 'bg-indigo-50 text-indigo-800 border-indigo-200';
    case 'sec_admin':
      return 'bg-cyan-50 text-cyan-800 border-cyan-200';
    case 'member':
      return 'bg-slate-100 text-slate-700 border-slate-300';
  }
}

export type AdminMemberViewerRole = UserRole | null | undefined;

/** Member list, detail and CSV export are available to both admin roles. */
export function canViewAdminMembers(role: AdminMemberViewerRole): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

/** Suspend/resume of ordinary members is delegated to sec_admin. */
export function canManageMemberLifecycle(role: AdminMemberViewerRole): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

/** Registration, role/quota edits and bulk import are sys_admin only. */
export function canAdministrateMembers(role: AdminMemberViewerRole): boolean {
  return role === 'sys_admin';
}

export function memberPermissionNotice(role: AdminMemberViewerRole): string {
  if (role === 'sec_admin') {
    return 'sec_admin はメンバー一覧・詳細・CSV エクスポートと、一般メンバーの停止・再開を実行できます。新規追加・ロール/クォータ更新・一括登録・sys_admin / sec_admin への操作は sys_admin 専用です。';
  }
  return 'sys_admin はメンバーの新規追加・ロール/部署/個人クォータ更新・停止/再開・CSV 一括登録をすべて実行できます。最後の有効な sys_admin と自分自身の権限変更は拒否されます。';
}

export function memberCanBeSuspended(
  viewerRole: AdminMemberViewerRole,
  viewerId: string | null | undefined,
  member: Pick<AdminMemberRow, 'id' | 'role' | 'status'>
): boolean {
  if (!canManageMemberLifecycle(viewerRole)) return false;
  if (!viewerId || member.id === viewerId) return false;
  if (member.status === 'suspended') return false;
  if (viewerRole === 'sec_admin') return member.role === 'member';
  return true;
}

export function memberCanBeResumed(
  viewerRole: AdminMemberViewerRole,
  viewerId: string | null | undefined,
  member: Pick<AdminMemberRow, 'id' | 'role' | 'status'>
): boolean {
  if (!canManageMemberLifecycle(viewerRole)) return false;
  if (member.status !== 'suspended') return false;
  if (viewerRole === 'sec_admin') return member.role === 'member';
  return true;
}

export function buildAdminMemberQuery(query: AdminMemberListQuery): string {
  const params = new URLSearchParams();
  if (query.query?.trim()) params.set('query', query.query.trim());
  if (query.role && query.role !== 'all') params.set('role', query.role);
  if (query.status && query.status !== 'all') {
    params.set('status', query.status);
  }
  if (query.department?.trim()) {
    params.set('department', query.department.trim());
  }
  if (query.sortBy) params.set('sortBy', query.sortBy);
  if (query.sortDir) params.set('sortDir', query.sortDir);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.format && query.format !== 'json') {
    params.set('format', query.format);
  }
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

export function toggleAdminMemberSort(
  current: { sortBy: AdminMemberSortBy; sortDir: AdminMemberSortDir },
  next: AdminMemberSortBy
): { sortBy: AdminMemberSortBy; sortDir: AdminMemberSortDir } {
  if (current.sortBy !== next) return { sortBy: next, sortDir: 'asc' };
  return {
    sortBy: next,
    sortDir: current.sortDir === 'asc' ? 'desc' : 'asc',
  };
}

export function ariaSortForMemberColumn(
  sortBy: AdminMemberSortBy,
  sortDir: AdminMemberSortDir,
  column: AdminMemberSortBy
): 'ascending' | 'descending' | undefined {
  if (sortBy !== column) return undefined;
  return sortDir === 'asc' ? 'ascending' : 'descending';
}

export interface AdminMemberFilterValues {
  query?: string;
  role?: AdminMemberListQuery['role'];
  status?: AdminMemberStatusFilter;
  department?: string;
}

export function filterAdminMembers(
  members: readonly AdminMemberRow[],
  filters: AdminMemberFilterValues
): AdminMemberRow[] {
  const query = filters.query?.trim().toLowerCase() ?? '';
  const department = filters.department?.trim() ?? '';
  return members.filter((member) => {
    if (filters.role && filters.role !== 'all' && member.role !== filters.role) {
      return false;
    }
    if (
      filters.status &&
      filters.status !== 'all' &&
      member.status !== filters.status
    ) {
      return false;
    }
    if (department && member.department !== department) return false;
    if (query) {
      const haystack = [
        member.email,
        member.displayName,
        member.department,
        member.id,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function sortAdminMemberRows(
  members: readonly AdminMemberRow[],
  sortBy: AdminMemberSortBy,
  sortDir: AdminMemberSortDir
): AdminMemberRow[] {
  const factor = sortDir === 'asc' ? 1 : -1;
  const value = (member: AdminMemberRow): string | number | null => {
    switch (sortBy) {
      case 'email':
        return member.email;
      case 'displayName':
        return member.displayName;
      case 'department':
        return member.department;
      case 'role':
        return member.role;
      case 'status':
        return member.status;
      case 'createdAt':
        return member.createdAt;
      case 'lastLoginAt':
        return member.lastLoginAt;
      case 'usedBytes':
        return member.usedBytes;
    }
  };
  return [...members].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') {
      return factor * (av - bv);
    }
    return factor * collator.compare(String(av), String(bv));
  });
}

export function memberStatusSummaryCards(
  aggregations: AdminMemberAggregations | null | undefined
): Array<{ status: Exclude<AdminMemberStatusFilter, 'all'>; label: string; count: number }> {
  return (['active', 'suspended'] as const).map((status) => ({
    status,
    label: ADMIN_MEMBER_STATUS_LABELS[status],
    count: aggregations?.byStatus?.[status] ?? 0,
  }));
}

export function memberRoleSummaryCards(
  aggregations: AdminMemberAggregations | null | undefined
): Array<{ role: UserRole; label: string; count: number }> {
  return (['sys_admin', 'sec_admin', 'member'] as const).map((role) => ({
    role,
    label: ADMIN_MEMBER_ROLE_LABELS[role],
    count: aggregations?.byRole?.[role] ?? 0,
  }));
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function memberUsagePercent(
  member: Pick<AdminMemberRow, 'usedBytes' | 'storageQuotaBytes'>
): number | null {
  if (member.storageQuotaBytes === null) return null;
  if (member.storageQuotaBytes <= 0) return 0;
  return Math.round((member.usedBytes / member.storageQuotaBytes) * 100);
}

export function formatMemberUsage(
  member: Pick<AdminMemberRow, 'usedBytes' | 'storageQuotaBytes'>
): string {
  const used = formatBytes(member.usedBytes);
  if (member.storageQuotaBytes === null) {
    return `${used} / 上限なし`;
  }
  const percent = memberUsagePercent(member) ?? 0;
  return `${used} / ${formatBytes(member.storageQuotaBytes)} (${percent}%)`;
}

export type MemberQuotaState = 'unlimited' | 'ok' | 'warning' | 'over';

export function memberQuotaState(
  member: Pick<AdminMemberRow, 'usedBytes' | 'storageQuotaBytes'>
): MemberQuotaState {
  if (member.storageQuotaBytes === null) return 'unlimited';
  if (member.storageQuotaBytes <= 0) return 'ok';
  if (member.usedBytes >= member.storageQuotaBytes) return 'over';
  if (member.usedBytes * 100 >= member.storageQuotaBytes * 90) {
    return 'warning';
  }
  return 'ok';
}

export type ParsedMemberQuota =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

const MAX_MEMBER_QUOTA_BYTES = 1_125_899_906_842_624; // 1 PiB

export function parseMemberQuotaInput(raw: string): ParsedMemberQuota {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: '個人クォータは正の整数（バイト）で指定してください。',
    };
  }
  const value = Number(trimmed);
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_MEMBER_QUOTA_BYTES
  ) {
    return {
      ok: false,
      message: '個人クォータは 1 バイト以上 1 PiB 以下で指定してください。',
    };
  }
  return { ok: true, value };
}

export function formatOptionalBytes(value: number | null): string {
  return value === null ? '上限なし' : formatBytes(value);
}

export function departmentLabel(department: string | null): string {
  return department ?? '部署未設定';
}

export const ADMIN_MEMBER_CSV_SAMPLE = [
  'email,displayName,department,role,storageQuotaBytes',
  'tanaka@example.com,田中 太郎,営業部,member,10737418240',
  'suzuki@example.com,鈴木 花子,開発部,sec_admin,',
].join('\n');

export function createMemberIdempotencyKey(
  action: string,
  targetId = 'bulk'
): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `admin-member-${action}-${targetId}-${random}`;
}

export function buildMemberAuditHref(): string {
  return buildAdminAuditPresetHref('user');
}

export function formatBulkImportSummary(
  result: Pick<
    AdminMemberBulkImportResponse,
    | 'dryRun'
    | 'createdCount'
    | 'updatedCount'
    | 'unchangedCount'
    | 'errorCount'
  >
): string {
  const prefix = result.dryRun ? 'プレビュー' : '実行結果';
  return `${prefix}: 作成 ${result.createdCount} 件 / 更新 ${result.updatedCount} 件 / 変更なし ${result.unchangedCount} 件 / エラー ${result.errorCount} 件`;
}

export function bulkRowLabel(row: AdminMemberBulkRowResult): string {
  return `${ADMIN_MEMBER_BULK_ACTION_LABELS[row.action]}${row.code ? ` (${row.code})` : ''}`;
}
