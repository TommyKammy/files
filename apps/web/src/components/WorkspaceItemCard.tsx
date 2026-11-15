'use client';

import {
  FileText,
  Folder,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type { Dispatch, MouseEvent, SetStateAction } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { WorkspaceSelectionCheckbox } from '@/components/WorkspaceSelectionCheckbox';
import { formatBytes, formatDateTime, isPdfFile } from '@/lib/formatters';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import type { IntentPrefetcher } from '@/lib/intent-prefetch';
import {
  getWorkspaceRowKey,
  isRowControlTarget,
  type InlineRenameState,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type { FileItem, FolderSummary } from '@/types/files';

export function WorkspaceItemCard({
  row,
  globalIdx,
  isFocused,
  isSelected,
  rowSelectable,
  isTrashView,
  isInlineRenaming,
  isPendingUpload,
  isCut,
  isContextMenuOpen,
  dropClass,
  inlineRename,
  inlineInputRef,
  inlineCommittedRef,
  prefetcher,
  onCheckboxClick,
  onPointerDown,
  onSelectRow,
  onOpenRow,
  onOpenContextMenu,
  onRestoreFolder,
  onRestoreFile,
  onSetInlineRename,
  onCommitInlineRename,
  onFocusRow,
}: {
  row: WorkspaceTableRow;
  globalIdx: number;
  isFocused: boolean;
  isSelected: boolean;
  rowSelectable: boolean;
  isTrashView: boolean;
  isInlineRenaming: boolean;
  isPendingUpload: boolean;
  isCut: boolean;
  isContextMenuOpen: boolean;
  dropClass: string;
  inlineRename: InlineRenameState | null;
  inlineInputRef: React.RefObject<HTMLInputElement | null>;
  inlineCommittedRef: React.MutableRefObject<string | null>;
  prefetcher: IntentPrefetcher;
  onCheckboxClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onSelectRow: (
    event: MouseEvent<HTMLDivElement>,
    rowKey: string,
    rowSelectable: boolean
  ) => void;
  onOpenRow: (row: WorkspaceTableRow) => void;
  onOpenContextMenu: (
    event: MouseEvent<HTMLElement>,
    row: WorkspaceTableRow
  ) => void;
  onRestoreFolder: (folder: FolderSummary) => void;
  onRestoreFile: (file: FileItem) => void;
  onSetInlineRename: Dispatch<SetStateAction<InlineRenameState | null>>;
  onCommitInlineRename: () => void;
  onFocusRow: (rowKey: string) => void;
}) {
  const rowKey = getWorkspaceRowKey(row);
  const isFolder = row.kind === 'folder';
  const folder = isFolder ? row.folder : null;
  const file = !isFolder ? row.file : null;
  const isDropEligible = Boolean(
    folder && !isTrashView && folder.deleted_at == null
  );

  return (
    <div
      key={rowKey}
      data-row-index={globalIdx}
      data-drop-folder-id={isDropEligible && folder ? folder.id : undefined}
      data-drop-label={isDropEligible && folder ? folder.name : undefined}
      onContextMenu={(e) => {
        if (isTrashView || isInlineRenaming || isPendingUpload) return;
        onOpenContextMenu(e, row);
      }}
      onPointerDown={(e) => {
        if (isInlineRenaming || isPendingUpload) return;
        onPointerDown(e);
      }}
      onClick={(e) => {
        if (isInlineRenaming || isRowControlTarget(e.target)) return;
        onSelectRow(e, rowKey, rowSelectable);
      }}
      onDoubleClick={(e) => {
        if (isTrashView || isInlineRenaming || isPendingUpload) return;
        if (isRowControlTarget(e.target)) return;
        onOpenRow(row);
      }}
      className={`flex h-[136px] flex-col justify-between rounded-lg border p-3 transition-colors ${
        dropClass
          ? dropClass
          : isPendingUpload
            ? 'border-blue-200 bg-blue-50/40'
            : isSelected
              ? 'border-[#c9cfee] bg-[#eef0fb]'
              : isFocused
                ? 'border-[#bcc3ea] bg-white'
                : 'border-[#e7e7ea] bg-white hover:border-[#d7d7dc] hover:bg-[#f6f6f8]'
      } ${isCut ? 'opacity-50 outline-1 outline-dashed outline-amber-400' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {rowSelectable && (
            <WorkspaceSelectionCheckbox
              checked={isSelected}
              label={`${isFolder ? folder!.name : file!.name} を選択`}
              onClick={(e) => {
                e.stopPropagation();
                if (rowSelectable) onCheckboxClick(e);
              }}
            />
          )}
          {isFolder ? (
            <Folder className="h-4 w-4 shrink-0 text-[#6b6f76]" />
          ) : isPendingUpload ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-[#6b6f76]" />
          )}
          {!isFolder && file && isPendingUpload && (
            <span className="rounded-full bg-blue-100 px-1.5 py-0.5 font-mono text-[0.625rem] text-blue-700">
              {file.upload_progress ?? 0}%
            </span>
          )}
          {!isFolder &&
            file &&
            !isPendingUpload &&
            file.current_version_num > 1 && (
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.625rem] text-slate-500">
                v{file.current_version_num}
              </span>
            )}
        </div>

        {isTrashView ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (folder) onRestoreFolder(folder);
              else if (file) onRestoreFile(file);
            }}
            className="inline-flex min-h-6 items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-100"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            <span>復元</span>
          </button>
        ) : !isPendingUpload ? (
          <button
            type="button"
            title="その他の操作"
            aria-haspopup="menu"
            aria-label={`${isFolder ? folder!.name : file!.name} のその他の操作`}
            data-row-action-trigger="true"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenContextMenu(e, row);
            }}
            className="rounded p-1 text-[#a0a0a7] transition hover:bg-[#f0f0f2] hover:text-[#111214]"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      <div className="min-w-0">
        {isInlineRenaming && inlineRename ? (
          <input
            ref={inlineInputRef}
            name="renameValue"
            aria-label="名前を変更"
            type="text"
            value={inlineRename.value}
            onChange={(e) =>
              onSetInlineRename((prev) =>
                prev ? { ...prev, value: e.target.value } : null
              )
            }
            onKeyDown={(e) => {
              if (isImeComposingEvent(e)) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                inlineCommittedRef.current = inlineRename.rowKey;
                onSetInlineRename(null);
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                onCommitInlineRename();
              }
            }}
            onBlur={() => onCommitInlineRename()}
            className="w-full rounded border border-blue-500 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          />
        ) : (
          <button
            type="button"
            data-row-name-trigger="true"
            data-workspace-row-trigger="true"
            aria-haspopup="menu"
            aria-expanded={isContextMenuOpen}
            disabled={isTrashView || isPendingUpload}
            title={
              isTrashView
                ? undefined
                : 'クリックで選択、ダブルクリックで開く'
            }
            onMouseEnter={() => {
              if (isTrashView || isPendingUpload) return;
              if (folder) prefetcher.scheduleHoverPrefetch(folder.id);
              else if (file && isPdfFile(file.name, file.mime_type)) {
                prefetcher.warmPdfPreviewRuntime();
              }
            }}
            onMouseLeave={() => {
              if (!isTrashView && folder) prefetcher.cancel(folder.id);
            }}
            onFocus={() => {
              onFocusRow(rowKey);
              if (!isTrashView && folder) {
                prefetcher.scheduleCursorPrefetch(folder.id);
              }
            }}
            onBlur={() => {
              if (!isTrashView && folder) prefetcher.cancel(folder.id);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || isTrashView || isPendingUpload) {
                return;
              }
              e.preventDefault();
              onOpenRow(row);
            }}
            className="w-full text-left text-[0.8125rem] font-semibold text-[#111214] transition hover:text-[#4f5ac2] disabled:cursor-default disabled:hover:text-[#111214]"
          >
            <span className="line-clamp-2 break-all">
              {folder ? folder.name : file!.name}
            </span>
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 text-[0.6875rem] text-[#6b6f76]">
        <div className="flex items-center gap-1 min-w-0">
          <ClassificationBadge
            classification={folder ? folder.classification : file!.classification}
            compact
          />
          {file?.ai_suggested_label && (
            <span
              title="AI 分類提案あり"
              className="inline-flex items-center rounded bg-indigo-50 px-1 py-0.5 text-[0.625rem] font-medium text-indigo-700"
            >
              <Sparkles className="h-2.5 w-2.5" />
            </span>
          )}
        </div>
        <span className="shrink-0 font-mono text-[0.625rem] text-[#6b6f76]">
          {folder
            ? formatDateTime(
                isTrashView ? folder.deleted_at : folder.updated_at
              )
            : formatBytes(file!.size_bytes)}
        </span>
      </div>
    </div>
  );
}
