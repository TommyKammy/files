'use client';

import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { getDropTargetClassName, type WorkspaceDragContextValue } from '@/components/WorkspaceDragPortal';
import { WorkspaceItemCard } from '@/components/WorkspaceItemCard';
import { WorkspaceItemRow } from '@/components/WorkspaceItemRow';
import type { DragWorkspaceItem } from '@/lib/drag-drop-controller';
import type { IntentPrefetcher } from '@/lib/intent-prefetch';
import type { useWorkspaceClipboard } from '@/lib/workspace-clipboard';
import { describeWorkspaceRow } from '@/lib/workspace-row-presentation';
import type { WorkspaceColumnVisibility } from '@/lib/workspace-table-columns';
import {
  getWorkspaceRowKey,
  isRowSelectable,
  toDragWorkspaceItem,
  type InlineRenameState,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type {
  FileItem,
  FileLockInfo,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

function collectDragItemsForRow(
  row: WorkspaceTableRow,
  selectedRows: WorkspaceTableRow[],
  selectedKeys: Set<string>,
  isTrashView: boolean,
  fallbackRole: ResourceRole
): DragWorkspaceItem[] {
  if (isTrashView || !isRowSelectable(row)) return [];
  const rowKey = getWorkspaceRowKey(row);
  if (selectedKeys.has(rowKey) && selectedRows.length > 0) {
    return selectedRows
      .filter((r) => isRowSelectable(r))
      .map((r) => toDragWorkspaceItem(r, fallbackRole));
  }
  return [toDragWorkspaceItem(row, fallbackRole)];
}

export interface UseWorkspaceRowRenderersParams {
  isTrashView: boolean;
  effectiveRole: ResourceRole;
  focusedRowKey: string | null;
  selectedKeys: Set<string>;
  selectedRows: WorkspaceTableRow[];
  clipboardState: ReturnType<typeof useWorkspaceClipboard>;
  isCutPending: (kind: 'folder' | 'file', id: string) => boolean;
  inlineRename: InlineRenameState | null;
  inlineInputRef: RefObject<HTMLInputElement | null>;
  inlineCommittedRef: MutableRefObject<string | null>;
  contextMenuRow: WorkspaceTableRow | null;
  prefetcher: IntentPrefetcher;
  canClassifyCurrentFolder: boolean;
  canDownloadCurrentFolder: boolean;
  isPrivilegedAdmin: boolean;
  columnVisibility: WorkspaceColumnVisibility;
  getEffectiveFileLock: (fileId: string) => FileLockInfo | null;
  selectRowCheckbox: (
    e: React.MouseEvent<HTMLButtonElement>,
    row: WorkspaceTableRow,
    rowKey: string
  ) => void;
  selectRowFromPointer: (
    e: React.MouseEvent,
    rowKey: string,
    rowSelectable: boolean
  ) => void;
  openRow: (row: WorkspaceTableRow) => void;
  openRowContextMenu: (e: React.MouseEvent, row: WorkspaceTableRow) => void;
  handleRestoreFolder: (folder: FolderSummary) => void;
  handleRestoreFile: (file: FileItem) => void;
  handleDownloadFile: (fileId: string) => void;
  setInlineRename: Dispatch<SetStateAction<InlineRenameState | null>>;
  commitInlineRename: () => void;
  setFocusedRowKey: Dispatch<SetStateAction<string | null>>;
  onFileUpdated: (file: FileItem) => void;
  setError: (error: string | null) => void;
}

/**
 * Builds `renderGridRowCard` and `renderTableRow` callbacks bound to the active
 * `WorkspaceDragProvider` context.
 */
export function useWorkspaceRowRenderers(
  params: UseWorkspaceRowRenderersParams
) {
  function createRenderers(dragCtx: WorkspaceDragContextValue) {
    function handleCardCheckboxClick(
      row: WorkspaceTableRow,
      rowKey: string,
      e: React.MouseEvent<HTMLButtonElement>
    ) {
      params.selectRowCheckbox(e, row, rowKey);
    }

    function handleCardPointerDown(
      row: WorkspaceTableRow,
      e: React.PointerEvent<HTMLElement>
    ) {
      const dragItems = collectDragItemsForRow(
        row,
        params.selectedRows,
        params.selectedKeys,
        params.isTrashView,
        params.effectiveRole
      );
      if (dragItems.length > 0) {
        dragCtx.startPointerDragCandidate(e, dragItems);
      }
    }

    function renderGridRowCard(row: WorkspaceTableRow, globalIdx: number) {
      const {
        rowKey,
        file,
        folder,
        isPendingUpload,
        isCut,
        isDropEligible,
      } = describeWorkspaceRow({
        row,
        isTrashView: params.isTrashView,
        clipboardState: params.clipboardState,
        isCutPending: params.isCutPending,
      });
      const dropClass =
        folder && dragCtx.isDragging && isDropEligible
          ? getDropTargetClassName(folder.id, dragCtx.hoveredTarget)
          : '';

      return (
        <WorkspaceItemCard
          key={rowKey}
          row={row}
          globalIdx={globalIdx}
          isFocused={params.focusedRowKey === rowKey}
          isSelected={params.selectedKeys.has(rowKey)}
          rowSelectable={isRowSelectable(row)}
          isTrashView={params.isTrashView}
          isInlineRenaming={params.inlineRename?.rowKey === rowKey}
          isPendingUpload={isPendingUpload}
          isCut={isCut}
          lock={file ? params.getEffectiveFileLock(file.id) : null}
          isContextMenuOpen={
            params.contextMenuRow
              ? getWorkspaceRowKey(params.contextMenuRow) === rowKey
              : false
          }
          dropClass={dropClass}
          inlineRename={params.inlineRename}
          inlineInputRef={params.inlineInputRef}
          inlineCommittedRef={params.inlineCommittedRef}
          prefetcher={params.prefetcher}
          onCheckboxClick={(e) => handleCardCheckboxClick(row, rowKey, e)}
          onPointerDown={(e) => handleCardPointerDown(row, e)}
          onSelectRow={params.selectRowFromPointer}
          onOpenRow={params.openRow}
          onOpenContextMenu={params.openRowContextMenu}
          onRestoreFolder={params.handleRestoreFolder}
          onRestoreFile={params.handleRestoreFile}
          onSetInlineRename={params.setInlineRename}
          onCommitInlineRename={params.commitInlineRename}
          onFocusRow={params.setFocusedRowKey}
        />
      );
    }

    function renderTableRow(row: WorkspaceTableRow, globalIdx: number) {
      const { rowKey, file, folder, isCut, isDropEligible } =
        describeWorkspaceRow({
          row,
          isTrashView: params.isTrashView,
          clipboardState: params.clipboardState,
          isCutPending: params.isCutPending,
        });
      const dropClass =
        folder && dragCtx.isDragging && isDropEligible
          ? getDropTargetClassName(folder.id, dragCtx.hoveredTarget)
          : '';

      return (
        <WorkspaceItemRow
          key={rowKey}
          row={row}
          globalIdx={globalIdx}
          isFocused={params.focusedRowKey === rowKey}
          isSelected={params.selectedKeys.has(rowKey)}
          rowSelectable={isRowSelectable(row)}
          isTrashView={params.isTrashView}
          isInlineRenaming={params.inlineRename?.rowKey === rowKey}
          isContextMenuOpen={
            params.contextMenuRow
              ? getWorkspaceRowKey(params.contextMenuRow) === rowKey
              : false
          }
          isCut={isCut}
          lock={file ? params.getEffectiveFileLock(file.id) : null}
          dropClass={dropClass}
          inlineRename={params.inlineRename}
          inlineInputRef={params.inlineInputRef}
          inlineCommittedRef={params.inlineCommittedRef}
          prefetcher={params.prefetcher}
          effectiveRole={params.effectiveRole}
          canClassify={params.canClassifyCurrentFolder}
          canDownloadCurrentFolder={params.canDownloadCurrentFolder}
          isPrivilegedAdmin={params.isPrivilegedAdmin}
          columnVisibility={params.columnVisibility}
          onCheckboxClick={(e) => handleCardCheckboxClick(row, rowKey, e)}
          onPointerDown={(e) => handleCardPointerDown(row, e)}
          onSelectRow={params.selectRowFromPointer}
          onOpenRow={params.openRow}
          onOpenContextMenu={params.openRowContextMenu}
          onRestoreFolder={params.handleRestoreFolder}
          onRestoreFile={params.handleRestoreFile}
          onDownloadFile={params.handleDownloadFile}
          onSetInlineRename={params.setInlineRename}
          onCommitInlineRename={params.commitInlineRename}
          onFocusRow={params.setFocusedRowKey}
          onFileUpdated={params.onFileUpdated}
          onError={params.setError}
        />
      );
    }

    return { renderGridRowCard, renderTableRow };
  }

  return { createRenderers };
}
