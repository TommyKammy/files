'use client';

import { useCallback, useMemo } from 'react';
import { chunkItemsIntoGridRows } from '@/lib/workspace-sort-and-view';
import { useTableVirtualWindow } from '@/lib/use-virtual-window';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';

const GRID_COLUMNS = 4;

export function useWorkspaceVirtualization({
  rows,
  viewMode,
}: {
  rows: WorkspaceTableRow[];
  viewMode: 'list' | 'grid';
}) {
  const gridRows = useMemo(
    () => chunkItemsIntoGridRows(rows, GRID_COLUMNS),
    [rows]
  );

  const virtualItemCount = viewMode === 'grid' ? gridRows.length : rows.length;
  const virtualWindow = useTableVirtualWindow(virtualItemCount, {
    rowHeight: viewMode === 'grid' ? 156 : 52,
    overscan: viewMode === 'grid' ? 4 : 10,
    threshold: viewMode === 'grid' ? 12 : 40,
  });

  const visibleRows = useMemo(
    () =>
      viewMode === 'list'
        ? rows.slice(virtualWindow.startIndex, virtualWindow.endIndex)
        : [],
    [viewMode, rows, virtualWindow.startIndex, virtualWindow.endIndex]
  );

  const visibleGridRows = useMemo(
    () =>
      viewMode === 'grid'
        ? gridRows.slice(virtualWindow.startIndex, virtualWindow.endIndex)
        : [],
    [viewMode, gridRows, virtualWindow.startIndex, virtualWindow.endIndex]
  );

  const scrollLinearRowIntoView = useCallback(
    (linearIdx: number) => {
      const targetIdx =
        viewMode === 'grid'
          ? Math.floor(linearIdx / GRID_COLUMNS)
          : linearIdx;
      virtualWindow.scrollRowIntoView(targetIdx);
    },
    [viewMode, virtualWindow]
  );

  return {
    GRID_COLUMNS,
    gridRows,
    virtualItemCount,
    virtualWindow,
    visibleRows,
    visibleGridRows,
    scrollLinearRowIntoView,
  };
}
