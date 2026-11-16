'use client';

import { History, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import { useId } from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  formatAuditDateTime,
  formatBytes,
} from '@/lib/formatters';
import type { FileVersionItem } from '@/types/files';
import {
  formatFileLockMode,
  formatVersionNumber,
  type VersionHistoryError,
} from '@/lib/version-history';

export function VersionRestoreConfirmModal({
  sourceVersion,
  currentVersionNum,
  nextVersionNum,
  submitting,
  error,
  returnFocus = null,
  onConfirm,
  onClose,
}: {
  sourceVersion: FileVersionItem;
  currentVersionNum: number;
  nextVersionNum: number;
  submitting: boolean;
  error: VersionHistoryError | null;
  returnFocus?: HTMLElement | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const titleId = useId();

  return (
    <ModalShell
      label="バージョンの復元確認"
      labelledBy={titleId}
      onClose={onClose}
      returnFocus={returnFocus}
      backdrop="deep"
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700">
            <RotateCcw className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-sm font-semibold text-slate-900"
            >
              バージョンの復元確認
            </h2>
            <p className="text-[0.6875rem] text-slate-500">
              過去版を新しい現在版として追加します
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5 text-xs">
        {error && (
          <div
            role="alert"
            data-testid="version-restore-error"
            className="space-y-1 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-red-700"
          >
            <p>{error.message}</p>
            {error.lock && (
              <div
                data-testid="version-lock-owner"
                className="space-y-0.5 font-medium text-red-800"
              >
                <p>
                  ロック保有者: {error.lock.ownerName}
                  {error.lock.ownerEmail ? ` (${error.lock.ownerEmail})` : ''}
                </p>
                <p className="text-red-700">
                  {formatFileLockMode(error.lock.mode)}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">復元元</span>
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 font-mono font-semibold text-indigo-700">
              {formatVersionNumber(sourceVersion.versionNum)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">現在のバージョン</span>
            <span className="font-mono text-slate-700">
              {formatVersionNumber(currentVersionNum)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-500">復元後の新しい現在版</span>
            <span className="font-mono font-semibold text-slate-900">
              {formatVersionNumber(nextVersionNum)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-2 text-[0.6875rem] text-slate-500">
            <span>復元元のサイズ / 作成日時</span>
            <span className="text-right text-slate-600">
              {formatBytes(sourceVersion.sizeBytes)} /{' '}
              {formatAuditDateTime(sourceVersion.createdAt)}
            </span>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="leading-relaxed">
            現在のバージョン（
            <span className="font-mono font-semibold">
              {formatVersionNumber(currentVersionNum)}
            </span>
            ）は削除されません。復元元の内容を{' '}
            <span className="font-mono font-semibold">
              {formatVersionNumber(nextVersionNum)}
            </span>{' '}
            として新しく追加し、現在版を更新します。
          </p>
        </div>

        <p className="text-[0.6875rem] leading-relaxed text-slate-500">
          復元元の内容を新しい現在版として追加します。既存の版履歴は変更されません。
        </p>
      </div>

      <div className="flex flex-col-reverse gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3.5 sm:flex-row sm:justify-end">
        <button
          type="button"
          data-autofocus
          onClick={onClose}
          className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          キャンセル
        </button>
        <button
          type="button"
          data-testid="version-restore-confirm"
          onClick={onConfirm}
          disabled={submitting}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <History className="h-3.5 w-3.5" />
          )}
          <span>
            {formatVersionNumber(sourceVersion.versionNum)} に戻す
          </span>
        </button>
      </div>
    </ModalShell>
  );
}
