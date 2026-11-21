'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClientError,
  fetchAdminPolicies,
  fetchInheritanceConflicts,
  updateAdminPolicies,
} from '@/lib/files-api';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type {
  AdminContentInspectPolicy,
  ClosedRootReport,
  FolderStructureMode,
  InvitePolicy,
  PermissionInheritanceMode,
  TenantPolicyRow,
  WaterfallInheritanceConflict,
} from '@/types/files';

type AdminPoliciesResponse = Awaited<ReturnType<typeof fetchAdminPolicies>>;
type InheritanceConflictsResponse = Awaited<
  ReturnType<typeof fetchInheritanceConflicts>
>;

interface UseGovernancePoliciesOptions {
  syncStore: WorkspaceSyncStore;
  snapshotPolicy: TenantPolicyRow | null;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

/**
 * Manages tenant governance policy state and all policy mutation handlers
 * (shared link defaults, advanced roles, folder structure mode, permission
 * inheritance, invite policy, and admin content inspection policy).
 */
export function useGovernancePolicies({
  syncStore,
  snapshotPolicy,
  setError,
  setNotice,
}: UseGovernancePoliciesOptions) {
  const [policy, setPolicy] = useState<TenantPolicyRow | null>(null);
  const [policySaving, setPolicySaving] = useState(false);

  const [advancedRolesSaving, setAdvancedRolesSaving] = useState(false);
  const [advancedRolesError, setAdvancedRolesError] = useState<string | null>(
    null
  );
  const [advancedRolesNotice, setAdvancedRolesNotice] = useState<string | null>(
    null
  );
  const advancedRolesDirtyRef = useRef(false);

  const [folderStructureSaving, setFolderStructureSaving] = useState(false);
  const [folderStructureError, setFolderStructureError] = useState<
    string | null
  >(null);
  const [folderStructureNotice, setFolderStructureNotice] = useState<
    string | null
  >(null);
  const [closedModeReport, setClosedModeReport] =
    useState<ClosedRootReport | null>(null);

  const [permissionInheritanceMode, setPermissionInheritanceMode] =
    useState<PermissionInheritanceMode>('additive');
  const [inheritanceSaving, setInheritanceSaving] = useState(false);
  const [inheritanceError, setInheritanceError] = useState<string | null>(null);
  const [inheritanceNotice, setInheritanceNotice] = useState<string | null>(
    null
  );
  const [inheritanceConflictReport, setInheritanceConflictReport] = useState<
    WaterfallInheritanceConflict[]
  >([]);

  const [invitePolicySaving, setInvitePolicySaving] = useState(false);
  const [invitePolicyError, setInvitePolicyError] = useState<string | null>(null);
  const [invitePolicyNotice, setInvitePolicyNotice] = useState<string | null>(
    null
  );

  const [inspectPolicySaving, setInspectPolicySaving] = useState(false);
  const [inspectPolicyError, setInspectPolicyError] = useState<string | null>(
    null
  );
  const [inspectPolicyNotice, setInspectPolicyNotice] = useState<
    string | null
  >(null);

  function setAdvancedRolesDirty(dirty: boolean) {
    advancedRolesDirtyRef.current = dirty;
  }

  useEffect(() => {
    if (snapshotPolicy && !policy) {
      setPolicy(snapshotPolicy);
    }
  }, [snapshotPolicy, policy]);

  const applyBundledPolicies = useCallback(
    (bundledPolicies: AdminPoliciesResponse) => {
      if (!advancedRolesDirtyRef.current) {
        setPolicy(bundledPolicies.policy);
      }
      setClosedModeReport(bundledPolicies.closedModeReport ?? null);
      setPermissionInheritanceMode(
        bundledPolicies.permissionInheritanceMode ?? 'additive'
      );
      setInheritanceConflictReport(
        bundledPolicies.inheritanceConflictReport ?? []
      );
    },
    []
  );

  const applyPolicyResponse = useCallback(
    (policyRes: AdminPoliciesResponse) => {
      // Never clobber an in-progress advanced-role switch with a
      // background realtime refresh (`admin.policy_updated` fires
      // `loadAll({ silent })`).
      if (!advancedRolesDirtyRef.current) {
        setPolicy(policyRes.policy);
      }
      setClosedModeReport(policyRes.closedModeReport ?? null);
    },
    []
  );

  const applyConflictsResponse = useCallback(
    (
      conflictsRes: InheritanceConflictsResponse,
      policyRes: AdminPoliciesResponse | null
    ) => {
      setPermissionInheritanceMode(
        conflictsRes.permissionInheritanceMode ??
          policyRes?.permissionInheritanceMode ??
          'additive'
      );
      setInheritanceConflictReport(conflictsRes.conflicts ?? []);
    },
    []
  );

  const clearInheritanceConflicts = useCallback(() => {
    setInheritanceConflictReport([]);
  }, []);

  async function handlePolicySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!policy || policySaving) return;
    setPolicySaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await updateAdminPolicies({
        enforceCompanyOnlyLinks: policy.enforce_company_only_links === 1,
        requireWatermarkConfidential: policy.require_watermark_confidential === 1,
        maxLinkExpirationDays: policy.max_link_expiration_days,
        sessionMaxHours: policy.session_max_hours,
        trashRetentionDays: policy.trash_retention_days,
        aiClassificationMode: policy.ai_classification_mode,
        aiAutoApplyThreshold: policy.ai_auto_apply_threshold,
        allowSharedLinkEdit: policy.allow_shared_link_edit === 1,
        allowPublicEditLinks:
          policy.allow_shared_link_edit === 1 &&
          policy.allow_public_edit_links === 1,
        allowViewerShareLinks: policy.allow_viewer_share_links === 1,
      });
      setPolicy(res.policy);
      void syncStore.bootstrap({ force: true });
      setNotice('テナントガバナンスポリシーを更新しました。');
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'ポリシー更新に失敗しました'
      );
    } finally {
      setPolicySaving(false);
    }
  }

  /**
   * Dedicated advanced-role policy save. Updates only
   * `advanced_roles_enabled` so a pending edit in the shared links policy form
   * is never silently overwritten.
   */
  async function handleAdvancedRolesUpdate(nextEnabled: boolean) {
    if (advancedRolesSaving) return false;
    setAdvancedRolesSaving(true);
    setAdvancedRolesError(null);
    setAdvancedRolesNotice(null);
    try {
      const res = await updateAdminPolicies({
        advancedRolesEnabled: nextEnabled,
      });
      advancedRolesDirtyRef.current = false;
      setPolicy(res.policy);
      void syncStore.bootstrap({ force: true });
      setAdvancedRolesNotice(
        nextEnabled
          ? '高度ロール (Uploader / Previewer + Uploader / Viewer + Uploader) を有効化しました。フォルダ権限画面で付与できます。'
          : '高度ロールを無効化しました。新規付与はブロックされますが、既存の付与は保持されます。'
      );
      return true;
    } catch (err) {
      setAdvancedRolesError(
        err instanceof ApiClientError
          ? err.message
          : '高度ロール設定の更新に失敗しました'
      );
      return false;
    } finally {
      setAdvancedRolesSaving(false);
    }
  }

  async function handleFolderStructureUpdate(
    nextMode: FolderStructureMode
  ): Promise<boolean> {
    if (folderStructureSaving) return false;
    setFolderStructureSaving(true);
    setFolderStructureError(null);
    setFolderStructureNotice(null);
    try {
      const res = await updateAdminPolicies({
        folderStructureMode: nextMode,
      });
      setPolicy(res.policy);
      setClosedModeReport(res.closedModeReport ?? null);
      void syncStore.bootstrap({ force: true });
      setFolderStructureNotice(
        nextMode === 'closed'
          ? 'フォルダ構成モードを Closed に変更しました。ルート直下の作成・移動・コピー・復元は sys_admin のみになります。既存フォルダと権限は維持されています。'
          : 'フォルダ構成モードを Open に変更しました。権限を持つメンバーがルート直下に作成・移動・コピー・復元できます。'
      );
      return true;
    } catch (err) {
      setFolderStructureError(
        err instanceof ApiClientError
          ? err.message
          : 'フォルダ構成モードの更新に失敗しました'
      );
      return false;
    } finally {
      setFolderStructureSaving(false);
    }
  }

  async function handlePermissionInheritanceUpdate(
    nextMode: PermissionInheritanceMode
  ): Promise<boolean> {
    if (inheritanceSaving) return false;
    setInheritanceSaving(true);
    setInheritanceError(null);
    setInheritanceNotice(null);
    try {
      const res = await updateAdminPolicies({
        permissionInheritanceMode: nextMode,
      });
      setPolicy(res.policy);
      setPermissionInheritanceMode(
        res.permissionInheritanceMode ??
          res.policy.permissionInheritanceMode ??
          nextMode
      );
      setInheritanceConflictReport(res.inheritanceConflictReport ?? []);
      void syncStore.bootstrap({ force: true });
      const conflictCount = res.inheritanceConflictReport?.length ?? 0;
      setInheritanceNotice(
        nextMode === 'waterfall'
          ? `権限継承モードを Waterfall (親優先) に変更しました。既存の子上書き ${
              conflictCount > 0 ? `${conflictCount} 件` : '0 件'
            } は自動削除されず、競合レポートに表示されています。`
          : '権限継承モードを Additive (加算) に変更しました。親と子の権限は capability 和集合で合成されます。'
      );
      return true;
    } catch (err) {
      setInheritanceError(
        err instanceof ApiClientError
          ? err.message
          : '権限継承モードの更新に失敗しました'
      );
      return false;
    } finally {
      setInheritanceSaving(false);
    }
  }

  async function handleInvitePolicyUpdate(
    nextPolicy: InvitePolicy
  ): Promise<boolean> {
    if (invitePolicySaving) return false;
    setInvitePolicySaving(true);
    setInvitePolicyError(null);
    setInvitePolicyNotice(null);
    try {
      const res = await updateAdminPolicies({ invitePolicy: nextPolicy });
      setPolicy(res.policy);
      void syncStore.bootstrap({ force: true });
      setInvitePolicyNotice(
        nextPolicy === 'editors'
          ? 'テナント招待ポリシーを「編集者以上」に変更しました。編集者はフォルダ権限画面から新しいメンバーを招待できます。'
          : nextPolicy === 'owners'
            ? 'テナント招待ポリシーを「所有者/共同所有者のみ」に変更しました。編集者は招待できません。'
            : 'テナント招待ポリシーを「管理者のみ」に変更しました。sys_admin がフォルダへのアクセス権を持つ場合だけ招待できます。'
      );
      return true;
    } catch (err) {
      setInvitePolicyError(
        err instanceof ApiClientError
          ? err.message
          : 'テナント招待ポリシーの更新に失敗しました'
      );
      return false;
    } finally {
      setInvitePolicySaving(false);
    }
  }

  async function handleAdminContentInspectPolicyUpdate(
    nextPolicy: AdminContentInspectPolicy
  ): Promise<boolean> {
    if (inspectPolicySaving) return false;
    setInspectPolicySaving(true);
    setInspectPolicyError(null);
    setInspectPolicyNotice(null);
    try {
      const res = await updateAdminPolicies({
        adminContentInspectPolicy: nextPolicy,
      });
      setPolicy(res.policy);
      void syncStore.bootstrap({ force: true });
      setInspectPolicyNotice(
        nextPolicy === 'watermark_confidential'
          ? '管理者コンテンツ検査ポリシーを「透かし強制付きプレビュー許可」に更新しました。'
          : nextPolicy === 'deny_confidential'
            ? '管理者コンテンツ検査ポリシーを「confidential 検査禁止」に更新しました。'
            : '管理者コンテンツ検査ポリシーを「全面禁止」に更新しました。'
      );
      return true;
    } catch (err) {
      setInspectPolicyError(
        err instanceof ApiClientError
          ? err.message
          : '管理者コンテンツ検査ポリシーの更新に失敗しました'
      );
      return false;
    } finally {
      setInspectPolicySaving(false);
    }
  }

  return {
    policy,
    setPolicy,
    policySaving,
    advancedRolesSaving,
    advancedRolesError,
    advancedRolesNotice,
    setAdvancedRolesDirty,
    folderStructureSaving,
    folderStructureError,
    folderStructureNotice,
    closedModeReport,
    permissionInheritanceMode,
    inheritanceSaving,
    inheritanceError,
    inheritanceNotice,
    inheritanceConflictReport,
    invitePolicySaving,
    invitePolicyError,
    invitePolicyNotice,
    inspectPolicySaving,
    inspectPolicyError,
    inspectPolicyNotice,
    applyBundledPolicies,
    applyPolicyResponse,
    applyConflictsResponse,
    clearInheritanceConflicts,
    handlePolicySubmit,
    handleAdvancedRolesUpdate,
    handleFolderStructureUpdate,
    handlePermissionInheritanceUpdate,
    handleInvitePolicyUpdate,
    handleAdminContentInspectPolicyUpdate,
  };
}
