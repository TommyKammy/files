import type { ClassificationLabel, FileItem, FolderSummary } from '@/types/files';

export type WorkspaceSortField =
  | 'name'
  | 'classification'
  | 'size_bytes'
  | 'updated_at';
export type WorkspaceSortDirection = 'asc' | 'desc';
export type WorkspaceViewMode = 'list' | 'grid';

export interface WorkspaceViewPrefs {
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
  viewMode: WorkspaceViewMode;
}

export const DEFAULT_WORKSPACE_VIEW_PREFS: WorkspaceViewPrefs = {
  sortBy: 'name',
  sortDir: 'asc',
  viewMode: 'list',
};

const VIEW_PREFS_STORAGE_KEY = 'files.workspace.view-prefs.v1';

const CLASSIFICATION_RANK: Record<ClassificationLabel, number> = {
  confidential: 3,
  internal: 2,
  public: 1,
  unset: 0,
};

const JA_COLLATOR = new Intl.Collator('ja', {
  numeric: true,
  sensitivity: 'base',
});

export function nextSortDirection(
  currentBy: WorkspaceSortField,
  currentDir: WorkspaceSortDirection,
  clickedField: WorkspaceSortField
): { sortBy: WorkspaceSortField; sortDir: WorkspaceSortDirection } {
  if (currentBy === clickedField) {
    return {
      sortBy: clickedField,
      sortDir: currentDir === 'asc' ? 'desc' : 'asc',
    };
  }
  return {
    sortBy: clickedField,
    sortDir: clickedField === 'name' ? 'asc' : 'desc',
  };
}

/**
 * 0ms client-side sorter keeping folders above files and breaking ties deterministically.
 */
export function sortWorkspaceFoldersAndFiles(options: {
  folders: readonly FolderSummary[];
  files: readonly FileItem[];
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
  isTrashView?: boolean;
}): { folders: FolderSummary[]; files: FileItem[] } {
  const { folders, files, sortBy, sortDir, isTrashView = false } = options;
  const dirSign = sortDir === 'asc' ? 1 : -1;

  const sortedFolders = [...folders].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'name':
        cmp = JA_COLLATOR.compare(a.name, b.name) * dirSign;
        break;
      case 'classification':
        cmp =
          (CLASSIFICATION_RANK[a.classification] -
            CLASSIFICATION_RANK[b.classification]) *
          dirSign;
        break;
      case 'updated_at': {
        const tsA = isTrashView ? a.deleted_at ?? a.updated_at : a.updated_at;
        const tsB = isTrashView ? b.deleted_at ?? b.updated_at : b.updated_at;
        cmp = tsA.localeCompare(tsB) * dirSign;
        break;
      }
      case 'size_bytes':
        cmp = JA_COLLATOR.compare(a.name, b.name);
        break;
    }
    if (cmp !== 0) return cmp;
    return JA_COLLATOR.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });

  const sortedFiles = [...files].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'name':
        cmp = JA_COLLATOR.compare(a.name, b.name) * dirSign;
        break;
      case 'classification':
        cmp =
          (CLASSIFICATION_RANK[a.classification] -
            CLASSIFICATION_RANK[b.classification]) *
          dirSign;
        break;
      case 'size_bytes':
        cmp = (a.size_bytes - b.size_bytes) * dirSign;
        break;
      case 'updated_at': {
        const tsA = isTrashView ? a.deleted_at ?? a.updated_at : a.updated_at;
        const tsB = isTrashView ? b.deleted_at ?? b.updated_at : b.updated_at;
        cmp = tsA.localeCompare(tsB) * dirSign;
        break;
      }
    }
    if (cmp !== 0) return cmp;
    return JA_COLLATOR.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });

  return { folders: sortedFolders, files: sortedFiles };
}

export function chunkItemsIntoGridRows<T>(
  items: readonly T[],
  columns: number
): T[][] {
  const cols = Math.max(1, Math.floor(columns));
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += cols) {
    result.push(items.slice(i, i + cols));
  }
  return result;
}

export function getAriaSortValue(
  field: WorkspaceSortField,
  activeBy: WorkspaceSortField,
  activeDir: WorkspaceSortDirection
): 'ascending' | 'descending' | 'none' {
  if (field !== activeBy) return 'none';
  return activeDir === 'asc' ? 'ascending' : 'descending';
}

export function loadWorkspaceViewPrefs(
  tenantId: string,
  userId: string
): WorkspaceViewPrefs {
  if (typeof window === 'undefined') return DEFAULT_WORKSPACE_VIEW_PREFS;
  try {
    const raw = window.localStorage.getItem(
      `${VIEW_PREFS_STORAGE_KEY}:${tenantId}:${userId}`
    );
    if (!raw) return DEFAULT_WORKSPACE_VIEW_PREFS;
    const parsed = JSON.parse(raw) as Partial<WorkspaceViewPrefs>;
    const validBy =
      parsed.sortBy === 'name' ||
      parsed.sortBy === 'classification' ||
      parsed.sortBy === 'size_bytes' ||
      parsed.sortBy === 'updated_at'
        ? parsed.sortBy
        : 'name';
    const validDir = parsed.sortDir === 'desc' ? 'desc' : 'asc';
    const validView = parsed.viewMode === 'grid' ? 'grid' : 'list';
    return { sortBy: validBy, sortDir: validDir, viewMode: validView };
  } catch {
    return DEFAULT_WORKSPACE_VIEW_PREFS;
  }
}

export function saveWorkspaceViewPrefs(
  tenantId: string,
  userId: string,
  prefs: WorkspaceViewPrefs
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      `${VIEW_PREFS_STORAGE_KEY}:${tenantId}:${userId}`,
      JSON.stringify(prefs)
    );
  } catch {
    // ignore storage errors
  }
}
