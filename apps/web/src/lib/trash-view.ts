import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  TrashFilters,
  TrashItem,
  TrashItemType,
  TrashSort,
} from '@/types/files';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';

export const DEFAULT_TRASH_FILTERS: TrashFilters = {
  query: '',
  type: 'all',
  deletedBy: null,
  deletedFrom: null,
  deletedTo: null,
  sort: 'deletedAt_desc',
};

export const DEFAULT_TRASH_PAGE_SIZE = 50;

export type TrashRetentionLevel =
  | 'calm'
  | 'normal'
  | 'warning'
  | 'urgent'
  | 'unknown';

export interface TrashRetentionBadge {
  level: TrashRetentionLevel;
  label: string;
  description: string;
  className: string;
}

const RETENTION_CLASSES: Record<TrashRetentionLevel, string> = {
  calm: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  normal: 'border-slate-200 bg-slate-100 text-slate-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  urgent: 'border-red-200 bg-red-50 text-red-700',
  unknown: 'border-slate-200 bg-white text-slate-500',
};

/**
 * Pure retention badge rules shared by list rows, grid cards and unit tests.
 *
 * - >= 30 days: calm (green)
 * - 8..29 days: normal (neutral)
 * - 2..7 days: warning (amber)
 * - <= 1 day / already past: urgent (red), matching the cron cutoff where
 *   `deleted_at + retention_days <= now` is purge-eligible.
 */
export function getTrashRetentionBadge(
  daysRemaining: number | null | undefined
): TrashRetentionBadge {
  if (
    daysRemaining === null ||
    daysRemaining === undefined ||
    !Number.isFinite(daysRemaining)
  ) {
    return {
      level: 'unknown',
      label: '期限不明',
      description: '削除予定日が不明です',
      className: RETENTION_CLASSES.unknown,
    };
  }

  const days = Math.trunc(daysRemaining);
  if (days >= 30) {
    return {
      level: 'calm',
      label: `残り ${days}日`,
      description: `自動削除まで残り ${days} 日です`,
      className: RETENTION_CLASSES.calm,
    };
  }
  if (days >= 8) {
    return {
      level: 'normal',
      label: `残り ${days}日`,
      description: `自動削除まで残り ${days} 日です`,
      className: RETENTION_CLASSES.normal,
    };
  }
  if (days >= 2) {
    return {
      level: 'warning',
      label: `残り ${days}日（注意）`,
      description: `自動削除まで残り ${days} 日です。復元する場合はお早めに`,
      className: RETENTION_CLASSES.warning,
    };
  }
  if (days < 0) {
    return {
      level: 'urgent',
      label: '期限超過',
      description: '保持期限を過ぎています。次回の定期削除で消去されます',
      className: RETENTION_CLASSES.urgent,
    };
  }
  if (days === 0) {
    return {
      level: 'urgent',
      label: '本日削除予定',
      description: '本日、自動削除の対象になります',
      className: RETENTION_CLASSES.urgent,
    };
  }
  return {
    level: 'urgent',
    label: '期限切れ間近（残り1日）',
    description: '自動削除まで残り 1 日です',
    className: RETENTION_CLASSES.urgent,
  };
}

export function trashItemKey(item: Pick<TrashItem, 'type' | 'id'>): string {
  return `${item.type}:${item.id}`;
}

/** Appends a cursor page while dropping items already present locally. */
export function mergeTrashItems(
  current: readonly TrashItem[],
  incoming: readonly TrashItem[]
): TrashItem[] {
  const seen = new Set(current.map(trashItemKey));
  const merged = [...current];
  for (const item of incoming) {
    const key = trashItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function removeTrashItem(
  items: readonly TrashItem[],
  type: TrashItemType,
  id: string
): TrashItem[] {
  return items.filter((item) => item.type !== type || item.id !== id);
}

export function updateTrashItem(
  items: readonly TrashItem[],
  updated: TrashItem
): TrashItem[] {
  return items.map((item) =>
    item.type === updated.type && item.id === updated.id ? updated : item
  );
}

export function isTrashFilterActive(filters: TrashFilters): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.type !== 'all' ||
    filters.deletedBy !== null ||
    filters.deletedFrom !== null ||
    filters.deletedTo !== null
  );
}

export type TrashEmptyState = 'list' | 'empty' | 'filtered-empty';

/**
 * Distinguishes an actually empty Trash from a zero-result search/filter so
 * the UI can show the correct message and a clear-filters action.
 */
export function getTrashEmptyState(
  filters: TrashFilters,
  itemCount: number
): TrashEmptyState {
  if (itemCount > 0) return 'list';
  return isTrashFilterActive(filters) ? 'filtered-empty' : 'empty';
}

export interface TrashRequestParams {
  limit: number;
  cursor: string | null;
  query: string;
  type: TrashFilters['type'];
  deletedBy: string | null;
  deletedFrom: string | null;
  deletedTo: string | null;
  sort: TrashSort;
}

/** Stable API request parameters for the Trash list (pure, unit-tested). */
export function buildTrashRequestParams(
  filters: TrashFilters,
  options: { cursor?: string | null; limit?: number } = {}
): TrashRequestParams {
  return {
    limit: options.limit ?? DEFAULT_TRASH_PAGE_SIZE,
    cursor: options.cursor ?? null,
    query: filters.query.trim(),
    type: filters.type,
    deletedBy: filters.deletedBy,
    deletedFrom: filters.deletedFrom,
    deletedTo: filters.deletedTo,
    sort: filters.sort,
  };
}

/** URLSearchParams string for GET /api/folders/trash. */
export function buildTrashQueryString(params: TrashRequestParams): string {
  const search = new URLSearchParams();
  search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.query) search.set('query', params.query);
  if (params.type !== 'all') search.set('type', params.type);
  if (params.deletedBy) search.set('deletedBy', params.deletedBy);
  if (params.deletedFrom) search.set('deletedFrom', params.deletedFrom);
  if (params.deletedTo) search.set('deletedTo', params.deletedTo);
  search.set('sort', params.sort);
  return search.toString();
}

export function trashSortToTableSort(sort: TrashSort): {
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
} {
  switch (sort) {
    case 'name_asc':
      return { sortBy: 'name', sortDir: 'asc' };
    case 'name_desc':
      return { sortBy: 'name', sortDir: 'desc' };
    case 'deletedAt_asc':
      return { sortBy: 'updated_at', sortDir: 'asc' };
    case 'deletedAt_desc':
    default:
      return { sortBy: 'updated_at', sortDir: 'desc' };
  }
}

/**
 * Maps a click on a sortable table header to the Trash API sort. Non-sortable
 * Trash columns (deleter / size) return null so the header stays inert.
 */
export function nextTrashSortForField(
  current: TrashSort,
  field: WorkspaceSortField
): TrashSort | null {
  if (field === 'name') {
    return current === 'name_asc' ? 'name_desc' : 'name_asc';
  }
  if (field === 'updated_at') {
    return current === 'deletedAt_desc' ? 'deletedAt_asc' : 'deletedAt_desc';
  }
  return null;
}

export function trashItemToWorkspaceRow(item: TrashItem): WorkspaceTableRow {
  return item.type === 'folder'
    ? { kind: 'folder', folder: item }
    : { kind: 'file', file: item };
}
