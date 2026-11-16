import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminTrashFiltersState,
  AdminTrashItem,
  AdminTrashPermissionSummary,
  AdminTrashRetentionFilter,
  AdminTrashPerson,
  AuditLogEntry,
  TrashSort,
  TrashTypeFilter,
  UserRole,
} from '@/types/files';

export const ADMIN_TRASH_PAGE_SIZE = 50;

/**
 * The complete restore/purge audit vocabulary rendered by the admin timeline.
 * Keep this list in one place so the API query, CSV export and labels cannot
 * drift apart.
 */
export const ADMIN_TRASH_AUDIT_ACTIONS = [
  'file.restore',
  'folder.restore',
  'file.purge',
  'folder.purge',
  'admin.file.restore',
  'admin.folder.restore',
  'admin.trash.empty',
] as const;

export type AdminTrashAuditAction = (typeof ADMIN_TRASH_AUDIT_ACTIONS)[number];

export const ADMIN_TRASH_ACTION_LABELS: Record<AdminTrashAuditAction, string> = {
  'file.restore': 'ファイル復元',
  'folder.restore': 'フォルダ復元',
  'file.purge': 'ファイル完全削除',
  'folder.purge': 'フォルダ完全削除',
  'admin.file.restore': '管理者代理: ファイル復元',
  'admin.folder.restore': '管理者代理: フォルダ復元',
  'admin.trash.empty': 'テナントゴミ箱を空にする',
};

export const DEFAULT_ADMIN_TRASH_FILTERS: AdminTrashFiltersState = {
  query: '',
  type: 'all',
  ownerId: null,
  deletedById: null,
  retention: 'all',
  sort: 'deletedAt_desc',
};

export const ADMIN_TRASH_SORT_OPTIONS: Array<{
  value: TrashSort;
  label: string;
}> = [
  { value: 'deletedAt_desc', label: '削除日時: 新しい順' },
  { value: 'deletedAt_asc', label: '削除日時: 古い順' },
  { value: 'name_asc', label: '名前: 昇順' },
  { value: 'name_desc', label: '名前: 降順' },
];

export const ADMIN_TRASH_RETENTION_OPTIONS: Array<{
  value: AdminTrashRetentionFilter;
  label: string;
  maxDays: number | null;
}> = [
  { value: 'all', label: 'すべての保持期限', maxDays: null },
  { value: '7', label: '7日以内に自動削除', maxDays: 7 },
  { value: '1', label: '期限切れ間近（1日以内）', maxDays: 1 },
];

export function canRestoreAdminTrash(
  role: UserRole | null | undefined
): boolean {
  return role === 'sys_admin' || role === 'sec_admin';
}

/** Permanent deletion and emptying are sys_admin-only by API contract. */
export function canPurgeAdminTrash(role: UserRole | null | undefined): boolean {
  return role === 'sys_admin';
}

export function retentionFilterToMaxDays(
  retention: AdminTrashRetentionFilter
): number | null {
  return (
    ADMIN_TRASH_RETENTION_OPTIONS.find((option) => option.value === retention)
      ?.maxDays ?? null
  );
}

export interface AdminTrashRequestParams {
  limit: number;
  cursor: string | null;
  query: string;
  type: TrashTypeFilter;
  ownerId: string | null;
  deletedById: string | null;
  daysRemainingMax: number | null;
  sort: TrashSort;
}

/** Stable request parameters for GET /api/admin/trash (pure, unit-tested). */
export function buildAdminTrashRequestParams(
  filters: AdminTrashFiltersState,
  options: { cursor?: string | null; limit?: number } = {}
): AdminTrashRequestParams {
  return {
    limit: options.limit ?? ADMIN_TRASH_PAGE_SIZE,
    cursor: options.cursor ?? null,
    query: filters.query.trim(),
    type: filters.type,
    ownerId: filters.ownerId,
    deletedById: filters.deletedById,
    daysRemainingMax: retentionFilterToMaxDays(filters.retention),
    sort: filters.sort,
  };
}

export function buildAdminTrashQueryString(
  params: AdminTrashRequestParams
): string {
  const search = new URLSearchParams();
  search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.query) search.set('query', params.query);
  if (params.type !== 'all') search.set('type', params.type);
  if (params.ownerId) search.set('ownerId', params.ownerId);
  if (params.deletedById) search.set('deletedById', params.deletedById);
  if (params.daysRemainingMax !== null) {
    search.set('daysRemainingMax', String(params.daysRemainingMax));
  }
  search.set('sort', params.sort);
  return search.toString();
}

export function adminTrashItemKey(
  item: Pick<AdminTrashItem, 'type' | 'id'>
): string {
  return `${item.type}:${item.id}`;
}

/** Appends a cursor page while dropping items already present locally. */
export function mergeAdminTrashItems(
  current: readonly AdminTrashItem[],
  incoming: readonly AdminTrashItem[]
): AdminTrashItem[] {
  const seen = new Set(current.map(adminTrashItemKey));
  const merged = [...current];
  for (const item of incoming) {
    const key = adminTrashItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function removeAdminTrashItems(
  items: readonly AdminTrashItem[],
  removed: ReadonlyArray<{ type: AdminTrashItem['type']; id: string }>
): AdminTrashItem[] {
  const keys = new Set(removed.map(adminTrashItemKey));
  return items.filter((item) => !keys.has(adminTrashItemKey(item)));
}

export function isAdminTrashFilterActive(
  filters: AdminTrashFiltersState
): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.type !== 'all' ||
    filters.ownerId !== null ||
    filters.deletedById !== null ||
    filters.retention !== 'all'
  );
}

