export type WorkspaceOptionalColumnId =
  | 'classification'
  | 'extension'
  | 'size'
  | 'updated_at';

export type WorkspaceColumnVisibility = Record<
  WorkspaceOptionalColumnId,
  boolean
>;

export const WORKSPACE_TABLE_COLUMNS_STORAGE_KEY =
  'files.workspace.tableColumns.v1';

export const DEFAULT_WORKSPACE_COLUMN_VISIBILITY: WorkspaceColumnVisibility = {
  classification: true,
  extension: false,
  size: true,
  updated_at: true,
};

export const WORKSPACE_OPTIONAL_COLUMNS: ReadonlyArray<{
  id: WorkspaceOptionalColumnId;
  label: string;
}> = [
  { id: 'classification', label: '機密分類' },
  { id: 'extension', label: '種類' },
  { id: 'size', label: 'サイズ' },
  { id: 'updated_at', label: '更新日' },
];

export function loadWorkspaceColumnVisibility(): WorkspaceColumnVisibility {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_WORKSPACE_COLUMN_VISIBILITY };
  }
  try {
    const raw = window.localStorage.getItem(WORKSPACE_TABLE_COLUMNS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WORKSPACE_COLUMN_VISIBILITY };
    const parsed = JSON.parse(raw) as Partial<Record<string, unknown>>;
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_WORKSPACE_COLUMN_VISIBILITY };
    }
    return {
      classification:
        typeof parsed.classification === 'boolean'
          ? parsed.classification
          : DEFAULT_WORKSPACE_COLUMN_VISIBILITY.classification,
      extension:
        typeof parsed.extension === 'boolean'
          ? parsed.extension
          : DEFAULT_WORKSPACE_COLUMN_VISIBILITY.extension,
      size:
        typeof parsed.size === 'boolean'
          ? parsed.size
          : DEFAULT_WORKSPACE_COLUMN_VISIBILITY.size,
      updated_at:
        typeof parsed.updated_at === 'boolean'
          ? parsed.updated_at
          : DEFAULT_WORKSPACE_COLUMN_VISIBILITY.updated_at,
    };
  } catch {
    return { ...DEFAULT_WORKSPACE_COLUMN_VISIBILITY };
  }
}

export function saveWorkspaceColumnVisibility(
  visibility: WorkspaceColumnVisibility
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      WORKSPACE_TABLE_COLUMNS_STORAGE_KEY,
      JSON.stringify(visibility)
    );
  } catch {
    // Ignore storage quota or private-browsing errors.
  }
}

export function countVisibleWorkspaceColumns(
  visibility: WorkspaceColumnVisibility
): number {
  let count = 3; // checkbox + name + actions
  if (visibility.classification) count += 1;
  if (visibility.extension) count += 1;
  if (visibility.size) count += 1;
  if (visibility.updated_at) count += 1;
  return count;
}
