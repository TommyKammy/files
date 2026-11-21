'use client';

import { AlertTriangle, FolderTree, History, Loader2 } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import {
  DestinationRowButton,
  type DestinationRow,
} from '@/components/DestinationRowButton';
import type { TrashRestoreDialogState } from '@/lib/trash-restore-options';
import type { useTrashRestoreDestinationTree } from '@/lib/use-trash-restore-destination-tree';
import type { TrashRestoreContextResponse } from '@/types/files';

type EvaluateRowFn = ComponentProps<typeof DestinationRowButton>['evaluate'];

export function RestoreDestinationPicker({
  context,
  state,
  tree,
  destinationBadge,
  parentToggleAvailable,
  loadingDestination,
  evaluateRow,
  onSwitchMode,
  onSelectDestinationRow,
  onToggleParentChain,
}: {
  context: TrashRestoreContextResponse;
  state: TrashRestoreDialogState;
  tree: ReturnType<typeof useTrashRestoreDestinationTree>;
  destinationBadge: ReactNode;
  parentToggleAvailable: boolean;
  loadingDestination: boolean;
  evaluateRow: EvaluateRowFn;
  onSwitchMode: (mode: 'original' | 'custom') => void;
  onSelectDestinationRow: (row: DestinationRow) => void;
  onToggleParentChain: (checked: boolean) => void;
}) {
  return (
    <>
      <section className="space-y-2">
        <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
          復元先
        </h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 transition ${
              state.mode === 'original'
                ? 'border-blue-300 bg-blue-50/60 ring-1 ring-inset ring-blue-200'
                : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}
          >
            <input
              type="radio"
              name="trash-restore-mode"
              value="original"
              checked={state.mode === 'original'}
              onChange={() => onSwitchMode('original')}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 font-medium text-slate-800">
                <History className="h-3.5 w-3.5" />
                元の場所へ復元
              </span>
              <span className="mt-0.5 block truncate text-[0.6875rem] text-slate-500">
                {context.originalLocation.path}
              </span>
            </span>
          </label>
          <label
            className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 transition ${
              state.mode === 'custom'
                ? 'border-blue-300 bg-blue-50/60 ring-1 ring-inset ring-blue-200'
                : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}
          >
            <input
              type="radio"
              name="trash-restore-mode"
              value="custom"
              checked={state.mode === 'custom'}
              onChange={() => onSwitchMode('custom')}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 font-medium text-slate-800">
                <FolderTree className="h-3.5 w-3.5" />
                別のフォルダへ復元
              </span>
              <span className="mt-0.5 block text-[0.6875rem] text-slate-500">
                アクセス可能なフォルダを選択
              </span>
            </span>
          </label>
        </div>
      </section>

      {state.mode === 'original' ? (
        <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[0.6875rem] font-medium text-slate-500">
                復元先のパンくず
              </p>
              <p
                className="truncate font-medium text-slate-900"
                data-restore-destination-path={state.targetPath}
              >
                {state.targetPath}
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-[0.625rem] text-slate-500">分類下限</span>
              {destinationBadge}
            </div>
          </div>

          {state.targetIsDeleted && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-amber-900">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                元の親フォルダが削除されています（削除済み祖先{' '}
                {state.targetDeletedAncestorCount} 件）
              </span>
            </div>
          )}

          <label
            className={`flex items-start gap-2 ${
              parentToggleAvailable
                ? 'cursor-pointer text-slate-800'
                : 'cursor-not-allowed text-slate-400'
            }`}
          >
            <input
              type="checkbox"
              checked={parentToggleAvailable && state.restoreParentChain}
              disabled={!parentToggleAvailable}
              onChange={(event) => onToggleParentChain(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">親フォルダもまとめて復元する</span>
              <span className="mt-0.5 block text-[0.6875rem] text-slate-500">
                {parentToggleAvailable
                  ? '削除済みの祖先フォルダ行だけを浅い順に復元します。関係ない兄弟アイテムはゴミ箱に残ります。'
                  : '親フォルダは有効なため、追加の復元は不要です。'}
              </span>
            </span>
          </label>
        </section>
      ) : (
        <section className="space-y-2">
          <div className="relative">
            <input
              ref={tree.searchInputRef}
              type="text"
              aria-label="復元先フォルダを検索"
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              value={tree.query}
              onChange={(event) => tree.setQuery(event.target.value)}
              placeholder="フォルダ名で絞り込み..."
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
          </div>
          <div
            className="max-h-52 space-y-0.5 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5"
            data-restore-destination-tree="true"
          >
            {tree.visibleRows.map((row) => (
              <div
                key={row.rowKey}
                data-restore-destination-id={row.folderId ?? '__ROOT__'}
              >
                <DestinationRowButton
                  row={row}
                  modeHint="move"
                  evaluate={evaluateRow}
                  highlighted={tree.selectedKey === row.rowKey}
                  onSelect={() => onSelectDestinationRow(row)}
                  onToggleExpand={tree.toggleExpand}
                />
              </div>
            ))}
            {tree.visibleRows.length === 0 && (
              <p className="px-3 py-6 text-center text-slate-500">
                選択できるフォルダがありません
              </p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[0.6875rem] font-medium text-slate-500">
                  選択中の復元先
                </p>
                <p
                  className="truncate font-medium text-slate-900"
                  data-restore-destination-path={state.targetPath}
                >
                  {state.targetPath}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-[0.625rem] text-slate-500">分類下限</span>
                {destinationBadge}
              </div>
            </div>
            {loadingDestination && (
              <p className="mt-1 flex items-center gap-1 text-[0.6875rem] text-slate-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                復元先を確認中...
              </p>
            )}
            {state.circular && (
              <p className="mt-1 text-[0.6875rem] font-medium text-red-700">
                自分自身または配下のフォルダへは復元できません
              </p>
            )}
            {state.maxDepthExceeded && (
              <p className="mt-1 text-[0.6875rem] font-medium text-red-700">
                階層が深すぎるため復元できません（最大 20 階層）
              </p>
            )}
            {!state.targetAccessible && (
              <p className="mt-1 text-[0.6875rem] font-medium text-red-700">
                このフォルダへのアクセス権限がありません
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
