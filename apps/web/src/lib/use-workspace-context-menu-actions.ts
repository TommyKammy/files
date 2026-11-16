'use client';

import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ContextMenuActionId } from '@/components/WorkspaceContextMenu';
import type { ActiveModal } from '@/components/WorkspaceManagementModals';
import type { ClassificationPickerState } from '@/components/WorkspaceUtilityOverlays';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  getWorkspaceRowKey,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type { FileItem, FolderSummary, ResourceRole } from '@/types/files';

export function useWorkspaceContextMenuActions({
  syncStore,
  folderId,
  effectiveRole,
  selectedRows,
  canEditRow,
  resolveRowRole,
  handleTogglePin,
  setActiveModal,
  setClassificationPicker,
  setFocusedRowKey,
  setInspectorOpen,
  setSelectedKeys,
  setSelectionAnchorKey,
  openRow,
  orderedRowKeys,
  startInlineRename,
  handleDownloadFile,
  handleCopyTargets,
  handleCutTargets,
  handlePasteClipboard,
  handleDuplicateTargets,
  handleOpenMoveCopyModal,
  onOpenWopiEditor,
  openCreateFolderModal,
  backgroundFileInputRef,
  backgroundFolderInputRef,
  selectableRowKeys,
  loadActiveView,
  handleToggleViewMode,
}: {
  syncStore: WorkspaceSyncStore;
  folderId: string | null;
  effectiveRole: ResourceRole;
  selectedRows: WorkspaceTableRow[];
  canEditRow: (row: WorkspaceTableRow) => boolean;
  resolveRowRole: (row: WorkspaceTableRow) => ResourceRole;
  handleTogglePin: (folder: FolderSummary) => void;
  setActiveModal: Dispatch<SetStateAction<ActiveModal | null>>;
  setClassificationPicker: Dispatch<
    SetStateAction<ClassificationPickerState | null>
  >;
  setFocusedRowKey: Dispatch<SetStateAction<string | null>>;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorKey: Dispatch<SetStateAction<string | null>>;
  openRow: (row: WorkspaceTableRow) => void;
  orderedRowKeys: string[];
  startInlineRename: (row: WorkspaceTableRow, index: number) => void;
  handleDownloadFile: (fileId: string) => void | Promise<void>;
  handleCopyTargets: (targets?: WorkspaceTableRow[]) => void;
  handleCutTargets: (targets?: WorkspaceTableRow[]) => void;
  handlePasteClipboard: (targetParentOverride?: string | null) => void;
  handleDuplicateTargets: (targets?: WorkspaceTableRow[]) => void;
  handleOpenMoveCopyModal: (
    targets?: WorkspaceTableRow[],
    modeHint?: 'move' | 'copy'
  ) => void;
  onOpenWopiEditor: (file: FileItem) => void;
  openCreateFolderModal: () => void;
  backgroundFileInputRef: RefObject<HTMLInputElement | null>;
  backgroundFolderInputRef: RefObject<HTMLInputElement | null>;
  selectableRowKeys: string[];
  loadActiveView: (options?: { force?: boolean }) => Promise<void>;
  handleToggleViewMode: () => void;
}) {
  const handleBackgroundMenuAction = useCallback(
    (action: string) => {
      switch (action) {
        case 'newFolder':
          openCreateFolderModal();
          break;
        case 'uploadFiles':
          backgroundFileInputRef.current?.click();
          break;
        case 'uploadFolder':
          backgroundFolderInputRef.current?.click();
          break;
        case 'paste':
          handlePasteClipboard(folderId ?? null);
          break;
        case 'selectAll':
          setSelectedKeys(new Set(selectableRowKeys));
          setSelectionAnchorKey(selectableRowKeys[0] ?? null);
          break;
        case 'refresh':
          void loadActiveView({ force: true });
          break;
        case 'toggleView':
          handleToggleViewMode();
          break;
      }
    },
    [
      openCreateFolderModal,
      backgroundFileInputRef,
      backgroundFolderInputRef,
      handlePasteClipboard,
      folderId,
      setSelectedKeys,
      setSelectionAnchorKey,
      selectableRowKeys,
      loadActiveView,
      handleToggleViewMode,
    ]
  );

  const handleContextMenuAction = useCallback(
    (
      action: ContextMenuActionId,
      primary: WorkspaceTableRow | null,
      targets: WorkspaceTableRow[],
      pasteDestId: string | null | undefined
    ) => {
      switch (action) {
        case 'open':
          if (!primary) return;
          openRow(primary);
          break;
        case 'wopiOpen':
          if (primary?.kind === 'file') {
            onOpenWopiEditor(primary.file);
          }
          break;
        case 'openInNewTab':
          if (primary?.kind === 'folder') {
            window.open(
              `/workspace?folderId=${encodeURIComponent(primary.folder.id)}`,
              '_blank',
              'noopener,noreferrer'
            );
          } else if (primary?.kind === 'file') {
            const parentQuery = primary.file.folder_id
              ? `folderId=${encodeURIComponent(primary.file.folder_id)}&`
              : '';
            window.open(
              `/workspace?${parentQuery}preview=${encodeURIComponent(primary.file.id)}`,
              '_blank',
              'noopener,noreferrer'
            );
          }
          break;
        case 'copyLink': {
          if (!primary) return;
          const fileParentQuery =
            primary.kind === 'file' && primary.file.folder_id
              ? `folderId=${encodeURIComponent(primary.file.folder_id)}&`
              : '';
          const url =
            primary.kind === 'folder'
              ? `${window.location.origin}/workspace?folderId=${encodeURIComponent(primary.folder.id)}`
              : `${window.location.origin}/workspace?${fileParentQuery}preview=${encodeURIComponent(primary.file.id)}`;
          void navigator.clipboard
            .writeText(url)
            .then(() =>
              syncStore.pushToast({
                kind: 'info',
                message: '内部リンクをコピーしました',
              })
            )
            .catch(() =>
              syncStore.pushToast({
                kind: 'error',
                message: 'リンクをコピーできませんでした',
              })
            );
          break;
        }
        case 'download':
          if (primary?.kind === 'file') {
            handleDownloadFile(primary.file.id);
          }
          break;
        case 'rename':
          if (primary) {
            const idx = orderedRowKeys.indexOf(getWorkspaceRowKey(primary));
            if (idx >= 0) startInlineRename(primary, idx);
          }
          break;
        case 'copy':
          handleCopyTargets(targets);
          break;
        case 'cut':
          handleCutTargets(targets);
          break;
        case 'paste':
          handlePasteClipboard(pasteDestId);
          break;
        case 'duplicate':
          handleDuplicateTargets(targets);
          break;
        case 'moveCopy':
          handleOpenMoveCopyModal(targets, 'move');
          break;
        case 'classify': {
          const targetFiles = targets
            .filter(
              (r): r is { kind: 'file'; file: FileItem } => r.kind === 'file'
            )
            .map((r) => r.file);
          if (targetFiles.length === 1) {
            setClassificationPicker({ mode: 'single', file: targetFiles[0]! });
          } else if (targetFiles.length > 1) {
            setClassificationPicker({ mode: 'bulk', files: targetFiles });
          }
          break;
        }
        case 'share':
          if (!primary) return;
          setActiveModal({
            kind: 'share',
            targetType: primary.kind,
            targetId:
              primary.kind === 'folder' ? primary.folder.id : primary.file.id,
            targetName:
              primary.kind === 'folder'
                ? primary.folder.name
                : primary.file.name,
            classification:
              primary.kind === 'folder'
                ? primary.folder.classification
                : primary.file.classification,
            canEdit: canEditRow(primary),
          });
          break;
        case 'pin':
          if (primary?.kind === 'folder') {
            handleTogglePin(primary.folder);
          }
          break;
        case 'permissions':
          if (primary) {
            setActiveModal({
              kind: 'permissions',
              targetType: primary.kind,
              targetId:
                primary.kind === 'folder'
                  ? primary.folder.id
                  : primary.file.id,
              targetName:
                primary.kind === 'folder'
                  ? primary.folder.name
                  : primary.file.name,
              effectiveRole: resolveRowRole(primary),
            });
          }
          break;
        case 'inspector':
          if (primary) {
            setFocusedRowKey(getWorkspaceRowKey(primary));
            setInspectorOpen(true);
          }
          break;
        case 'trash':
          for (const r of targets) {
            if (!canEditRow(r)) continue;
            if (r.kind === 'folder') {
              syncStore.optimisticSoftDeleteFolder(r.folder);
            } else {
              syncStore.optimisticSoftDeleteFile(
                r.file,
                folderId,
                effectiveRole
              );
            }
          }
          if (selectedRows.length > 0) {
            setSelectedKeys(new Set());
          }
          break;
      }
    },
    [
      openRow,
      handleDownloadFile,
      orderedRowKeys,
      startInlineRename,
      handleCopyTargets,
      handleCutTargets,
      handlePasteClipboard,
      handleDuplicateTargets,
      handleOpenMoveCopyModal,
      onOpenWopiEditor,
      canEditRow,
      handleTogglePin,
      resolveRowRole,
      syncStore,
      folderId,
      effectiveRole,
      selectedRows.length,
      setActiveModal,
      setClassificationPicker,
      setFocusedRowKey,
      setInspectorOpen,
      setSelectedKeys,
    ]
  );

  return { handleBackgroundMenuAction, handleContextMenuAction };
}
