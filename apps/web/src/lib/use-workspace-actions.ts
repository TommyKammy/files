'use client';

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ActiveModal } from '@/components/WorkspaceManagementModals';
import type { ClassificationPickerState } from '@/components/WorkspaceUtilityOverlays';
import type { DragWorkspaceItem } from '@/lib/drag-drop-controller';
import { hasRoleAtLeast } from '@/lib/formatters';
import type { WorkspaceClipboardStore } from '@/lib/workspace-clipboard';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  isRowSelectable,
  toDragWorkspaceItem,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type {
  AuthUser,
  FileItem,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export function useWorkspaceActions({
  syncStore,
  clipboardStore,
  user,
  isTrashView,
  folderId,
  effectiveRole,
  canEditCurrentFolder,
  isPrivilegedAdmin,
  selectedRows,
  focusedRow,
  error,
  canEditRow,
  setError,
  setSelectedKeys,
  setSelectionAnchorKey,
  setActiveModal,
  setClassificationPicker,
  setMoveCopyModal,
  removeTrashFolder,
  removeTrashFile,
}: {
  syncStore: WorkspaceSyncStore;
  clipboardStore: WorkspaceClipboardStore;
  user: AuthUser | null;
  isTrashView: boolean;
  folderId: string | null;
  effectiveRole: ResourceRole;
  canEditCurrentFolder: boolean;
  isPrivilegedAdmin: boolean;
  selectedRows: WorkspaceTableRow[];
  focusedRow: WorkspaceTableRow | null;
  error: string | null;
  canEditRow: (row: WorkspaceTableRow) => boolean;
  setError: (message: string | null) => void;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorKey: (key: string | null) => void;
  setActiveModal: Dispatch<SetStateAction<ActiveModal | null>>;
  setClassificationPicker: Dispatch<
    SetStateAction<ClassificationPickerState | null>
  >;
  setMoveCopyModal: Dispatch<
    SetStateAction<{
      items: DragWorkspaceItem[];
      modeHint: 'move' | 'copy';
    } | null>
  >;
  removeTrashFolder: (folderId: string) => void;
  removeTrashFile: (fileId: string) => void;
}) {
  const resolveRowRole = useCallback(
    (row: WorkspaceTableRow): ResourceRole => {
      if (row.kind === 'folder') {
        return row.folder.effectiveRole ?? effectiveRole;
      }
      return effectiveRole;
    },
    [effectiveRole]
  );

  const isSysAdmin = user?.role === 'sys_admin';

  const getShortcutTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]): WorkspaceTableRow[] => {
      if (explicitTargets && explicitTargets.length > 0) {
        return explicitTargets.filter(isRowSelectable);
      }
      if (selectedRows.length > 0) {
        return selectedRows.filter(isRowSelectable);
      }
      if (focusedRow && isRowSelectable(focusedRow)) {
        return [focusedRow];
      }
      return [];
    },
    [selectedRows, focusedRow]
  );

  const toClipboardItems = useCallback(
    (targets: WorkspaceTableRow[]) =>
      targets.map((row) =>
        row.kind === 'folder'
          ? {
              type: 'folder' as const,
              id: row.folder.id,
              name: row.folder.name,
              parentId: row.folder.parent_id,
              classification: row.folder.classification,
              version: row.folder.version,
            }
          : {
              type: 'file' as const,
              id: row.file.id,
              name: row.file.name,
              parentId: row.file.folder_id,
              classification: row.file.classification,
              version: row.file.meta_version ?? 1,
            }
      ),
    []
  );

  const handleCopyTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView || !user) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      const blocked = targets.some(
        (r) =>
          !isSysAdmin && !hasRoleAtLeast(resolveRowRole(r), 'viewer')
      );
      if (blocked) {
        syncStore.pushToast({
          kind: 'error',
          message: 'Previewer 権限のアイテムはコピーできません (DLP 保護)',
        });
        return;
      }
      clipboardStore.setClipboard('copy', toClipboardItems(targets), {
        tenantId: user.tenantId,
        userId: user.id,
      });
      syncStore.pushToast({
        kind: 'info',
        message: `${targets.length} 件をコピーしました（移動先で ⌘V / Ctrl+V）`,
      });
    },
    [
      isTrashView,
      user,
      getShortcutTargets,
      isSysAdmin,
      resolveRowRole,
      clipboardStore,
      toClipboardItems,
      syncStore,
    ]
  );

  const handleCutTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView || !user) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      const blocked = targets.some(
        (r) =>
          !isSysAdmin && !hasRoleAtLeast(resolveRowRole(r), 'editor')
      );
      if (blocked) {
        syncStore.pushToast({
          kind: 'error',
          message: '切り取り（移動）には Editor 以上の権限が必要です',
        });
        return;
      }
      clipboardStore.setClipboard('cut', toClipboardItems(targets), {
        tenantId: user.tenantId,
        userId: user.id,
      });
      syncStore.pushToast({
        kind: 'info',
        message: `${targets.length} 件を切り取りました（移動先で ⌘V / Ctrl+V）`,
      });
    },
    [
      isTrashView,
      user,
      getShortcutTargets,
      isSysAdmin,
      resolveRowRole,
      clipboardStore,
      toClipboardItems,
      syncStore,
    ]
  );

  const handlePasteClipboard = useCallback(
    (targetParentOverride?: string | null) => {
      if (isTrashView) return;
      const clip = clipboardStore.getState();
      if (!clip || clip.items.length === 0) return;

      const destId =
        targetParentOverride !== undefined
          ? targetParentOverride
          : folderId;
      const refs = clip.items.map((it) => ({ type: it.type, id: it.id }));

      setError(null);
      if (clip.mode === 'cut') {
        const res = syncStore.optimisticMoveItems({
          items: refs,
          targetParentId: destId,
        });
        if (!res.ok) {
          setError(res.error ?? '貼り付け移動に失敗しました');
          syncStore.pushToast({
            kind: 'error',
            message: res.error ?? '貼り付け移動に失敗しました',
          });
          return;
        }
        clipboardStore.completePaste();
        setSelectedKeys(new Set());
        return;
      }

      const res = syncStore.optimisticCopyItems({
        items: refs,
        targetParentId: destId,
        mode: 'copy',
        conflictPolicy: 'rename',
      });
      if (!res.ok) {
        setError(res.error ?? '貼り付けコピーに失敗しました');
        syncStore.pushToast({
          kind: 'error',
          message: res.error ?? '貼り付けコピーに失敗しました',
        });
        return;
      }
      setSelectedKeys(new Set());
    },
    [
      isTrashView,
      clipboardStore,
      folderId,
      syncStore,
      setError,
      setSelectedKeys,
    ]
  );

  const handleDuplicateTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      setError(null);
      const res = syncStore.optimisticCopyItems({
        items: targets.map((r) =>
          r.kind === 'folder'
            ? { type: 'folder', id: r.folder.id }
            : { type: 'file', id: r.file.id }
        ),
        targetParentId: folderId,
        mode: 'duplicate',
      });
      if (!res.ok) {
        setError(res.error ?? '複製に失敗しました');
        syncStore.pushToast({
          kind: 'error',
          message: res.error ?? '複製に失敗しました',
        });
      }
    },
    [isTrashView, getShortcutTargets, syncStore, folderId, setError]
  );

  const handleOpenMoveCopyModal = useCallback(
    (
      explicitTargets?: WorkspaceTableRow[],
      modeHint: 'move' | 'copy' = 'move'
    ) => {
      if (isTrashView) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) {
        syncStore.pushToast({
          kind: 'info',
          message:
            '移動・コピーするアイテムを選択またはフォーカスしてください',
        });
        return;
      }
      setMoveCopyModal({
        items: targets.map((r) => toDragWorkspaceItem(r, effectiveRole)),
        modeHint,
      });
    },
    [
      isTrashView,
      getShortcutTargets,
      syncStore,
      effectiveRole,
      setMoveCopyModal,
    ]
  );

  const openShareFromTarget = useCallback(() => {
    if (isTrashView) return;
    const row = focusedRow ?? selectedRows[0] ?? null;
    if (!row) return;
    if (!canEditRow(row)) {
      syncStore.pushToast({
        kind: 'error',
        message: '共有リンクの作成には編集者以上の権限が必要です',
      });
      return;
    }
    if (row.kind === 'folder') {
      setActiveModal({
        kind: 'share',
        targetType: 'folder',
        targetId: row.folder.id,
        targetName: row.folder.name,
        classification: row.folder.classification,
        canEdit: true,
      });
    } else {
      setActiveModal({
        kind: 'share',
        targetType: 'file',
        targetId: row.file.id,
        targetName: row.file.name,
        classification: row.file.classification,
        canEdit: true,
      });
    }
  }, [
    isTrashView,
    focusedRow,
    selectedRows,
    canEditRow,
    syncStore,
    setActiveModal,
  ]);

  const openClassificationPickerFromTarget = useCallback(() => {
    if (isTrashView) return;
    const selectedFiles = selectedRows
      .filter(
        (r): r is { kind: 'file'; file: FileItem } => r.kind === 'file'
      )
      .map((r) => r.file);

    const targetFiles =
      selectedFiles.length > 0
        ? selectedFiles
        : focusedRow?.kind === 'file' && isRowSelectable(focusedRow)
          ? [focusedRow.file]
          : [];

    if (targetFiles.length === 0) {
      syncStore.pushToast({
        kind: 'info',
        message:
          '機密区分の変更はファイルを選択またはフォーカスして実行してください',
      });
      return;
    }

    if (!canEditCurrentFolder && !isPrivilegedAdmin) {
      syncStore.pushToast({
        kind: 'error',
        message: '機密区分を変更する権限がありません',
      });
      return;
    }

    if (targetFiles.length === 1) {
      setClassificationPicker({
        mode: 'single',
        file: targetFiles[0]!,
      });
    } else {
      setClassificationPicker({ mode: 'bulk', files: targetFiles });
    }
  }, [
    isTrashView,
    selectedRows,
    focusedRow,
    syncStore,
    canEditCurrentFolder,
    isPrivilegedAdmin,
    setClassificationPicker,
  ]);

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

  const handleDragDropMove = useCallback(
    (items: DragWorkspaceItem[], targetFolderId: string | null) => {
      setError(null);
      const res = syncStore.optimisticMoveItems({
        items: items.map((it) => ({ type: it.type, id: it.id })),
        targetParentId: targetFolderId,
      });
      if (!res.ok) {
        setError(res.error ?? 'アイテムの移動に失敗しました');
        return;
      }
      setSelectedKeys(new Set());
      setSelectionAnchorKey(null);
    },
    [syncStore, setError, setSelectedKeys, setSelectionAnchorKey]
  );

  // Retained for parity with the previous handler's dependency on current error state.
  void error;

  return {
    resolveRowRole,
    isSysAdmin,
    getShortcutTargets,
    handleCopyTargets,
    handleCutTargets,
    handlePasteClipboard,
    handleDuplicateTargets,
    handleOpenMoveCopyModal,
    openShareFromTarget,
    openClassificationPickerFromTarget,
    trashSelectedOrFocused,
    handleTogglePin,
    handleRestoreFolder,
    handleRestoreFile,
    handleDragDropMove,
  };
}
