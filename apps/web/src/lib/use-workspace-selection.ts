'use client';

import { useCallback, useMemo } from 'react';
import {
  selectKeyRange,
  toggleKeySelection,
} from '@/lib/keyboard-shortcuts';
import { resolvePointerSelection } from '@/lib/workspace-actions';
import {
  getWorkspaceRowKey,
  isRowSelectable,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';

export function useWorkspaceSelection({
  rows,
  isTrashView,
  focusedRowKey,
  setFocusedRowKey,
  selectedKeys,
  setSelectedKeys,
  selectionAnchorKey,
  setSelectionAnchorKey,
}: {
  rows: WorkspaceTableRow[];
  isTrashView: boolean;
  focusedRowKey: string | null;
  setFocusedRowKey: (rowKey: string | null) => void;
  selectedKeys: Set<string>;
  setSelectedKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  selectionAnchorKey: string | null;
  setSelectionAnchorKey: (rowKey: string | null) => void;
}) {

  const orderedRowKeys = useMemo(
    () => rows.map(getWorkspaceRowKey),
    [rows]
  );

  const focusedRowIndex = useMemo(() => {
    if (!focusedRowKey) return -1;
    return orderedRowKeys.indexOf(focusedRowKey);
  }, [orderedRowKeys, focusedRowKey]);

  const focusedRow =
    focusedRowIndex >= 0 ? rows[focusedRowIndex] ?? null : null;

  const selectedRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          isRowSelectable(row) &&
          selectedKeys.has(getWorkspaceRowKey(row))
      ),
    [rows, selectedKeys]
  );

  const selectableRowKeys = useMemo(
    () => rows.filter(isRowSelectable).map(getWorkspaceRowKey),
    [rows]
  );

  /**
   * Google Drive-compatible pointer selection:
   * - plain click: exclusive selection
   * - ⌘/Ctrl+click: toggle
   * - Shift+click: range from the anchor
   */
  const selectRowFromPointer = useCallback(
    (
      event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
      rowKey: string,
      selectable: boolean
    ) => {
      if (!selectable) return;
      setFocusedRowKey(rowKey);
      const resolved = resolvePointerSelection({
        orderedKeys: orderedRowKeys,
        selectedKeys,
        anchorKey: selectionAnchorKey,
        rowKey,
        modifiers: event,
      });
      setSelectedKeys(resolved.selectedKeys);
      setSelectionAnchorKey(resolved.anchorKey);
    },
    [orderedRowKeys, selectedKeys, selectionAnchorKey]
  );

  const selectRowCheckbox = useCallback(
    (
      event: { shiftKey: boolean },
      row: WorkspaceTableRow,
      rowKey: string
    ) => {
      if (!isRowSelectable(row)) return;
      setFocusedRowKey(rowKey);
      if (event.shiftKey && selectionAnchorKey) {
        setSelectedKeys(
          selectKeyRange(orderedRowKeys, selectionAnchorKey, rowKey)
        );
      } else {
        setSelectedKeys((prev) => toggleKeySelection(prev, rowKey));
        setSelectionAnchorKey(rowKey);
      }
    },
    [orderedRowKeys, selectionAnchorKey]
  );

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
  }, []);

  return {
    focusedRowKey,
    setFocusedRowKey,
    selectedKeys,
    setSelectedKeys,
    selectionAnchorKey,
    setSelectionAnchorKey,
    orderedRowKeys,
    focusedRowIndex,
    focusedRow,
    selectedRows,
    selectableRowKeys,
    selectRowFromPointer,
    selectRowCheckbox,
    clearSelection,
  };
}
