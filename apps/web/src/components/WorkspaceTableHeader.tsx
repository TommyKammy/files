'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { WorkspaceSelectionCheckbox } from '@/components/WorkspaceSelectionCheckbox';
import { getAriaSortValue } from '@/lib/workspace-sort-and-view';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';

export function WorkspaceTableHeader({
  isTrashView,
  selectableRowKeys,
  selectedRowCount,
  sortBy,
  sortDir,
  onToggleSelectAll,
  onSort,
}: {
  isTrashView: boolean;
  selectableRowKeys: string[];
  selectedRowCount: number;
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
  onToggleSelectAll: () => void;
  onSort: (field: WorkspaceSortField) => void;
}) {
  return (
    <thead className="sticky top-0 z-10 border-b border-[#ededf0] bg-[#fbfbfc]/95 text-[0.6875rem] font-medium tracking-normal text-[#6b6f76] backdrop-blur-xs">
      <tr aria-rowindex={1}>
        <th scope="col" className="w-10 px-3 py-2">
          {selectableRowKeys.length > 0 && (
            <WorkspaceSelectionCheckbox
              checked={
                selectedRowCount > 0 &&
                selectedRowCount === selectableRowKeys.length
              }
              label="すべて選択"
              onClick={onToggleSelectAll}
            />
          )}
        </th>
        {(
          [
            { field: 'name', label: '名前', sortable: true },
            {
              field: 'classification',
              label: isTrashView ? '削除者' : '機密分類 / AI',
              sortable: !isTrashView,
            },
            { field: 'size_bytes', label: 'サイズ', sortable: !isTrashView },
            {
              field: 'updated_at',
              label: isTrashView ? '削除日時' : '更新日時',
              sortable: true,
            },
          ] as const
        ).map(({ field, label, sortable }) => {
          const isActiveSort = sortBy === field;
          return (
            <th
              key={field}
              scope="col"
              aria-sort={
                sortable
                  ? getAriaSortValue(field, sortBy, sortDir)
                  : undefined
              }
              className="px-3 py-2"
            >
              {sortable ? (
                <button
                  type="button"
                  onClick={() => onSort(field)}
                  className={`inline-flex min-h-6 items-center gap-1 rounded px-1 py-0.5 transition hover:bg-slate-200/60 hover:text-slate-900 ${
                    isActiveSort ? 'text-slate-900' : 'text-slate-500'
                  }`}
                >
                  <span>{label}</span>
                  {isActiveSort ? (
                    sortDir === 'asc' ? (
                      <ArrowUp className="h-3 w-3 text-blue-600" />
                    ) : (
                      <ArrowDown className="h-3 w-3 text-blue-600" />
                    )
                  ) : (
                    <ArrowUpDown className="h-3 w-3 opacity-40" />
                  )}
                </button>
              ) : (
                <span className="px-1 text-slate-500">{label}</span>
              )}
            </th>
          );
        })}
        <th scope="col" className="px-3 py-2 text-right">
          操作
        </th>
      </tr>
    </thead>
  );
}