export function getAdminTrashEmptyState(
  filters: AdminTrashFiltersState,
  itemCount: number
): 'list' | 'empty' | 'filtered-empty' {
  if (itemCount > 0) return 'list';
  return isAdminTrashFilterActive(filters) ? 'filtered-empty' : 'empty';
}

export function formatAdminTrashPermissionSummary(
  summary: AdminTrashPermissionSummary | null | undefined
): string {
  if (!summary || summary.total === 0) return '権限なし';
  const roleParts = (
    [
      ['owner', 'Owner'],
      ['co_owner', 'Co-Owner'],
      ['editor', 'Editor'],
      ['viewer_uploader', 'Viewer + Uploader'],
      ['previewer_uploader', 'Previewer + Uploader'],
      ['viewer', 'Viewer'],
      ['previewer', 'Previewer'],
      ['uploader', 'Uploader'],
    ] as const
  )
    .filter(([role]) => (summary.roles?.[role] ?? 0) > 0)
    .map(([role, label]) => `${label} ${summary.roles[role]}`);
  const parts = [`${summary.total} 件`];
  if (summary.inherited > 0) parts.push(`継承 ${summary.inherited}`);
  if (roleParts.length > 0) parts.push(roleParts.join(' / '));
  if (summary.sharedLinkCount > 0) {
    parts.push(`共有リンク ${summary.sharedLinkCount}`);
  }
  return parts.join(' · ');
}

export function formatAdminTrashPerson(
  person: AdminTrashPerson | null | undefined
): string {
  if (!person) return '不明';
  return person.email ? `${person.name} (${person.email})` : person.name;
}

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string
): string | null {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : null;
}

function displayedRestoredTo(metadata: Record<string, unknown> | null): string {
  const value = metadata?.restoredTo;
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.path === 'string' && record.path.trim()) {
      return record.path;
    }
    if (typeof record.name === 'string' && record.name.trim()) {
      return record.name;
    }
    if (typeof record.id === 'string' && record.id.trim()) {
      return record.id;
    }
  }
  return '—';
}

function displayedVersion(metadata: Record<string, unknown> | null): string {
  const value = metadata?.sourceVersion;
  if (typeof value === 'number' && Number.isFinite(value)) return `v${value}`;
  if (typeof value === 'string' && value.trim()) return value;
  return '—';
}

function displayedOnBehalf(metadata: Record<string, unknown> | null): string {
  const name = metadataString(metadata, 'ownerName');
  const email = metadataString(metadata, 'ownerEmail');
  if (name && email) return `${name} (${email})`;
  if (name) return name;
  const ownerId =
    metadataString(metadata, 'onBehalfOfUserId') ??
    metadataString(metadata, 'ownerId');
  return ownerId ?? '—';
}

function displayedCounts(metadata: Record<string, unknown> | null): string {
  if (!metadata) return '—';
  const numbers = ['deletedCount', 'skippedCount', 'failedCount']
    .map((key) => metadata[key])
    .filter((value): value is number => typeof value === 'number');
  if (numbers.length === 0) return '—';
  return `削除 ${metadata.deletedCount ?? 0} / スキップ ${
    metadata.skippedCount ?? 0
  } / 失敗 ${metadata.failedCount ?? 0}`;
}

export interface AdminTrashAuditDisplay {
  action: string;
  actionLabel: string;
  targetName: string;
  sourceVersion: string;
  restoredTo: string;
  actorEmail: string;
  onBehalfOf: string;
  dateLabel: string;
  detail: string;
}

/**
 * Project an audit row into the compact timeline columns. Metadata is treated
 * as untrusted JSON: unknown or missing fields degrade to an em dash rather
 * than leaking ids or throwing during render.
 */
export function formatAdminTrashAuditEntry(
  log: AuditLogEntry
): AdminTrashAuditDisplay {
  const metadata = log.metadata;
  const label =
    (ADMIN_TRASH_ACTION_LABELS as Record<string, string>)[log.action] ??
    log.action;
  const emptyTenant = log.action === 'admin.trash.empty';
  return {
    action: log.action,
    actionLabel: label,
    targetName:
      metadataString(metadata, 'targetName') ??
      metadataString(metadata, 'restoredName') ??
      (emptyTenant ? 'テナント全体のゴミ箱' : log.targetId ?? '—'),
    sourceVersion: displayedVersion(metadata),
    restoredTo: emptyTenant ? '—' : displayedRestoredTo(metadata),
    actorEmail: log.actorEmail ?? '不明',
    onBehalfOf: emptyTenant ? '—' : displayedOnBehalf(metadata),
    dateLabel: formatAuditDateTime(log.createdAt),
    detail: emptyTenant ? displayedCounts(metadata) : '—',
  };
}

/** CSV export URL that mirrors the timeline's action filter. */
export function buildAdminTrashAuditCsvHref(): string {
  const params = new URLSearchParams({
    format: 'csv',
    limit: '200',
    actions: ADMIN_TRASH_AUDIT_ACTIONS.join(','),
  });
  return `/api/audit-logs?${params.toString()}`;
}
