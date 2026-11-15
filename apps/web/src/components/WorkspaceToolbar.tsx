'use client';

import {
  FolderPlus,
  Inbox,
  Info,
  Keyboard,
  LayoutGrid,
  Link2,
  List,
  Shield,
  Star,
} from 'lucide-react';
import type { FolderSummary } from '@/types/files';

export function WorkspaceToolbar({
  isTrashView,
  hasSelection,
  canEditCurrentFolder,
  canManageCurrentFolderPerms,
  currentFolder,
  viewMode,
  inspectorOpen,
  onNewFolder,
  onTogglePin,
  onOpenFileRequest,
  onOpenShare,
  onOpenPermissions,
  onToggleViewMode,
  onToggleInspector,
  onOpenShortcuts,
}: {
  isTrashView: boolean;
  hasSelection: boolean;
  canEditCurrentFolder: boolean;
  canManageCurrentFolderPerms: boolean;
  currentFolder: FolderSummary | null;
  viewMode: 'list' | 'grid';
  inspectorOpen: boolean;
  onNewFolder: () => void;
  onTogglePin: (folder: FolderSummary) => void;
  onOpenFileRequest: () => void;
  onOpenShare: () => void;
  onOpenPermissions: () => void;
  onToggleViewMode: () => void;
  onToggleInspector: () => void;
  onOpenShortcuts: () => void;
}) {
  return (
    <div
      aria-hidden={hasSelection}
      inert={hasSelection}
      className={`flex flex-wrap items-center gap-2 ${
        hasSelection ? 'invisible' : ''
      }`}
    >
      {!isTrashView && (
        <>
          {canEditCurrentFolder && (
            <button
              type="button"
              onClick={onNewFolder}
              className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
            >
              <FolderPlus className="h-3.5 w-3.5 text-blue-600" />
              <span>新規フォルダ</span>
            </button>
          )}

          {currentFolder && canEditCurrentFolder && (
            <>
              <button
                type="button"
                onClick={() => onTogglePin(currentFolder)}
                className={`inline-flex items-center gap-1.5 h-7 rounded-md border px-2.5 text-[0.75rem] font-medium transition ${
                  currentFolder.is_pinned === 1
                    ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Star
                  className={`h-3.5 w-3.5 ${
                    currentFolder.is_pinned === 1
                      ? 'fill-amber-400 text-[#6b6f76]'
                      : 'text-slate-500'
                  }`}
                />
                <span>
                  {currentFolder.is_pinned === 1 ? 'ピン留め中' : 'ピン留め'}
                </span>
              </button>

              <button
                type="button"
                onClick={onOpenFileRequest}
                className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
              >
                <Inbox className="h-3.5 w-3.5 text-indigo-600" />
                <span>ファイル収集</span>
              </button>

              <button
                type="button"
                onClick={onOpenShare}
                className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
              >
                <Link2 className="h-3.5 w-3.5 text-blue-600" />
                <span>フォルダ共有</span>
              </button>
            </>
          )}

          {currentFolder && canManageCurrentFolderPerms && (
            <button
              type="button"
              onClick={onOpenPermissions}
              className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
            >
              <Shield className="h-3.5 w-3.5 text-slate-600" />
              <span>権限管理</span>
            </button>
          )}
        </>
      )}

      <button
        type="button"
        title="リスト / グリッド表示切替 (v)"
        aria-pressed={viewMode === 'grid'}
        onClick={onToggleViewMode}
        className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
      >
        {viewMode === 'grid' ? (
          <List className="h-3.5 w-3.5 text-slate-600" />
        ) : (
          <LayoutGrid className="h-3.5 w-3.5 text-slate-600" />
        )}
        <span>{viewMode === 'grid' ? 'リスト' : 'グリッド'}</span>
      </button>

      {!isTrashView && (
        <button
          type="button"
          title="詳細インスペクタ (i)"
          aria-pressed={inspectorOpen}
          onClick={onToggleInspector}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-2xs transition ${
            inspectorOpen
              ? 'border-[#bcc3ea] bg-[#eef0fb] text-[#4f5ac2]'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900'
          }`}
        >
          <Info className="h-3.5 w-3.5" />
          <span>詳細</span>
        </button>
      )}

      <button
        type="button"
        title="キーボードショートカット (?)"
        onClick={onOpenShortcuts}
        className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
      >
        <Keyboard className="h-3.5 w-3.5 text-slate-500" />
        <kbd className="font-mono text-[0.625rem] text-slate-500">?</kbd>
      </button>
    </div>
  );
}
