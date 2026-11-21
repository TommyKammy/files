'use client';

import { Loader2, X } from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';

export function GroupCreateModal({
  baseId,
  createName,
  createBusy,
  createError,
  createResult,
  onChangeName,
  onClose,
  onSubmit,
}: {
  baseId: string;
  createName: string;
  createBusy: boolean;
  createError: string | null;
  createResult: string | null;
  onChangeName: (name: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <ModalShell
      label="グループを作成"
      labelledBy={`${baseId}-create-heading`}
      onClose={onClose}
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div data-testid="group-create-modal">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <h3
              id={`${baseId}-create-heading`}
              className="text-sm font-semibold text-slate-900"
            >
              手動グループを作成
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              同一テナント内で重複するグループ名は作成できません。
            </p>
          </div>
          <button
            type="button"
            data-testid="group-create-close"
            aria-label="グループ作成を閉じる"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <form
          className="space-y-3 px-5 py-4 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label className="block text-[0.6875rem] font-medium text-slate-700">
            グループ名
            <input
              type="text"
              required
              data-testid="group-create-name"
              data-autofocus
              value={createName}
              onChange={(event) => onChangeName(event.target.value)}
              maxLength={120}
              className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
            />
          </label>
          {createError && (
            <div
              role="alert"
              data-testid="group-create-error"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
            >
              {createError}
            </div>
          )}
          {createResult && (
            <div
              role="status"
              data-testid="group-create-result"
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
            >
              {createResult}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              閉じる
            </button>
            <button
              type="submit"
              data-testid="group-create-submit"
              disabled={createBusy}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {createBusy && (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              )}
              作成
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
}
