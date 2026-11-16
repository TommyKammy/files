'use client';

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ActiveModal } from '@/components/WorkspaceManagementModals';
import type { ClassificationPickerState } from '@/components/WorkspaceUtilityOverlays';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  isRowSelectable,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type { FileItem } from '@/types/files';

export function useWorkspaceShareActions({
  syncStore,
  isTrashView,
  selectedRows,
  focusedRow,
  canShareRow,
  canManageLinksRow,
  canClassifyRow,
  isPrivilegedAdmin,
  setActiveModal,
  setClassificationPicker,
}: {
  syncStore: WorkspaceSyncStore;
  isTrashView: boolean;
  selectedRows: WorkspaceTableRow[];
  focusedRow: WorkspaceTableRow | null;
  canShareRow: (row: WorkspaceTableRow) => boolean;
  canManageLinksRow: (row: WorkspaceTableRow) => boolean;
  canClassifyRow: (row: WorkspaceTableRow) => boolean;
  isPrivilegedAdmin: boolean;
  setActiveModal: Dispatch<SetStateAction<ActiveModal | null>>;
  setClassificationPicker: Dispatch<
    SetStateAction<ClassificationPickerState | null>
  >;
}) {
  const openShareFromTarget = useCallback(() => {
    if (isTrashView) return;
    const row = focusedRow ?? selectedRows[0] ?? null;
    if (!row) return;
    if (!canShareRow(row)) {
      syncStore.pushToast({
        kind: 'error',
        message: '共有リンクの作成権限がありません',
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
        canManageLinks: canManageLinksRow(row),
      });
    } else {
      setActiveModal({
        kind: 'share',
        targetType: 'file',
        targetId: row.file.id,
        targetName: row.file.name,
        classification: row.file.classification,
        canEdit: true,
        canManageLinks: canManageLinksRow(row),
      });
    }
  }, [
    isTrashView,
    focusedRow,
    selectedRows,
    canShareRow,
    canManageLinksRow,
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

    if (
      !isPrivilegedAdmin &&
      !targetFiles.every((file) => {
        const row = selectedRows.find(
          (candidate) =>
            candidate.kind === 'file' && candidate.file.id === file.id
        ) ?? (focusedRow?.kind === 'file' && focusedRow.file.id === file.id
          ? focusedRow
          : null);
        return row ? canClassifyRow(row) : false;
      })
    ) {
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
    canClassifyRow,
    isPrivilegedAdmin,
    setClassificationPicker,
  ]);

  return {
    openShareFromTarget,
    openClassificationPickerFromTarget,
  };
}
