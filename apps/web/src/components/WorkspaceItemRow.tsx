'use client';

import {
  Download,
  FileText,
  Folder,
  Loader2,
  Lock,
  MoreHorizontal,
  RotateCcw,
} from 'lucide-react';
import type { Dispatch, MouseEvent, SetStateAction } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ClassificationCell } from '@/components/ClassificationCell';
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
import type {
  FileItem,
  FileLockInfo,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export function WorkspaceItemRow({
  row,
  globalIdx,
  isFocused,
  isSelected,
  rowSelectable,
  isTrashView,
  isInlineRenaming,
  isContextMenuOpen,
  isCut,
  lock,
  dropClass,
  inlineRename,
  inlineInputRef,
  inlineCommittedRef,
  prefetcher,
  effectiveRole,
  canEditCurrentFolder,
  canDownloadCurrentFolder,
  isPrivilegedAdmin,
  onCheckboxClick,
  onPointerDown,
  onSelectRow,
  onOpenRow,
  onOpenContextMenu,
  onRestoreFolder,
  onRestoreFile,
  onDownloadFile,
  onSetInlineRename,
  onCommitInlineRename,
  onFocusRow,
  onFileUpdated,
  onError,
}: {
  row: WorkspaceTableRow;
  globalIdx: number;
  isFocused: boolean;
  isSelected: boolean;
  rowSelectable: boolean;
  isTrashView: boolean;
  isInlineRenaming: boolean;
  isContextMenuOpen: boolean;
  isCut: boolean;
  lock?: FileLockInfo | null;
  dropClass: string;
  inlineRename: InlineRenameState | null;
  inlineInputRef: React.RefObject<HTMLInputElement | null>;
  inlineCommittedRef: React.MutableRefObject<string | null>;
  prefetcher: IntentPrefetcher;
  effectiveRole: ResourceRole;
  canEditCurrentFolder: boolean;
  canDownloadCurrentFolder: boolean;
  isPrivilegedAdmin: boolean;
  onCheckboxClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onSelectRow: (
    event: MouseEvent<HTMLTableRowElement>,
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
  onDownloadFile: (fileId: string) => void;
  onSetInlineRename: Dispatch<SetStateAction<InlineRenameState | null>>;
  onCommitInlineRename: () => void;
  onFocusRow: (rowKey: string) => void;
  onFileUpdated: (file: FileItem) => void;
  onError: (message: string) => void;
}) {
  const rowKey = getWorkspaceRowKey(row);
  const isFolder = row.kind === 'folder';
  const folder = isFolder ? row.folder : null;
  const file = !isFolder ? row.file : null;
  const isPendingUpload = Boolean(
    file && (file.upload_state === 'pending' || file.optimistic)
  );
  const isDropEligible = Boolean(
    folder && !isTrashView && folder.deleted_at == null
  );

  const rowClassName = `h-11 transition-colors ${
    isPendingUpload
      ? 'bg-[#eef0fb]/50 text-[#55565a]'
      : dropClass
        ? dropClass
        : isSelected
          ? 'bg-[#eef0fb]'
          : isFocused
            ? 'bg-[#f4f4f5]'
            : 'hover:bg-[#f6f6f8]'
  } ${isFocused ? 'ring-1 ring-inset ring-[#6d78d5]/45' : ''} ${
    isCut ? 'opacity-50 outline-1 outline-dashed outline-amber-400' : ''
  }`;

  return (
    <tr
      key={rowKey}
      data-row-index={globalIdx}
      aria-rowindex={globalIdx + 2}
      data-drop-folder-id={
        isDropEligible && folder ? folder.id : undefined
      }
      data-drop-label={isDropEligible && folder ? folder.name : undefined}
      aria-selected={isSelected}
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
      className={rowClassName}
    >
      <td className="w-10 px-3 py-3">
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
      </td>
      <td className="px-3 py-2">
        {isInlineRenaming && inlineRename ? (
          <div className="flex items-center gap-2.5">
            {isFolder ? (
              <Folder className="h-4 w-4 shrink-0 text-[#6b6f76]" />
            ) : (
              <FileText className="h-4 w-4 shrink-0 text-[#6b6f76]" />
            )}
            <input
              ref={inlineInputRef}
              name="renameValue"
              aria-label={
                isFolder ? 'フォルダ名を変更' : 'ファイル名を変更'
              }
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
              className="w-full max-w-xs rounded border border-blue-500 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
          </div>
        ) : (
          <button
            type="button"
            data-row-name-trigger="true"
            data-workspace-row-trigger="true"
            aria-haspopup="menu"
            aria-expanded={isContextMenuOpen}
            disabled={isTrashView || isPendingUpload}
            title={
              isTrashView || isPendingUpload
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
              if (!isTrashView && !isPendingUpload && folder) {
                prefetcher.cancel(folder.id);
              }
            }}
            onFocus={() => {
              onFocusRow(rowKey);
              if (!isTrashView && !isPendingUpload && folder) {
                prefetcher.scheduleCursorPrefetch(folder.id);
              }
            }}
            onBlur={() => {
              if (!isTrashView && !isPendingUpload && folder) {
                prefetcher.cancel(folder.id);
              }
            }}
            onKeyDown={(e) => {
              if (
                e.key !== 'Enter' ||
                isTrashView ||
                isPendingUpload
              ) {
                return;
              }
              e.preventDefault();
              onOpenRow(row);
            }}
            className="flex items-center gap-2.5 text-left text-[0.8125rem] font-medium text-[#111214] transition hover:text-[#4f5ac2] disabled:cursor-default disabled:hover:text-[#111214]"
          >
            {isFolder ? (
              <Folder className="h-4 w-4 shrink-0 text-[#6b6f76]" />
            ) : isPendingUpload ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
            ) : (
              <FileText className="h-4 w-4 shrink-0 text-[#6b6f76]" />
            )}
            <span>{folder ? folder.name : file!.name}</span>
            {lock && (
              <span
                title={`${lock.ownerName} が${lock.mode === 'desktop_exclusive' ? 'デスクトップで編集中' : 'Webで編集中'}`}
                className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-700"
              >
                <Lock className="h-3 w-3" />
                編集中
              </span>
            )}
            {!isFolder && isPendingUpload ? (
              <span className="rounded-full bg-blue-100 px-2 py-0.5 font-mono text-[0.625rem] font-medium text-blue-700">
                アップロード中 {file!.upload_progress ?? 0}%
              </span>
            ) : (
              !isFolder &&
              file!.current_version_num > 1 && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.625rem] text-slate-500">
                  v{file!.current_version_num}
                </span>
              )
            )}
          </button>
        )}
      </td>
      <td className="px-3 py-2">
        {isFolder ? (
          <ClassificationBadge
            classification={folder!.classification}
            compact
          />
        ) : (
          <ClassificationCell
            file={file!}
            canEdit={
              !isTrashView &&
              !isPendingUpload &&
              (canEditCurrentFolder || isPrivilegedAdmin)
            }
            effectiveRole={effectiveRole}
            isPrivilegedAdmin={isPrivilegedAdmin}
            onUpdated={(updatedFile) => {
              if (isTrashView) onFileUpdated(updatedFile);
            }}
            onError={onError}
          />
        )}
      </td>
      <td className="px-3 py-2 font-mono text-[#55565a]">
        {isFolder ? 'フォルダ' : formatBytes(file!.size_bytes)}
      </td>
      <td className="px-3 py-2 text-[#55565a]">
        {formatDateTime(
          isFolder
            ? isTrashView
              ? folder!.deleted_at
              : folder!.updated_at
            : isTrashView
              ? file!.deleted_at
              : file!.updated_at
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {isTrashView ? (
          <button
            type="button"
            onClick={() => {
              if (folder) onRestoreFolder(folder);
              else if (file) onRestoreFile(file);
            }}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-100"
          >
            <RotateCcw className="h-3 w-3" />
            <span>復元</span>
          </button>
        ) : isPendingUpload ? (
          <span className="text-[0.6875rem] text-[#6b6f76]">
            転送完了後に操作可能
          </span>
        ) : (
          <div className="inline-flex items-center gap-1">
            {!isFolder && canDownloadCurrentFolder && (
              <button
                type="button"
                title="ダウンロード"
                onClick={(e) => {
                  e.stopPropagation();
                  onDownloadFile(file!.id);
                }}
                className="rounded p-1 text-[#a0a0a7] transition hover:bg-[#f0f0f2] hover:text-[#111214]"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}
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
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
