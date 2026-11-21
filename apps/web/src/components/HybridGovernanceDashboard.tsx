'use client';

import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { AdminConsoleShell } from '@/components/AdminConsoleShell';
import { AppShellRail } from '@/components/AppShellRail';
import { AdminQuotaWarningBanner } from '@/components/admin/AdminQuotaWarningBanner';
import {
  AdminSectionTabs,
  AdminTabPanel,
} from '@/components/admin/AdminSectionTabs';
import { GovernanceAuthGates } from '@/components/admin/dashboard/GovernanceAuthGates';
import { GovernanceTabContent } from '@/components/admin/dashboard/GovernanceTabContent';
import { ADMIN_SECTION_PRELOADERS } from '@/components/admin/dashboard/admin-section-loaders';
import { readQuotaThresholds } from '@/lib/admin-compliance';
import {
  getAdminConsoleNavItem,
  type AdminConsoleSection,
  type AdminSectionFetchPlan,
} from '@/lib/admin-console-nav';
import { getAdminTabPreloadChunkIds } from '@/lib/admin-console-tabs';
import { useGovernanceDashboard } from '@/lib/use-governance-dashboard';

function tabPlanHasFetch(plan: AdminSectionFetchPlan): boolean {
  return (
    plan.insights ||
    plan.storageStats ||
    plan.aiSuggestions ||
    plan.sharedLinks ||
    plan.policies ||
    plan.auditLogs ||
    plan.inheritanceConflicts ||
    plan.settingsBundle
  );
}

export function HybridGovernanceDashboard({
  section = 'all',
  auditPreset = null,
  initialTab = null,
  initialTopic = null,
}: {
  section?: AdminConsoleSection;
  auditPreset?: string | string[] | null;
  initialTab?: string | string[] | null;
  initialTopic?: string | string[] | null;
}) {
  const dashboard = useGovernanceDashboard({
    section,
    auditPreset,
    initialTab,
  });

  const {
    syncStore,
    snapshot,
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
    suggestions,
    policy,
    loadAll,
  } = dashboard;

  useEffect(() => {
    // Preload only the active tab's dynamic chunks alongside auth/bundle
    // fetches so the tab mounts without an extra chunk download waterfall.
    for (const chunkId of getAdminTabPreloadChunkIds(section, activeTabId)) {
      void ADMIN_SECTION_PRELOADERS[chunkId]();
    }
  }, [section, activeTabId]);

  const navItem = getAdminConsoleNavItem(section);
  const hasDashboardFetch = tabPlanHasFetch(tabFetchPlan);

  if (!authChecked || !user || !isPrivilegedAdmin || !sectionAllowed) {
    return (
      <GovernanceAuthGates
        authChecked={authChecked}
        user={user}
        snapshot={snapshot}
        syncStore={syncStore}
        isPrivilegedAdmin={isPrivilegedAdmin}
        sectionAllowed={sectionAllowed}
      />
    );
  }

  const usedPct =
    stats && stats.quotaBytes > 0
      ? Math.min(100, Math.round((stats.usedBytes / stats.quotaBytes) * 100))
      : 0;
  const policyThresholds = readQuotaThresholds(policy);
  const quotaThresholds = {
    warn: stats?.quotaWarnThresholdPct ?? policyThresholds.warn,
    critical: stats?.quotaCriticalThresholdPct ?? policyThresholds.critical,
  };

  return (
    <div className="flex min-h-screen bg-[#efeff1] text-slate-900">
      <a
        href="#governance-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#111214] focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]"
      >
        メインコンテンツへスキップ
      </a>
      <AppShellRail user={user} activeView="admin" />

      <main
        id="governance-main"
        tabIndex={-1}
        className="mb-2 mr-2 mt-2 min-w-0 flex-1 rounded-2xl border border-[#e7e7ea] bg-[#f9f9fa] px-5 py-4 lg:px-7"
      >
        <AdminConsoleShell user={user} section={section}>
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-[1rem] font-semibold tracking-[-0.01em] text-[#111214]">
                {navItem.heading}
              </h1>
              <p className="text-[0.6875rem] text-[#55565a]">
                {navItem.summary}
              </p>
            </div>

            {hasDashboardFetch && (
              <button
                type="button"
                onClick={() => void loadAll()}
                disabled={loading}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
                />
                <span>再読み込み</span>
              </button>
            )}
          </header>

          {visibleTabs.length > 0 && (
            <AdminSectionTabs
              section={section}
              tabs={visibleTabs}
              activeTabId={activeTabId}
              onSelectTab={selectTab}
              ariaLabel={`${navItem.label}のセクション内タブ`}
              badges={{ 'ai-classification': suggestions.length }}
            />
          )}

          {section !== 'insights' && stats && stats.quotaBytes > 0 && (
            <AdminQuotaWarningBanner
              usedPct={usedPct}
              thresholds={quotaThresholds}
            />
          )}

          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div
              role="status"
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-800"
            >
              {notice}
            </div>
          )}

          {!initialLoadComplete ? (
            <div
              role="status"
              data-testid="governance-initial-loading"
              className="flex min-h-[7rem] items-center justify-center gap-2 rounded-2xl border border-[#e7e7ea] bg-white px-5 py-6 text-[0.75rem] text-[#55565a] shadow-xs"
            >
              <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
              <span>
                {section === 'all'
                  ? 'ガバナンスデータを一括読み込み中...'
                  : `${navItem.label}を読み込み中...`}
              </span>
            </div>
          ) : visibleTabs.length > 0 && activeTab ? (
            <AdminTabPanel
              section={section}
              tabId={activeTab.id}
              summary={activeTab.summary}
            >
              <GovernanceTabContent
                dashboard={dashboard}
                user={user}
                usedPct={usedPct}
                initialTopic={initialTopic}
              />
            </AdminTabPanel>
          ) : (
            <GovernanceTabContent
              dashboard={dashboard}
              user={user}
              usedPct={usedPct}
              initialTopic={initialTopic}
            />
          )}
        </AdminConsoleShell>
      </main>
    </div>
  );
}
