'use client';

import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { useRouter } from 'next/navigation';
import type { useTableVirtualWindow } from '@/lib/use-virtual-window';
import {
  isEditableTarget,
  isImeComposingEvent,
  isInteractiveNonRowTarget,
  isTrashShortcut,
  keyboardScopes,
  selectKeyRange,
  shouldHandleWorkspaceKey,
  toggleKeySelection,
} from '@/lib/keyboard-shortcuts';
import type { WorkspaceClipboardStore } from '@/lib/workspace-clipboard';
import { resolveContextSelection } from '@/lib/workspace-actions';
import {
  getWorkspaceRowKey,
  isRowSelectable,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { AuthUser, FileItem } from '@/types/files';

export interface WorkspaceContextMenuState {
  x: number;
  y: number;
  row: WorkspaceTableRow | null;
  trigger: HTMLElement | null;
}

export interface WorkspaceKeyboardContext {
  authChecked: boolean;
  user: AuthUser | null;
  isTrashView: boolean;
  syncStore: WorkspaceSyncStore;
  selectableRowKeys: string[];
  selectedKeys: Set<string>;
  inspectorOpen: boolean;
  selectionAnchorKey: string | null;
  focusedRowKey: string | null;
  rows: WorkspaceTableRow[];
  focusedRowIndex: number;
  orderedRowKeys: string[];
  focusedRow: WorkspaceTableRow | null;
  selectedRows: WorkspaceTableRow[];
  virtualWindow: ReturnType<typeof useTableVirtualWindow>;
  router: ReturnType<typeof useRouter>;
  clipboardStore: WorkspaceClipboardStore;
  canDownloadCurrentFolder: boolean;
  lastOsPasteAtRef: { current: number };
  lastVirtualPasteAtRef: { current: number };
  setShortcutsHelpOpen: Dispatch<SetStateAction<boolean>>;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setFocusedRowKey: (rowKey: string | null) => void;
  setSelectionAnchorKey: (rowKey: string | null) => void;
  setContextMenu: Dispatch<SetStateAction<WorkspaceContextMenuState | null>>;
  scrollLinearRowIntoView: (linearIdx: number) => void;
  navigateToParentFolder: () => void;
  openPreviewForFile: (file: FileItem) => void;
  startInlineRename: (row: WorkspaceTableRow, rowIdx: number) => void;
  openClassificationPickerFromTarget: () => void;
  openShareFromTarget: () => void;
  trashSelectedOrFocused: () => void;
  getShortcutTargets: (
    explicitTargets?: WorkspaceTableRow[]
  ) => WorkspaceTableRow[];
  handleCopyTargets: (explicitTargets?: WorkspaceTableRow[]) => void;
  handleCutTargets: (explicitTargets?: WorkspaceTableRow[]) => void;
  handlePasteClipboard: (targetParentOverride?: string | null) => void;
  handleDuplicateTargets: (explicitTargets?: WorkspaceTableRow[]) => void;
  handleOpenMoveCopyModal: (
    explicitTargets?: WorkspaceTableRow[],
    modeHint?: 'move' | 'copy'
  ) => void;
  handleToggleViewMode: () => void;
  handleDownloadFile: (fileId: string) => void;
}

export function useWorkspaceKeyboard(ctx: WorkspaceKeyboardContext) {
  const {
    authChecked,
    user,
    isTrashView,
    syncStore,
    selectableRowKeys,
    selectedKeys,
    inspectorOpen,
    selectionAnchorKey,
    focusedRowKey,
    rows,
    focusedRowIndex,
    orderedRowKeys,
    focusedRow,
    selectedRows,
    virtualWindow,
    router,
    clipboardStore,
    canDownloadCurrentFolder,
    lastOsPasteAtRef,
    lastVirtualPasteAtRef,
    setShortcutsHelpOpen,
    setInspectorOpen,
    setSelectedKeys,
    setFocusedRowKey,
    setSelectionAnchorKey,
    setContextMenu,
    scrollLinearRowIntoView,
    navigateToParentFolder,
    openPreviewForFile,
    startInlineRename,
    openClassificationPickerFromTarget,
    openShareFromTarget,
    trashSelectedOrFocused,
    getShortcutTargets,
    handleCopyTargets,
    handleCutTargets,
    handlePasteClipboard,
    handleDuplicateTargets,
    handleOpenMoveCopyModal,
    handleToggleViewMode,
    handleDownloadFile,
  } = ctx;

  useEffect(() => {
    if (!authChecked || !user) return;

    function handleWorkspaceKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;

      const topScope = keyboardScopes.getTopScope();

      if (
        e.key === '?' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditableTarget(e.target) &&
        (topScope === 'workspace' || topScope === 'preview')
      ) {
        e.preventDefault();
        setShortcutsHelpOpen((prev) => !prev);
        return;
      }

      if (!shouldHandleWorkspaceKey(e, topScope)) {
        return;
      }

      if (
        !isTrashView &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'z'
      ) {
        if (!syncStore.getSnapshot().canUndo) return;
        e.preventDefault();
        void syncStore.undoLatest();
        return;
      }

      if (
        !isTrashView &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'a'
      ) {
        if (selectableRowKeys.length === 0) return;
        e.preventDefault();
        setSelectedKeys(new Set(selectableRowKeys));
        return;
      }

      if (e.key === 'Escape') {
        if (selectedKeys.size > 0) {
          e.preventDefault();
          setSelectedKeys(new Set());
          return;
        }
        if (clipboardStore.getItemCount() > 0) {
          e.preventDefault();
          clipboardStore.clear();
          return;
        }
        if (inspectorOpen) {
          e.preventDefault();
          setInspectorOpen(false);
          return;
        }
      }

      if (isTrashShortcut(e)) {
        if (isTrashView || rows.length === 0) return;
        e.preventDefault();
        trashSelectedOrFocused();
        return;
      }

      if (e.shiftKey && e.key === 'F10' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTrashView) return;
        const targetRow = focusedRow ?? selectedRows[0] ?? null;
        if (!targetRow) return;
        e.preventDefault();
        const rowKey = getWorkspaceRowKey(targetRow);
        setFocusedRowKey(rowKey);
        const resolved = resolveContextSelection(selectedKeys, rowKey);
        if (resolved.changed) {
          setSelectedKeys(resolved.selectedKeys);
          setSelectionAnchorKey(resolved.anchorKey);
        }
        const targetIdx = orderedRowKeys.indexOf(rowKey);
        const tableContainer = virtualWindow.containerRef.current;
        const rowEl =
          targetIdx >= 0
            ? tableContainer?.querySelector<HTMLElement>(
                `[data-row-index="${targetIdx}"]`
              )
            : null;
        const rect = rowEl?.getBoundingClientRect() ??
          tableContainer?.getBoundingClientRect() ?? { left: 260, top: 220 };
        setContextMenu({
          x: Math.round(rect.left + 80),
          y: Math.round(rect.top + 24),
          row: targetRow,
          trigger:
            rowEl?.querySelector<HTMLElement>('[data-row-name-trigger="true"]') ??
            rowEl ??
            tableContainer ??
            null,
        });
        return;
      }

      if (!isTrashView && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const modKey = e.key.toLowerCase();
        if (modKey === 'c') {
          const targets = getShortcutTargets();
          if (targets.length === 0) return;
          e.preventDefault();
          handleCopyTargets(targets);
          return;
        }
        if (modKey === 'x') {
          const targets = getShortcutTargets();
          if (targets.length === 0) return;
          e.preventDefault();
          handleCutTargets(targets);
          return;
        }
        if (modKey === 'v') {
          // Defer 20ms so OS `paste` event wins cleanly if clipboard carries OS files/images;
          // if browser does not dispatch native `paste` (e.g. Ctrl+V on macOS), paste virtual clipboard.
          const pressedAt = performance.now();
          window.setTimeout(() => {
            if (lastOsPasteAtRef.current >= pressedAt - 5) return;
            if (lastVirtualPasteAtRef.current >= pressedAt - 5) return;
            if (clipboardStore.getItemCount() > 0) {
              lastVirtualPasteAtRef.current = performance.now();
              handlePasteClipboard();
            }
          }, 20);
          return;
        }
        if (modKey === 'd') {
          const targets = getShortcutTargets();
          if (targets.length === 0) return;
          e.preventDefault();
          handleDuplicateTargets(targets);
          return;
        }
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const lower = e.key.toLowerCase();

      const moveFocusTo = (nextIdx: number, extendRange: boolean) => {
        const nextKey = orderedRowKeys[nextIdx];
        if (!nextKey) return;
        if (extendRange && !isTrashView) {
          const anchor = selectionAnchorKey ?? focusedRowKey ?? nextKey;
          if (!selectionAnchorKey) {
            setSelectionAnchorKey(anchor);
          }
          setSelectedKeys(selectKeyRange(orderedRowKeys, anchor, nextKey));
        } else if (!isTrashView) {
          // Google Drive parity: a bare arrow moves focus and selection together.
          setSelectedKeys(new Set([nextKey]));
          setSelectionAnchorKey(nextKey);
        }
        setFocusedRowKey(nextKey);
        scrollLinearRowIntoView(nextIdx);
        virtualWindow.containerRef.current?.focus({ preventScroll: true });
      };

      if (e.key === 'ArrowDown' || lower === 'j') {
        if (rows.length === 0) return;
        e.preventDefault();
        const nextIdx =
          focusedRowIndex < 0 ? 0 : Math.min(rows.length - 1, focusedRowIndex + 1);
        moveFocusTo(nextIdx, e.shiftKey);
        return;
      }

      if (e.key === 'ArrowUp' || lower === 'k') {
        if (rows.length === 0) return;
        e.preventDefault();
        const nextIdx =
          focusedRowIndex < 0 ? 0 : Math.max(0, focusedRowIndex - 1);
        moveFocusTo(nextIdx, e.shiftKey);
        return;
      }

      if (e.key === 'Home') {
        if (rows.length === 0) return;
        e.preventDefault();
        moveFocusTo(0, e.shiftKey);
        return;
      }

      if (e.key === 'End') {
        if (rows.length === 0) return;
        e.preventDefault();
        moveFocusTo(rows.length - 1, e.shiftKey);
        return;
      }

      if (e.key === 'F2' || lower === 'r') {
        if (isTrashView || !focusedRow || focusedRowIndex < 0) return;
        e.preventDefault();
        startInlineRename(focusedRow, focusedRowIndex);
        return;
      }

      if (e.key === 'Backspace' || lower === 'h') {
        if (isTrashView) return;
        if (e.key === 'Backspace' && isInteractiveNonRowTarget(e.target)) return;
        e.preventDefault();
        navigateToParentFolder();
        return;
      }

      if (e.key === 'Enter' || lower === 'l') {
        if (e.key === 'Enter' && isInteractiveNonRowTarget(e.target)) return;
        if (!focusedRow || isTrashView) return;
        e.preventDefault();
        if (focusedRow.kind === 'folder') {
          router.push(
            `/workspace?folderId=${encodeURIComponent(focusedRow.folder.id)}`
          );
        } else {
          openPreviewForFile(focusedRow.file);
        }
        return;
      }

      if (e.key === ' ') {
        if (isInteractiveNonRowTarget(e.target)) return;
        if (isTrashView) return;
        e.preventDefault();
        if (focusedRow?.kind === 'file') {
          openPreviewForFile(focusedRow.file);
        }
        return;
      }

      if (lower === 'x') {
        if (isTrashView || !focusedRow || !isRowSelectable(focusedRow)) return;
        e.preventDefault();
        const key = getWorkspaceRowKey(focusedRow);
        setSelectedKeys((prev) => toggleKeySelection(prev, key));
        setSelectionAnchorKey(key);
        return;
      }

      if (lower === 'm') {
        if (isTrashView) return;
        e.preventDefault();
        handleOpenMoveCopyModal();
        return;
      }

      if (lower === 'd') {
        if (isTrashView || !canDownloadCurrentFolder) return;
        const targetFile =
          focusedRow?.kind === 'file'
            ? focusedRow.file
            : selectedRows.find((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
                ?.file;
        if (targetFile && targetFile.upload_state !== 'pending' && !targetFile.optimistic) {
          e.preventDefault();
          void handleDownloadFile(targetFile.id);
        }
        return;
      }

      if (lower === 'i') {
        if (isTrashView) return;
        e.preventDefault();
        setInspectorOpen((prev) => !prev);
        return;
      }

      if (lower === 'v') {
        if (isTrashView) return;
        e.preventDefault();
        handleToggleViewMode();
        return;
      }

      if (lower === 's') {
        if (isTrashView) return;
        e.preventDefault();
        openShareFromTarget();
      }
    }

    window.addEventListener('keydown', handleWorkspaceKeyDown);
    return () => window.removeEventListener('keydown', handleWorkspaceKeyDown);
  }, [
    authChecked,
    user,
    isTrashView,
    syncStore,
    selectableRowKeys,
    selectedKeys,
    inspectorOpen,
    selectionAnchorKey,
    focusedRowKey,
    rows,
    focusedRowIndex,
    orderedRowKeys,
    focusedRowIndex,
    focusedRow,
    selectedRows,
    virtualWindow,
    scrollLinearRowIntoView,
    router,
    navigateToParentFolder,
    openPreviewForFile,
    startInlineRename,
    openClassificationPickerFromTarget,
    openShareFromTarget,
    trashSelectedOrFocused,
    canDownloadCurrentFolder,
    clipboardStore,
    getShortcutTargets,
    handleCopyTargets,
    handleCutTargets,
    handlePasteClipboard,
    handleDuplicateTargets,
    handleOpenMoveCopyModal,
    handleToggleViewMode,
  ]);
}
