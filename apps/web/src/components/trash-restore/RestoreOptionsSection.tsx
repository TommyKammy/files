'use client';

import {
  AlertTriangle,
  ArrowRightLeft,
  Info,
  ShieldAlert,
} from 'lucide-react';
import type { TrashRestoreDialogState } from '@/lib/trash-restore-options';

export function RestoreOptionsSection({
  state,
  onChangeConflictPolicy,
}: {
  state: TrashRestoreDialogState;
  onChangeConflictPolicy: (policy: 'fail' | 'rename') => void;
}) {
  return (
    <>
      <section className="space-y-2">
        <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
          名前が重複した場合
        </h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <input
              type="radio"
              name="trash-restore-conflict"
              checked={state.conflictPolicy === 'fail'}
              onChange={() => onChangeConflictPolicy('fail')}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-slate-800">
                名前が重複している場合はエラーにする
              </span>
              <span className="mt-0.5 block text-[0.6875rem] text-slate-500">
                何も上書きせず、再選択できます
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <input
              type="radio"
              name="trash-restore-conflict"
              checked={state.conflictPolicy === 'rename'}
              onChange={() => onChangeConflictPolicy('rename')}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium text-slate-800">
                自動で別名に変更して復元
              </span>
              <span className="mt-0.5 block text-[0.6875rem] text-slate-500">
                「(Restored)」連番を付与します
              </span>
            </span>
          </label>
        </div>

        {state.conflict.hasConflict && (
          <div
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
            data-restore-conflict="true"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <p className="font-medium">
                同名のアイテムが復元先に存在します
              </p>
              {state.conflict.suggestedName && (
                <p className="mt-0.5">
                  推奨名:{' '}
                  <span className="font-mono text-[0.6875rem]">
                    {state.conflict.suggestedName}
                  </span>
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="space-y-2">
        {state.willUpgradeClassification && (
          <div
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
            data-restore-upgrade="true"
          >
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              復元先の分類下限「
              {state.targetClassification === 'confidential'
                ? '極秘'
                : state.targetClassification === 'internal'
                  ? '社内'
                  : state.targetClassification === 'public'
                    ? '公開'
                    : '未設定'}
              」へ昇格します
              {state.upgradeCount > 0 ? `（対象 ${state.upgradeCount} 件）` : ''}
              。
            </span>
          </div>
        )}
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              復元先の権限を継承します。ルート直下へ復元する場合は、復元者がアクセスできなくならないよう直接権限を維持します。
            </span>
          </p>
          <p className="mt-1 flex items-start gap-1.5">
            <ArrowRightLeft className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              極秘へ昇格したファイルの公開共有リンクは自動的に無効化され、ダウンロード制限・電子透かしが適用されます。
            </span>
          </p>
        </div>
      </section>
    </>
  );
}
