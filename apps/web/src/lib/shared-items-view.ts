import type {
  ClassificationLabel,
  ResourceRole,
  SharedItemEntry,
} from '@/types/files';

export type SharedItemsTypeFilter = 'all' | 'folder' | 'file';
export type SharedItemsClassificationFilter = 'all' | ClassificationLabel;
export type SharedItemsSortField =
  | 'name'
  | 'classification'
  | 'role'
  | 'updatedAt';
export type SharedItemsSortDirection = 'asc' | 'desc';

export interface SharedItemsFilterState {
  query: string;
  type: SharedItemsTypeFilter;
  classification: SharedItemsClassificationFilter;
}

export interface SharedItemsSortState {
  field: SharedItemsSortField;
  direction: SharedItemsSortDirection;
}

export const DEFAULT_SHARED_ITEMS_FILTER: SharedItemsFilterState = {
  query: '',
  type: 'all',
  classification: 'all',
};

export const DEFAULT_SHARED_ITEMS_SORT: SharedItemsSortState = {
  field: 'updatedAt',
  direction: 'desc',
};

const CLASSIFICATION_RANK: Record<ClassificationLabel, number> = {
  confidential: 3,
  internal: 2,
  public: 1,
  unset: 0,
};

const ROLE_RANK: Record<ResourceRole, number> = {
  owner: 8,
  co_owner: 7,
  editor: 6,
  viewer_uploader: 5,
  previewer_uploader: 4,
  viewer: 3,
  previewer: 2,
  uploader: 1,
};

export function hasActiveSharedItemsFilter(
  filter: SharedItemsFilterState
): boolean {
  return (
    filter.query.trim().length > 0 ||
    filter.type !== 'all' ||
    filter.classification !== 'all'
  );
}

export function filterSharedItems(
  items: readonly SharedItemEntry[],
  filter: SharedItemsFilterState
): SharedItemEntry[] {
  const normalizedQuery = filter.query.trim().toLowerCase();

  return items.filter((item) => {
    if (filter.type !== 'all' && item.itemType !== filter.type) {
      return false;
    }
    if (
      filter.classification !== 'all' &&
      item.classification !== filter.classification
    ) {
      return false;
    }
    if (normalizedQuery.length > 0) {
      const nameMatch = item.name.toLowerCase().includes(normalizedQuery);
      const pathMatch = item.pathLabel.toLowerCase().includes(normalizedQuery);
      if (!nameMatch && !pathMatch) {
        return false;
      }
    }
    return true;
  });
}

function compareByName(a: SharedItemEntry, b: SharedItemEntry): number {
  return a.name.localeCompare(b.name, 'ja', {
    numeric: true,
    sensitivity: 'base',
  });
}

export function sortSharedItems(
  items: readonly SharedItemEntry[],
  sort: SharedItemsSortState
): SharedItemEntry[] {
  const factor = sort.direction === 'asc' ? 1 : -1;

  return [...items].sort((a, b) => {
    let cmp = 0;
    if (sort.field === 'name') {
      cmp = compareByName(a, b);
    } else if (sort.field === 'classification') {
      cmp =
        CLASSIFICATION_RANK[a.classification] -
        CLASSIFICATION_RANK[b.classification];
      if (cmp === 0) cmp = compareByName(a, b);
    } else if (sort.field === 'role') {
      const rankA = a.effectiveRole ? ROLE_RANK[a.effectiveRole] ?? 0 : 0;
      const rankB = b.effectiveRole ? ROLE_RANK[b.effectiveRole] ?? 0 : 0;
      cmp = rankA - rankB;
      if (cmp === 0) cmp = compareByName(a, b);
    } else if (sort.field === 'updatedAt') {
      const timeA = Date.parse(a.updatedAt);
      const timeB = Date.parse(b.updatedAt);
      if (Number.isFinite(timeA) && Number.isFinite(timeB)) {
        cmp = timeA - timeB;
      } else {
        cmp = a.updatedAt.localeCompare(b.updatedAt);
      }
      if (cmp === 0) cmp = compareByName(a, b);
    }
    return cmp * factor;
  });
}

export function nextSharedItemsSort(
  current: SharedItemsSortState,
  field: SharedItemsSortField
): SharedItemsSortState {
  if (current.field === field) {
    return {
      field,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    };
  }
  return {
    field,
    direction: field === 'updatedAt' ? 'desc' : 'asc',
  };
}
