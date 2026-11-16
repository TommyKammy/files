import type { Dispatch, SetStateAction } from 'react';
import type { useRouter } from 'next/navigation';
import type { useTableVirtualWindow } from '@/lib/use-virtual-window';
import {
  isInteractiveNonRowTarget,
  selectKeyRange,
  toggleKeySelection,
} from '@/lib/keyboard-shortcuts';
import {
  getWorkspaceRowKey,
  isRowSelectable,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type { FileItem } from '@/types/files';

export interface WorkspaceNavigationContext {
  isTrashView: boolean;
  rows: WorkspaceTableRow[];
  focusedRowIndex: number;
  focusedRow: WorkspaceTableRow | null;
  orderedRowKeys: string[];
  selectedRows: WorkspaceTableRow[];
  selectionAnchorKey: string | null;
  focusedRowKey: string | null;
  canDownloadCurrentFolder: boolean;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setFocusedRowKey: (key: string | null) => void;
  setSelectionAnchorKey: (key: string | null) => void;
  scrollLinearRowIntoView: (index: number) => void;
  virtualWindow: ReturnType<typeof useTableVirtualWindow>;
  router: ReturnType<typeof useRouter>;
  navigateToParentFolder: () => void;
  openPreviewForFile: (file: FileItem) => void;
  startInlineRename: (row: WorkspaceTableRow, index: number) => void;
  handleOpenMoveCopyModal: (
    targets?: WorkspaceTableRow[],
    modeHint?: 'move' | 'copy'
  ) => void;
  handleDownloadFile: (fileId: string) => void;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  handleToggleViewMode: () => void;
  openShareFromTarget: () => void;
}

export function handleWorkspaceNavigationKey(
  e: KeyboardEvent,
  ctx: WorkspaceNavigationContext
): boolean {
  const lower = e.key.toLowerCase();

  const moveFocusTo = (nextIdx: number, extendRange: boolean) => {
    const nextKey = ctx.orderedRowKeys[nextIdx];
    if (!nextKey) return;
    if (extendRange) {
      const anchor =
        ctx.selectionAnchorKey ?? ctx.focusedRowKey ?? nextKey;
      if (!ctx.selectionAnchorKey) {
        ctx.setSelectionAnchorKey(anchor);
      }
      ctx.setSelectedKeys(
        selectKeyRange(ctx.orderedRowKeys, anchor, nextKey)
      );
    } else {
      ctx.setSelectedKeys(new Set([nextKey]));
      ctx.setSelectionAnchorKey(nextKey);
    }
    ctx.setFocusedRowKey(nextKey);
    ctx.scrollLinearRowIntoView(nextIdx);
    ctx.virtualWindow.containerRef.current?.focus({ preventScroll: true });
  };

  if (e.key === 'ArrowDown' || lower === 'j') {
    if (ctx.rows.length === 0) return false;
    e.preventDefault();
    const nextIdx =
      ctx.focusedRowIndex < 0
        ? 0
        : Math.min(ctx.rows.length - 1, ctx.focusedRowIndex + 1);
    moveFocusTo(nextIdx, e.shiftKey);
    return true;
  }

  if (e.key === 'ArrowUp' || lower === 'k') {
    if (ctx.rows.length === 0) return false;
    e.preventDefault();
    const nextIdx =
      ctx.focusedRowIndex < 0
        ? 0
        : Math.max(0, ctx.focusedRowIndex - 1);
    moveFocusTo(nextIdx, e.shiftKey);
    return true;
  }

  if (e.key === 'Home') {
    if (ctx.rows.length === 0) return false;
    e.preventDefault();
    moveFocusTo(0, e.shiftKey);
    return true;
  }

  if (e.key === 'End') {
    if (ctx.rows.length === 0) return false;
    e.preventDefault();
    moveFocusTo(ctx.rows.length - 1, e.shiftKey);
    return true;
  }

  if (e.key === 'F2' || lower === 'r') {
    if (ctx.isTrashView || !ctx.focusedRow || ctx.focusedRowIndex < 0) {
      return false;
    }
    e.preventDefault();
    ctx.startInlineRename(ctx.focusedRow, ctx.focusedRowIndex);
    return true;
  }

  if (e.key === 'Backspace' || lower === 'h') {
    if (ctx.isTrashView) return false;
    if (e.key === 'Backspace' && isInteractiveNonRowTarget(e.target)) {
      return false;
    }
    e.preventDefault();
    ctx.navigateToParentFolder();
    return true;
  }

  if (e.key === 'Enter' || lower === 'l') {
    if (e.key === 'Enter' && isInteractiveNonRowTarget(e.target)) {
      return false;
    }
    if (!ctx.focusedRow || ctx.isTrashView) return false;
    e.preventDefault();
    if (ctx.focusedRow.kind === 'folder') {
      ctx.router.push(
        `/workspace?folderId=${encodeURIComponent(ctx.focusedRow.folder.id)}`
      );
    } else {
      ctx.openPreviewForFile(ctx.focusedRow.file);
    }
    return true;
  }

  if (e.key === ' ') {
    if (isInteractiveNonRowTarget(e.target)) return false;
    if (!ctx.focusedRow || !isRowSelectable(ctx.focusedRow)) return false;
    e.preventDefault();
    if (ctx.isTrashView) {
      const key = getWorkspaceRowKey(ctx.focusedRow);
      ctx.setSelectedKeys((prev) => toggleKeySelection(prev, key));
      ctx.setSelectionAnchorKey(key);
      return true;
    }
    if (ctx.focusedRow.kind === 'file') {
      ctx.openPreviewForFile(ctx.focusedRow.file);
    }
    return true;
  }

  if (lower === 'x') {
    if (!ctx.focusedRow || !isRowSelectable(ctx.focusedRow)) {
      return false;
    }
    e.preventDefault();
    const key = getWorkspaceRowKey(ctx.focusedRow);
    ctx.setSelectedKeys((prev) => toggleKeySelection(prev, key));
    ctx.setSelectionAnchorKey(key);
    return true;
  }

  if (lower === 'm') {
    if (ctx.isTrashView) return false;
    e.preventDefault();
    ctx.handleOpenMoveCopyModal();
    return true;
  }

  if (lower === 'd') {
    if (ctx.isTrashView || !ctx.canDownloadCurrentFolder) return false;
    const targetFile =
      ctx.focusedRow?.kind === 'file'
        ? ctx.focusedRow.file
        : ctx.selectedRows.find(
            (r): r is { kind: 'file'; file: FileItem } => r.kind === 'file'
          )?.file;
    if (
      targetFile &&
      targetFile.upload_state !== 'pending' &&
      !targetFile.optimistic
    ) {
      e.preventDefault();
      void ctx.handleDownloadFile(targetFile.id);
    }
    return true;
  }

  if (lower === 'i') {
    if (ctx.isTrashView) return false;
    e.preventDefault();
    ctx.setInspectorOpen((prev) => !prev);
    return true;
  }

  if (lower === 'v') {
    e.preventDefault();
    ctx.handleToggleViewMode();
    return true;
  }

  if (lower === 's') {
    if (ctx.isTrashView) return false;
    e.preventDefault();
    ctx.openShareFromTarget();
    return true;
  }

  return false;
}
