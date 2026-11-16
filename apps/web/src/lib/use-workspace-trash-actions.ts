'use client';

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  FileItem,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export function useWorkspaceTrashActions({
  syncStore,
  isTrashView,
  selectedRows,
  focusedRow,
  canEditRow,
  folderId,
  effectiveRole,
  setError,
  setSelectedKeys,
  removeTrashFolder,
  removeTrashFile,
}: {
  syncStore: WorkspaceSyncStore;
  isTrashView: boolean;
  selectedRows: WorkspaceTableRow[];
  focusedRow: WorkspaceTableRow | null;
  canEditRow: (row: WorkspaceTableRow) => boolean;
  folderId: string | null;
  effectiveRole: ResourceRole;
  setError: (message: string | null) => void;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  removeTrashFolder: (folderId: string) => void;
  removeTrashFile: (fileId: string) => void;
}) {
  const trashSelectedOrFocused = useCallback(() => {
    if (isTrashView) return;
    const targets =
      selectedRows.length > 0
        ? selectedRows
        : focusedRow
          ? [focusedRow]
          : [];
    if (targets.length === 0) return;

    setError(null);
    let moved = 0;
    let firstError: string | null = null;
    for (const row of targets) {
      if (!canEditRow(row)) continue;
      if (row.kind === 'folder') {
        const res = syncStore.optimisticSoftDeleteFolder(row.folder);
        if (res.ok) moved += 1;
        else if (!firstError) {
          firstError = res.error ?? 'フォルダの削除に失敗しました';
        }
      } else {
        const res = syncStore.optimisticSoftDeleteFile(
          row.file,
          folderId,
          effectiveRole
        );
        if (res.ok) moved += 1;
        else if (!firstError) {
          firstError = res.error ?? 'ファイルの削除に失敗しました';
        }
      }
    }
    if (firstError) setError(firstError);
    if (moved === 0) {
      syncStore.pushToast({
        kind: 'error',
        message: '削除権限がないか、処理中のアイテムです',
      });
    }
    if (selectedRows.length > 0) {
      setSelectedKeys(new Set());
    }
  }, [
    isTrashView,
    selectedRows,
    focusedRow,
    canEditRow,
    syncStore,
    folderId,
    effectiveRole,
    setError,
    setSelectedKeys,
  ]);

  const handleTogglePin = useCallback(
    (folder: FolderSummary) => {
      setError(null);
      const res = syncStore.optimisticToggleFolderPin(folder);
      if (!res.ok) {
        setError(res.error ?? 'ピン留めの変更に失敗しました');
      }
    },
    [setError, syncStore]
  );

  const handleRestoreFolder = useCallback(
    (folder: FolderSummary) => {
      setError(null);
      removeTrashFolder(folder.id);
      syncStore.optimisticRestoreFolder(folder, 'rename');
    },
    [setError, removeTrashFolder, syncStore]
  );

  const handleRestoreFile = useCallback(
    (file: FileItem) => {
      setError(null);
      removeTrashFile(file.id);
      syncStore.optimisticRestoreFile(file);
    },
    [setError, removeTrashFile, syncStore]
  );

  return {
    trashSelectedOrFocused,
    handleTogglePin,
    handleRestoreFolder,
    handleRestoreFile,
  };
}
