'use client';

import type { ReactNode } from 'react';
import { WorkspaceTableHeader } from '@/components/WorkspaceTableHeader';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
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
  onToggleSelectAll,
  onSort,
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
  onToggleSelectAll: () => void;
  onSort: (field: WorkspaceSortField) => void;
  renderRow: (row: WorkspaceTableRow, globalIdx: number) => ReactNode;
}) {
  return (
    <table
      role="grid"
      aria-labelledby="workspace-table-caption"
      aria-multiselectable="true"
      aria-rowcount={rowCount + 1}
      aria-colcount={6}
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
        onToggleSelectAll={onToggleSelectAll}
        onSort={onSort}
      />
      <tbody className="divide-y divide-[#f0f0f1]">
        {topSpacerPx > 0 && (
          <tr aria-hidden="true">
            <td
              colSpan={6}
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
              colSpan={6}
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
