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
  canDeleteRow,
  folderId,
  effectiveRole,
  setError,
  setSelectedKeys,
  onRequestRestoreFolder,
  onRequestRestoreFile,
}: {
  syncStore: WorkspaceSyncStore;
  isTrashView: boolean;
  selectedRows: WorkspaceTableRow[];
  focusedRow: WorkspaceTableRow | null;
  canDeleteRow: (row: WorkspaceTableRow) => boolean;
  folderId: string | null;
  effectiveRole: ResourceRole;
  setError: (message: string | null) => void;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  onRequestRestoreFolder: (folder: FolderSummary) => void;
  onRequestRestoreFile: (file: FileItem) => void;
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
      if (!canDeleteRow(row)) continue;
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
    canDeleteRow,
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

  // Single-item restore now opens the confirmation dialog instead of applying
  // an optimistic restore immediately. The dialog owns destination, parent
  // chain and conflict policy, so the actual API mutation lives there.
  const handleRestoreFolder = useCallback(
    (folder: FolderSummary) => {
      setError(null);
      onRequestRestoreFolder(folder);
    },
    [onRequestRestoreFolder, setError]
  );

  const handleRestoreFile = useCallback(
    (file: FileItem) => {
      setError(null);
      onRequestRestoreFile(file);
    },
    [onRequestRestoreFile, setError]
  );

  return {
    trashSelectedOrFocused,
    handleTogglePin,
    handleRestoreFolder,
    handleRestoreFile,
  };
}
