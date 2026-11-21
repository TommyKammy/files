'use client';

import type { TrashRestoreDialogState } from '@/lib/trash-restore-options';

export function RestoreErrorAlert({
  state,
  onRetryWithRename,
  onRetryWithParentChain,
  onSwitchToCustom,
}: {
  state: TrashRestoreDialogState;
  onRetryWithRename: () => void;
  onRetryWithParentChain: () => void;
  onSwitchToCustom: () => void;
}) {
  if (!state.error) return null;

  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800"
      data-trash-restore-error="true"
    >
      <p className="font-medium">{state.error}</p>
      {state.errorCode && (
        <p className="font-mono text-[0.625rem] text-red-600">
          {state.errorCode}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {state.conflict.suggestedName &&
          state.conflictPolicy !== 'rename' &&
          state.errorCode === 'NAME_CONFLICT' && (
            <button
              type="button"
              onClick={onRetryWithRename}
              className="rounded-md border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100"
            >
              推奨名「{state.conflict.suggestedName}」で再試行
            </button>
          )}
        {(state.errorCode === 'PARENT_FOLDER_DELETED' ||
          state.errorCode === 'PARENT_IN_TRASH') &&
          state.mode === 'original' &&
          !state.restoreParentChain && (
            <button
              type="button"
              onClick={onRetryWithParentChain}
              className="rounded-md border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100"
            >
              親フォルダも復元して再試行
            </button>
          )}
        {state.mode === 'original' && (
          <button
            type="button"
            onClick={onSwitchToCustom}
            className="rounded-md border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100"
          >
            別のフォルダを選ぶ
          </button>
        )}
      </div>
    </div>
  );
}
