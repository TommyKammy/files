'use client';

import type { ReactNode } from 'react';
import { WorkspaceTableHeader } from '@/components/WorkspaceTableHeader';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import {
  countVisibleWorkspaceColumns,
  DEFAULT_WORKSPACE_COLUMN_VISIBILITY,
  type WorkspaceColumnVisibility,
  type WorkspaceOptionalColumnId,
} from '@/lib/workspace-table-columns';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';

export function WorkspaceTableBody({
  rowCount,
  visibleRows,
  startIndex,
  topSpacerPx,
  bottomSpacerPx,
  isTrashView,
  selectableRowKeys,
  selectedRowCount,
  sortBy,
  sortDir,
  columnVisibility = DEFAULT_WORKSPACE_COLUMN_VISIBILITY,
  onToggleSelectAll,
  onSort,
  onToggleColumn,
  renderRow,
}: {
  rowCount: number;
  visibleRows: WorkspaceTableRow[];
  startIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  isTrashView: boolean;
  selectableRowKeys: string[];
  selectedRowCount: number;
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
  columnVisibility?: WorkspaceColumnVisibility;
  onToggleSelectAll: () => void;
  onSort: (field: WorkspaceSortField) => void;
  onToggleColumn?: (columnId: WorkspaceOptionalColumnId) => void;
  renderRow: (row: WorkspaceTableRow, globalIdx: number) => ReactNode;
}) {
  const colCount = countVisibleWorkspaceColumns(columnVisibility);
  return (
    <table
      role="grid"
      aria-labelledby="workspace-table-caption"
      aria-multiselectable="true"
      aria-rowcount={rowCount + 1}
      aria-colcount={colCount}
      className="w-full text-left text-xs"
    >
      <caption id="workspace-table-caption" className="sr-only">
        ファイルとフォルダの一覧
      </caption>
      <WorkspaceTableHeader
        isTrashView={isTrashView}
        selectableRowKeys={selectableRowKeys}
        selectedRowCount={selectedRowCount}
        sortBy={sortBy}
        sortDir={sortDir}
        columnVisibility={columnVisibility}
        onToggleSelectAll={onToggleSelectAll}
        onSort={onSort}
        onToggleColumn={onToggleColumn}
      />
      <tbody className="divide-y divide-[#f0f0f1]">
        {topSpacerPx > 0 && (
          <tr aria-hidden="true">
            <td
              colSpan={colCount}
              style={{
                height: `${topSpacerPx}px`,
                padding: 0,
                border: 0,
              }}
            />
          </tr>
        )}

        {visibleRows.map((row, sliceIdx) =>
          renderRow(row, startIndex + sliceIdx)
        )}

        {bottomSpacerPx > 0 && (
          <tr aria-hidden="true">
            <td
              colSpan={colCount}
              style={{
                height: `${bottomSpacerPx}px`,
                padding: 0,
                border: 0,
              }}
            />
          </tr>
        )}
      </tbody>
    </table>
  );
}
