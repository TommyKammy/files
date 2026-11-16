'use client';

import { Loader2 } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { WorkspaceEmptyState } from '@/components/WorkspaceEmptyState';
import { WorkspaceGridBody } from '@/components/WorkspaceGridBody';
import { WorkspaceTableBody } from '@/components/WorkspaceTableBody';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';

export function WorkspaceFileListSection({
  viewMode,
  isInitialLoading,
  isTrashView,
  folderId,
  rowCount,
  visibleRows,
  visibleGridRows,
  virtualWindow,
  gridColumns,
  selectableRowKeys,
  selectedRowCount,
  sortBy,
  sortDir,
  nextCursor,
  loadingMore,
  marqueeSurfaceRef,
  containerRef,
  onMarqueePointerDown,
  onBackgroundContextMenu,
  onBackgroundEmptyClick,
  onToggleSelectAll,
  onSort,
  onLoadMore,
  registerScrollContainer,
  renderCard,
  renderRow,
}: {
  viewMode: 'list' | 'grid';
  isInitialLoading: boolean;
  isTrashView: boolean;
  folderId: string | null;
  rowCount: number;
  visibleRows: WorkspaceTableRow[];
  visibleGridRows: WorkspaceTableRow[][];
  virtualWindow: {
    containerRef: RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    startIndex: number;
    topSpacerPx: number;
    bottomSpacerPx: number;
    virtualized: boolean;
  };
  gridColumns: number;
  selectableRowKeys: string[];
  selectedRowCount: number;
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
  nextCursor: string | null;
  loadingMore: boolean;
  marqueeSurfaceRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  onMarqueePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onBackgroundContextMenu: (event: React.MouseEvent) => void;
  onBackgroundEmptyClick: (event: React.MouseEvent) => void;
  onToggleSelectAll: () => void;
  onSort: (field: WorkspaceSortField) => void;
  onLoadMore: () => void;
  registerScrollContainer: (element: HTMLDivElement) => void;
  renderCard: (row: WorkspaceTableRow, globalIdx: number) => ReactNode;
  renderRow: (row: WorkspaceTableRow, globalIdx: number) => ReactNode;
}) {
  return (
    <div
      ref={marqueeSurfaceRef}
      data-marquee-surface="true"
      onPointerDown={onMarqueePointerDown}
      onContextMenu={onBackgroundContextMenu}
      className="-mx-6 px-6 lg:-mx-8 lg:px-8"
    >
      <section className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
        {isInitialLoading ? (
          <div className="flex h-48 items-center justify-center text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
            読み込み中...
          </div>
        ) : rowCount === 0 ? (
          <WorkspaceEmptyState
            isTrashView={isTrashView}
            folderId={folderId}
            onContextMenu={onBackgroundContextMenu}
            onClick={onBackgroundEmptyClick}
          />
        ) : (
          <div
            ref={(el) => {
              (containerRef as {
                current: HTMLDivElement | null;
              }).current = el;
              if (el) registerScrollContainer(el);
            }}
            onScroll={virtualWindow.onScroll}
            onContextMenu={onBackgroundContextMenu}
            role="region"
            aria-label="ファイルとフォルダの一覧"
            tabIndex={0}
            data-workspace-table="true"
            className={`min-h-[420px] overflow-x-auto ${
              virtualWindow.virtualized
                ? 'max-h-[68vh] overflow-y-auto'
                : ''
            }`}
          >
            {viewMode === 'grid' ? (
              <WorkspaceGridBody
                visibleRows={visibleGridRows}
                startIndex={virtualWindow.startIndex}
                columns={gridColumns}
                topSpacerPx={virtualWindow.topSpacerPx}
                bottomSpacerPx={virtualWindow.bottomSpacerPx}
                renderCard={renderCard}
              />
            ) : (
              <WorkspaceTableBody
                rowCount={rowCount}
                visibleRows={visibleRows}
                startIndex={virtualWindow.startIndex}
                topSpacerPx={virtualWindow.topSpacerPx}
                bottomSpacerPx={virtualWindow.bottomSpacerPx}
                isTrashView={isTrashView}
                selectableRowKeys={selectableRowKeys}
                selectedRowCount={selectedRowCount}
                sortBy={sortBy}
                sortDir={sortDir}
                onToggleSelectAll={onToggleSelectAll}
                onSort={onSort}
                renderRow={renderRow}
              />
            )}
          </div>
        )}

        {nextCursor && (
          <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-center">
            <button
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
              className="inline-flex items-center gap-2 h-7 rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
            >
              {loadingMore && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              <span>さらに読み込む</span>
            </button>
          </div>
        )}
      </section>
      <div
        aria-hidden="true"
        data-background-surface="true"
        className="min-h-[96px]"
        onClick={onBackgroundEmptyClick}
        onContextMenu={onBackgroundContextMenu}
      />
    </div>
  );
}
