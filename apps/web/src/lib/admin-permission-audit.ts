import type {
  AdminBulkSummary,
  AdminPermissionAuditEntry,
  AdminPermissionAuditQuery,
  AdminPermissionRootSummary,
  AdminPermissionSortBy,
  AdminPermissionSortDir,
  ResourceRole,
} from '@/types/files';

export const DEFAULT_PERMISSION_AUDIT_QUERY: Required<
  Pick<
    AdminPermissionAuditQuery,
    'targetType' | 'source' | 'health' | 'sortBy' | 'sortDir' | 'limit' | 'offset'
  >
> = {
  targetType: 'all',
  source: 'all',
  health: 'all',
  sortBy: 'createdAt',
  sortDir: 'desc',
  limit: 50,
  offset: 0,
};

export const PERMISSION_ROLE_LABELS: Record<ResourceRole, string> = {
  owner: 'オーナー',
  co_owner: '共同所有者',
  editor: '編集者',
  viewer_uploader: '閲覧 + アップロード',
  previewer_uploader: 'プレビュー + アップロード',
  viewer: '閲覧者',
  previewer: 'プレビュー',
  uploader: 'アップロード',
};

export const PERMISSION_ROLE_ORDER: Record<ResourceRole, number> = {
  owner: 0,
  co_owner: 1,
  editor: 2,
  viewer_uploader: 3,
  previewer_uploader: 4,
  viewer: 5,
  previewer: 6,
  uploader: 7,
};

export function formatPermissionRoleLabel(role: ResourceRole): string {
  return PERMISSION_ROLE_LABELS[role] ?? role;
}

export function formatPermissionSourceLabel(
  entry: Pick<
    AdminPermissionAuditEntry,
    'source' | 'inheritedFromName' | 'inheritedDepth'
  >
): string {
  if (entry.source === 'direct') return '直接付与';
  const name = entry.inheritedFromName ?? '祖先フォルダ';
  return `継承元: ${name}`;
}

export function formatPermissionTargetLabel(
  entry: Pick<AdminPermissionAuditEntry, 'targetType' | 'targetName'>
): string {
  return `${entry.targetType === 'folder' ? 'フォルダ' : 'ファイル'}: ${entry.targetName}`;
}

export function formatGranteeStatusLabel(
  status: 'active' | 'suspended' | 'deleted'
): string {
  return status === 'active'
    ? '有効'
    : status === 'suspended'
      ? '停止中'
      : '削除済み';
}

export function buildPermissionAuditQueryString(
  query: AdminPermissionAuditQuery
): string {
  const search = new URLSearchParams();
  if (query.targetType && query.targetType !== 'all') {
    search.set('targetType', query.targetType);
  }
  if (query.targetId) search.set('targetId', query.targetId);
  if (query.rootFolderId) search.set('rootFolderId', query.rootFolderId);
  if (query.includeInherited) search.set('includeInherited', '1');
  if (query.grantee?.trim()) search.set('grantee', query.grantee.trim());
  if (query.granteeType) search.set('granteeType', query.granteeType);
  const roles = Array.isArray(query.role)
    ? query.role
    : query.role
      ? query.role.split(',').map((role) => role.trim()).filter(Boolean)
      : [];
  if (roles.length > 0) search.set('role', roles.join(','));
  if (query.source && query.source !== 'all') search.set('source', query.source);
  if (query.inheritedFromId) {
    search.set('inheritedFromId', query.inheritedFromId);
  }
  if (query.grantedBy?.trim()) search.set('grantedBy', query.grantedBy.trim());
  if (query.from) search.set('from', query.from);
  if (query.to) search.set('to', query.to);
  if (query.granteeStatus) {
    search.set('granteeStatus', query.granteeStatus);
  }
  if (query.health && query.health !== 'all') search.set('health', query.health);
  if (query.sortBy) search.set('sortBy', query.sortBy);
  if (query.sortDir) search.set('sortDir', query.sortDir);
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  if (query.offset !== undefined) search.set('offset', String(query.offset));
  return search.toString();
}

export function buildPermissionAuditHref(query: AdminPermissionAuditQuery): string {
  const qs = buildPermissionAuditQueryString(query);
  return qs ? `/api/admin/permissions?${qs}` : '/api/admin/permissions';
}

