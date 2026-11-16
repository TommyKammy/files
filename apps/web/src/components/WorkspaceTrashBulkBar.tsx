'use client';

import { Loader2, RotateCcw, Trash2 } from 'lucide-react';

export function WorkspaceTrashBulkBar({
  selectedCount,
  restorableCount,
  purgableCount,
  hasTrashItems,
  busyAction,
  conflictPolicy,
  onConflictPolicyChange,
  onRestore,
  onPurge,
  onEmpty,
  onClearSelection,
}: {
  selectedCount: number;
  restorableCount: number;
  purgableCount: number;
  hasTrashItems: boolean;
  busyAction: 'restore' | 'purge' | 'empty' | null;
  conflictPolicy: 'fail' | 'rename';
  onConflictPolicyChange: (policy: 'fail' | 'rename') => void;
  onRestore: () => void;
  onPurge: () => void;
  onEmpty: () => void;
  onClearSelection: () => void;
}) {
  const isBusy = busyAction !== null;

  return (
    <div
      role="toolbar"
      aria-label="ゴミ箱の一括操作"
      aria-busy={isBusy}
      data-trash-bulk-bar="true"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-[#e1e4f2] bg-white px-3 py-2 text-[0.6875rem] text-[#3c3f46]"
    >
      {selectedCount > 0 ? (
        <>
          <span className="shrink-0 font-semibold" data-trash-selected-count={selectedCount}>
            {selectedCount} 件選択中
          </span>
          <label className="inline-flex shrink-0 items-center gap-1 text-[#6b6f76]">
            <span>名前衝突</span>
            <select
              aria-label="復元時の名前衝突ポリシー"
              value={conflictPolicy}
              disabled={isBusy}
              onChange={(event) =>
                onConflictPolicyChange(
                  event.target.value === 'fail' ? 'fail' : 'rename'
                )
              }
              className="h-6 rounded border border-[#d9d9de] bg-white px-1.5 text-[0.6875rem] text-[#3c3f46] disabled:opacity-50"
            >
              <option value="rename">自動リネーム</option>
              <option value="fail">失敗させる</option>
            </select>
          </label>
          <button
            type="button"
            disabled={isBusy || restorableCount === 0}
            onClick={onRestore}
            title={
              restorableCount === 0
                ? '復元権限（editor以上）を持つ選択項目がありません'
                : '選択した項目を元の場所へ復元します'
            }
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-[#5e6ad2] bg-[#5e6ad2] px-2 font-medium text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'restore' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            <span>選択項目を復元</span>
          </button>
          <button
            type="button"
            disabled={isBusy || purgableCount === 0}
            onClick={onPurge}
            title={
              purgableCount === 0
                ? '完全削除にはowner / co_owner権限（またはsys_admin）が必要です'
                : '選択した項目を完全に削除します'
            }
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-[#f3d3d5] bg-white px-2 font-medium text-[#d9343f] transition hover:bg-[#fdf0f1] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busyAction === 'purge' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            <span>完全削除</span>
          </button>
          <button
            type="button"
            disabled={isBusy}
            onClick={onClearSelection}
            className="inline-flex h-6 shrink-0 items-center rounded px-2 text-[#55565a] transition hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            選択解除
          </button>
        </>
      ) : (
        <span className="shrink-0 text-[#6b6f76]">
          ゴミ箱の一括操作
        </span>
      )}

      {busyAction && (
        <span className="inline-flex items-center gap-1 text-[#6b6f76]" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          処理中...
        </span>
      )}

      <button
        type="button"
        disabled={isBusy || !hasTrashItems}
        onClick={onEmpty}
        className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded border border-[#d9d9de] bg-white px-2 font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busyAction === 'empty' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
        <span>ゴミ箱を空にする</span>
      </button>
    </div>
  );
}
