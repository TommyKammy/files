import type {
  AdminGuestAggregations,
  AdminGuestDomainSummary,
  AdminGuestInviterSummary,
  AdminGuestLifecycleStatus,
  AdminGuestListQuery,
  AdminGuestRow,
  AdminGuestSortBy,
  AdminGuestSortDir,
  AdminGuestStatusFilter,
  UserRole,
} from '@/types/files';

/**
 * Pure P10-3 / TOM-61 helpers for the admin guest console. Keeping RBAC,
 * filter/sort serialization and aggregation shaping here makes the UI rules
 * unit-testable without rendering React.
 */

export const ADMIN_GUEST_STATUS_LABELS: Record<AdminGuestStatusFilter, string> = {
  all: 'すべて',
  active: '有効',
  suspended: '停止中',
  expired: '期限切れ',
  pending_invite: '招待中',
  offboarded: 'オフボーディング済み',
};

export const ADMIN_GUEST_SORT_LABELS: Record<AdminGuestSortBy, string> = {
  createdAt: '作成日時',
  lastLoginAt: '最終ログイン',
  expiresAt: '有効期限',
  email: 'メール',
  externalOrg: '外部組織',
};

export function guestStatusLabel(status: AdminGuestLifecycleStatus): string {
  return ADMIN_GUEST_STATUS_LABELS[status];
}

export function guestStatusBadgeClass(status: AdminGuestLifecycleStatus): string {
  switch (status) {
    case 'active':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'pending_invite':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'expired':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    case 'suspended':
      return 'bg-red-50 text-red-700 border-red-200';
    case 'offboarded':
      return 'bg-slate-100 text-slate-600 border-slate-300';
  }
}

export type AdminGuestViewerRole = UserRole | null | undefined;

/** Viewing, auditing, exporting and suspending are allowed for both admins. */
export function canViewAdminGuests(role: AdminGuestViewerRole): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

export function canSuspendGuest(role: AdminGuestViewerRole): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

/** Resume / resend invitation / offboarding / domain policy are sys_admin only. */
export function canManageGuestLifecycle(role: AdminGuestViewerRole): boolean {
  return role === 'sys_admin';
}

export function canManageGuestDomainPolicy(role: AdminGuestViewerRole): boolean {
  return role === 'sys_admin';
}

/** sec_admin sees disabled destructive controls with an explicit explanation. */
export function guestLifecyclePermissionNotice(
  role: AdminGuestViewerRole
): string {
  if (role === 'sec_admin') {
    return 'sec_admin は閲覧・監査・エクスポート・停止のみ実行できます。再開・招待再送・完全オフボーディング削除・ドメインポリシー更新は sys_admin 専用です。';
  }
  return 'sys_admin はゲストの停止・再開・招待再送・完全オフボーディング削除・ドメインポリシー更新をすべて実行できます。';
}

function isoOrEndOfDay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('T')) return trimmed;
  return `${trimmed}T23:59:59.999Z`;
}

export function buildAdminGuestQuery(query: AdminGuestListQuery): string {
  const params = new URLSearchParams();
  if (query.query?.trim()) params.set('query', query.query.trim());
  if (query.status && query.status !== 'all') params.set('status', query.status);
  if (query.domain?.trim()) params.set('domain', query.domain.trim().toLowerCase());
  if (query.invitedBy?.trim()) params.set('invitedBy', query.invitedBy.trim());
  if (query.expiresBefore?.trim()) {
    params.set('expiresBefore', isoOrEndOfDay(query.expiresBefore));
  }
  if (query.sortBy) params.set('sortBy', query.sortBy);
  if (query.sortDir) params.set('sortDir', query.sortDir);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.format && query.format !== 'json') params.set('format', query.format);
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

export function toggleAdminGuestSort(
  current: { sortBy: AdminGuestSortBy; sortDir: AdminGuestSortDir },
  next: AdminGuestSortBy
): { sortBy: AdminGuestSortBy; sortDir: AdminGuestSortDir } {
  if (current.sortBy !== next) return { sortBy: next, sortDir: 'asc' };
  return {
    sortBy: next,
    sortDir: current.sortDir === 'asc' ? 'desc' : 'asc',
  };
}

export function ariaSortForGuestColumn(
  sortBy: AdminGuestSortBy,
  sortDir: AdminGuestSortDir,
  column: AdminGuestSortBy
): 'ascending' | 'descending' | undefined {
  if (sortBy !== column) return undefined;
  return sortDir === 'asc' ? 'ascending' : 'descending';
}

