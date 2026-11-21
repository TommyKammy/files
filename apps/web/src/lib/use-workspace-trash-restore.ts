'use client';

import { useCallback, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TrashRestoreSuccessResult } from '@/components/WorkspaceTrashRestoreModal';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import { getTrashBulkCapabilities } from '@/lib/trash-bulk';
import { formatTrashRestoreSuccessMessage } from '@/lib/trash-restore-options';
import { useWorkspaceTrashBulkActions } from '@/lib/use-workspace-trash-bulk-actions';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  AuthUser,
  FileItem,
  FolderSummary,
  TrashItem,
} from '@/types/files';

export interface TrashControllerLike {
  items: TrashItem[];
  removeItem: (type: 'folder' | 'file', id: string) => void;
  retry: () => Promise<void>;
  clearFilters: () => Promise<void>;
}

/**
 * Manages Trash view bulk selection capabilities, conflict policy, and single-item
 * restore modal state/callbacks.
 */
export function useWorkspaceTrashRestore({
  isTrashView,
  selectedRows,
  trash,
  user,
  syncStore,
  setSelectedKeys,
  setSelectionAnchorKey,
  setError,
}: {
  isTrashView: boolean;
  selectedRows: WorkspaceTableRow[];
  trash: TrashControllerLike;
  user: AuthUser | null;
  syncStore: WorkspaceSyncStore;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorKey: Dispatch<SetStateAction<string | null>>;
  setError: (error: string | null) => void;
}) {
  const [trashConflictPolicy, setTrashConflictPolicy] = useState<
    'fail' | 'rename'
  >('rename');
  const [trashRestoreTarget, setTrashRestoreTarget] =
    useState<TrashItem | null>(null);

  const selectedTrashItems = useMemo<TrashItem[]>(
    () =>
      isTrashView
        ? selectedRows.map((row) =>
            row.kind === 'folder'
              ? (row.folder as TrashItem)
              : (row.file as TrashItem)
          )
        : [],
    [isTrashView, selectedRows]
  );

  const selectedTrashCapabilities = useMemo(
    () => getTrashBulkCapabilities(selectedTrashItems, user),
    [selectedTrashItems, user]
  );

  const currentTrashCapabilities = useMemo(
    () => getTrashBulkCapabilities(trash.items, user),
    [trash.items, user]
  );

  const trashBulk = useWorkspaceTrashBulkActions({
    syncStore,
    selectedItems: selectedTrashItems,
    allItems: trash.items,
    removeTrashItem: trash.removeItem,
    reloadTrash: trash.retry,
    resetTrashView: trash.clearFilters,
    setSelectedKeys,
  });

  const requestRestoreTrashFolder = useCallback(
    (folder: FolderSummary) => {
      const target = trash.items.find(
        (candidate) => candidate.type === 'folder' && candidate.id === folder.id
      );
      if (!target) {
        setError('復元対象の情報を取得できませんでした');
        return;
      }
      setTrashRestoreTarget(target);
    },
    [trash.items, setError]
  );

  const requestRestoreTrashFile = useCallback(
    (file: FileItem) => {
      const target = trash.items.find(
        (candidate) => candidate.type === 'file' && candidate.id === file.id
      );
      if (!target) {
        setError('復元対象の情報を取得できませんでした');
        return;
      }
      setTrashRestoreTarget(target);
    },
    [trash.items, setError]
  );

  const handleTrashRestoreSuccess = useCallback(
    (result: TrashRestoreSuccessResult) => {
      const target = trashRestoreTarget;
      if (target) {
        trash.removeItem(target.type, target.id);
      }
      for (const ancestorId of result.restoredAncestorIds) {
        trash.removeItem('folder', ancestorId);
      }

      if (result.file) {
        syncStore.upsertFileInCache(result.file);
      }
      if (result.folder) {
        syncStore.upsertFolderInCache(result.folder);
      }

      const refreshIds = new Set<string | null>(result.affectedFolderIds);
      refreshIds.add(result.destination.id);
      for (const id of refreshIds) {
        void syncStore
          .ensureDirectoryLoaded(id, { force: true })
          .catch(() => undefined);
      }

      syncStore.pushToast({
        kind: 'info',
        message: formatTrashRestoreSuccessMessage({
          itemName: target?.name ?? result.restoredName,
          destinationPath: result.destination.path,
          restoredName: result.restoredName,
          restoredAncestorCount: result.restoredAncestorIds.length,
        }),
      });
      setTrashRestoreTarget(null);
      setSelectedKeys(new Set());
      setSelectionAnchorKey(null);
    },
    [
      setSelectedKeys,
      setSelectionAnchorKey,
      syncStore,
      trash,
      trashRestoreTarget,
    ]
  );

  return {
    trashConflictPolicy,
    setTrashConflictPolicy,
    trashRestoreTarget,
    setTrashRestoreTarget,
    selectedTrashCapabilities,
    currentTrashCapabilities,
    trashBulk,
    requestRestoreTrashFolder,
    requestRestoreTrashFile,
    handleTrashRestoreSuccess,
  };
}
