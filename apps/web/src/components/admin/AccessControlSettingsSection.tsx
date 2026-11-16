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
import { ROLE_META } from '@/lib/capabilities';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import { readPermissionInheritanceMode } from '@/lib/permission-inheritance';
import {
  INVITE_POLICY_DESCRIPTION,
  INVITE_POLICY_LABEL,
  readTenantInvitePolicy,
} from '@/lib/invite-policy';
import type {
  ClosedRootReport,
  FolderStructureMode,
  InvitePolicy,
  PermissionInheritanceMode,
  TenantPolicyRow,
  WaterfallInheritanceConflict,
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
  permissionInheritanceMode,
  inheritanceSaving,
  inheritanceError,
  inheritanceNotice,
  canManagePermissionInheritance,
  inheritanceConflictReport,
  invitePolicySaving,
  invitePolicyError,
  invitePolicyNotice,
  canManageInvitePolicy,
  onSave,
  onSaveFolderStructureMode,
  onSavePermissionInheritanceMode,
  onSaveInvitePolicy,
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
  permissionInheritanceMode: PermissionInheritanceMode;
  inheritanceSaving: boolean;
  inheritanceError: string | null;
  inheritanceNotice: string | null;
  canManagePermissionInheritance: boolean;
  inheritanceConflictReport: WaterfallInheritanceConflict[];
  invitePolicySaving: boolean;
  invitePolicyError: string | null;
  invitePolicyNotice: string | null;
  canManageInvitePolicy: boolean;
  onSave: (enabled: boolean) => Promise<boolean>;
  onSaveFolderStructureMode: (
    mode: FolderStructureMode
  ) => Promise<boolean>;
  onSavePermissionInheritanceMode: (
    mode: PermissionInheritanceMode
  ) => Promise<boolean>;
  onSaveInvitePolicy: (policy: InvitePolicy) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const persisted = readAdvancedRolesEnabled(policy);
  const persistedFolderStructureMode = readFolderStructureMode(policy);
  const persistedInheritanceMode = readPermissionInheritanceMode(policy);
  const [desiredEnabled, setDesiredEnabled] = useState(persisted);
  const [dirty, setDirty] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const [desiredFolderStructureMode, setDesiredFolderStructureMode] =
    useState<FolderStructureMode>(persistedFolderStructureMode);
  const [folderStructureDirty, setFolderStructureDirty] = useState(false);
  const folderStructureDirtyRef = useRef(false);
  const [desiredInheritanceMode, setDesiredInheritanceMode] =
    useState<PermissionInheritanceMode>(persistedInheritanceMode);
  const [inheritanceDirty, setInheritanceDirty] = useState(false);
  const inheritanceDirtyRef = useRef(false);
  const persistedInvitePolicy = readTenantInvitePolicy(policy);
  const [desiredInvitePolicy, setDesiredInvitePolicy] =
    useState<InvitePolicy>(persistedInvitePolicy);
  const [invitePolicyDirty, setInvitePolicyDirty] = useState(false);
  const invitePolicyDirtyRef = useRef(false);

  useEffect(() => {
    if (dirtyRef.current) return;
    setDesiredEnabled(readAdvancedRolesEnabled(policy));
  }, [policy]);

  useEffect(() => {
    if (folderStructureDirtyRef.current) return;
    setDesiredFolderStructureMode(readFolderStructureMode(policy));
  }, [policy]);

  useEffect(() => {
    if (inheritanceDirtyRef.current) return;
    setDesiredInheritanceMode(readPermissionInheritanceMode(policy));
  }, [policy]);

  useEffect(() => {
    if (invitePolicyDirtyRef.current) return;
    setDesiredInvitePolicy(readTenantInvitePolicy(policy));
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

  function updateInheritanceMode(next: PermissionInheritanceMode) {
    setDesiredInheritanceMode(next);
    const isDirty = next !== persistedInheritanceMode;
    inheritanceDirtyRef.current = isDirty;
    setInheritanceDirty(isDirty);
  }

  function updateInvitePolicy(next: InvitePolicy) {
    setDesiredInvitePolicy(next);
    const isDirty = next !== persistedInvitePolicy;
    invitePolicyDirtyRef.current = isDirty;
    setInvitePolicyDirty(isDirty);
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

  async function handleInvitePolicySubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    if (
      invitePolicySaving ||
      !policy ||
      !canManageInvitePolicy ||
      !invitePolicyDirty
    ) {
      return;
    }
    const ok = await onSaveInvitePolicy(desiredInvitePolicy);
    if (ok) {
      invitePolicyDirtyRef.current = false;
      setInvitePolicyDirty(false);
    }
  }

  const statusId = 'policy-advanced-roles-status';
  const descriptionId = 'policy-advanced-roles-description';
  const feedback = localError ?? error;
  const showClosedReport =
    desiredFolderStructureMode === 'closed' ||
    persistedFolderStructureMode === 'closed';
  const recommendWaterfall = desiredFolderStructureMode === 'closed';

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

      <form
        onSubmit={handleInvitePolicySubmit}
        aria-labelledby="tenant-invite-policy-heading"
        data-testid="tenant-invite-policy-section"
        className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5 xl:col-span-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Users className="h-4 w-4 text-[#5e6ad2]" />
          <h2
            id="tenant-invite-policy-heading"
            className="text-sm font-semibold text-slate-900"
          >
            テナント招待ポリシー
          </h2>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
            現在: {INVITE_POLICY_LABEL[persistedInvitePolicy]}
          </span>
        </div>
        <p className="text-[0.6875rem] leading-relaxed text-slate-600">
          新しいメンバーをフォルダ・ファイルへ招待できる人を決めます。フォルダ管理者は配下フォルダで、これより緩くない範囲の上書き設定ができます。
        </p>

        <fieldset disabled={!policy || invitePolicySaving} className="space-y-3">
          <legend className="text-xs font-semibold text-slate-700">
            招待できる人
          </legend>

          <div className="grid gap-2 sm:grid-cols-3">
            {(['editors', 'owners', 'admins'] as InvitePolicy[]).map(
              (option) => {
                const selected = desiredInvitePolicy === option;
                const descriptionId = `tenant-invite-policy-${option}-description`;
                return (
                  <label
                    key={option}
                    data-testid={`tenant-invite-policy-option-${option}`}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
                      selected
                        ? 'border-[#5e6ad2] bg-[#eef0fb]'
                        : 'border-transparent bg-slate-50 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
                    } ${
                      !canManageInvitePolicy || !policy || invitePolicySaving
                        ? 'cursor-not-allowed opacity-70'
                        : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="invitePolicy"
                      value={option}
                      checked={selected}
                      disabled={!canManageInvitePolicy}
                      aria-describedby={descriptionId}
                      onChange={() => updateInvitePolicy(option)}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-slate-900">
                        {INVITE_POLICY_LABEL[option]}
                      </span>
                      <span
                        id={descriptionId}
                        className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
                      >
                        {INVITE_POLICY_DESCRIPTION[option]}
                      </span>
                    </span>
                  </label>
                );
              }
            )}
          </div>

          <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-blue-900">
            <p className="flex items-start gap-1.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                ポリシー変更は即時に反映されます。既存の付与・権限は削除されませんが、新しい招待と招待フォームの表示が変わります。
                <strong>管理者のみ</strong> では、sys_admin
                でもフォルダへの所有者・共同所有者・編集者アクセスがない場合は招待できません。
              </span>
            </p>
          </div>

          {!canManageInvitePolicy && (
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
              テナント招待ポリシーを変更できるのはシステム管理者（sys_admin）だけです。sec_admin
              は現在の設定を読み取り専用で確認できます。
            </p>
          )}

          <div aria-live="assertive" aria-atomic="true" className="min-h-0">
            {invitePolicyError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{invitePolicyError}</span>
              </div>
            )}
            {!invitePolicyError && invitePolicyNotice && (
              <div
                role="status"
                data-testid="tenant-invite-policy-notice"
                className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
              >
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{invitePolicyNotice}</span>
              </div>
            )}
            {!invitePolicyError && !invitePolicyNotice && invitePolicyDirty && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>未保存の招待ポリシー変更があります。</span>
              </div>
            )}
          </div>

          {canManageInvitePolicy && (
            <div className="flex items-center justify-end">
              <button
                type="submit"
                disabled={
                  !policy ||
                  invitePolicySaving ||
                  !invitePolicyDirty ||
                  !canManageInvitePolicy
                }
                className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {invitePolicySaving && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                <span>
                  {invitePolicySaving ? '保存中...' : '招待ポリシーを保存'}
                </span>
              </button>
            </div>
          )}
        </fieldset>
      </form>
    </section>
  );
}
