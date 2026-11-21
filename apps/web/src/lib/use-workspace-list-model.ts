'use client';

import { useCallback, useMemo } from 'react';
import {
  nextTrashSortForField,
  trashItemToWorkspaceRow,
} from '@/lib/trash-view';
import { buildContextMenuCapabilities } from '@/lib/workspace-actions';
import {
  filterWorkspaceItems,
  type WorkspaceQuickFilter,
} from '@/lib/workspace-filter';
import {
  sortWorkspaceFoldersAndFiles,
  type WorkspaceSortDirection,
  type WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  Capability,
  FileItem,
  FolderStructureMode,
  FolderSummary,
  ResourceRole,
  TrashItem,
} from '@/types/files';

/**
 * Computes sorted/filtered workspace rows and list sort handler for the active
 * directory or Trash view.
 */
export function useWorkspaceListModel({
  isTrashView,
  folders,
  visibleFiles,
  sortBy,
  sortDir,
  quickFilter,
  trashItems,
  trashSort,
  applyTrashFilters,
  handleSortHeaderClick,
}: {
  isTrashView: boolean;
  folders: FolderSummary[];
  visibleFiles: FileItem[];
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
  quickFilter: WorkspaceQuickFilter;
  trashItems: TrashItem[];
  trashSort: Parameters<typeof nextTrashSortForField>[0];
  applyTrashFilters: (patch: {
    sort: NonNullable<ReturnType<typeof nextTrashSortForField>>;
  }) => Promise<void>;
  handleSortHeaderClick: (field: WorkspaceSortField) => void;
}) {
  const handleListSort = useCallback(
    (field: WorkspaceSortField) => {
      if (!isTrashView) {
        handleSortHeaderClick(field);
        return;
      }
      const nextSort = nextTrashSortForField(trashSort, field);
      if (nextSort) {
        void applyTrashFilters({ sort: nextSort });
      }
    },
    [isTrashView, handleSortHeaderClick, trashSort, applyTrashFilters]
  );

  const { folders: sortedFolders, files: sortedFiles } = useMemo(
    () =>
      isTrashView
        ? sortWorkspaceFoldersAndFiles({
            folders,
            files: visibleFiles,
            sortBy,
            sortDir,
            isTrashView: true,
          })
        : filterWorkspaceItems({
            folders,
            files: visibleFiles,
            filter: quickFilter,
          }),
    [folders, visibleFiles, sortBy, sortDir, isTrashView, quickFilter]
  );

  const rows = useMemo<WorkspaceTableRow[]>(
    () =>
      isTrashView
        ? trashItems.map(trashItemToWorkspaceRow)
        : [
            ...sortedFolders.map((folder) => ({
              kind: 'folder' as const,
              folder,
            })),
            ...sortedFiles.map((file) => ({ kind: 'file' as const, file })),
          ],
    [isTrashView, trashItems, sortedFolders, sortedFiles]
  );

  return {
    handleListSort,
    sortedFolders,
    sortedFiles,
    rows,
  };
}

/**
 * Computes context-menu / toolbar capabilities for the currently selected rows.
 */
export function useWorkspaceSelectionCapabilities({
  selectedRows,
  folderId,
  effectiveRole,
  directoryCapabilities,
  isPrivilegedAdmin,
  isSysAdmin,
  folderStructureMode,
  clipboardItems,
  resolveRowRole,
  collectRowCapabilities,
}: {
  selectedRows: WorkspaceTableRow[];
  folderId: string | null;
  effectiveRole: ResourceRole;
  directoryCapabilities: Capability[] | undefined;
  isPrivilegedAdmin: boolean;
  isSysAdmin: boolean;
  folderStructureMode: FolderStructureMode;
  clipboardItems: { type: 'folder' | 'file' }[] | undefined;
  resolveRowRole: (row: WorkspaceTableRow) => ResourceRole;
  collectRowCapabilities: (
    row: WorkspaceTableRow,
    folderCapabilities: Capability[] | undefined
  ) => Capability[] | undefined;
}) {
  return useMemo(
    () =>
      buildContextMenuCapabilities({
        targets: selectedRows,
        primaryRow: selectedRows[0] ?? null,
        currentFolderId: folderId,
        folderRole: effectiveRole,
        folderCapabilities: directoryCapabilities,
        isPrivilegedAdmin,
        isSysAdmin,
        folderStructureMode,
        hasClipboardItems: Boolean(clipboardItems && clipboardItems.length > 0),
        clipboardHasFiles: Boolean(
          clipboardItems?.some((item) => item.type === 'file')
        ),
        resolveRowRole,
        resolveRowCapabilities: (row) =>
          collectRowCapabilities(row, directoryCapabilities),
      }),
    [
      selectedRows,
      folderId,
      effectiveRole,
      directoryCapabilities,
      isPrivilegedAdmin,
      isSysAdmin,
      folderStructureMode,
      clipboardItems,
      resolveRowRole,
      collectRowCapabilities,
    ]
  );
}
