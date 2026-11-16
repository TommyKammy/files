'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { WorkspaceEmptyState } from '@/components/WorkspaceEmptyState';
import { WorkspaceGridBody } from '@/components/WorkspaceGridBody';
import { WorkspaceTableBody } from '@/components/WorkspaceTableBody';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';

function TrashErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-[240px] flex-col items-center justify-center px-6 py-12 text-center"
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-red-200 bg-red-50 text-red-600">
        <AlertTriangle className="h-4 w-4" />
      </div>
      <p className="mt-3 text-[0.8125rem] font-medium text-[#111214]">
        ゴミ箱の取得に失敗しました
      </p>
      <p className="mt-1 max-w-sm text-[0.6875rem] leading-relaxed text-[#6b6f76]">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex h-7 items-center rounded-md border border-[#d9d9de] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
      >
        再試行
      </button>
    </div>
  );
}

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
  trashError,
  trashFilterActive,
  marqueeSurfaceRef,
  containerRef,
  onMarqueePointerDown,
  onBackgroundContextMenu,
  onBackgroundEmptyClick,
  onToggleSelectAll,
  onSort,
  onLoadMore,
  onRetryTrash,
  onClearTrashFilters,
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
  trashError: string | null;
  trashFilterActive: boolean;
  marqueeSurfaceRef: RefObject<HTMLDivElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  onMarqueePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onBackgroundContextMenu: (event: React.MouseEvent) => void;
  onBackgroundEmptyClick: (event: React.MouseEvent) => void;
  onToggleSelectAll: () => void;
  onSort: (field: WorkspaceSortField) => void;
  onLoadMore: () => void;
  onRetryTrash: () => void;
  onClearTrashFilters: () => void;
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
      {isTrashView && trashError && rowCount > 0 && (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
        >
          <span className="inline-flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {trashError}
          </span>
          <button
            type="button"
            onClick={onRetryTrash}
            className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-900 hover:bg-amber-100"
          >
            再試行
          </button>
        </div>
      )}
      <section
        className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white"
        aria-busy={isInitialLoading || loadingMore}
      >
        {isInitialLoading ? (
          <div className="flex h-48 items-center justify-center text-sm text-slate-500">
            <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
            読み込み中...
          </div>
        ) : rowCount === 0 ? (
          isTrashView && trashError ? (
            <TrashErrorState message={trashError} onRetry={onRetryTrash} />
          ) : (
            <WorkspaceEmptyState
              isTrashView={isTrashView}
              folderId={folderId}
              trashFilterActive={trashFilterActive}
              onClearTrashFilters={onClearTrashFilters}
              onContextMenu={onBackgroundContextMenu}
              onClick={onBackgroundEmptyClick}
            />
          )
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
