'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import { useFileLockActions } from '@/lib/use-file-lock-actions';
import { useFileLocks } from '@/lib/use-file-locks';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type { FileItem, FileLockInfo, ResourceRole } from '@/types/files';

/**
 * Manages optimistic file lock state/toggling and single/bulk AI classification
 * approval actions.
 */
export function useWorkspaceLocksAndAi({
  syncStore,
  contextMenuFile,
  canClassifyCurrentFolder,
  isPrivilegedAdmin,
  effectiveRole,
  selectedRows,
  setSelectedKeys,
  setError,
}: {
  syncStore: WorkspaceSyncStore;
  contextMenuFile: FileItem | null;
  canClassifyCurrentFolder: boolean;
  isPrivilegedAdmin: boolean;
  effectiveRole: ResourceRole;
  selectedRows: WorkspaceTableRow[];
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setError: (error: string | null) => void;
}) {
  const fileLocks = useFileLocks(syncStore);
  const [localLockOverrides, setLocalLockOverrides] = useState<
    Record<string, FileLockInfo | null>
  >({});

  useEffect(() => {
    setLocalLockOverrides({});
  }, [fileLocks]);

  const handleLockChanged = useCallback(
    (fileId: string, lock: FileLockInfo | null) => {
      setLocalLockOverrides((prev) => ({ ...prev, [fileId]: lock }));
    },
    []
  );

  const getEffectiveFileLock = useCallback(
    (fileId: string): FileLockInfo | null => {
      if (Object.prototype.hasOwnProperty.call(localLockOverrides, fileId)) {
        return localLockOverrides[fileId] ?? null;
      }
      return fileLocks[fileId] ?? null;
    },
    [fileLocks, localLockOverrides]
  );

  const contextMenuFileLock = contextMenuFile
    ? getEffectiveFileLock(contextMenuFile.id)
    : null;

  const { toggleLock: toggleContextMenuFileLock } = useFileLockActions({
    fileId: contextMenuFile?.id ?? null,
    initialLock: contextMenuFileLock,
    syncStore,
    onLockChanged: handleLockChanged,
  });

  const handleApproveSingleAi = useCallback(
    (file: FileItem): { ok: boolean; error?: string } => {
      if (!canClassifyCurrentFolder && !isPrivilegedAdmin) {
        const message = 'AI分類提案を承認する権限がありません';
        setError(message);
        return { ok: false, error: message };
      }
      const res = syncStore.optimisticUpdateFileClassification(
        file,
        { acceptSuggestion: true },
        { effectiveRole, isPrivilegedAdmin }
      );
      if (!res.ok) {
        setError(res.error ?? 'AI分類を承認できませんでした');
      }
      return res;
    },
    [
      canClassifyCurrentFolder,
      isPrivilegedAdmin,
      syncStore,
      effectiveRole,
      setError,
    ]
  );

  const handleBulkApproveAi = useCallback(() => {
    const candidates = selectedRows
      .filter((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
      .map((r) => r.file)
      .filter((f) => f.ai_suggested_label != null);
    if (candidates.length === 0) return;
    if (!canClassifyCurrentFolder && !isPrivilegedAdmin) {
      setError('AI分類提案を承認する権限がありません');
      return;
    }

    let firstError: string | null = null;
    for (const file of candidates) {
      if (!file.ai_suggested_label) continue;
      const res = syncStore.optimisticUpdateFileClassification(
        file,
        { acceptSuggestion: true },
        { effectiveRole, isPrivilegedAdmin }
      );
      if (!res.ok && !firstError) {
        firstError = res.error ?? '一部のAI分類を承認できませんでした';
      }
    }
    if (firstError) setError(firstError);
    setSelectedKeys(new Set());
  }, [
    selectedRows,
    canClassifyCurrentFolder,
    isPrivilegedAdmin,
    syncStore,
    effectiveRole,
    setError,
    setSelectedKeys,
  ]);

  return {
    handleLockChanged,
    getEffectiveFileLock,
    contextMenuFileLock,
    toggleContextMenuFileLock,
    handleApproveSingleAi,
    handleBulkApproveAi,
  };
}
