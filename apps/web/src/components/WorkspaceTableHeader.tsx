'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, Columns3 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { WorkspaceSelectionCheckbox } from '@/components/WorkspaceSelectionCheckbox';
import { getAriaSortValue } from '@/lib/workspace-sort-and-view';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import {
  DEFAULT_WORKSPACE_COLUMN_VISIBILITY,
  WORKSPACE_OPTIONAL_COLUMNS,
  type WorkspaceColumnVisibility,
  type WorkspaceOptionalColumnId,
} from '@/lib/workspace-table-columns';

export function WorkspaceTableHeader({
  isTrashView,
  selectableRowKeys,
  selectedRowCount,
  sortBy,
  sortDir,
  columnVisibility = DEFAULT_WORKSPACE_COLUMN_VISIBILITY,
  onToggleSelectAll,
  onSort,
  onToggleColumn,
}: {
  isTrashView: boolean;
  selectableRowKeys: string[];
  selectedRowCount: number;
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
  columnVisibility?: WorkspaceColumnVisibility;
  onToggleSelectAll: () => void;
  onSort: (field: WorkspaceSortField) => void;
  onToggleColumn?: (columnId: WorkspaceOptionalColumnId) => void;
}) {
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!columnsMenuOpen) return;
    function handleOutsideClick(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        setColumnsMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [columnsMenuOpen]);

  const columns: Array<{
    key: string;
    field?: WorkspaceSortField;
    label: string;
    sortable: boolean;
    visible: boolean;
  }> = [
    { key: 'name', field: 'name', label: '名前', sortable: true, visible: true },
    {
      key: 'classification',
      field: 'classification',
      label: isTrashView ? '削除者' : '機密分類 / AI',
      sortable: !isTrashView,
      visible: columnVisibility.classification,
    },
    {
      key: 'extension',
      label: '種類',
      sortable: false,
      visible: columnVisibility.extension,
    },
    {
      key: 'size_bytes',
      field: 'size_bytes',
      label: 'サイズ',
      sortable: !isTrashView,
      visible: columnVisibility.size,
    },
    {
      key: 'updated_at',
      field: 'updated_at',
      label: isTrashView ? '削除日時' : '更新日時',
      sortable: true,
      visible: columnVisibility.updated_at,
    },
  ];

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
        {columns
          .filter((col) => col.visible)
          .map(({ key, field, label, sortable }) => {
            const isActiveSort = Boolean(field && sortBy === field);
            return (
              <th
                key={key}
                scope="col"
                aria-sort={
                  sortable && field
                    ? getAriaSortValue(field, sortBy, sortDir)
                    : undefined
                }
                className="px-3 py-2"
              >
                {sortable && field ? (
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
          <div className="relative inline-flex items-center justify-end gap-1.5" ref={popoverRef}>
            <span>操作</span>
            {onToggleColumn && (
              <>
                <button
                  type="button"
                  data-testid="workspace-columns-toggle"
                  aria-expanded={columnsMenuOpen}
                  aria-haspopup="true"
                  onClick={() => setColumnsMenuOpen((open) => !open)}
                  className="inline-flex h-6 items-center gap-1 rounded border border-[#e1e1e4] bg-white px-1.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
                  title="表示する列を切り替え"
                >
                  <Columns3 className="h-3 w-3" />
                  <span>列</span>
                </button>
                {columnsMenuOpen && (
                  <div
                    data-testid="workspace-columns-popover"
                    role="dialog"
                    aria-label="表示列の設定"
                    className="absolute right-0 top-7 z-30 w-40 rounded-lg border border-[#e1e1e4] bg-white p-2 text-left shadow-lg"
                  >
                    <div className="mb-1 px-1 text-[0.625rem] font-semibold text-[#6b6f76]">
                      表示する列
                    </div>
                    <div className="space-y-1">
                      {WORKSPACE_OPTIONAL_COLUMNS.map((col) => (
                        <label
                          key={col.id}
                          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[0.75rem] font-normal text-[#111214] hover:bg-[#f5f5f7]"
                        >
                          <input
                            type="checkbox"
                            data-testid={`workspace-col-checkbox-${col.id}`}
                            checked={columnVisibility[col.id]}
                            onChange={() => onToggleColumn(col.id)}
                            className="h-3.5 w-3.5 rounded border-slate-300 accent-[#5e6ad2]"
                          />
                          <span>{col.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </th>
      </tr>
    </thead>
  );
}
