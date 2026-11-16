'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useId } from 'react';
import { ModalShell } from '@/components/ModalShell';
import type { TrashBulkConfirmState } from '@/lib/trash-bulk';
import type { TrashBulkResultState } from '@/lib/use-workspace-trash-bulk-actions';

function ConfirmDialog({
  state,
  busy,
  onConfirm,
  onCancel,
}: {
  state: TrashBulkConfirmState;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const isDanger = state.kind === 'purge' || state.kind === 'empty';

  return (
    <ModalShell
      label={state.title}
      labelledBy={titleId}
      onClose={onCancel}
      backdrop="deep"
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-700">
            <Trash2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-slate-900">
              {state.title}
            </h2>
            <p className="text-[0.6875rem] text-slate-500">
              この操作は取り消せません
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5 text-xs">
        <div
          className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3"
          data-trash-confirm-count={state.count}
        >
          <p className="text-sm font-semibold text-slate-900">
            {state.summary}
          </p>
        </div>

        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="font-medium">{state.warnings[0]}</p>
          </div>
          <div className="flex items-start gap-2" data-trash-share-warning="true">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{state.warnings[1]}</p>
          </div>
        </div>

        <p className="text-[0.6875rem] leading-relaxed text-slate-500">
          ロック中のファイルや完全削除権限のない共有アイテムはスキップされ、
          結果に理由が表示されます。
        </p>
      </div>

      <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
        <button
          type="button"
          data-autofocus
          disabled={busy}
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
        >
          キャンセル
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-white transition disabled:opacity-60 ${
            isDanger
              ? 'bg-[#d9343f] hover:bg-[#bf2d36]'
              : 'bg-[#5e6ad2] hover:bg-[#4f5ac2]'
          }`}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {state.confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

function ResultDialog({
  state,
  onClose,
}: {
  state: TrashBulkResultState;
  onClose: () => void;
}) {
  const titleId = useId();
  const { summary, action } = state;
  const problemItems = [...summary.failed, ...summary.skipped];
  const actionLabel =
    action === 'restore'
      ? '復元'
      : action === 'empty'
        ? 'ゴミ箱を空にする'
        : '完全削除';

  return (
    <ModalShell
      label="ゴミ箱操作の結果"
      labelledBy={titleId}
      onClose={onClose}
      backdrop="deep"
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-slate-900">
              {actionLabel}の結果
            </h2>
            <p className="text-[0.6875rem] text-slate-500">
              一部の項目を処理できませんでした
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5 text-xs">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-2">
            <p className="flex items-center justify-center gap-1 text-[0.625rem] text-emerald-700">
              <CheckCircle2 className="h-3 w-3" />
              成功
            </p>
            <p className="mt-0.5 text-sm font-semibold text-emerald-800">
              {summary.succeeded.length} 件
            </p>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 px-2 py-2">
            <p className="text-[0.625rem] text-red-700">失敗</p>
            <p className="mt-0.5 text-sm font-semibold text-red-800">
              {summary.failed.length} 件
            </p>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-2">
            <p className="text-[0.625rem] text-amber-800">スキップ</p>
            <p className="mt-0.5 text-sm font-semibold text-amber-900">
              {summary.skipped.length} 件
            </p>
          </div>
        </div>

        <div
          className="max-h-64 space-y-2 overflow-y-auto"
          data-trash-result-failures="true"
        >
          {problemItems.map((item) => (
            <div
              key={item.key}
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
              data-trash-result-item={item.key}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-slate-800">
                  {item.name}
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium ${
                    item.status === 'skipped'
                      ? 'bg-amber-100 text-amber-800'
                      : 'bg-red-100 text-red-700'
                  }`}
                >
                  {item.status === 'skipped' ? 'スキップ' : '失敗'}
                </span>
              </div>
              <p className="mt-0.5 text-[0.6875rem] text-slate-600">
                {item.message}
                {item.code ? (
                  <span className="ml-1 font-mono text-[0.625rem] text-slate-400">
                    ({item.code})
                  </span>
                ) : null}
              </p>
            </div>
          ))}
        </div>

        <p className="text-[0.6875rem] text-slate-500">
          失敗した項目はゴミ箱に残っています。権限やロック状態を確認して再試行してください。
        </p>
      </div>

      <div className="flex justify-end border-t border-slate-200 px-5 py-3">
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
        >
          閉じる
        </button>
      </div>
    </ModalShell>
  );
}

export function WorkspaceTrashBulkDialogs({
  confirmState,
  resultState,
  busy,
  onConfirm,
  onCancel,
  onCloseResult,
}: {
  confirmState: TrashBulkConfirmState | null;
  resultState: TrashBulkResultState | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onCloseResult: () => void;
}) {
  return (
    <>
      {confirmState && (
        <ConfirmDialog
          state={confirmState}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
      {resultState && (
        <ResultDialog state={resultState} onClose={onCloseResult} />
      )}
    </>
  );
}
