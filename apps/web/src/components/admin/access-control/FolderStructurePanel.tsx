'use client';

import {
  AlertTriangle,
  CheckCircle2,
  FolderTree,
  Info,
  Loader2,
  Users,
} from 'lucide-react';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import type {
  ClosedRootReport,
  FolderStructureMode,
  TenantPolicyRow,
} from '@/types/files';

export function FolderStructurePanel({
  policy,
  canManageFolderStructure,
  folderStructureSaving,
  folderStructureError,
  folderStructureNotice,
  closedModeReport,
  desiredFolderStructureMode,
  folderStructureDirty,
  showClosedReport,
  colSpanFull,
  onSelectMode,
  onSubmit,
}: {
  policy: TenantPolicyRow | null;
  canManageFolderStructure: boolean;
  folderStructureSaving: boolean;
  folderStructureError: string | null;
  folderStructureNotice: string | null;
  closedModeReport: ClosedRootReport | null;
  desiredFolderStructureMode: FolderStructureMode;
  folderStructureDirty: boolean;
  showClosedReport: boolean;
  colSpanFull: boolean;
  onSelectMode: (mode: FolderStructureMode) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      onKeyDown={(event) => {
        if (isImeComposingEvent(event.nativeEvent) && event.key === 'Enter') {
          event.preventDefault();
        }
      }}
      aria-labelledby="folder-structure-mode-heading"
      className={`space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5 ${
        colSpanFull ? 'xl:col-span-3' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <FolderTree className="h-4 w-4 text-[#5e6ad2]" />
        <h2
          id="folder-structure-mode-heading"
          className="text-sm font-semibold text-slate-900"
        >
          フォルダ構成モード (Open / Closed)
        </h2>
      </div>

      <fieldset disabled={!policy || folderStructureSaving} className="space-y-3">
        <legend className="text-xs font-semibold text-slate-700">
          ルート直下の作成・移動・復元ポリシー
        </legend>

        <div className="grid gap-2">
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
              desiredFolderStructureMode === 'open'
                ? 'border-[#5e6ad2] bg-[#eef0fb]'
                : 'border-transparent bg-slate-50 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
            } ${
              !canManageFolderStructure || !policy || folderStructureSaving
                ? 'cursor-not-allowed opacity-70'
                : ''
            }`}
          >
            <input
              type="radio"
              name="folderStructureMode"
              value="open"
              checked={desiredFolderStructureMode === 'open'}
              disabled={!canManageFolderStructure}
              aria-describedby="folder-structure-mode-open-description"
              onChange={() => onSelectMode('open')}
              className="mt-0.5 h-4 w-4 accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
            />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-slate-900">
                Open（オープン構成）
              </span>
              <span
                id="folder-structure-mode-open-description"
                className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
              >
                従来どおり、権限を持つメンバーがルート直下にフォルダ・ファイルを作成できます。
              </span>
            </span>
          </label>

          <label
            className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
              desiredFolderStructureMode === 'closed'
                ? 'border-[#5e6ad2] bg-[#eef0fb]'
                : 'border-transparent bg-slate-50 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
            } ${
              !canManageFolderStructure || !policy || folderStructureSaving
                ? 'cursor-not-allowed opacity-70'
                : ''
            }`}
          >
            <input
              type="radio"
              name="folderStructureMode"
              value="closed"
              checked={desiredFolderStructureMode === 'closed'}
              disabled={!canManageFolderStructure}
              aria-describedby="folder-structure-mode-closed-description"
              onChange={() => onSelectMode('closed')}
              className="mt-0.5 h-4 w-4 accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
            />
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-slate-900">
                Closed（クローズド構成）
              </span>
              <span
                id="folder-structure-mode-closed-description"
                className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
              >
                ルート直下の作成・移動・コピー・復元は sys_admin
                のみ可能です。sec_admin は閲覧・監査のみになります。
              </span>
            </span>
          </label>
        </div>

        {!canManageFolderStructure && (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
            フォルダ構成モードを変更できるのは sys_admin のみです。sec_admin
            は現在の設定を読み取り専用で確認できます。
          </p>
        )}

        <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-blue-900">
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              モードを切り替えても、既存のルートフォルダ・配下フォルダ・ファイル・権限は
              <strong>削除も変更もされません</strong>。Closed
              では非 sys_admin による新規のルート直下作成・移動・コピー・復元だけを制限します。既存フォルダ内の作業はこれまでどおり可能です。
            </span>
          </p>
        </div>

        <div aria-live="assertive" aria-atomic="true" className="min-h-0">
          {folderStructureError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{folderStructureError}</span>
            </div>
          )}
          {!folderStructureError && folderStructureNotice && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
            >
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{folderStructureNotice}</span>
            </div>
          )}
          {!folderStructureError &&
            !folderStructureNotice &&
            folderStructureDirty && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>未保存のフォルダ構成モード変更があります。</span>
              </div>
            )}
        </div>
      </fieldset>

      {showClosedReport && (
        <section
          aria-labelledby="closed-mode-report-heading"
          className="rounded-xl border border-amber-200 bg-amber-50/70 p-3"
        >
          <h3
            id="closed-mode-report-heading"
            className="flex items-center gap-1.5 text-xs font-semibold text-amber-900"
          >
            <Users className="h-3.5 w-3.5" />
            既存ルート所有者レポート
          </h3>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-white px-2 py-2 ring-1 ring-inset ring-amber-200">
              <dt className="text-[0.625rem] text-slate-500">
                ルートフォルダ
              </dt>
              <dd className="text-sm font-semibold text-slate-900">
                {closedModeReport?.totalRootFolders ?? '—'}
              </dd>
            </div>
            <div className="rounded-lg bg-white px-2 py-2 ring-1 ring-inset ring-amber-200">
              <dt className="text-[0.625rem] text-slate-500">所有者不在</dt>
              <dd className="text-sm font-semibold text-red-700">
                {closedModeReport?.missingOwnerCount ?? '—'}
              </dd>
            </div>
            <div className="rounded-lg bg-white px-2 py-2 ring-1 ring-inset ring-amber-200">
              <dt className="text-[0.625rem] text-slate-500">
                停止ユーザー所有
              </dt>
              <dd className="text-sm font-semibold text-amber-800">
                {closedModeReport?.suspendedOwnerCount ?? '—'}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[0.625rem] leading-relaxed text-amber-900">
            所有者不在・停止ユーザーのルートは、下の「ルートフォルダ管理」から
            sys_admin が所有者を移管できます。
          </p>
        </section>
      )}

      {canManageFolderStructure && (
        <div className="flex items-center justify-end">
          <button
            type="submit"
            disabled={
              !policy ||
              folderStructureSaving ||
              !folderStructureDirty ||
              !canManageFolderStructure
            }
            className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {folderStructureSaving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            <span>
              {folderStructureSaving ? '保存中...' : '構成モードを保存'}
            </span>
          </button>
        </div>
      )}
    </form>
  );
}
