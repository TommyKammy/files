'use client';

import {
  AlertTriangle,
  CheckCircle2,
  FolderTree,
  Info,
  Loader2,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import type {
  ClosedRootReport,
  FolderStructureMode,
  TenantPolicyRow,
} from '@/types/files';

/**
 * Native checkbox rendered as a switch. React's HTML typings predate the
 * HTML `switch` attribute, so the attribute is spread through an explicit
 * input-props cast while remaining a real native checkbox in the DOM.
 */
const NATIVE_SWITCH_ATTRS = {
  switch: '',
} as unknown as React.InputHTMLAttributes<HTMLInputElement>;

function readAdvancedRolesEnabled(policy: TenantPolicyRow | null): boolean {
  if (!policy) return false;
  if (typeof policy.advancedRolesEnabled === 'boolean') {
    return policy.advancedRolesEnabled;
  }
  return policy.advanced_roles_enabled === 1;
}

function readFolderStructureMode(
  policy: TenantPolicyRow | null
): FolderStructureMode {
  if (!policy) return 'open';
  if (policy.folderStructureMode === 'closed') return 'closed';
  if (policy.folder_structure_mode === 'closed') return 'closed';
  return 'open';
}

export function AccessControlSettingsSection({
  policy,
  saving,
  error,
  notice,
  canManageFolderStructure,
  folderStructureSaving,
  folderStructureError,
  folderStructureNotice,
  closedModeReport,
  onSave,
  onSaveFolderStructureMode,
  onDirtyChange,
}: {
  policy: TenantPolicyRow | null;
  saving: boolean;
  error: string | null;
  notice: string | null;
  canManageFolderStructure: boolean;
  folderStructureSaving: boolean;
  folderStructureError: string | null;
  folderStructureNotice: string | null;
  closedModeReport: ClosedRootReport | null;
  onSave: (enabled: boolean) => Promise<boolean>;
  onSaveFolderStructureMode: (
    mode: FolderStructureMode
  ) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const persisted = readAdvancedRolesEnabled(policy);
  const persistedFolderStructureMode = readFolderStructureMode(policy);
  const [desiredEnabled, setDesiredEnabled] = useState(persisted);
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const [desiredFolderStructureMode, setDesiredFolderStructureMode] =
    useState<FolderStructureMode>(persistedFolderStructureMode);
  const [folderStructureDirty, setFolderStructureDirty] = useState(false);
  const folderStructureDirtyRef = useRef(false);

  useEffect(() => {
    if (dirtyRef.current) return;
    setDesiredEnabled(readAdvancedRolesEnabled(policy));
  }, [policy]);

  useEffect(() => {
    if (folderStructureDirtyRef.current) return;
    setDesiredFolderStructureMode(readFolderStructureMode(policy));
  }, [policy]);

  function updateDirty(next: boolean) {
    dirtyRef.current = next;
    setDirty(next);
    onDirtyChange(next);
  }

  function updateFolderStructureMode(next: FolderStructureMode) {
    setDesiredFolderStructureMode(next);
    const isDirty = next !== persistedFolderStructureMode;
    folderStructureDirtyRef.current = isDirty;
    setFolderStructureDirty(isDirty);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !policy) return;
    setLocalError(null);
    const ok = await onSave(desiredEnabled);
    if (ok) updateDirty(false);
  }

  async function handleFolderStructureSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    if (
      folderStructureSaving ||
      !policy ||
      !canManageFolderStructure ||
      !folderStructureDirty
    ) {
      return;
    }
    const ok = await onSaveFolderStructureMode(desiredFolderStructureMode);
    if (ok) {
      folderStructureDirtyRef.current = false;
      setFolderStructureDirty(false);
    }
  }

  const statusId = 'policy-advanced-roles-status';
  const descriptionId = 'policy-advanced-roles-description';
  const feedback = localError ?? error;
  const showClosedReport =
    desiredFolderStructureMode === 'closed' ||
    persistedFolderStructureMode === 'closed';

  return (
    <section
      aria-labelledby="access-control-heading"
      className="grid grid-cols-1 gap-6 xl:grid-cols-3"
    >
      <div className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white xl:col-span-2">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-[#5e6ad2]" />
            <h2
              id="access-control-heading"
              className="text-sm font-semibold text-slate-900"
            >
              アクセス制御
            </h2>
          </div>
          <p className="mt-1 text-[0.6875rem] text-slate-500">
            高度ロール (Uploader / Previewer + Uploader / Viewer + Uploader)
            のテナントポリシーと、オープン / クローズド構成のルート直下ポリシーを管理します。
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-5 py-4">
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold text-slate-700">
              高度ロール (Advanced Roles) 有効化スイッチ
            </legend>

            <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:flex-row sm:items-center sm:justify-between">
              <label
                htmlFor="policy-advanced-roles-enabled"
                className="flex cursor-pointer items-start gap-3 text-xs"
              >
                <input
                  {...NATIVE_SWITCH_ATTRS}
                  id="policy-advanced-roles-enabled"
                  name="advancedRolesEnabled"
                  type="checkbox"
                  checked={desiredEnabled}
                  disabled={!policy || saving}
                  aria-describedby={descriptionId}
                  onChange={(event) => {
                    setDesiredEnabled(event.target.checked);
                    setLocalError(null);
                    updateDirty(true);
                  }}
                  onKeyDown={(event) => {
                    // Native checkboxes toggle on Space; add Enter for parity
                    // with the switch pattern expected by the admin UX.
                    if (event.key !== 'Enter' || !policy || saving) return;
                    event.preventDefault();
                    setDesiredEnabled((prev) => !prev);
                    setLocalError(null);
                    updateDirty(true);
                  }}
                  className="mt-0.5 h-5 w-9 shrink-0 cursor-pointer accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">
                    投稿系ロールをフォルダで付与可能にする
                  </span>
                  <span
                    id={descriptionId}
                    className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
                  >
                    既定は無効です。無効時は新しい高度ロール付与をブロックし、既存の付与は変更・削除するまで保持します。
                    高度ロールはフォルダ専用で、ファイルには付与できません。
                  </span>
                </span>
              </label>

              <div className="flex shrink-0 items-center gap-2 sm:pl-3">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-1 text-[0.6875rem] font-medium ${
                    persisted
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-slate-200 text-slate-700'
                  }`}
                >
                  {persisted ? '有効' : '無効'}
                </span>
                <button
                  type="submit"
                  disabled={!policy || saving || !dirty}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>{saving ? '保存中...' : '変更を保存'}</span>
                </button>
              </div>
            </div>
          </fieldset>

          <div
            id={statusId}
            aria-live="assertive"
            aria-atomic="true"
            className="min-h-0"
          >
            {feedback && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{feedback}</span>
              </div>
            )}
            {!feedback && notice && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
              >
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{notice}</span>
              </div>
            )}
            {!feedback && !notice && dirty && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  未保存の変更があります。「変更を保存」で
                  {desiredEnabled ? '有効化' : '無効化'}を適用してください。
                </span>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
              <SlidersHorizontal className="h-3.5 w-3.5 text-slate-500" />
              ポリシー変更の影響
            </h3>
            <ul className="mt-2 space-y-1.5 text-[0.6875rem] leading-relaxed text-slate-600">
              <li>
                ・<strong>有効化</strong>すると、フォルダの権限画面で
                <span className="font-mono"> Uploader </span>
                /
                <span className="font-mono"> Previewer + Uploader </span>
                /
                <span className="font-mono"> Viewer + Uploader </span>
                を付与できます。ファイルには付与できません。
              </li>
              <li>
                ・<strong>無効化</strong>すると新規付与は
                <span className="font-mono"> ADVANCED_ROLES_DISABLED </span>
                でブロックされます。既存の高度ロール付与は自動削除されず、管理者が更新または取り消すまで有効です。
              </li>
              <li>
                ・<strong>Uploader</strong> は新規アップロード専用で、一覧・プレビュー・ダウンロードはできません。
                <strong>Previewer + Uploader</strong>{' '}
                はプレビューと新規アップロードのみで、DL・既存版の上書き・WOPI
                編集はできません。
              </li>
              <li>
                ・<strong>Viewer + Uploader</strong> は閲覧・DL・WOPI
                編集・新規/新版アップロードが可能ですが、名前変更・移動・削除・権限管理・機密区分変更はできません。作成できる共有リンクは表示専用（DL不可・透かし付き）です。
              </li>
            </ul>
          </div>
        </form>
      </div>

      <form
        onSubmit={handleFolderStructureSubmit}
        onKeyDown={(event) => {
          if (isImeComposingEvent(event.nativeEvent) && event.key === 'Enter') {
            event.preventDefault();
          }
        }}
        aria-labelledby="folder-structure-mode-heading"
        className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5"
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
                onChange={() => updateFolderStructureMode('open')}
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
                onChange={() => updateFolderStructureMode('closed')}
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
    </section>
  );
}
