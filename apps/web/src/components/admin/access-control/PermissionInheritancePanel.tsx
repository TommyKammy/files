'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ROLE_META } from '@/lib/capabilities';
import { readPermissionInheritanceMode } from '@/lib/permission-inheritance';
import type {
  PermissionInheritanceMode,
  TenantPolicyRow,
  WaterfallInheritanceConflict,
} from '@/types/files';

export function PermissionInheritancePanel({
  policy,
  inheritanceSaving,
  inheritanceError,
  inheritanceNotice,
  canManagePermissionInheritance,
  inheritanceConflictReport,
  recommendWaterfall,
  onSavePermissionInheritanceMode,
}: {
  policy: TenantPolicyRow | null;
  inheritanceSaving: boolean;
  inheritanceError: string | null;
  inheritanceNotice: string | null;
  canManagePermissionInheritance: boolean;
  inheritanceConflictReport: WaterfallInheritanceConflict[];
  recommendWaterfall: boolean;
  onSavePermissionInheritanceMode: (
    mode: PermissionInheritanceMode
  ) => Promise<boolean>;
}) {
  const persistedInheritanceMode = readPermissionInheritanceMode(policy);
  const [desiredInheritanceMode, setDesiredInheritanceMode] =
    useState<PermissionInheritanceMode>(persistedInheritanceMode);
  const [inheritanceDirty, setInheritanceDirty] = useState(false);
  const inheritanceDirtyRef = useRef(false);

  useEffect(() => {
    if (inheritanceDirtyRef.current) return;
    setDesiredInheritanceMode(readPermissionInheritanceMode(policy));
  }, [policy]);

  function updateInheritanceMode(next: PermissionInheritanceMode) {
    setDesiredInheritanceMode(next);
    const isDirty = next !== persistedInheritanceMode;
    inheritanceDirtyRef.current = isDirty;
    setInheritanceDirty(isDirty);
  }

  async function handleInheritanceSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    if (
      inheritanceSaving ||
      !policy ||
      !canManagePermissionInheritance ||
      !inheritanceDirty
    ) {
      return;
    }
    const ok = await onSavePermissionInheritanceMode(desiredInheritanceMode);
    if (ok) {
      inheritanceDirtyRef.current = false;
      setInheritanceDirty(false);
    }
  }

  return (
    <form
      onSubmit={handleInheritanceSubmit}
      aria-labelledby="permission-inheritance-heading"
      className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5 xl:col-span-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-[#5e6ad2]" />
        <h2
          id="permission-inheritance-heading"
          className="text-sm font-semibold text-slate-900"
        >
          権限継承モード (Additive / Waterfall)
        </h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
          現在: {persistedInheritanceMode === 'waterfall' ? 'Waterfall' : 'Additive'}
        </span>
      </div>

      <fieldset disabled={!policy || inheritanceSaving} className="space-y-3">
        <legend className="text-xs font-semibold text-slate-700">
          子フォルダで同じユーザー・グループを再付与できるか
        </legend>

        <div className="grid gap-2 sm:grid-cols-2">
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
              desiredInheritanceMode === 'additive'
                ? 'border-[#5e6ad2] bg-[#eef0fb]'
                : 'border-transparent bg-slate-50 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
            } ${
              !canManagePermissionInheritance || !policy || inheritanceSaving
                ? 'cursor-not-allowed opacity-70'
                : ''
            }`}
          >
            <input
              type="radio"
              name="permissionInheritanceMode"
              value="additive"
              checked={desiredInheritanceMode === 'additive'}
              disabled={!canManagePermissionInheritance}
              aria-describedby="permission-inheritance-additive-description"
              onChange={() => updateInheritanceMode('additive')}
              className="mt-0.5 h-4 w-4 accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
            />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-slate-900">
                Additive (加算)
              </span>
              <span
                id="permission-inheritance-additive-description"
                className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
              >
                現行の capability 和集合。親の権限に子の直接付与を加算します。既存テナントの既定値です。
              </span>
            </span>
          </label>

          <label
            className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
              desiredInheritanceMode === 'waterfall'
                ? 'border-[#5e6ad2] bg-[#eef0fb]'
                : 'border-transparent bg-slate-50 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
            } ${
              !canManagePermissionInheritance || !policy || inheritanceSaving
                ? 'cursor-not-allowed opacity-70'
                : ''
            }`}
          >
            <input
              type="radio"
              name="permissionInheritanceMode"
              value="waterfall"
              checked={desiredInheritanceMode === 'waterfall'}
              disabled={!canManagePermissionInheritance}
              aria-describedby="permission-inheritance-waterfall-description"
              onChange={() => updateInheritanceMode('waterfall')}
              className="mt-0.5 h-4 w-4 accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-slate-900">
                Waterfall (親優先)
                {recommendWaterfall && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[0.625rem] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                    推奨: Closed 構成
                  </span>
                )}
              </span>
              <span
                id="permission-inheritance-waterfall-description"
                className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
              >
                親フォルダで権限を一元管理します。同じユーザー・グループが既に継承中の子フォルダでは再付与・変更できません（新規プリンシパルの追加は可能）。
              </span>
            </span>
          </label>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-amber-900">
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              既存テナントは既定 Additive です。Waterfall
              へ切り替えても既存の子上書き権限は自動削除されず、下の競合レポートに一覧表示されます。必要に応じて子側の直接付与を削除してください。
            </span>
          </p>
        </div>

        {!canManagePermissionInheritance && (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
            権限継承モードの変更は sys_admin に限定されます。sec_admin
            は現在の設定と競合レポートを読み取り専用で確認できます。
          </p>
        )}

        <div aria-live="assertive" aria-atomic="true" className="min-h-0">
          {inheritanceError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{inheritanceError}</span>
            </div>
          )}
          {!inheritanceError && inheritanceNotice && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
            >
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{inheritanceNotice}</span>
            </div>
          )}
          {!inheritanceError && !inheritanceNotice && inheritanceDirty && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
            >
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>未保存の権限継承モード変更があります。</span>
            </div>
          )}
        </div>

        <section
          aria-labelledby="inheritance-conflict-heading"
          className="rounded-xl border border-slate-200 bg-white p-3"
        >
          <h3
            id="inheritance-conflict-heading"
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-800"
          >
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
            継承競合レポート ({inheritanceConflictReport.length})
          </h3>
          {inheritanceConflictReport.length === 0 ? (
            <p className="mt-1.5 text-[0.6875rem] text-slate-600">
              子フォルダ側で上書きされている継承権限はありません。
            </p>
          ) : (
            <div
              role="region"
              aria-label="継承競合レポート"
              tabIndex={0}
              className="mt-2 overflow-x-auto rounded-lg border border-slate-200 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
            >
              <table className="w-full min-w-[640px] border-collapse text-left text-[0.6875rem]">
                <caption className="sr-only">
                  親フォルダから継承済みの権限を子フォルダ側で上書きしている項目の一覧。
                </caption>
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th scope="col" className="px-3 py-2 font-medium">
                      対象
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      プリンシパル
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      子での直接ロール
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      継承元
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      親ロール
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {inheritanceConflictReport.map((conflict) => (
                    <tr
                      key={conflict.permissionId}
                      data-testid="inheritance-conflict-row"
                      className="border-b border-slate-100 last:border-b-0"
                    >
                      <th scope="row" className="px-3 py-2 font-medium">
                        <span className="block text-slate-900">
                          {conflict.targetName}
                        </span>
                        <span className="text-[0.625rem] font-normal text-slate-500">
                          {conflict.targetType === 'folder'
                            ? 'フォルダ'
                            : 'ファイル'}
                        </span>
                      </th>
                      <td className="px-3 py-2 text-slate-700">
                        {conflict.granteeName ?? conflict.granteeId}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {ROLE_META[conflict.directRole]?.label ??
                          conflict.directRole}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {conflict.ancestorFolderName}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {ROLE_META[conflict.ancestorRole]?.label ??
                          conflict.ancestorRole}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {canManagePermissionInheritance && (
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={
                !policy ||
                inheritanceSaving ||
                !inheritanceDirty ||
                !canManagePermissionInheritance
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inheritanceSaving && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              <span>
                {inheritanceSaving ? '保存中...' : '継承モードを保存'}
              </span>
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
