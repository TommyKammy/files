'use client';

import { MoveCopyTreeModal } from '@/components/MoveCopyTreeModal';
import { WorkspaceBackgroundMenu } from '@/components/WorkspaceBackgroundMenu';
import {
  WorkspaceContextMenu,
  type ContextMenuActionId,
} from '@/components/WorkspaceContextMenu';
import type { DragWorkspaceItem } from '@/lib/drag-drop-controller';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  buildContextMenuCapabilities,
  isRootCreationRestricted,
  resolveTargetRows,
  type ContextRowTarget,
} from '@/lib/workspace-actions';
import type {
  AuthUser,
  Capability,
  FolderStructureMode,
  FolderSummary,
  ResourceRole,
  WorkspaceClipboardState,
} from '@/types/files';

export interface WorkspaceContextMenuState {
  row: ContextRowTarget;
  x: number;
  y: number;
  trigger: HTMLElement | null;
}

export interface WorkspaceBackgroundMenuState {
  x: number;
  y: number;
  trigger: HTMLElement | null;
}

export interface WorkspaceMoveCopyState {
  items: DragWorkspaceItem[];
  modeHint: 'move' | 'copy';
}

export function WorkspaceActionOverlays({
  contextMenu,
  backgroundMenu,
  moveCopyModal,
  isTrashView,
  selectedRows,
  folderId,
  effectiveRole,
  folderCapabilities,
  currentFolder,
  viewMode,
  canCreateFolder,
  canUploadNew,
  canPaste,
  isPrivilegedAdmin,
  isSysAdmin,
  folderStructureMode = 'open',
  clipboardState,
  resolveRowRole,
  user,
  syncStore,
  isTargetLocked = false,
  isTargetFavorited = false,
  onToggleLock,
  onToggleFavorite,
  onOpenActivity,
  onContextAction,
  onCloseContextMenu,
  onBackgroundAction,
  onCloseBackgroundMenu,
  onCloseMoveCopy,
  onMoveCopySuccess,
}: {
  contextMenu: WorkspaceContextMenuState | null;
  backgroundMenu: WorkspaceBackgroundMenuState | null;
  moveCopyModal: WorkspaceMoveCopyState | null;
  isTrashView: boolean;
  selectedRows: ContextRowTarget[];
  folderId: string | null;
  effectiveRole: ResourceRole;
  folderCapabilities?: Capability[];
  currentFolder: FolderSummary | null;
  viewMode: 'list' | 'grid';
  canCreateFolder: boolean;
  canUploadNew: boolean;
  canPaste: boolean;
  isPrivilegedAdmin: boolean;
  isSysAdmin: boolean;
  folderStructureMode?: FolderStructureMode;
  clipboardState: WorkspaceClipboardState | null;
  resolveRowRole: (row: ContextRowTarget) => ResourceRole;
  user: AuthUser | null;
  syncStore: WorkspaceSyncStore;
  isTargetLocked?: boolean;
  isTargetFavorited?: boolean;
  onToggleLock?: (row: ContextRowTarget) => void;
  onToggleFavorite?: (row: ContextRowTarget) => void;
  onOpenActivity?: (row: ContextRowTarget) => void;
  onContextAction: (
    action: ContextMenuActionId,
    row: ContextRowTarget,
    targets: ContextRowTarget[],
    pasteDestId: string | undefined,
    returnFocus: HTMLElement | null
  ) => void;
  onCloseContextMenu: () => void;
  onBackgroundAction: (action: string) => void;
  onCloseBackgroundMenu: () => void;
  onCloseMoveCopy: () => void;
  onMoveCopySuccess: () => void;
}) {
  return (
    <>
      {contextMenu && !isTrashView && (() => {
        const targets = resolveTargetRows(contextMenu.row, selectedRows);
        const clip = clipboardState;
        const capabilities = buildContextMenuCapabilities({
          targets,
          primaryRow: contextMenu.row,
          currentFolderId: folderId,
          folderRole: effectiveRole,
          folderCapabilities,
          isPrivilegedAdmin,
          isSysAdmin,
          folderStructureMode,
          hasClipboardItems: Boolean(clip && clip.items.length > 0),
          clipboardHasFiles: Boolean(
            clip?.items.some((i) => i.type === 'file')
          ),
          resolveRowRole,
          resolveRowCapabilities: (row) =>
            row.kind === 'folder'
              ? row.folder.capabilities ?? folderCapabilities
              : folderCapabilities,
        });
        const pasteDestId =
          !capabilities.isMulti && contextMenu.row.kind === 'folder'
            ? contextMenu.row.folder.id
            : undefined;
        return (
          <WorkspaceContextMenu
            anchor={{ x: contextMenu.x, y: contextMenu.y }}
            targets={targets}
            primaryRow={contextMenu.row}
            capabilities={capabilities}
            clipboardCount={clip?.items.length ?? 0}
            isTargetLocked={isTargetLocked}
            isTargetFavorited={isTargetFavorited}
            returnFocus={contextMenu.trigger}
            onToggleLock={onToggleLock}
            onToggleFavorite={onToggleFavorite}
            onOpenActivity={onOpenActivity}
            onAction={(action) =>
              onContextAction(
                action,
                contextMenu.row,
                targets,
                pasteDestId,
                contextMenu.trigger
              )
            }
            onClose={onCloseContextMenu}
          />
        );
      })()}

      {backgroundMenu && !isTrashView && (
        <WorkspaceBackgroundMenu
          anchor={{ x: backgroundMenu.x, y: backgroundMenu.y }}
          canCreate={canCreateFolder || isPrivilegedAdmin}
          canUpload={Boolean(currentFolder) && canUploadNew}
          canUploadFolder={Boolean(currentFolder) && canUploadNew}
          canPaste={canPaste}
          clipboardCount={clipboardState?.items.length ?? 0}
          viewMode={viewMode}
          rootCreationRestricted={
            folderId === null &&
            isRootCreationRestricted(folderStructureMode, isSysAdmin)
          }
          returnFocus={backgroundMenu.trigger}
          onAction={onBackgroundAction}
          onClose={onCloseBackgroundMenu}
        />
      )}

      {moveCopyModal && user && (
        <MoveCopyTreeModal
          items={moveCopyModal.items}
          modeHint={moveCopyModal.modeHint}
          currentFolderId={folderId}
          user={user}
          isSysAdmin={isSysAdmin}
          folderStructureMode={folderStructureMode}
          syncStore={syncStore}
          onClose={onCloseMoveCopy}
          onSuccess={onMoveCopySuccess}
        />
      )}
    </>
  );
}


