import type {
  AdminGroupListQuery,
  AdminGroupRow,
  AdminGroupSource,
  AdminGroupSourceFilter,
  AdminGroupSummary,
  AdminMemberRow,
  AdminScimTokenRow,
  AdminScimTokenStatus,
  UserRole,
} from '@/types/files';

/**
 * Pure P11-3 / TOM-69 helpers for the admin group and SCIM token console.
 *
 * Keeping RBAC, filter serialization, source badges and one-time token rules
 * here makes the UI behavior unit-testable without rendering React.
 */

export type AdminGroupViewerRole = UserRole | null | undefined;

export const ADMIN_GROUP_SOURCE_LABELS: Record<AdminGroupSourceFilter, string> = {
  all: 'すべて',
  manual: '手動',
  scim: 'SCIM 同期',
};

export const ADMIN_SCIM_TOKEN_STATUS_LABELS: Record<
  AdminScimTokenStatus,
  string
> = {
  active: '有効',
  revoked: '失効済み',
};

/** Both admin roles may inspect groups; only sys_admin may mutate them. */
export function canViewAdminGroups(role: AdminGroupViewerRole): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

export function canManageAdminGroups(role: AdminGroupViewerRole): boolean {
  return role === 'sys_admin';
}

/** Alias matching the member-console naming convention. */
export const canAdministrateGroups = canManageAdminGroups;

export function groupPermissionNotice(role: AdminGroupViewerRole): string {
  if (role === 'sec_admin') {
    return 'sec_admin はグループ一覧・詳細・所属メンバー・付与済み権限を閲覧できます。グループの作成・改名・削除・メンバー追加/削除・SCIM トークン管理は sys_admin 専用です。';
  }
  return 'sys_admin は手動グループの作成・改名・削除・メンバー追加/削除と SCIM トークンの発行・ローテーション・失効を実行できます。SCIM 同期グループは IdP が管理するため読み取り専用です。';
}

export const SCIM_MANAGED_GROUP_REASON =
  'このグループは IdP の SCIM プロビジョニングで同期されているため、管理者コンソールから名前・メンバーを変更したり削除したりできません。変更は IdP 側で行ってください。';

export function isScimManagedGroup(
  group: Pick<AdminGroupRow, 'source' | 'externalIdpId'>
): boolean {
  return group.source === 'scim' || group.externalIdpId != null;
}

export function canEditAdminGroup(
  role: AdminGroupViewerRole,
  group: Pick<AdminGroupRow, 'source' | 'externalIdpId'>
): boolean {
  return canManageAdminGroups(role) && !isScimManagedGroup(group);
}

export function groupReadOnlyReason(
  role: AdminGroupViewerRole,
  group: Pick<AdminGroupRow, 'source' | 'externalIdpId'>
): string | null {
  if (isScimManagedGroup(group)) return SCIM_MANAGED_GROUP_REASON;
  if (!canManageAdminGroups(role)) {
    return 'グループの変更は sys_admin 専用です。sec_admin は閲覧のみ可能です。';
  }
  return null;
}

export function groupSourceLabel(source: AdminGroupSourceFilter): string {
  return ADMIN_GROUP_SOURCE_LABELS[source];
}

export function groupSourceBadgeClass(source: AdminGroupSource): string {
  if (source === 'scim') {
    return 'bg-indigo-50 text-indigo-800 border-indigo-200';
  }
  return 'bg-slate-100 text-slate-700 border-slate-300';
}

export function groupSourceSummaryCards(
  summary: AdminGroupSummary | null | undefined
): Array<{ key: AdminGroupSourceFilter; label: string; count: number }> {
  return [
    { key: 'all', label: '全グループ', count: summary?.total ?? 0 },
    { key: 'manual', label: '手動グループ', count: summary?.manualCount ?? 0 },
    { key: 'scim', label: 'SCIM 同期', count: summary?.scimCount ?? 0 },
  ];
}

export function buildAdminGroupQuery(query: AdminGroupListQuery = {}): string {
  const params = new URLSearchParams();
  if (query.query?.trim()) params.set('query', query.query.trim());
  if (query.source && query.source !== 'all') {
    params.set('source', query.source);
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

export interface AdminGroupFilterValues {
  query?: string;
  source?: AdminGroupSourceFilter;
}

/** Client-side projection used for instant filtering and unit tests. */
export function filterAdminGroups(
  groups: readonly AdminGroupRow[],
  filters: AdminGroupFilterValues
): AdminGroupRow[] {
  const query = filters.query?.trim().toLowerCase() ?? '';
  const source = filters.source ?? 'all';
  return groups.filter((group) => {
    if (source !== 'all' && group.source !== source) return false;
    if (!query) return true;
    return [group.id, group.name, group.externalIdpId]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

export function sortAdminGroupRows(
  groups: readonly AdminGroupRow[]
): AdminGroupRow[] {
  return [...groups].sort((a, b) => collator.compare(a.name, b.name));
}

/** Active internal members that are not already in the group. */
export function selectableGroupMembers(
  members: readonly AdminMemberRow[],
  existingMemberIds: readonly string[]
): AdminMemberRow[] {
  const existing = new Set(existingMemberIds);
  return members
    .filter((member) => !existing.has(member.id))
    .filter((member) => member.status === 'active')
    .sort((a, b) => collator.compare(a.displayName, b.displayName));
}

/** Both admin roles may view SCIM tokens; only sys_admin may manage them. */
export function canViewScimTokens(role: AdminGroupViewerRole): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

export function canManageScimTokens(role: AdminGroupViewerRole): boolean {
  return role === 'sys_admin';
}

/** Alias matching the member-console naming convention. */
export const canAdministrateScimTokens = canManageScimTokens;

export function scimTokenPermissionNotice(role: AdminGroupViewerRole): string {
  if (role === 'sec_admin') {
    return 'sec_admin は SCIM トークンの一覧・最終利用日時・失効状態を閲覧できます。新規発行・ローテーション・失効は sys_admin 専用です。';
  }
  return '平文トークンは発行またはローテーション直後の 1 回だけ表示されます。D1 には SHA-256 ハッシュのみを保存し、監査ログにも平文を記録しません。';
}

export function scimTokenStatusLabel(status: AdminScimTokenStatus): string {
  return ADMIN_SCIM_TOKEN_STATUS_LABELS[status];
}

export function scimTokenStatusBadgeClass(status: AdminScimTokenStatus): string {
  return status === 'active'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-red-50 text-red-700 border-red-200';
}

export function canRotateScimToken(
  role: AdminGroupViewerRole,
  token: Pick<AdminScimTokenRow, 'status'>
): boolean {
  return canManageScimTokens(role) && token.status === 'active';
}

export function canRevokeScimToken(
  role: AdminGroupViewerRole,
  token: Pick<AdminScimTokenRow, 'status'>
): boolean {
  return canManageScimTokens(role) && token.status === 'active';
}

/** Absolute SCIM base URL for the current console origin. */
export function buildScimEndpointUrl(origin?: string | null): string {
  const base = origin?.trim().replace(/\/+$/, '') ?? '';
  return base ? `${base}/scim/v2` : '/scim/v2';
}

export function scimTokenUsageLabel(lastUsedAt: string | null): string {
  return lastUsedAt ? '利用あり' : '未使用';
}

/** Aliases kept for concise call sites and future tests. */
export const groupSummaryCards = groupSourceSummaryCards;
