'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  adminEmergencyRevokeSharedLink,
  ApiClientError,
  bulkApproveAiSuggestions,
  fetchAdminAiSuggestions,
  fetchAdminPolicies,
  fetchAdminSharedLinks,
  fetchAdminStorageStats,
  fetchAuditLogs,
  fetchInheritanceConflicts,
  updateAdminPolicies,
} from '@/lib/files-api';
import { AdminAiBatchCoalescer } from '@/lib/mutation-outbox';
import {
  getWorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import type {
  AdminContentInspectPolicy,
  AdminSharedLinkRow,
  AiSuggestionItem,
  AuditLogEntry,
  ClassificationLabel,
  ClosedRootReport,
  FolderStructureMode,
  InvitePolicy,
  PermissionInheritanceMode,
  StorageStatsResponse,
  TenantPolicyRow,
  WaterfallInheritanceConflict,
} from '@/types/files';
import {
  GUEST_AUDIT_ACTION_PREFIXES,
  PERMISSION_AUDIT_ACTION_PREFIXES,
  ROOT_FOLDER_AUDIT_ACTIONS,
  USER_AUDIT_ACTION_PREFIXES,
} from '@/lib/admin-audit';
import {
  ADMIN_AUDIT_PRESETS,
  buildAdminAuditPresetHref,
  getAdminSectionFetchPlan,
  parseAdminAuditPreset,
  type AdminConsoleSection,
} from '@/lib/admin-console-nav';

export function useGovernanceDashboard({
  section = 'all',
  auditPreset = null,
}: {
  section?: AdminConsoleSection;
  auditPreset?: string | string[] | null;
} = {}) {
  const router = useRouter();
  const syncStore = getWorkspaceSyncStore();
  const snapshot = useWorkspaceSyncSnapshot();
  const user = snapshot.user;
  const authChecked = snapshot.authStatus !== 'unknown';

  const initialAuditPreset = parseAdminAuditPreset(auditPreset);
  const initialAuditPresetConfig = initialAuditPreset
    ? ADMIN_AUDIT_PRESETS[initialAuditPreset]
    : null;

  const [loading, setLoading] = useState(true);
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    section === 'users'
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [stats, setStats] = useState<StorageStatsResponse | null>(null);
  const [suggestions, setSuggestions] = useState<AiSuggestionItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [labelFilter, setLabelFilter] = useState<ClassificationLabel | 'all'>('all');
  const [bulkBusy, setBulkBusy] = useState(false);

  const [sharedLinks, setSharedLinks] = useState<AdminSharedLinkRow[]>([]);
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

  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditCursor, setAuditCursor] = useState<{
    createdAt: string;
    id: string;
  } | null>(null);
  const [auditActionFilter, setAuditActionFilter] = useState('');
  const [auditActionPreset, setAuditActionPreset] = useState<string[]>(
    initialAuditPresetConfig ? [...initialAuditPresetConfig.actions] : []
  );
  const [auditActionPrefixFilter, setAuditActionPrefixFilter] = useState('');
  const [auditActionPrefixPreset, setAuditActionPrefixPreset] = useState<
    string[]
  >(
    initialAuditPresetConfig
      ? [...initialAuditPresetConfig.actionPrefixes]
      : []
  );
  const [auditPresetKind, setAuditPresetKind] = useState<
    'permission' | 'guest' | 'user' | null
  >(initialAuditPresetConfig?.presetKind ?? null);
  const [auditTargetType, setAuditTargetType] = useState('');
  const [auditStatusFilter, setAuditStatusFilter] = useState<'' | 'allowed' | 'blocked'>('');
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);

  // The reports page is a normal server-rendered route, so `auditPreset`
  // arrives as a prop. Only re-apply when the raw query value changes; the
  // initial state above already covers the first render.
  const initialAuditPresetRaw =
    (Array.isArray(auditPreset) ? auditPreset[0] : auditPreset) ?? null;
  const appliedAuditPresetRef = useRef<string | null>(initialAuditPresetRaw);

  useEffect(() => {
    void syncStore.hydrateFromScopeHint();
    void syncStore.bootstrap();
  }, [syncStore]);

  useEffect(() => {
    if (snapshot.policy && !policy) {
      setPolicy(snapshot.policy);
    }
  }, [snapshot.policy, policy]);

  const isPrivilegedAdmin =
    user?.userType !== 'guest' &&
    (user?.role === 'sys_admin' || user?.role === 'sec_admin');

  const loadAll = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!authChecked || !user || !isPrivilegedAdmin) return;

      const plan = getAdminSectionFetchPlan(section);
      if (plan.completesImmediately) {
        if (!options?.silent) {
          setLoading(false);
          setInitialLoadComplete(true);
        }
        return;
      }

      if (!options?.silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const [statsRes, aiRes, linksRes, policyRes, logsRes, conflictsRes] =
          await Promise.all([
            plan.storageStats ? fetchAdminStorageStats() : Promise.resolve(null),
            plan.aiSuggestions
              ? fetchAdminAiSuggestions({
                  suggestedLabel:
                    labelFilter === 'all' ? undefined : labelFilter,
                  limit: 50,
                })
              : Promise.resolve(null),
            plan.sharedLinks
              ? fetchAdminSharedLinks(50)
              : Promise.resolve(null),
            plan.policies ? fetchAdminPolicies() : Promise.resolve(null),
            plan.auditLogs
              ? fetchAuditLogs({
                  action: auditActionFilter.trim() || undefined,
                  actions:
                    auditActionPreset.length > 0
                      ? auditActionPreset
                      : undefined,
                  actionPrefixes: [
                    ...auditActionPrefixPreset,
                    ...(auditActionPrefixFilter.trim()
                      ? [auditActionPrefixFilter.trim()]
                      : []),
                  ].filter(Boolean),
                  targetType: auditTargetType || undefined,
                  status: auditStatusFilter || undefined,
                  limit: 50,
                })
              : Promise.resolve(null),
            plan.inheritanceConflicts
              ? fetchInheritanceConflicts()
              : Promise.resolve(null),
          ]);

        if (statsRes) {
          setStats(statsRes);
        }
        if (aiRes) {
          setSuggestions(aiRes.suggestions);
          setSelectedIds(new Set());
        }
        if (linksRes) {
          setSharedLinks(linksRes.links);
        }
        if (policyRes) {
          // Never clobber an in-progress advanced-role switch with a
          // background realtime refresh (`admin.policy_updated` fires
          // `loadAll({ silent })`).
          if (!advancedRolesDirtyRef.current) {
            setPolicy(policyRes.policy);
          }
          setClosedModeReport(policyRes.closedModeReport ?? null);
        }
        if (conflictsRes) {
          setPermissionInheritanceMode(
            conflictsRes.permissionInheritanceMode ??
              policyRes?.permissionInheritanceMode ??
              'additive'
          );
          setInheritanceConflictReport(conflictsRes.conflicts ?? []);
        }
        if (logsRes) {
          setAuditLogs(logsRes.logs);
          setAuditCursor(logsRes.nextCursor);
        }
      } catch (err) {
        if (!options?.silent) {
          setError(
            err instanceof ApiClientError
              ? err.message
              : 'ガバナンスデータの読み込みに失敗しました'
          );
        }
      } finally {
        if (!options?.silent) {
          setLoading(false);
          // Mark the first section load complete only after every value for
          // this view has been applied in the same commit. The shell renders
          // one compact loading surface until then, so child sections cannot
          // shift content above them as their independent fetches resolve.
          setInitialLoadComplete(true);
        }
      }
    },
    [
      authChecked,
      user,
      isPrivilegedAdmin,
      section,
      labelFilter,
      auditActionFilter,
      auditActionPreset,
      auditActionPrefixFilter,
      auditActionPrefixPreset,
      auditTargetType,
      auditStatusFilter,
    ]
  );

  useEffect(() => {
    if (authChecked && isPrivilegedAdmin) {
      void loadAll();
    } else if (authChecked) {
      setLoading(false);
      setInitialLoadComplete(true);
    }
  }, [authChecked, isPrivilegedAdmin, loadAll]);

  useEffect(() => {
    const raw =
      (Array.isArray(auditPreset) ? auditPreset[0] : auditPreset) ?? null;
    if (appliedAuditPresetRef.current === raw) return;
    appliedAuditPresetRef.current = raw;

    const parsed = parseAdminAuditPreset(raw);
    const config = parsed ? ADMIN_AUDIT_PRESETS[parsed] : null;
    setAuditActionFilter('');
    setAuditActionPrefixFilter('');
    setAuditTargetType('');
    setAuditStatusFilter('');
    setAuditActionPreset(config ? [...config.actions] : []);
    setAuditActionPrefixPreset(config ? [...config.actionPrefixes] : []);
    setAuditPresetKind(config?.presetKind ?? null);
  }, [auditPreset]);

  useEffect(() => {
    if (!authChecked || !isPrivilegedAdmin) return;
    let refreshTimer: number | null = null;
    const unlistenSignals = syncStore.subscribeRealtimeSignals(() => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadAll({ silent: true });
      }, 250);
    });
    const unlistenRevocations = syncStore.subscribeSecurityRevocations((event) => {
      if (event.kind === 'user.suspended') {
        setStats(null);
        setSuggestions([]);
        setSharedLinks([]);
        setAuditLogs([]);
        setSelectedIds(new Set());
        setInheritanceConflictReport([]);
        setError(
          'アカウント停止またはセッション失効のため管理ダッシュボードデータを消去しました。'
        );
      }
    });
    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      unlistenSignals();
      unlistenRevocations();
    };
  }, [authChecked, isPrivilegedAdmin, loadAll, syncStore]);

  const aiRollbackRef = useRef(
    new Map<string, { item: AiSuggestionItem; index: number }>()
  );

  const aiCoalescer = useMemo(
    () =>
      new AdminAiBatchCoalescer({
        submit: async (batch) => {
          const res = await bulkApproveAiSuggestions(batch);
          for (const item of batch) {
            aiRollbackRef.current.delete(item.fileId);
          }
          setNotice(`${res.approvedCount}件のAI分類提案を承認しました。`);
          void syncStore.syncDelta();
        },
        onError: (batch, err) => {
          setSuggestions((prev) => {
            const next = [...prev];
            for (const b of batch) {
              const snap = aiRollbackRef.current.get(b.fileId);
              if (snap && !next.some((s) => s.fileId === b.fileId)) {
                next.splice(Math.min(snap.index, next.length), 0, snap.item);
              }
              aiRollbackRef.current.delete(b.fileId);
            }
            return next;
          });
          setError(
            err instanceof ApiClientError
              ? err.message
              : 'AI分類承認に失敗したためロールバックしました'
          );
        },
      }),
    [syncStore]
  );

  useEffect(() => () => aiCoalescer.clear(), [aiCoalescer]);

  function toggleSelection(fileId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function handleSelectAllSuggestions(checked: boolean) {
    setSelectedIds(
      checked
        ? new Set(suggestions.slice(0, 50).map((s) => s.fileId))
        : new Set()
    );
  }

  function handleBulkApprove() {
    if (selectedIds.size === 0 || bulkBusy) return;
    setError(null);
    setNotice(null);

    const targetIds = new Set([...selectedIds].slice(0, 50));
    const items = [...targetIds].map((fileId) => ({ fileId }));
    suggestions.forEach((item, index) => {
      if (targetIds.has(item.fileId)) {
        aiRollbackRef.current.set(item.fileId, { item, index });
      }
    });

    setSuggestions((prev) => prev.filter((s) => !targetIds.has(s.fileId)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of targetIds) next.delete(id);
      return next;
    });
    setNotice(`${items.length}件のAI分類提案を承認しました（同期中）`);
    aiCoalescer.enqueue(items);
  }

  function handleSingleApprove(
    fileId: string,
    overrideLabel?: Exclude<ClassificationLabel, 'unset'>
  ) {
    setError(null);
    setNotice(null);
    const index = suggestions.findIndex((s) => s.fileId === fileId);
    if (index >= 0) {
      aiRollbackRef.current.set(fileId, { item: suggestions[index], index });
    }
    setSuggestions((prev) => prev.filter((s) => s.fileId !== fileId));
    setSelectedIds((prev) => {
      if (!prev.has(fileId)) return prev;
      const next = new Set(prev);
      next.delete(fileId);
      return next;
    });
    setNotice('1件のファイル分類を確定しました（同期中）');
    aiCoalescer.enqueue([
      overrideLabel ? { fileId, label: overrideLabel } : { fileId },
    ]);
  }

  async function handleEmergencyRevoke(linkId: string) {
    setError(null);
    setNotice(null);
    const index = sharedLinks.findIndex((l) => l.id === linkId);
    const snapshot = index >= 0 ? sharedLinks[index] : null;

    setSharedLinks((prev) => prev.filter((l) => l.id !== linkId));
    setNotice(`共有リンク (${linkId.slice(0, 8)}...) を緊急失効しました。`);

    try {
      await adminEmergencyRevokeSharedLink(linkId, 'Admin dashboard revocation');
      void syncStore.syncDelta();
    } catch (err) {
      if (snapshot) {
        setSharedLinks((prev) => {
          if (prev.some((l) => l.id === linkId)) return prev;
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, snapshot);
          return next;
        });
      }
      setNotice(null);
      setError(
        err instanceof ApiClientError
          ? err.message
          : '共有リンクの緊急失効に失敗しました'
      );
    }
  }

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

  function scrollToAuditLogs() {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document
          .getElementById('admin-audit-logs')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function handleShowRootFolderAudit() {
    if (section !== 'all') {
      router.push(buildAdminAuditPresetHref('rootFolder'));
      return;
    }
    setAuditActionFilter('');
    setAuditActionPreset([...ROOT_FOLDER_AUDIT_ACTIONS]);
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([]);
    setAuditPresetKind(null);
    setAuditTargetType('');
    scrollToAuditLogs();
  }

  function handleShowPermissionAudit() {
    setAuditActionFilter('');
    setAuditActionPreset([]);
    setAuditStatusFilter('');
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([...PERMISSION_AUDIT_ACTION_PREFIXES]);
    setAuditPresetKind('permission');
    setAuditTargetType('');
    scrollToAuditLogs();
  }

  /** Guest lifecycle preset: `guest.*` and `admin.guest.*`. */
  function handleShowGuestAudit() {
    if (section !== 'all') {
      router.push(buildAdminAuditPresetHref('guest'));
      return;
    }
    setAuditActionFilter('');
    setAuditActionPreset([]);
    setAuditStatusFilter('');
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([...GUEST_AUDIT_ACTION_PREFIXES]);
    setAuditPresetKind('guest');
    setAuditTargetType('');
    scrollToAuditLogs();
  }

  /** Internal member administration preset: `admin.user.*`. */
  function handleShowMemberAudit() {
    if (section !== 'all') {
      router.push(buildAdminAuditPresetHref('user'));
      return;
    }
    setAuditActionFilter('');
    setAuditActionPreset([]);
    setAuditStatusFilter('');
    setAuditActionPrefixFilter('');
    setAuditActionPrefixPreset([...USER_AUDIT_ACTION_PREFIXES]);
    setAuditPresetKind('user');
    setAuditTargetType('');
    scrollToAuditLogs();
  }

  function handleClearAuditPreset() {
    setAuditActionPreset([]);
  }

  function handleClearAuditPrefixPreset() {
    setAuditActionPrefixPreset([]);
    setAuditPresetKind(null);
  }

  function handleAuditActionFilterChange(value: string) {
    setAuditActionPreset([]);
    setAuditActionPrefixPreset([]);
    setAuditActionPrefixFilter('');
    setAuditPresetKind(null);
    setAuditActionFilter(value);
  }

  function handleAuditActionPrefixFilterChange(value: string) {
    setAuditActionPrefixPreset([]);
    setAuditPresetKind(null);
    setAuditActionPrefixFilter(value);
  }

  function handleAuditTargetTypeChange(value: string) {
    setAuditTargetType(value);
  }

  async function handleLoadMoreLogs() {
    if (!auditCursor || auditLoadingMore) return;
    setAuditLoadingMore(true);
    try {
      const res = await fetchAuditLogs({
        action: auditActionFilter.trim() || undefined,
        actions: auditActionPreset.length > 0 ? auditActionPreset : undefined,
        actionPrefixes: [
          ...auditActionPrefixPreset,
          ...(auditActionPrefixFilter.trim()
            ? [auditActionPrefixFilter.trim()]
            : []),
        ].filter(Boolean),
        targetType: auditTargetType || undefined,
        status: auditStatusFilter || undefined,
        cursorCreatedAt: auditCursor.createdAt,
        cursorId: auditCursor.id,
        limit: 50,
      });
      setAuditLogs((prev) => [...prev, ...res.logs]);
      setAuditCursor(res.nextCursor);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : '監査ログの読み込みに失敗しました'
      );
    } finally {
      setAuditLoadingMore(false);
    }
  }

  return {
    syncStore,
    snapshot,
    user,
    authChecked,
    isPrivilegedAdmin,
    loading,
    initialLoadComplete,
    error,
    notice,
    stats,
    suggestions,
    selectedIds,
    labelFilter,
    bulkBusy,
    sharedLinks,
    policy,
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
    auditLogs,
    auditCursor,
    auditActionFilter,
    auditActionPreset,
    auditActionPrefixFilter,
    auditActionPrefixPreset,
    auditPresetKind,
    auditTargetType,
    auditStatusFilter,
    auditLoadingMore,
    setLabelFilter,
    setAuditActionFilter: handleAuditActionFilterChange,
    setAuditActionPrefixFilter: handleAuditActionPrefixFilterChange,
    setAuditTargetType: handleAuditTargetTypeChange,
    setAuditStatusFilter,
    handleClearAuditPrefixPreset,
    handleShowPermissionAudit,
    handleShowGuestAudit,
    handleShowMemberAudit,
    setPolicy,
    loadAll,
    toggleSelection,
    handleSelectAllSuggestions,
    handleBulkApprove,
    handleSingleApprove,
    handleEmergencyRevoke,
    handlePolicySubmit,
    handleAdvancedRolesUpdate,
    handleFolderStructureUpdate,
    handlePermissionInheritanceUpdate,
    handleInvitePolicyUpdate,
    handleAdminContentInspectPolicyUpdate,
    handleShowRootFolderAudit,
    handleClearAuditPreset,
    handleLoadMoreLogs,
  };
}
