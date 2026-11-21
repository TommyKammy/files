'use client';

import {
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  AdvancedRoleMatrix,
  ImpactSummaryCard,
} from '@/components/admin/access-control/AdvancedRoleMatrix';
import { AdminContentInspectPolicyPanel } from '@/components/admin/access-control/AdminContentInspectPolicyPanel';
import { FolderStructurePanel } from '@/components/admin/access-control/FolderStructurePanel';
import { PermissionInheritancePanel } from '@/components/admin/access-control/PermissionInheritancePanel';
import { TenantInvitePolicyPanel } from '@/components/admin/access-control/TenantInvitePolicyPanel';
import type {
  AdminContentInspectPolicy,
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
  permissionInheritanceMode: _permissionInheritanceMode,
  inheritanceSaving,
  inheritanceError,
  inheritanceNotice,
  canManagePermissionInheritance,
  inheritanceConflictReport,
  invitePolicySaving,
  invitePolicyError,
  invitePolicyNotice,
  canManageInvitePolicy,
  inspectPolicySaving,
  inspectPolicyError,
  inspectPolicyNotice,
  canManageInspectPolicy,
  onSave,
  onSaveFolderStructureMode,
  onSavePermissionInheritanceMode,
  onSaveInvitePolicy,
  onSaveAdminContentInspectPolicy,
  onDirtyChange,
  topicFilter = 'all',
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
  inspectPolicySaving: boolean;
  inspectPolicyError: string | null;
  inspectPolicyNotice: string | null;
  canManageInspectPolicy: boolean;
  onSave: (enabled: boolean) => Promise<boolean>;
  onSaveFolderStructureMode: (
    mode: FolderStructureMode
  ) => Promise<boolean>;
  onSavePermissionInheritanceMode: (
    mode: PermissionInheritanceMode
  ) => Promise<boolean>;
  onSaveInvitePolicy: (policy: InvitePolicy) => Promise<boolean>;
  onSaveAdminContentInspectPolicy: (
    policy: AdminContentInspectPolicy
  ) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
  /**
   * 1-Screen-1-Topic projection. `all` keeps the legacy stacked layout for
   * the integrated `/admin?tab=settings` shell; the workbench renders one
   * focused subset at a time.
   */
  topicFilter?:
    | 'roles-and-invite'
    | 'folder-structure'
    | 'content-inspection'
    | 'all';
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
  const recommendWaterfall = desiredFolderStructureMode === 'closed';

  const showAdvancedRoles =
    topicFilter === 'all' || topicFilter === 'roles-and-invite';
  const showInvitePolicy = showAdvancedRoles;
  const showFolderStructure =
    topicFilter === 'all' || topicFilter === 'folder-structure';
  const showPermissionInheritance =
    topicFilter === 'all' || topicFilter === 'folder-structure';
  const showInspectPolicy =
    topicFilter === 'all' || topicFilter === 'content-inspection';
  const roleFocused = topicFilter === 'roles-and-invite';

  return (
    <section
      aria-label="アクセス制御とフォルダ構成"
      className="grid grid-cols-1 gap-6 xl:grid-cols-3"
    >
      {showAdvancedRoles && (
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

            {topicFilter === 'all' && <ImpactSummaryCard />}
          </form>
          <AdvancedRoleMatrix />
        </div>
      )}

      {roleFocused && <ImpactSummaryCard />}

      {showFolderStructure && (
        <FolderStructurePanel
          policy={policy}
          canManageFolderStructure={canManageFolderStructure}
          folderStructureSaving={folderStructureSaving}
          folderStructureError={folderStructureError}
          folderStructureNotice={folderStructureNotice}
          closedModeReport={closedModeReport}
          desiredFolderStructureMode={desiredFolderStructureMode}
          folderStructureDirty={folderStructureDirty}
          showClosedReport={showClosedReport}
          colSpanFull={topicFilter !== 'all'}
          onSelectMode={updateFolderStructureMode}
          onSubmit={handleFolderStructureSubmit}
        />
      )}

      {showPermissionInheritance && (
        <PermissionInheritancePanel
          policy={policy}
          inheritanceSaving={inheritanceSaving}
          inheritanceError={inheritanceError}
          inheritanceNotice={inheritanceNotice}
          canManagePermissionInheritance={canManagePermissionInheritance}
          inheritanceConflictReport={inheritanceConflictReport}
          recommendWaterfall={recommendWaterfall}
          onSavePermissionInheritanceMode={onSavePermissionInheritanceMode}
        />
      )}

      {showInvitePolicy && (
        <TenantInvitePolicyPanel
          policy={policy}
          invitePolicySaving={invitePolicySaving}
          invitePolicyError={invitePolicyError}
          invitePolicyNotice={invitePolicyNotice}
          canManageInvitePolicy={canManageInvitePolicy}
          onSaveInvitePolicy={onSaveInvitePolicy}
        />
      )}

      {showInspectPolicy && (
        <AdminContentInspectPolicyPanel
          policy={policy}
          inspectPolicySaving={inspectPolicySaving}
          inspectPolicyError={inspectPolicyError}
          inspectPolicyNotice={inspectPolicyNotice}
          canManageInspectPolicy={canManageInspectPolicy}
          onSaveAdminContentInspectPolicy={onSaveAdminContentInspectPolicy}
        />
      )}
    </section>
  );
}