export function buildPermissionExportHref(
  query: AdminPermissionAuditQuery,
  format: 'csv' | 'json'
): string {
  const search = new URLSearchParams(buildPermissionAuditQueryString(query));
  search.set('format', format);
  if (format === 'json') search.set('download', '1');
  return `/api/admin/permissions?${search.toString()}`;
}

export interface PermissionRootSummaryCounts {
  total: number;
  ownerMissing: number;
  suspendedOwner: number;
  deletedOwner: number;
  archived: number;
  totalGrants: number;
}

export function summarizePermissionRoots(
  roots: readonly AdminPermissionRootSummary[]
): PermissionRootSummaryCounts {
  return {
    total: roots.length,
    ownerMissing: roots.filter((root) => root.ownerMissing).length,
    suspendedOwner: roots.filter((root) => root.hasSuspendedOwner).length,
    deletedOwner: roots.filter((root) => root.hasDeletedOwner).length,
    archived: roots.filter((root) => root.archived).length,
    totalGrants: roots.reduce((sum, root) => sum + root.totalGrantCount, 0),
  };
}

export function permissionRootWarnings(
  root: Pick<
    AdminPermissionRootSummary,
    'ownerMissing' | 'hasSuspendedOwner' | 'hasDeletedOwner' | 'archived'
  >
): string[] {
  const warnings: string[] = [];
  if (root.ownerMissing) warnings.push('所有者不在');
  if (root.hasSuspendedOwner) warnings.push('停止済みオーナー');
  if (root.hasDeletedOwner) warnings.push('削除済みオーナー');
  if (root.archived) warnings.push('アーカイブ済み');
  return warnings;
}

export function sortPermissionEntries(
  entries: readonly AdminPermissionAuditEntry[],
  sortBy: AdminPermissionSortBy,
  sortDir: AdminPermissionSortDir
): AdminPermissionAuditEntry[] {
  const factor = sortDir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator('ja-JP', {
    numeric: true,
    sensitivity: 'base',
  });
  return [...entries].sort((a, b) => {
    let comparison = 0;
    switch (sortBy) {
      case 'role':
        comparison =
          PERMISSION_ROLE_ORDER[a.role] - PERMISSION_ROLE_ORDER[b.role];
        break;
      case 'targetName':
        comparison = collator.compare(a.targetName, b.targetName);
        break;
      case 'granteeName':
        comparison = collator.compare(a.granteeName, b.granteeName);
        break;
      case 'createdAt':
      default:
        comparison = a.createdAt.localeCompare(b.createdAt);
        break;
    }
    if (comparison === 0) {
      comparison = a.id.localeCompare(b.id);
    }
    return factor * comparison;
  });
}

export function togglePermissionSort(
  current: { sortBy: AdminPermissionSortBy; sortDir: AdminPermissionSortDir },
  clicked: AdminPermissionSortBy
): { sortBy: AdminPermissionSortBy; sortDir: AdminPermissionSortDir } {
  if (current.sortBy !== clicked) {
    return { sortBy: clicked, sortDir: 'asc' };
  }
  return {
    sortBy: clicked,
    sortDir: current.sortDir === 'asc' ? 'desc' : 'asc',
  };
}

export function isPermissionAuditFilterActive(
  query: AdminPermissionAuditQuery
): boolean {
  return Boolean(
    (query.targetType && query.targetType !== 'all') ||
      query.targetId ||
      query.rootFolderId ||
      query.includeInherited ||
      query.grantee?.trim() ||
      query.granteeType ||
      (Array.isArray(query.role)
        ? query.role.length > 0
        : query.role?.trim()) ||
      (query.source && query.source !== 'all') ||
      query.inheritedFromId ||
      query.grantedBy?.trim() ||
      query.from ||
      query.to ||
      query.granteeStatus ||
      (query.health && query.health !== 'all')
  );
}

export function formatAdminBulkSummary(summary: AdminBulkSummary): string {
  return `対象 ${summary.requested} 件 / 成功 ${summary.succeeded} 件 / スキップ ${summary.skipped} 件 / 失敗 ${summary.failed} 件`;
}

export function createBulkIdempotencyKey(operation: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${operation}:${crypto.randomUUID()}`;
  }
  return `${operation}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}
