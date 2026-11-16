'use client';

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ActiveModal } from '@/components/WorkspaceManagementModals';
import type { ClassificationPickerState } from '@/components/WorkspaceUtilityOverlays';
import type { DragWorkspaceItem } from '@/lib/drag-drop-controller';
import type { WorkspaceClipboardStore } from '@/lib/workspace-clipboard';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  isRowSelectable,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import { useWorkspaceClipboardActions } from '@/lib/use-workspace-clipboard-actions';
import { useWorkspaceShareActions } from '@/lib/use-workspace-share-actions';
import { useWorkspaceTrashActions } from '@/lib/use-workspace-trash-actions';
import type {
  AuthUser,
  FileItem,
  FolderStructureMode,
  FolderSummary,
  ResourceRole,
  TenantPolicyRow,
} from '@/types/files';

export function useWorkspaceActions({
  syncStore,
  clipboardStore,
  user,
  isTrashView,
  folderId,
  effectiveRole,
  isPrivilegedAdmin,
  folderStructureMode = 'open',
  selectedRows,
  focusedRow,
  error,
  canDeleteRow,
  canShareRow,
  canManageLinksRow,
  canClassifyRow,
  policy = null,
  setError,
  setSelectedKeys,
  setSelectionAnchorKey,
  setActiveModal,
  setClassificationPicker,
  setMoveCopyModal,
  onRequestRestoreFolder,
  onRequestRestoreFile,
}: {
  syncStore: WorkspaceSyncStore;
  clipboardStore: WorkspaceClipboardStore;
  user: AuthUser | null;
  isTrashView: boolean;
  folderId: string | null;
  effectiveRole: ResourceRole;
  isPrivilegedAdmin: boolean;
  folderStructureMode?: FolderStructureMode;
  selectedRows: WorkspaceTableRow[];
  focusedRow: WorkspaceTableRow | null;
  error: string | null;
  canDeleteRow: (row: WorkspaceTableRow) => boolean;
  canShareRow: (row: WorkspaceTableRow) => boolean;
  canManageLinksRow: (row: WorkspaceTableRow) => boolean;
  canClassifyRow: (row: WorkspaceTableRow) => boolean;
  policy?: TenantPolicyRow | null;
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
  onRequestRestoreFolder: (folder: FolderSummary) => void;
  onRequestRestoreFile: (file: FileItem) => void;
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

  const clipboardActions = useWorkspaceClipboardActions({
    syncStore,
    clipboardStore,
    user,
    isTrashView,
    folderId,
    effectiveRole,
    getShortcutTargets,
    resolveRowRole,
    isSysAdmin,
    folderStructureMode,
    setError,
    setSelectedKeys,
    setSelectionAnchorKey,
    setMoveCopyModal,
  });

  const trashActions = useWorkspaceTrashActions({
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
  });

  const shareActions = useWorkspaceShareActions({
    syncStore,
    isTrashView,
    selectedRows,
    focusedRow,
    canShareRow,
    canManageLinksRow,
    canClassifyRow,
    isPrivilegedAdmin,
    policy,
    setActiveModal,
    setClassificationPicker,
  });

  // Retained for parity with the previous handler's dependency on current error state.
  void error;

  return {
    resolveRowRole,
    isSysAdmin,
    getShortcutTargets,
    ...clipboardActions,
    ...trashActions,
    ...shareActions,
  };
}