export interface AdminGuestFilterValues {
  query?: string;
  status?: AdminGuestStatusFilter;
  domain?: string;
  invitedBy?: string;
  expiresBefore?: string;
}

export function filterAdminGuests(
  guests: readonly AdminGuestRow[],
  filters: AdminGuestFilterValues
): AdminGuestRow[] {
  const query = filters.query?.trim().toLowerCase() ?? '';
  const domain = filters.domain?.trim().toLowerCase() ?? '';
  const invitedBy = filters.invitedBy?.trim().toLowerCase() ?? '';
  const expiresBefore = filters.expiresBefore?.trim()
    ? isoOrEndOfDay(filters.expiresBefore)
    : '';
  return guests.filter((guest) => {
    if (filters.status && filters.status !== 'all' && guest.status !== filters.status) {
      return false;
    }
    if (domain && guest.domain?.toLowerCase() !== domain) return false;
    if (invitedBy) {
      const haystack = [
        guest.invitedBy,
        guest.invitedByEmail,
        guest.invitedByName,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(invitedBy)) return false;
    }
    if (expiresBefore) {
      if (!guest.expiresAt || guest.expiresAt > expiresBefore) return false;
    }
    if (query) {
      const haystack = [
        guest.email,
        guest.displayName,
        guest.externalOrg,
        guest.id,
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

export function sortAdminGuestRows(
  guests: readonly AdminGuestRow[],
  sortBy: AdminGuestSortBy,
  sortDir: AdminGuestSortDir
): AdminGuestRow[] {
  const factor = sortDir === 'asc' ? 1 : -1;
  const value = (guest: AdminGuestRow): string | null => {
    switch (sortBy) {
      case 'createdAt':
        return guest.createdAt;
      case 'lastLoginAt':
        return guest.lastLoginAt;
      case 'expiresAt':
        return guest.expiresAt;
      case 'email':
        return guest.email;
      case 'externalOrg':
        return guest.externalOrg;
    }
  };
  return [...guests].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return factor * collator.compare(av, bv);
  });
}

export function guestStatusSummaryCards(
  aggregations: AdminGuestAggregations | null | undefined
): Array<{ status: AdminGuestStatusFilter; label: string; count: number }> {
  const order: AdminGuestStatusFilter[] = [
    'active',
    'pending_invite',
    'expired',
    'suspended',
    'offboarded',
  ];
  return order.map((status) => ({
    status,
    label: ADMIN_GUEST_STATUS_LABELS[status],
    count: aggregations?.byStatus?.[status] ?? 0,
  }));
}

export interface AdminGuestDomainRowView extends AdminGuestDomainSummary {
  statusLabel: string;
  warning: string | null;
}

export function formatGuestDomainSummary(
  rows: readonly AdminGuestDomainSummary[]
): AdminGuestDomainRowView[] {
  return [...rows]
    .sort((a, b) => {
      if (a.allowedByPolicy !== b.allowedByPolicy) return a.allowedByPolicy ? 1 : -1;
      if (b.count !== a.count) return b.count - a.count;
      return a.domain.localeCompare(b.domain, 'ja');
    })
    .map((row) => ({
      ...row,
      statusLabel: row.allowedByPolicy ? '許可済み' : '許可外',
      warning: row.allowedByPolicy
        ? null
        : '許可リスト外です。suspend_existing の場合は既存ゲストも停止対象になります。',
    }));
}

export interface AdminGuestInviterRowView extends AdminGuestInviterSummary {
  displayName: string;
}

export function formatGuestInviterSummary(
  rows: readonly AdminGuestInviterSummary[]
): AdminGuestInviterRowView[] {
  return [...rows]
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.inviterName.localeCompare(b.inviterName, 'ja');
    })
    .map((row) => ({
      ...row,
      displayName: row.inviterEmail
        ? `${row.inviterName} (${row.inviterEmail})`
        : row.inviterName,
    }));
}

export function buildGuestDetailExportHref(
  guestId: string,
  kind: 'csv' | 'json'
): string {
  const suffix =
    kind === 'csv' ? '?format=csv&export=permissions' : '?download=1';
  return `/api/admin/guests/${encodeURIComponent(guestId)}${suffix}`;
}

export function createGuestIdempotencyKey(action: string, guestId: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `admin-guest-${action}-${guestId}-${random}`;
}
