'use client';

import { AlertCircle, Filter, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { WorkspaceBreadcrumbs } from '@/components/WorkspaceBreadcrumbs';
import { WorkspaceSelectionBar } from '@/components/WorkspaceSelectionBar';
import { WorkspaceToolbar } from '@/components/WorkspaceToolbar';
import type { OfficeDocumentKind } from '@/lib/files-api/create-office';
import {
  isWorkspaceFilterActive,
  type WorkspaceQuickFilter,
  type WorkspaceQuickFilterItemType,
} from '@/lib/workspace-filter';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  AccessMode,
  BreadcrumbItem,
  ClassificationLabel,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export type SortDrainStatus = 'idle' | 'syncing' | 'error';

export function WorkspaceMainHeader({
  isTrashView,
  accessMode,
  folderId,
  breadcrumbs,
  currentFolder,
  effectiveRole,
  nextCursor,
  sortBy,
  sortDir,
  sortDrainStatus = 'idle',
  onRetrySortDrain,
  selectedRows,
  canCreateFolder,
  canCreateOfficeDoc = false,
  canRenameCurrentFolder,
  canShareCurrentFolder,
  canManageCurrentFolderPerms,
  canInviteCurrentFolder = false,
  canInspectCurrentFolder,
  isPrivilegedAdmin,
  canCopySelection,
  canCutSelection,
  canDuplicateSelection,
  canMoveCopySelection,
  canClassifySelection,
  canTrashSelection,
  canDownloadSelection = false,
  downloadingZip = false,
  viewMode,
  inspectorOpen,
  rootCreationRestricted = false,
  quickFilter,
  onQuickFilterChange,
  onClearQuickFilter,
  onNewFolder,
  onCreateOfficeDoc,
  onTogglePin,
  onOpenFileRequest,
  onOpenShare,
  onOpenPermissions,
  onToggleViewMode,
  onToggleInspector,
  onOpenShortcuts,
  onCopy,
  onCut,
  onDuplicate,
  onMoveCopy,
  onBulkApproveAi,
  onClassify,
  onTrash,
  onDownloadZip,
  onClearSelection,
}: {
  isTrashView: boolean;
  accessMode?: AccessMode | null;
  folderId: string | null;
  breadcrumbs: BreadcrumbItem[];
  currentFolder: FolderSummary | null;
  effectiveRole: ResourceRole;
  nextCursor: string | null;
  sortBy: WorkspaceSortField;
  sortDir: WorkspaceSortDirection;
  sortDrainStatus?: SortDrainStatus;
  onRetrySortDrain?: () => void;
  selectedRows: WorkspaceTableRow[];
  canCreateFolder: boolean;
  canCreateOfficeDoc?: boolean;
  canRenameCurrentFolder: boolean;
  canShareCurrentFolder: boolean;
  canManageCurrentFolderPerms: boolean;
  canInviteCurrentFolder?: boolean;
  canInspectCurrentFolder: boolean;
  isPrivilegedAdmin: boolean;
  canCopySelection: boolean;
  canCutSelection: boolean;
  canDuplicateSelection: boolean;
  canMoveCopySelection: boolean;
  canClassifySelection: boolean;
  canTrashSelection: boolean;
  canDownloadSelection?: boolean;
  downloadingZip?: boolean;
  viewMode: 'list' | 'grid';
  inspectorOpen: boolean;
  rootCreationRestricted?: boolean;
  quickFilter?: WorkspaceQuickFilter;
  onQuickFilterChange?: (next: WorkspaceQuickFilter) => void;
  onClearQuickFilter?: () => void;
  onNewFolder: () => void;
  onCreateOfficeDoc?: (kind: OfficeDocumentKind) => void;
  onTogglePin: (folder: FolderSummary) => void;
  onOpenFileRequest: () => void;
  onOpenShare: () => void;
  onOpenPermissions: () => void;
  onToggleViewMode: () => void;
  onToggleInspector: () => void;
  onOpenShortcuts: () => void;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onMoveCopy: () => void;
  onBulkApproveAi: () => void;
  onClassify: () => void;
  onTrash: () => void;
  onDownloadZip?: () => void;
  onClearSelection: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 space-y-1">
        {isTrashView ? (
          <div className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-slate-600" />
            <h1 className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-[#111214]">
              ゴミ箱
            </h1>
          </div>
        ) : (
          <WorkspaceBreadcrumbs
            folderId={folderId ?? null}
            breadcrumbs={breadcrumbs}
          />
        )}

        {!isTrashView &&
          (currentFolder ||
            (nextCursor &&
              (sortBy !== 'name' || sortDir !== 'asc') &&
              sortDrainStatus !== 'idle')) && (
            <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-[#6b6f76]">
              {currentFolder && (
                <>
                  <ClassificationBadge
                    classification={currentFolder.classification}
                    compact
                  />
                  {accessMode === 'path' ? (
                    <span className="inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[0.6875rem] font-medium text-sky-700">
                      途中階層 (パスのみ)
                    </span>
                  ) : (
                    <span>実効ロール: {effectiveRole}</span>
                  )}
                </>
              )}
              {nextCursor &&
                (sortBy !== 'name' || sortDir !== 'asc') &&
                sortDrainStatus === 'syncing' && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[0.6875rem] font-medium text-amber-700">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    <span>ソート全件同期中...</span>
                  </span>
                )}
              {nextCursor &&
                (sortBy !== 'name' || sortDir !== 'asc') &&
                sortDrainStatus === 'error' && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[0.6875rem] font-medium text-red-700">
                    <AlertCircle className="h-3 w-3" />
                    <span>ソート全件同期に失敗</span>
                    {onRetrySortDrain && (
                      <button
                        type="button"
                        onClick={onRetrySortDrain}
                        className="inline-flex items-center gap-0.5 rounded px-1 py-0.25 text-red-800 underline decoration-red-400 underline-offset-2 hover:bg-red-100"
                      >
                        <RefreshCw className="h-2.5 w-2.5" />
                        <span>再試行</span>
                      </button>
                    )}
                  </span>
                )}
            </div>
          )}
      </div>

      <div className="relative flex w-full min-w-0 flex-wrap items-center gap-1.5">
        <WorkspaceToolbar
          isTrashView={isTrashView}
          hasSelection={!isTrashView && selectedRows.length > 0}
          canCreateFolder={canCreateFolder}
          canCreateOfficeDoc={canCreateOfficeDoc}
          canRenameCurrentFolder={canRenameCurrentFolder}
          canShareCurrentFolder={canShareCurrentFolder}
          canManageCurrentFolderPerms={canManageCurrentFolderPerms}
          canInviteCurrentFolder={canInviteCurrentFolder}
          canInspectCurrentFolder={canInspectCurrentFolder}
          currentFolder={currentFolder}
          viewMode={viewMode}
          inspectorOpen={inspectorOpen}
          rootCreationRestricted={rootCreationRestricted}
          onNewFolder={onNewFolder}
          onCreateOfficeDoc={onCreateOfficeDoc}
          onTogglePin={onTogglePin}
          onOpenFileRequest={onOpenFileRequest}
          onOpenShare={onOpenShare}
          onOpenPermissions={onOpenPermissions}
          onToggleViewMode={onToggleViewMode}
          onToggleInspector={onToggleInspector}
          onOpenShortcuts={onOpenShortcuts}
        />

        {!isTrashView && selectedRows.length > 0 && (
          <WorkspaceSelectionBar
            selectedRows={selectedRows}
            canCopySelection={canCopySelection}
            canCutSelection={canCutSelection}
            canDuplicateSelection={canDuplicateSelection}
            canMoveCopySelection={canMoveCopySelection}
            canClassifySelection={canClassifySelection}
            canTrashSelection={canTrashSelection}
            canDownloadSelection={canDownloadSelection}
            downloadingZip={downloadingZip}
            isPrivilegedAdmin={isPrivilegedAdmin}
            onCopy={onCopy}
            onCut={onCut}
            onDuplicate={onDuplicate}
            onMoveCopy={onMoveCopy}
            onBulkApproveAi={onBulkApproveAi}
            onClassify={onClassify}
            onTrash={onTrash}
            onDownloadZip={onDownloadZip}
            onClear={onClearSelection}
          />
        )}
      </div>

      {!isTrashView && quickFilter && onQuickFilterChange && (
        <div
          role="search"
          aria-label="フォルダ内クイックフィルタ"
          className="flex w-full flex-wrap items-center gap-2 rounded-lg border border-[#e7e7ea] bg-white px-2.5 py-1.5"
        >
          <Filter className="h-3.5 w-3.5 shrink-0 text-[#6b6f76]" />
          <input
            type="search"
            value={quickFilter.query}
            onChange={(e) =>
              onQuickFilterChange({ ...quickFilter, query: e.target.value })
            }
            placeholder="このフォルダ内を名前で絞り込み..."
            aria-label="フォルダ内を名前で絞り込み"
            data-testid="in-folder-filter-input"
            className="h-7 min-w-[180px] flex-1 rounded border border-[#e1e1e4] bg-[#fafafa] px-2.5 text-[0.75rem] text-[#111214] placeholder:text-[#8c919b] focus:border-[#5e6ad2] focus:bg-white focus:outline-none"
          />
          <select
            aria-label="種別で絞り込み"
            value={quickFilter.itemType}
            onChange={(e) =>
              onQuickFilterChange({
                ...quickFilter,
                itemType: e.target.value as WorkspaceQuickFilterItemType,
              })
            }
            data-testid="in-folder-filter-type"
            className="h-7 rounded border border-[#e1e1e4] bg-white px-2 text-[0.75rem] text-[#3c3f46] focus:border-[#5e6ad2] focus:outline-none"
          >
            <option value="all">すべて</option>
            <option value="folder">フォルダ</option>
            <option value="file">ファイル</option>
          </select>
          <select
            aria-label="機密区分で絞り込み"
            value={quickFilter.classification}
            onChange={(e) =>
              onQuickFilterChange({
                ...quickFilter,
                classification: e.target.value as 'all' | ClassificationLabel,
              })
            }
            data-testid="in-folder-filter-classification"
            className="h-7 rounded border border-[#e1e1e4] bg-white px-2 text-[0.75rem] text-[#3c3f46] focus:border-[#5e6ad2] focus:outline-none"
          >
            <option value="all">すべての区分</option>
            <option value="unset">未設定</option>
            <option value="public">公開</option>
            <option value="internal">社内限定</option>
            <option value="confidential">社外秘</option>
          </select>
          {isWorkspaceFilterActive(quickFilter) && onClearQuickFilter && (
            <button
              type="button"
              onClick={onClearQuickFilter}
              data-testid="in-folder-filter-clear"
              className="inline-flex h-7 items-center gap-1 rounded border border-[#e1e1e4] bg-[#f4f4f6] px-2 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#e9e9ed] hover:text-[#111214]"
            >
              <X className="h-3 w-3" />
              <span>クリア</span>
            </button>
          )}
        </div>
      )}
    </header>
  );
}
