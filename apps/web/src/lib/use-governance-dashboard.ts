'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  adminEmergencyRevokeSharedLink,
  ApiClientError,
  fetchAdminAiSuggestions,
  fetchAdminInsights,
  fetchAdminPolicies,
  fetchAdminSettingsBundle,
  fetchAdminSharedLinks,
  fetchAdminStorageStats,
  fetchAuditLogs,
  fetchInheritanceConflicts,
} from '@/lib/files-api';
import {
  getWorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import type {
  AdminInsightsRangeDays,
  AdminInsightsResponse,
  AdminSettingsBundleResponse,
  AdminSharedLinkRow,
  StorageStatsResponse,
} from '@/types/files';
import {
  canViewAdminConsoleSection,
  getAdminSectionOwnedApiPrefixes,
  type AdminConsoleSection,
} from '@/lib/admin-console-nav';
import {
  buildAdminTabHref,
  getAdminTabFetchPlan,
  getVisibleAdminTabs,
  parseAdminTabQuery,
  resolveActiveAdminTab,
} from '@/lib/admin-console-tabs';
import { hasAdminCapability } from '@/lib/admin-delegations';
import { ADMIN_INSIGHTS_DEFAULT_DAYS } from '@/lib/admin-insights';
import { useGovernanceAiSuggestions } from '@/lib/governance-dashboard/use-governance-ai-suggestions';
import { useGovernanceAuditLogs } from '@/lib/governance-dashboard/use-governance-audit-logs';
import { useGovernancePolicies } from '@/lib/governance-dashboard/use-governance-policies';

export function useGovernanceDashboard({
  section = 'all',
  auditPreset = null,
  initialTab = null,
}: {
  section?: AdminConsoleSection;
  auditPreset?: string | string[] | null;
  initialTab?: string | string[] | null;
} = {}) {
  const syncStore = getWorkspaceSyncStore();
  const snapshot = useWorkspaceSyncSnapshot();
  const user = snapshot.user;
  const authChecked = snapshot.authStatus !== 'unknown';

  const [selectedTabId, setSelectedTabId] = useState<string | null>(
    parseAdminTabQuery(initialTab)
  );
  const visibleTabs = getVisibleAdminTabs(user, section);
  const activeTab = resolveActiveAdminTab(user, section, selectedTabId, {
    auditPreset,
  });
  const activeTabId = activeTab?.id ?? null;
  const tabFetchPlan = useMemo(
    () => getAdminTabFetchPlan(section, activeTabId),
    [section, activeTabId]
  );

  const [loading, setLoading] = useState(true);
  const [initialLoadComplete, setInitialLoadComplete] = useState(
    getAdminTabFetchPlan(section, parseAdminTabQuery(initialTab))
      .completesImmediately
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [stats, setStats] = useState<StorageStatsResponse | null>(null);
  const [insights, setInsights] = useState<AdminInsightsResponse | null>(null);
  const [insightsDays, setInsightsDays] = useState<AdminInsightsRangeDays>(
    ADMIN_INSIGHTS_DEFAULT_DAYS
  );
  const [insightsLoading, setInsightsLoading] = useState(false);
  const insightsDaysRef = useRef<AdminInsightsRangeDays>(
    ADMIN_INSIGHTS_DEFAULT_DAYS
  );
  const insightsRequestRef = useRef(0);

  const [sharedLinks, setSharedLinks] = useState<AdminSharedLinkRow[]>([]);
  const [settingsBundle, setSettingsBundle] =
    useState<AdminSettingsBundleResponse | null>(null);

  const initialTabRaw =
    (Array.isArray(initialTab) ? initialTab[0] : initialTab) ?? null;
  const appliedInitialTabRef = useRef<string | null>(initialTabRaw);

  const selectTab = useCallback(
    (tabId: string) => {
      setSelectedTabId(tabId);
      if (typeof window === 'undefined') return;

      // Preserve unrelated query params (e.g. `auditPreset`) while replacing
      // the current history entry so tab switches do not pollute Back.
      const extraParams: Record<string, string> = {};
      const url = new URL(window.location.href);
      url.searchParams.forEach((value, key) => {
        if (key !== 'tab') extraParams[key] = value;
      });
      const href = buildAdminTabHref(section, tabId, extraParams);
      const current = `${window.location.pathname}${window.location.search}`;
      if (current !== href) {
        window.history.replaceState(window.history.state, '', href);
      }
    },
    [section]
  );

  const aiSuggestions = useGovernanceAiSuggestions({
    syncStore,
    setError,
    setNotice,
  });

  const policies = useGovernancePolicies({
    syncStore,
    snapshotPolicy: snapshot.policy,
    setError,
    setNotice,
  });

  const audit = useGovernanceAuditLogs({
    section,
    auditPreset,
    user,
    selectTab,
    setSelectedTabId,
    setError,
  });

  const { labelFilter, applyAiSuggestions, clearAiSuggestions } = aiSuggestions;
  const {
    applyBundledPolicies,
    applyPolicyResponse,
    applyConflictsResponse,
    clearInheritanceConflicts,
  } = policies;
  const { auditQueryParams, applyAuditLogsResponse, clearAuditLogs } = audit;

  useEffect(() => {
    void syncStore.hydrateFromScopeHint();
    void syncStore.bootstrap();
  }, [syncStore]);

  const isPrivilegedAdmin =
    user?.userType !== 'guest' &&
    (user?.role === 'sys_admin' ||
      user?.role === 'sec_admin' ||
      (user?.adminCapabilities?.length ?? 0) > 0);
  const sectionAllowed = canViewAdminConsoleSection(user, section);

  const loadAll = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!authChecked || !user || !isPrivilegedAdmin) return;
      // A denied direct deep link must not call any section API. The shell
      // renders the permission notice instead of a loading surface.
      if (!sectionAllowed) {
        if (!options?.silent) {
          setLoading(false);
          setInitialLoadComplete(true);
        }
        return;
      }

      const plan = tabFetchPlan;
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
        const canFetchSettingsBundle =
          plan.settingsBundle &&
          (hasAdminCapability(user, 'admin.policies.read') ||
            hasAdminCapability(user, 'admin.links.revoke') ||
            hasAdminCapability(user, 'admin.users.read'));

        const [
          statsRes,
          aiRes,
          linksRes,
          policyRes,
          logsRes,
          conflictsRes,
          insightsRes,
          settingsBundleRes,
        ] = await Promise.all([
          plan.storageStats && hasAdminCapability(user, 'admin.insights.read')
            ? fetchAdminStorageStats()
            : Promise.resolve(null),
          plan.aiSuggestions && hasAdminCapability(user, 'admin.content.unlock')
            ? fetchAdminAiSuggestions({
                suggestedLabel:
                  labelFilter === 'all' ? undefined : labelFilter,
                limit: 50,
              })
            : Promise.resolve(null),
          plan.sharedLinks && hasAdminCapability(user, 'admin.links.revoke')
            ? fetchAdminSharedLinks(50)
            : Promise.resolve(null),
          plan.policies && hasAdminCapability(user, 'admin.policies.read')
            ? fetchAdminPolicies()
            : Promise.resolve(null),
          plan.auditLogs && hasAdminCapability(user, 'admin.audit.read')
            ? fetchAuditLogs(auditQueryParams)
            : Promise.resolve(null),
          plan.inheritanceConflicts &&
          hasAdminCapability(user, 'admin.policies.read')
            ? fetchInheritanceConflicts()
            : Promise.resolve(null),
          plan.insights && hasAdminCapability(user, 'admin.insights.read')
            ? fetchAdminInsights(insightsDaysRef.current)
            : Promise.resolve(null),
          canFetchSettingsBundle
            ? fetchAdminSettingsBundle()
            : Promise.resolve(null),
        ]);

        if (statsRes) {
          setStats(statsRes);
        }
        if (insightsRes) {
          if (insightsRes.rangeDays === insightsDaysRef.current) {
            setInsights(insightsRes);
            // Focused `/admin/insights` reads storage from the insights
            // payload itself so the route never calls
            // `/api/admin/storage-stats`.
            if (!statsRes) {
              setStats(insightsRes.storage);
            }
          }
        }
        if (aiRes) {
          applyAiSuggestions(aiRes.suggestions);
        }
        if (settingsBundleRes) {
          setSettingsBundle(settingsBundleRes);
          if (settingsBundleRes.policies) {
            applyBundledPolicies(settingsBundleRes.policies);
          }
          if (settingsBundleRes.sharedLinks) {
            setSharedLinks(settingsBundleRes.sharedLinks.links);
          }
        }
        if (linksRes) {
          setSharedLinks(linksRes.links);
        }
        if (policyRes) {
          applyPolicyResponse(policyRes);
        }
        if (conflictsRes) {
          applyConflictsResponse(conflictsRes, policyRes);
        }
        if (logsRes) {
          applyAuditLogsResponse(logsRes);
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
      sectionAllowed,
      tabFetchPlan,
      labelFilter,
      auditQueryParams,
      applyAiSuggestions,
      applyBundledPolicies,
      applyPolicyResponse,
      applyConflictsResponse,
      applyAuditLogsResponse,
    ]
  );

  useEffect(() => {
    if (authChecked && isPrivilegedAdmin && sectionAllowed) {
      void loadAll();
    } else if (authChecked) {
      setLoading(false);
      setInitialLoadComplete(true);
    }
  }, [authChecked, isPrivilegedAdmin, sectionAllowed, loadAll]);

  // Adopt a new `?tab=` value when the server component passes a changed
  // search param (client-side navigation or history restore).
  useEffect(() => {
    const raw =
      (Array.isArray(initialTab) ? initialTab[0] : initialTab) ?? null;
    if (appliedInitialTabRef.current === raw) return;
    appliedInitialTabRef.current = raw;
    setSelectedTabId(parseAdminTabQuery(raw));
  }, [initialTab]);

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
        setInsights(null);
        clearAiSuggestions();
        setSharedLinks([]);
        clearAuditLogs();
        clearInheritanceConflicts();
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
  }, [
    authChecked,
    isPrivilegedAdmin,
    loadAll,
    syncStore,
    clearAiSuggestions,
    clearAuditLogs,
    clearInheritanceConflicts,
  ]);

  async function handleEmergencyRevoke(linkId: string) {
    setError(null);
    setNotice(null);
    const index = sharedLinks.findIndex((l) => l.id === linkId);
    const linkSnapshot = index >= 0 ? sharedLinks[index] : null;

    setSharedLinks((prev) => prev.filter((l) => l.id !== linkId));
    setNotice(`共有リンク (${linkId.slice(0, 8)}...) を緊急失効しました。`);

    try {
      await adminEmergencyRevokeSharedLink(linkId, 'Admin dashboard revocation');
      void syncStore.syncDelta();
    } catch (err) {
      if (linkSnapshot) {
        setSharedLinks((prev) => {
          if (prev.some((l) => l.id === linkId)) return prev;
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, linkSnapshot);
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

  async function handleInsightsDaysChange(
    days: AdminInsightsRangeDays
  ): Promise<void> {
    if (
      !isPrivilegedAdmin ||
      !hasAdminCapability(user, 'admin.insights.read') ||
      insightsDays === days
    ) {
      return;
    }
    insightsDaysRef.current = days;
    setInsightsDays(days);
    const requestId = insightsRequestRef.current + 1;
    insightsRequestRef.current = requestId;
    setInsightsLoading(true);
    try {
      const result = await fetchAdminInsights(days);
      if (requestId !== insightsRequestRef.current) return;
      setInsights(result);
      if (section === 'insights') setStats(result.storage);
      setError(null);
    } catch (err) {
      if (requestId !== insightsRequestRef.current) return;
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'インサイトデータの読み込みに失敗しました'
      );
    } finally {
      if (requestId === insightsRequestRef.current) {
        setInsightsLoading(false);
      }
    }
  }

  return {
    syncStore,
    snapshot,
    section,
    sectionOwnedApiPrefixes: getAdminSectionOwnedApiPrefixes(section),
    user,
    authChecked,
    isPrivilegedAdmin,
    sectionAllowed,
    loading,
    initialLoadComplete,
    visibleTabs,
    activeTab,
    activeTabId,
    tabFetchPlan,
    selectTab,
    error,
    notice,
    stats,
    insights,
    insightsDays,
    insightsLoading,
    suggestions: aiSuggestions.suggestions,
    selectedIds: aiSuggestions.selectedIds,
    labelFilter: aiSuggestions.labelFilter,
    bulkBusy: aiSuggestions.bulkBusy,
    sharedLinks,
    settingsBundle,
    policy: policies.policy,
    policySaving: policies.policySaving,
    advancedRolesSaving: policies.advancedRolesSaving,
    advancedRolesError: policies.advancedRolesError,
    advancedRolesNotice: policies.advancedRolesNotice,
    setAdvancedRolesDirty: policies.setAdvancedRolesDirty,
    folderStructureSaving: policies.folderStructureSaving,
    folderStructureError: policies.folderStructureError,
    folderStructureNotice: policies.folderStructureNotice,
    closedModeReport: policies.closedModeReport,
    permissionInheritanceMode: policies.permissionInheritanceMode,
    inheritanceSaving: policies.inheritanceSaving,
    inheritanceError: policies.inheritanceError,
    inheritanceNotice: policies.inheritanceNotice,
    inheritanceConflictReport: policies.inheritanceConflictReport,
    invitePolicySaving: policies.invitePolicySaving,
    invitePolicyError: policies.invitePolicyError,
    invitePolicyNotice: policies.invitePolicyNotice,
    inspectPolicySaving: policies.inspectPolicySaving,
    inspectPolicyError: policies.inspectPolicyError,
    inspectPolicyNotice: policies.inspectPolicyNotice,
    auditLogs: audit.auditLogs,
    auditCursor: audit.auditCursor,
    auditActionFilter: audit.auditActionFilter,
    auditActionPreset: audit.auditActionPreset,
    auditActionPrefixFilter: audit.auditActionPrefixFilter,
    auditActionPrefixPreset: audit.auditActionPrefixPreset,
    auditPresetKind: audit.auditPresetKind,
    auditTargetType: audit.auditTargetType,
    auditStatusFilter: audit.auditStatusFilter,
    auditActorEmailFilter: audit.auditActorEmailFilter,
    auditTargetIdFilter: audit.auditTargetIdFilter,
    auditFromFilter: audit.auditFromFilter,
    auditToFilter: audit.auditToFilter,
    auditLoadingMore: audit.auditLoadingMore,
    setLabelFilter: aiSuggestions.setLabelFilter,
    setAuditActionFilter: audit.setAuditActionFilter,
    setAuditActionPrefixFilter: audit.setAuditActionPrefixFilter,
    setAuditTargetType: audit.setAuditTargetType,
    setAuditStatusFilter: audit.setAuditStatusFilter,
    setAuditActorEmailFilter: audit.setAuditActorEmailFilter,
    setAuditTargetIdFilter: audit.setAuditTargetIdFilter,
    setAuditFromFilter: audit.setAuditFromFilter,
    setAuditToFilter: audit.setAuditToFilter,
    handleClearAuditFilters: audit.handleClearAuditFilters,
    handleClearAuditPrefixPreset: audit.handleClearAuditPrefixPreset,
    handleShowPermissionAudit: audit.handleShowPermissionAudit,
    handleShowGuestAudit: audit.handleShowGuestAudit,
    handleShowMemberAudit: audit.handleShowMemberAudit,
    setPolicy: policies.setPolicy,
    loadAll,
    toggleSelection: aiSuggestions.toggleSelection,
    handleSelectAllSuggestions: aiSuggestions.handleSelectAllSuggestions,
    handleBulkApprove: aiSuggestions.handleBulkApprove,
    handleSingleApprove: aiSuggestions.handleSingleApprove,
    handleEmergencyRevoke,
    handleInsightsDaysChange,
    handlePolicySubmit: policies.handlePolicySubmit,
    handleAdvancedRolesUpdate: policies.handleAdvancedRolesUpdate,
    handleFolderStructureUpdate: policies.handleFolderStructureUpdate,
    handlePermissionInheritanceUpdate:
      policies.handlePermissionInheritanceUpdate,
    handleInvitePolicyUpdate: policies.handleInvitePolicyUpdate,
    handleAdminContentInspectPolicyUpdate:
      policies.handleAdminContentInspectPolicyUpdate,
    handleShowRootFolderAudit: audit.handleShowRootFolderAudit,
    handleClearAuditPreset: audit.handleClearAuditPreset,
    handleLoadMoreLogs: audit.handleLoadMoreLogs,
  };
}

export type GovernanceDashboardState = ReturnType<typeof useGovernanceDashboard>;
