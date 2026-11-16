'use client';

import { useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { WorkspacePaletteActions } from '@/lib/palette-actions';
import { hasRoleAtLeast } from '@/lib/formatters';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type { ResourceRole, WorkspaceClipboardState } from '@/types/files';

export function useWorkspacePaletteActions({
  focusedRow,
  selectedRows,
  isTrashView,
  canEditCurrentFolder,
  isPrivilegedAdmin,
  isSysAdmin,
  effectiveRole,
  canEditRow,
  resolveRowRole,
  getShortcutTargets,
  clipboardState,
  openCreateFolderModal,
  openClassificationPickerFromTarget,
  openShareFromTarget,
  trashSelectedOrFocused,
  handleOpenMoveCopyModal,
  handleCopyTargets,
  handleCutTargets,
  handlePasteClipboard,
  handleDuplicateTargets,
  handleToggleViewMode,
  setInspectorOpen,
  setShortcutsHelpOpen,
}: {
  focusedRow: WorkspaceTableRow | null;
  selectedRows: WorkspaceTableRow[];
  isTrashView: boolean;
  canEditCurrentFolder: boolean;
  isPrivilegedAdmin: boolean;
  isSysAdmin: boolean;
  effectiveRole: ResourceRole;
  canEditRow: (row: WorkspaceTableRow) => boolean;
  resolveRowRole: (row: WorkspaceTableRow) => ResourceRole;
  getShortcutTargets: () => WorkspaceTableRow[];
  clipboardState: WorkspaceClipboardState | null;
  openCreateFolderModal: () => void;
  openClassificationPickerFromTarget: () => void;
  openShareFromTarget: () => void;
  trashSelectedOrFocused: () => void;
  handleOpenMoveCopyModal: (
    targets?: WorkspaceTableRow[],
    modeHint?: 'move' | 'copy'
  ) => void;
  handleCopyTargets: (targets?: WorkspaceTableRow[]) => void;
  handleCutTargets: (targets?: WorkspaceTableRow[]) => void;
  handlePasteClipboard: (targetParentOverride?: string | null) => void;
  handleDuplicateTargets: (targets?: WorkspaceTableRow[]) => void;
  handleToggleViewMode: () => void;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutsHelpOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return useMemo<WorkspacePaletteActions>(
    () => ({
      hasTargetItem: Boolean(focusedRow || selectedRows.length > 0),
      canClassifyTarget:
        !isTrashView && (canEditCurrentFolder || isPrivilegedAdmin),
      canShareTarget:
        !isTrashView &&
        Boolean((focusedRow && canEditRow(focusedRow)) || selectedRows[0]),
      canTrashTarget:
        !isTrashView &&
        (selectedRows.length > 0 ||
          (focusedRow !== null && canEditRow(focusedRow))),
      canCopyTarget:
        !isTrashView &&
        getShortcutTargets().some(
          (r) => isSysAdmin || hasRoleAtLeast(resolveRowRole(r), 'viewer')
        ),
      canCutTarget:
        !isTrashView &&
        getShortcutTargets().some(
          (r) => isSysAdmin || hasRoleAtLeast(resolveRowRole(r), 'editor')
        ),
      canPasteClipboard:
        !isTrashView &&
        Boolean(clipboardState && clipboardState.items.length > 0),
      canDuplicateTarget:
        !isTrashView &&
        getShortcutTargets().length > 0 &&
        (isSysAdmin || hasRoleAtLeast(effectiveRole, 'viewer')),
      onCommand: (cmdId) => {
        switch (cmdId) {
          case 'cmd:new-folder':
            openCreateFolderModal();
            break;
          case 'cmd:move-copy':
            handleOpenMoveCopyModal();
            break;
          case 'cmd:copy':
            handleCopyTargets();
            break;
          case 'cmd:cut':
            handleCutTargets();
            break;
          case 'cmd:paste':
            handlePasteClipboard();
            break;
          case 'cmd:duplicate':
            handleDuplicateTargets();
            break;
          case 'cmd:toggle-inspector':
            setInspectorOpen((prev) => !prev);
            break;
          case 'cmd:toggle-view':
            handleToggleViewMode();
            break;
          case 'cmd:change-classification':
            openClassificationPickerFromTarget();
            break;
          case 'cmd:share':
            openShareFromTarget();
            break;
          case 'cmd:trash':
            trashSelectedOrFocused();
            break;
          case 'cmd:shortcuts':
            setShortcutsHelpOpen(true);
            break;
        }
      },
    }),
    [
      focusedRow,
      selectedRows,
      isTrashView,
      canEditCurrentFolder,
      isPrivilegedAdmin,
      isSysAdmin,
      effectiveRole,
      canEditRow,
      resolveRowRole,
      getShortcutTargets,
      clipboardState,
      openCreateFolderModal,
      openClassificationPickerFromTarget,
      openShareFromTarget,
      trashSelectedOrFocused,
      handleOpenMoveCopyModal,
      handleCopyTargets,
      handleCutTargets,
      handlePasteClipboard,
      handleDuplicateTargets,
      handleToggleViewMode,
      setInspectorOpen,
      setShortcutsHelpOpen,
    ]
  );
}
