'use client';

import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { useRouter } from 'next/navigation';
import type { useTableVirtualWindow } from '@/lib/use-virtual-window';
import {
  isEditableTarget,
  isImeComposingEvent,
  isTrashShortcut,
  keyboardScopes,
  shouldHandleWorkspaceKey,
} from '@/lib/keyboard-shortcuts';
import { handleWorkspaceNavigationKey } from '@/lib/keyboard/workspace-navigation';
import type { WorkspaceClipboardStore } from '@/lib/workspace-clipboard';
import { resolveContextSelection } from '@/lib/workspace-actions';
import { getWorkspaceRowKey, type WorkspaceTableRow } from '@/lib/workspace-table-row';
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
  canInspectCurrentFolder: boolean;
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
  onRedo?: () => void;
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
    canInspectCurrentFolder,
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
    onRedo,
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
        !e.altKey &&
        (((e.metaKey || e.ctrlKey) &&
          e.shiftKey &&
          e.key.toLowerCase() === 'z') ||
          (e.ctrlKey &&
            !e.metaKey &&
            !e.shiftKey &&
            e.key.toLowerCase() === 'y'))
      ) {
        if (!syncStore.getSnapshot().canRedo) return;
        e.preventDefault();
        if (onRedo) {
          onRedo();
        } else {
          void syncStore.redoLatest();
        }
        return;
      }

      if (
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

      handleWorkspaceNavigationKey(e, {
        isTrashView,
        rows,
        focusedRowIndex,
        focusedRow,
        orderedRowKeys,
        selectedRows,
        selectionAnchorKey,
        focusedRowKey,
        canDownloadCurrentFolder,
        canInspectCurrentFolder,
        setSelectedKeys,
        setFocusedRowKey,
        setSelectionAnchorKey,
        scrollLinearRowIntoView,
        virtualWindow,
        router,
        navigateToParentFolder,
        openPreviewForFile,
        startInlineRename,
        handleOpenMoveCopyModal,
        handleDownloadFile,
        setInspectorOpen,
        handleToggleViewMode,
        openShareFromTarget,
      });
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
    canInspectCurrentFolder,
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
