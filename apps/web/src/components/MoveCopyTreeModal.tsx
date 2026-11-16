'use client';

import {
  AlertTriangle,
  Clock,
  Copy,
  FolderPlus,
  MoveRight,
  Search,
  X,
} from 'lucide-react';
import {
  DestinationRowButton,
  type DestinationRow,
} from '@/components/DestinationRowButton';
import { ModalShell } from '@/components/ModalShell';
import { useMoveCopyTree } from '@/lib/use-move-copy-tree';
import { type DragWorkspaceItem } from '@/lib/drag-drop-controller';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import { type WorkspaceSyncStore } from '@/lib/sync-store';
import type { AuthUser } from '@/types/files';

export function MoveCopyTreeModal({
  items,
  modeHint = 'move',
  currentFolderId,
  user,
  isSysAdmin,
  syncStore,
  onClose,
  onSuccess,
}: {
  items: DragWorkspaceItem[];
  modeHint?: 'move' | 'copy';
  currentFolderId: string | null;
  user: AuthUser;
  isSysAdmin: boolean;
  syncStore: WorkspaceSyncStore;
  onClose: () => void;
  onSuccess: (action: 'move' | 'copy', targetFolderId: string | null) => void;
}) {
  const {
    searchInputRef,
    query,
    setQuery,
    visibleRows,
    selectedRow,
    selectedEval,
    evalForRow,
    setHighlightedKey,
    inlineNewFolderOpen,
    setInlineNewFolderOpen,
    inlineNewFolderName,
    setInlineNewFolderName,
    actionError,
    handleCreateInlineFolder,
    executeAction,
    toggleExpand,
  } = useMoveCopyTree({
    items,
    modeHint,
    currentFolderId,
    user,
    isSysAdmin,
    syncStore,
    onClose,
    onSuccess,
  });

  const recentRows = visibleRows.filter((r) => r.section === 'recent');
  const treeRows = visibleRows.filter((r) => r.section === 'tree');

  const renderDestinationRow = (row: DestinationRow) => (
    <DestinationRowButton
      key={row.rowKey}
      row={row}
      modeHint={modeHint}
      evaluate={evalForRow}
      highlighted={selectedRow?.rowKey === row.rowKey}
      onSelect={() => setHighlightedKey(row.rowKey)}
      onToggleExpand={toggleExpand}
    />
  );


  return (
    <ModalShell
      label="移動またはコピー先を選択"
      onClose={onClose}
      className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">
              移動 / コピー先を選択 ({items.length} 件)
            </h2>
            <p className="truncate text-[0.6875rem] text-slate-500">
              {items.length === 1
                ? items[0]!.name
                : `${items[0]!.name} ほか ${items.length - 1} 件`}
            </p>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
            <input
              ref={searchInputRef}
              id="move-copy-destination-search"
              name="destinationSearch"
              aria-label="移動先フォルダを検索"
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="フォルダ名で絞り込み..."
              className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
          </div>
          <button
            type="button"
            onClick={() => setInlineNewFolderOpen((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            <FolderPlus className="h-3.5 w-3.5 text-blue-600" />
            <span>新規フォルダ</span>
          </button>
        </div>

        {inlineNewFolderOpen && (
          <div className="flex items-center gap-2 border-b border-blue-100 bg-blue-50/60 px-4 py-2 text-xs">
            <input
              autoFocus
              id="move-copy-new-folder-name"
              name="newFolderName"
              aria-label={`「${selectedRow?.name ?? 'マイファイル'}」内に作成するフォルダ名`}
              type="text"
              value={inlineNewFolderName}
              onChange={(e) => setInlineNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposingEvent(e)) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCreateInlineFolder();
                }
              }}
              placeholder={`「${selectedRow?.name ?? 'マイファイル'}」内に作成するフォルダ名`}
              className="flex-1 rounded-md border border-blue-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
            <button
              type="button"
              onClick={handleCreateInlineFolder}
              className="rounded-md bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700"
            >
              作成
            </button>
            <button
              type="button"
              onClick={() => {
                setInlineNewFolderOpen(false);
                setInlineNewFolderName('');
              }}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
          {recentRows.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 px-2 text-[0.625rem] font-semibold uppercase tracking-wide text-slate-500">
                <Clock className="h-3 w-3" />
                <span>最近の移動先</span>
              </div>
              <div className="space-y-0.5">
                {recentRows.map(renderDestinationRow)}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1 px-2 text-[0.625rem] font-semibold uppercase tracking-wide text-slate-500">
              ワークスペースフォルダ
            </div>
            <div className="space-y-0.5">
              {treeRows.map(renderDestinationRow)}
            </div>
          </div>
        </div>

        {(selectedEval?.moveEval.promotesToConfidential ||
          selectedEval?.copyEval.promotesToConfidential) && (
          <div className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              このフォルダへ移動またはコピーすると、対象アイテムの機密区分は「極秘 (Confidential)」へ自動昇格します。
            </span>
          </div>
        )}

        {(actionError ||
          (!selectedEval?.moveEval.allowed && selectedEval?.moveEval.reason) ||
          (!selectedEval?.copyEval.allowed && selectedEval?.copyEval.reason)) && (
          <div
            role="alert"
            className="border-t border-slate-100 bg-slate-50 px-5 py-1.5 text-[0.6875rem] text-slate-600"
          >
            {actionError ? (
              <span className="font-medium text-red-700">{actionError}</span>
            ) : (
              <span>
                {!selectedEval?.moveEval.allowed && selectedEval?.moveEval.reason
                  ? `移動不可: ${selectedEval.moveEval.reason}`
                  : ''}
                {!selectedEval?.moveEval.allowed &&
                selectedEval?.moveEval.reason &&
                !selectedEval?.copyEval.allowed &&
                selectedEval?.copyEval.reason
                  ? ' ／ '
                  : ''}
                {!selectedEval?.copyEval.allowed && selectedEval?.copyEval.reason
                  ? `コピー不可: ${selectedEval.copyEval.reason}`
                  : ''}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs">
          <span className="text-[0.6875rem] text-slate-500">
            ↑↓ 移動 • ←→ 展開/折畳 • Enter 決定
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 font-medium text-slate-600 hover:bg-slate-100"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={!selectedEval?.copyEval.allowed}
              onClick={() => executeAction('copy')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 font-semibold text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Copy className="h-3.5 w-3.5" />
              <span>ここにコピー</span>
            </button>
            <button
              type="button"
              disabled={!selectedEval?.moveEval.allowed}
              onClick={() => executeAction('move')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <MoveRight className="h-3.5 w-3.5" />
              <span>ここへ移動</span>
            </button>
          </div>
        </div>
    </ModalShell>
  );
}
