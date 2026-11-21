'use client';

import { AlertCircle, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { WorkspaceBreadcrumbs } from '@/components/WorkspaceBreadcrumbs';
import { WorkspaceSelectionBar } from '@/components/WorkspaceSelectionBar';
import { WorkspaceToolbar } from '@/components/WorkspaceToolbar';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  AccessMode,
  BreadcrumbItem,
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
  viewMode,
  inspectorOpen,
  rootCreationRestricted = false,
  onNewFolder,
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
  viewMode: 'list' | 'grid';
  inspectorOpen: boolean;
  rootCreationRestricted?: boolean;
  onNewFolder: () => void;
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
            isPrivilegedAdmin={isPrivilegedAdmin}
            onCopy={onCopy}
            onCut={onCut}
            onDuplicate={onDuplicate}
            onMoveCopy={onMoveCopy}
            onBulkApproveAi={onBulkApproveAi}
            onClassify={onClassify}
            onTrash={onTrash}
            onClear={onClearSelection}
          />
        )}
      </div>
    </header>
  );
}
