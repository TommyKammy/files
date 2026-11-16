'use client';

import { useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { WorkspacePaletteActions } from '@/lib/palette-actions';
import { canAccess } from '@/lib/capabilities';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  Capability,
  FolderStructureMode,
  ResourceRole,
  WorkspaceClipboardState,
} from '@/types/files';
import {
  isRootCreationRestricted,
} from '@/lib/workspace-actions';

export function useWorkspacePaletteActions({
  focusedRow,
  selectedRows,
  isTrashView,
  isPrivilegedAdmin,
  isSysAdmin,
  folderId,
  folderStructureMode = 'open',
  effectiveRole,
  folderCapabilities,
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
  isPrivilegedAdmin: boolean;
  isSysAdmin: boolean;
  folderId?: string | null;
  folderStructureMode?: FolderStructureMode;
  effectiveRole: ResourceRole;
  folderCapabilities?: Capability[];
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
  return useMemo<WorkspacePaletteActions>(() => {
    const rowAccess = (row: WorkspaceTableRow) => ({
      capabilities:
        row.kind === 'folder' ? row.folder.capabilities : folderCapabilities,
      effectiveRole: resolveRowRole(row),
    });
    const targets = getShortcutTargets();
    const primary = focusedRow ?? selectedRows[0] ?? null;
    const rootCreationRestricted =
      (folderId ?? null) === null &&
      isRootCreationRestricted(folderStructureMode, isSysAdmin);

    return {
      hasTargetItem: Boolean(focusedRow || selectedRows.length > 0),
      canCreateFolder:
        !isTrashView &&
        !rootCreationRestricted &&
        (isSysAdmin ||
          canAccess(
            { capabilities: folderCapabilities, effectiveRole },
            'folder.create'
          )),
      canInspectTarget:
        !isTrashView &&
        Boolean(primary) &&
        (isSysAdmin || canAccess(rowAccess(primary!), 'item.preview')),
      canMoveCopyTarget:
        !isTrashView &&
        targets.some(
          (row) =>
            isSysAdmin ||
            canAccess(rowAccess(row), 'item.download') ||
            canAccess(
              rowAccess(row),
              row.kind === 'folder' ? 'folder.move' : 'item.move'
            )
        ),
      canClassifyTarget:
        !isTrashView &&
        targets.some(
          (row) =>
            row.kind === 'file' &&
            (isPrivilegedAdmin ||
              canAccess(rowAccess(row), 'classification.edit'))
        ),
      canShareTarget:
        !isTrashView &&
        Boolean(primary) &&
        (isSysAdmin || canAccess(rowAccess(primary!), 'share_link.create')),
      canTrashTarget:
        !isTrashView &&
        targets.length > 0 &&
        targets.every(
          (row) =>
            isSysAdmin ||
            canAccess(
              rowAccess(row),
              row.kind === 'folder' ? 'folder.delete' : 'item.delete'
            )
        ),
      canCopyTarget:
        !isTrashView &&
        targets.some(
          (r) => isSysAdmin || canAccess(rowAccess(r), 'item.download')
        ),
      canCutTarget:
        !isTrashView &&
        targets.some(
          (r) =>
            isSysAdmin ||
            canAccess(
              rowAccess(r),
              r.kind === 'folder' ? 'folder.move' : 'item.move'
            )
        ),
      canPasteClipboard:
        !isTrashView &&
        !rootCreationRestricted &&
        Boolean(clipboardState && clipboardState.items.length > 0) &&
        (isSysAdmin ||
          canAccess(
            { capabilities: folderCapabilities, effectiveRole },
            'item.upload_new'
          )),
      canDuplicateTarget:
        !isTrashView &&
        !rootCreationRestricted &&
        targets.length > 0 &&
        (isSysAdmin ||
          (canAccess({ capabilities: folderCapabilities }, 'item.upload_new') &&
            targets.every((row) => canAccess(rowAccess(row), 'item.download')))),
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
    };
  }, [
      focusedRow,
      selectedRows,
      isTrashView,
      isPrivilegedAdmin,
      isSysAdmin,
      folderId,
      folderStructureMode,
      effectiveRole,
      folderCapabilities,
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
