'use client';

import { Check, Loader2, RotateCcw } from 'lucide-react';
import type { TrashRestoreDialogState } from '@/lib/trash-restore-options';

export function RestoreModalFooter({
  state,
  busy,
  canSubmit,
  loadingContext,
  hasLoadError,
  onClose,
  onSubmit,
}: {
  state: TrashRestoreDialogState | null;
  busy: boolean;
  canSubmit: boolean;
  loadingContext: boolean;
  hasLoadError: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-[0.6875rem] text-slate-500">
        {state && (
          <span className="flex min-w-0 items-center gap-1">
            <Check className="h-3 w-3 shrink-0 text-emerald-600" />
            <span className="truncate">
              復元先: {state.targetPath}
              {state.mode === 'original' && state.restoreParentChain
                ? '（親フォルダも復元）'
                : ''}
            </span>
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          disabled={busy}
          className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit || busy || loadingContext || hasLoadError}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <RotateCcw className="h-3.5 w-3.5" />
          復元する
        </button>
      </div>
    </div>
  );
}
