'use client';

import {
  Clipboard,
  Copy,
  Download,
  FolderInput,
  Scissors,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';

function BulkActionButton({
  label,
  shortcut,
  icon,
  onClick,
  variant = 'default',
}: {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  onClick: () => void;
  variant?: 'default' | 'primary' | 'danger';
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-[0.6875rem] font-medium transition ${
        variant === 'primary'
          ? 'border-[#5e6ad2] bg-[#5e6ad2] text-white hover:bg-[#4f5ac2]'
          : variant === 'danger'
            ? 'border-[#f3d3d5] bg-white text-[#d9343f] hover:bg-[#fdf0f1]'
            : 'border-[#dfe2f5] bg-white text-[#3c3f46] hover:bg-[#f2f2f4]'
      }`}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

export function WorkspaceSelectionBar({
  selectedRows,
  canCopySelection,
  canCutSelection,
  canDuplicateSelection,
  canMoveCopySelection,
  canClassifySelection,
  canTrashSelection,
  canDownloadSelection = false,
  downloadingZip = false,
  isPrivilegedAdmin,
  onCopy,
  onCut,
  onDuplicate,
  onMoveCopy,
  onBulkApproveAi,
  onClassify,
  onTrash,
  onDownloadZip,
  onClear,
}: {
  selectedRows: WorkspaceTableRow[];
  canCopySelection: boolean;
  canCutSelection: boolean;
  canDuplicateSelection: boolean;
  canMoveCopySelection: boolean;
  canClassifySelection: boolean;
  canTrashSelection: boolean;
  canDownloadSelection?: boolean;
  downloadingZip?: boolean;
  isPrivilegedAdmin: boolean;
  onCopy: () => void;
  onCut: () => void;
  onDuplicate: () => void;
  onMoveCopy: () => void;
  onBulkApproveAi: () => void;
  onClassify: () => void;
  onTrash: () => void;
  onDownloadZip?: () => void;
  onClear: () => void;
}) {
  const hasAiSuggestion = selectedRows.some(
    (row) => row.kind === 'file' && row.file.ai_suggested_label != null
  );
  const hasFiles = selectedRows.some((row) => row.kind === 'file');

  return (
    <div
      role="toolbar"
      aria-label="一括操作"
      className="absolute inset-0 z-20 flex items-center gap-1 overflow-x-auto whitespace-nowrap rounded-md border border-[#dfe2f5] bg-[#eef0fb]/95 px-2 py-1 text-[0.6875rem] text-[#3c3f46]"
    >
      <span className="shrink-0 font-semibold">
        {selectedRows.length} 件選択中
      </span>
      {canDownloadSelection && onDownloadZip && (
        <BulkActionButton
          label={downloadingZip ? 'ZIP作成中...' : 'ZIPダウンロード'}
          icon={<Download className="h-3.5 w-3.5 text-slate-500" />}
          onClick={onDownloadZip}
        />
      )}
      {canCopySelection && (
        <BulkActionButton
          label="コピー"
          shortcut="⌘C"
          icon={<Copy className="h-3.5 w-3.5 text-slate-500" />}
          onClick={onCopy}
        />
      )}
      {canCutSelection && (
        <BulkActionButton
          label="切り取り"
          shortcut="⌘X"
          icon={<Scissors className="h-3.5 w-3.5 text-slate-500" />}
          onClick={onCut}
        />
      )}
      {canDuplicateSelection && (
        <BulkActionButton
          label="複製"
          shortcut="⌘D"
          icon={<Clipboard className="h-3.5 w-3.5 text-slate-500" />}
          onClick={onDuplicate}
        />
      )}
      {canMoveCopySelection && (
        <BulkActionButton
          label="移動 / コピー"
          shortcut="m"
          icon={<FolderInput className="h-3.5 w-3.5 text-blue-600" />}
          onClick={onMoveCopy}
        />
      )}
      {hasAiSuggestion && (canClassifySelection || isPrivilegedAdmin) && (
        <BulkActionButton
          label="AI提案を一括承認"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          variant="primary"
          onClick={onBulkApproveAi}
        />
      )}
      {hasFiles && (canClassifySelection || isPrivilegedAdmin) && (
        <BulkActionButton
          label="機密変更"
          shortcut="c"
          icon={<Tag className="h-3.5 w-3.5 text-slate-500" />}
          onClick={onClassify}
        />
      )}
      {canTrashSelection && (
        <BulkActionButton
          label="ゴミ箱"
          variant="danger"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={onTrash}
        />
      )}
      <button
        type="button"
        onClick={onClear}
        className="shrink-0 rounded-lg px-2 py-1 text-slate-700 hover:bg-indigo-100 hover:text-slate-900"
      >
        解除
      </button>
    </div>
  );
}
