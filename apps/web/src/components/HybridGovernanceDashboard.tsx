'use client';

import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect } from 'react';
import { AdminQuotaWarningBanner } from '@/components/admin/AdminQuotaWarningBanner';
import {
  AdminSectionTabs,
  AdminTabPanel,
} from '@/components/admin/AdminSectionTabs';
import { AdminConsoleShell } from '@/components/AdminConsoleShell';
import { AppShellRail } from '@/components/AppShellRail';
import {
  canViewAdminConsoleSection,
  getAdminConsoleNavItem,
  getVisibleAdminNavItems,
  type AdminConsoleSection,
} from '@/lib/admin-console-nav';
import type { AdminSectionFetchPlan } from '@/lib/admin-console-nav';
import {
  getAdminTabPreloadChunkIds,
  type AdminSectionChunkId,
} from '@/lib/admin-console-tabs';
import { hasAdminCapability } from '@/lib/admin-delegations';
import { readQuotaThresholds } from '@/lib/admin-compliance';
import { useGovernanceDashboard } from '@/lib/use-governance-dashboard';
import { LocalDevQuickLoginPanel, SignInCard } from '@/components/SignInCard';

// Code-split admin section modules so focused routes (/admin/insights, /admin/settings, etc.)
// download and compile only the components belonging to the active route.
const loadAccessControlSettings = () =>
  import('@/components/admin/AccessControlSettingsSection').then(
    (m) => m.AccessControlSettingsSection
  );
const loadAdminAuthControl = () =>
  import('@/components/admin/AdminAuthControlSection').then(
    (m) => m.AdminAuthControlSection
  );
const loadAdminContentManager = () =>
  import('@/components/admin/AdminContentManagerSection').then(
    (m) => m.AdminContentManagerSection
  );
const loadAdminComplianceSettings = () =>
  import('@/components/admin/AdminComplianceSettingsSection').then(
    (m) => m.AdminComplianceSettingsSection
  );
const loadAdminDelegations = () =>
  import('@/components/admin/AdminDelegationsSection').then(
    (m) => m.AdminDelegationsSection
  );
const loadAdminFileRequests = () =>
  import('@/components/admin/AdminFileRequestsSection').then(
    (m) => m.AdminFileRequestsSection
  );
const loadAdminInsightsDashboard = () =>
  import('@/components/admin/AdminInsightsDashboardSection').then(
    (m) => m.AdminInsightsDashboardSection
  );
const loadAdminSiemSettings = () =>
  import('@/components/admin/AdminSiemSettingsSection').then(
    (m) => m.AdminSiemSettingsSection
  );
const loadAiSuggestionQueue = () =>
  import('@/components/admin/AiSuggestionQueue').then(
    (m) => m.AiSuggestionQueue
  );
const loadAdminGuests = () =>
  import('@/components/admin/AdminGuestsSection').then(
    (m) => m.AdminGuestsSection
  );
const loadAdminGroups = () =>
  import('@/components/admin/AdminGroupsSection').then(
    (m) => m.AdminGroupsSection
  );
const loadAdminMembers = () =>
  import('@/components/admin/AdminMembersSection').then(
    (m) => m.AdminMembersSection
  );
const loadAdminPermissionAudit = () =>
  import('@/components/admin/AdminPermissionAuditSection').then(
    (m) => m.AdminPermissionAuditSection
  );
const loadAdminReports = () =>
  import('@/components/admin/AdminReportsSection').then(
    (m) => m.AdminReportsSection
  );
const loadAdminRootFolders = () =>
  import('@/components/admin/AdminRootFoldersSection').then(
    (m) => m.AdminRootFoldersSection
  );
const loadAdminScimTokens = () =>
  import('@/components/admin/AdminScimTokensSection').then(
    (m) => m.AdminScimTokensSection
  );
const loadAdminSessions = () =>
  import('@/components/admin/AdminSessionsSection').then(
    (m) => m.AdminSessionsSection
  );
const loadAdminTrash = () =>
  import('@/components/admin/AdminTrashSection').then(
    (m) => m.AdminTrashSection
  );
const loadAuditLog = () =>
  import('@/components/admin/AuditLogSection').then((m) => m.AuditLogSection);
const loadGuestPolicy = () =>
  import('@/components/admin/GuestPolicySection').then(
    (m) => m.GuestPolicySection
  );
const loadSharedLinksPolicy = () =>
  import('@/components/admin/SharedLinksPolicySection').then(
    (m) => m.SharedLinksPolicySection
  );

const AccessControlSettingsSection = dynamic(loadAccessControlSettings);
const AdminAuthControlSection = dynamic(loadAdminAuthControl);
const AdminContentManagerSection = dynamic(loadAdminContentManager);
const AdminComplianceSettingsSection = dynamic(loadAdminComplianceSettings);
const AdminDelegationsSection = dynamic(loadAdminDelegations);
const AdminFileRequestsSection = dynamic(loadAdminFileRequests);
const AdminInsightsDashboardSection = dynamic(loadAdminInsightsDashboard);
const AdminSiemSettingsSection = dynamic(loadAdminSiemSettings);
const AiSuggestionQueue = dynamic(loadAiSuggestionQueue);
const AdminGuestsSection = dynamic(loadAdminGuests);
const AdminGroupsSection = dynamic(loadAdminGroups);
const AdminMembersSection = dynamic(loadAdminMembers);
const AdminPermissionAuditSection = dynamic(loadAdminPermissionAudit);
const AdminReportsSection = dynamic(loadAdminReports);
const AdminRootFoldersSection = dynamic(loadAdminRootFolders);
const AdminScimTokensSection = dynamic(loadAdminScimTokens);
const AdminSessionsSection = dynamic(loadAdminSessions);
const AdminTrashSection = dynamic(loadAdminTrash);
const AuditLogSection = dynamic(loadAuditLog);
const GuestPolicySection = dynamic(loadGuestPolicy);
const SharedLinksPolicySection = dynamic(loadSharedLinksPolicy);

// Map the pure `getAdminTabPreloadChunkIds` plan to the actual dynamic
// import loaders. Only the active tab's chunks are preloaded, so `/admin`
// does not download every section chunk and `/admin/content` does not
// download all five content tabs on first paint.
const ADMIN_SECTION_PRELOADERS: Record<
  AdminSectionChunkId,
  () => Promise<unknown>
> = {
  'insights-dashboard': loadAdminInsightsDashboard,
  'content-manager': loadAdminContentManager,
  'ai-suggestion-queue': loadAiSuggestionQueue,
  'admin-file-requests': loadAdminFileRequests,
  'admin-trash': loadAdminTrash,
  'admin-root-folders': loadAdminRootFolders,
  'admin-members': loadAdminMembers,
  'admin-groups': loadAdminGroups,
  'admin-guests': loadAdminGuests,
  'admin-delegations': loadAdminDelegations,
  'admin-scim-tokens': loadAdminScimTokens,
  'access-control-settings': loadAccessControlSettings,
  'admin-auth-control': loadAdminAuthControl,
  'admin-compliance-settings': loadAdminComplianceSettings,
  'admin-siem-settings': loadAdminSiemSettings,
  'admin-sessions': loadAdminSessions,
  'shared-links-policy': loadSharedLinksPolicy,
  'guest-policy': loadGuestPolicy,
  'admin-permission-audit': loadAdminPermissionAudit,
  'admin-reports': loadAdminReports,
  'audit-log': loadAuditLog,
};

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
}: {
  section?: AdminConsoleSection;
  auditPreset?: string | string[] | null;
  initialTab?: string | string[] | null;
}) {
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
    insights,
    insightsDays,
    insightsLoading,
    suggestions,
    selectedIds,
    labelFilter,
    bulkBusy,
    sharedLinks,
    settingsBundle,
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
    auditActorEmailFilter,
    auditTargetIdFilter,
    auditFromFilter,
    auditToFilter,
    auditLoadingMore,
    setLabelFilter,
    setAuditActionFilter,
    setAuditActionPrefixFilter,
    setAuditTargetType,
    setAuditStatusFilter,
    setAuditActorEmailFilter,
    setAuditTargetIdFilter,
    setAuditFromFilter,
    setAuditToFilter,
    setPolicy,
    loadAll,
    toggleSelection,
    handleSelectAllSuggestions,
    handleBulkApprove,
    handleSingleApprove,
    handleEmergencyRevoke,
    handleInsightsDaysChange,
    handlePolicySubmit,
    handleAdvancedRolesUpdate,
    handleFolderStructureUpdate,
    handlePermissionInheritanceUpdate,
    handleInvitePolicyUpdate,
    handleAdminContentInspectPolicyUpdate,
    handleShowRootFolderAudit,
    handleShowPermissionAudit,
    handleShowGuestAudit,
    handleShowMemberAudit,
    handleClearAuditPreset,
    handleClearAuditPrefixPreset,
    handleClearAuditFilters,
    handleLoadMoreLogs,
  } = useGovernanceDashboard({ section, auditPreset, initialTab });

  useEffect(() => {
    // Preload only the active tab's dynamic chunks alongside auth/bundle
    // fetches so the tab mounts without an extra chunk download waterfall.
    for (const chunkId of getAdminTabPreloadChunkIds(section, activeTabId)) {
      void ADMIN_SECTION_PRELOADERS[chunkId]();
    }
  }, [section, activeTabId]);

  const navItem = getAdminConsoleNavItem(section);
  const hasDashboardFetch = tabPlanHasFetch(tabFetchPlan);

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
        認証を確認中...
      </div>
    );
  }

  if (!user) {
    if (snapshot.sessionError?.code === 'SESSION_REVOKED_BY_ADMIN') {
      return (
        <SignInCard
          title="セッションが管理者によって失効されました"
          description={
            snapshot.sessionError.message ||
            '管理者が強制サインアウトを実行しました。安全のため再度サインインしてください。'
          }
          returnTo="/admin"
          preferredRoles={['sys_admin', 'sec_admin']}
          onSignedIn={(signedIn) => {
            void syncStore.adoptAuthenticatedUser(signedIn);
          }}
        />
      );
    }
    return (
      <SignInCard
        title="ガバナンスセンターへサインイン"
        description="システム管理者 (sys_admin) またはセキュリティ管理者 (sec_admin) としてサインインしてください。"
        returnTo="/admin"
        preferredRoles={['sys_admin', 'sec_admin']}
        onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
      />
    );
  }

  if (!isPrivilegedAdmin) {
    return (
      <div className="flex min-h-screen bg-[#efeff1] text-slate-900">
        <AppShellRail user={user} activeView="workspace" />
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-xs space-y-3">
            <ShieldAlert className="mx-auto h-8 w-8 text-amber-500" />
            <h1 className="text-base font-semibold text-slate-900">
              アクセス権限がありません (403)
            </h1>
            <p className="text-[0.6875rem] text-[#55565a]">
              管理ガバナンスコンソールは sys_admin または sec_admin ロール専用です。
            </p>
            <Link
              href="/workspace"
              className="inline-flex rounded-md bg-[#5e6ad2] px-4 py-2 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2]"
            >
              ワークスペースに戻る
            </Link>
            <LocalDevQuickLoginPanel
              preferredRoles={['sys_admin', 'sec_admin']}
              onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
            />
          </div>
        </main>
      </div>
    );
  }

  if (!sectionAllowed) {
    const visibleItems = getVisibleAdminNavItems(user);
    return (
      <div className="flex min-h-screen bg-[#efeff1] text-slate-900">
        <AppShellRail user={user} activeView="admin" />
        <main className="flex flex-1 items-center justify-center p-8">
          <div
            data-testid="admin-section-denied"
            className="max-w-lg rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-xs space-y-3"
          >
            <ShieldAlert className="mx-auto h-8 w-8 text-amber-500" />
            <h1 className="text-base font-semibold text-slate-900">
              権限がありません
            </h1>
            <p className="text-[0.6875rem] text-[#55565a]">
              このセクションを表示する管理 Capability が委任されていません。
              許可済みのタブから利用してください。
            </p>
            {visibleItems.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                {visibleItems.map((item) => (
                  <Link
                    key={item.section}
                    href={item.href}
                    className="inline-flex rounded-md border border-[#e1e1e4] bg-white px-3 py-1.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
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

  const insightsPanel = (
    <AdminInsightsDashboardSection
      insights={insights}
      stats={stats}
      usedPct={usedPct}
      days={insightsDays}
      loading={insightsLoading}
      onDaysChange={(days) => {
        void handleInsightsDaysChange(days);
      }}
    />
  );

  const aiClassificationPanel =
    hasAdminCapability(user, 'admin.content.unlock') && (
      <AiSuggestionQueue
        suggestions={suggestions}
        selectedIds={selectedIds}
        labelFilter={labelFilter}
        bulkBusy={bulkBusy}
        onFilterChange={setLabelFilter}
        onSelectAll={handleSelectAllSuggestions}
        onBulkApprove={handleBulkApprove}
        onSingleApprove={handleSingleApprove}
        onToggleSelection={toggleSelection}
      />
    );

  const contentManagerPanel =
    hasAdminCapability(user, 'admin.content.unlock') && (
      <AdminContentManagerSection />
    );

  const fileRequestsPanel =
    hasAdminCapability(user, 'admin.content.unlock') && (
      <AdminFileRequestsSection />
    );

  const trashPanel =
    hasAdminCapability(user, 'admin.trash.manage') && (
      <AdminTrashSection user={user} />
    );

  const rootFoldersPanel =
    hasAdminCapability(user, 'admin.root_folders.read') && (
      <AdminRootFoldersSection
        user={user}
        onShowAuditLogs={handleShowRootFolderAudit}
      />
    );

  const accessControlPanel =
    hasAdminCapability(user, 'admin.policies.edit') && (
      <AccessControlSettingsSection
        policy={policy}
        saving={advancedRolesSaving}
        error={advancedRolesError}
        notice={advancedRolesNotice}
        canManageFolderStructure={user.role === 'sys_admin'}
        folderStructureSaving={folderStructureSaving}
        folderStructureError={folderStructureError}
        folderStructureNotice={folderStructureNotice}
        closedModeReport={closedModeReport}
        permissionInheritanceMode={permissionInheritanceMode}
        inheritanceSaving={inheritanceSaving}
        inheritanceError={inheritanceError}
        inheritanceNotice={inheritanceNotice}
        canManagePermissionInheritance={user.role === 'sys_admin'}
        inheritanceConflictReport={inheritanceConflictReport}
        invitePolicySaving={invitePolicySaving}
        invitePolicyError={invitePolicyError}
        invitePolicyNotice={invitePolicyNotice}
        canManageInvitePolicy={user.role === 'sys_admin'}
        inspectPolicySaving={inspectPolicySaving}
        inspectPolicyError={inspectPolicyError}
        inspectPolicyNotice={inspectPolicyNotice}
        canManageInspectPolicy={user.role === 'sys_admin'}
        onSave={handleAdvancedRolesUpdate}
        onSaveFolderStructureMode={handleFolderStructureUpdate}
        onSavePermissionInheritanceMode={handlePermissionInheritanceUpdate}
        onSaveInvitePolicy={handleInvitePolicyUpdate}
        onSaveAdminContentInspectPolicy={
          handleAdminContentInspectPolicyUpdate
        }
        onDirtyChange={setAdvancedRolesDirty}
      />
    );

  const authControlPanel =
    hasAdminCapability(user, 'admin.policies.read') && (
      <AdminAuthControlSection
        user={user}
        policy={policy}
        initialSsoStatus={
          settingsBundle ? settingsBundle.ssoStatus : undefined
        }
        onPolicyUpdated={setPolicy}
      />
    );

  const compliancePanel =
    hasAdminCapability(user, 'admin.policies.read') && (
      <AdminComplianceSettingsSection
        policy={policy}
        canManage={user.role === 'sys_admin'}
        initialTos={
          settingsBundle ? (settingsBundle.tos?.tos ?? null) : undefined
        }
        onPolicyUpdated={setPolicy}
      />
    );

  const siemPanel =
    hasAdminCapability(user, 'admin.policies.read') && (
      <AdminSiemSettingsSection
        canManage={user.role === 'sys_admin'}
        initialSiem={
          settingsBundle ? (settingsBundle.siem?.siem ?? null) : undefined
        }
      />
    );

  const sessionsPanel =
    hasAdminCapability(user, 'admin.users.read') && (
      <AdminSessionsSection
        user={user}
        initialSessions={
          settingsBundle ? settingsBundle.sessions : undefined
        }
      />
    );

  const sharedLinksPanel =
    hasAdminCapability(user, 'admin.links.revoke') && (
      <SharedLinksPolicySection
        sharedLinks={sharedLinks}
        policy={policy}
        policySaving={policySaving}
        onEmergencyRevoke={handleEmergencyRevoke}
        onPolicySubmit={handlePolicySubmit}
        onPolicyChange={setPolicy}
      />
    );

  const guestPolicyPanel =
    (hasAdminCapability(user, 'admin.policies.read') ||
      hasAdminCapability(user, 'admin.guests.manage')) && (
      <GuestPolicySection
        policy={policy}
        canManage={user.role === 'sys_admin'}
        initialInvitations={
          settingsBundle
            ? (settingsBundle.guestInvitations?.invitations ?? null)
            : undefined
        }
        onPolicyUpdated={setPolicy}
      />
    );

  const membersPanel =
    (hasAdminCapability(user, 'admin.users.read') ||
      hasAdminCapability(user, 'admin.users.suspend')) && (
      <AdminMembersSection
        user={user}
        onShowAuditLogs={handleShowMemberAudit}
      />
    );

  const groupsPanel =
    (hasAdminCapability(user, 'admin.users.read') ||
      hasAdminCapability(user, 'admin.groups.manage')) && (
      <AdminGroupsSection user={user} />
    );

  const scimPanel =
    hasAdminCapability(user, 'admin.users.read') && (
      <AdminScimTokensSection user={user} />
    );

  const guestsPanel =
    hasAdminCapability(user, 'admin.guests.manage') && (
      <AdminGuestsSection
        user={user}
        onShowAuditLogs={handleShowGuestAudit}
      />
    );

  const delegationsPanel = (
    <AdminDelegationsSection user={user} />
  );

  const reportsPanel =
    hasAdminCapability(user, 'admin.reports.run') && (
      <AdminReportsSection />
    );

  const permissionAuditPanel =
    hasAdminCapability(user, 'admin.permissions.audit') && (
      <AdminPermissionAuditSection
        user={user}
        onShowPermissionAudit={handleShowPermissionAudit}
      />
    );

  const auditLogPanel =
    hasAdminCapability(user, 'admin.audit.read') && (
      <AuditLogSection
        auditLogs={auditLogs}
        auditCursor={auditCursor}
        auditActionFilter={auditActionFilter}
        auditActionPrefixFilter={auditActionPrefixFilter}
        auditActionPrefixes={auditActionPrefixPreset}
        auditPresetKind={auditPresetKind}
        auditTargetType={auditTargetType}
        auditStatusFilter={auditStatusFilter}
        auditActorEmailFilter={auditActorEmailFilter}
        auditTargetIdFilter={auditTargetIdFilter}
        auditFromFilter={auditFromFilter}
        auditToFilter={auditToFilter}
        auditLoadingMore={auditLoadingMore}
        auditPresetActions={auditActionPreset}
        onActionFilterChange={setAuditActionFilter}
        onActionPrefixFilterChange={setAuditActionPrefixFilter}
        onTargetTypeChange={setAuditTargetType}
        onStatusFilterChange={setAuditStatusFilter}
        onActorEmailFilterChange={setAuditActorEmailFilter}
        onTargetIdFilterChange={setAuditTargetIdFilter}
        onFromFilterChange={setAuditFromFilter}
        onToFilterChange={setAuditToFilter}
        onClearFilters={handleClearAuditFilters}
        onLoadMore={handleLoadMoreLogs}
        onClearPreset={handleClearAuditPreset}
        onClearPrefixPreset={handleClearAuditPrefixPreset}
      />
    );

  // Only the selected tab's panels are mounted. This keeps focused routes
  // from paying for every child section's independent fetches.
  const activeTabContent = (() => {
    const tabId = activeTab?.id;
    if (!tabId) return null;

    if (section === 'all') {
      switch (tabId) {
        case 'overview':
          return insightsPanel;
        case 'content':
          return (
            <>
              {aiClassificationPanel}
              {contentManagerPanel}
              {fileRequestsPanel}
              {trashPanel}
              {rootFoldersPanel}
            </>
          );
        case 'users':
          return (
            <div className="space-y-4">
              {membersPanel}
              {groupsPanel}
              {scimPanel}
              {guestsPanel}
              {delegationsPanel}
            </div>
          );
        case 'settings':
          return (
            <>
              {accessControlPanel}
              {authControlPanel}
              {compliancePanel}
              {sessionsPanel}
              {sharedLinksPanel}
              {guestPolicyPanel}
            </>
          );
        case 'integrations':
          return (
            <>
              {authControlPanel}
              {scimPanel}
              {siemPanel}
            </>
          );
        case 'reports':
          return (
            <>
              {reportsPanel}
              {permissionAuditPanel}
              {auditLogPanel}
            </>
          );
        default:
          return null;
      }
    }

    if (section === 'content') {
      switch (tabId) {
        case 'manager':
          return contentManagerPanel;
        case 'root-folders':
          return rootFoldersPanel;
        case 'trash':
          return trashPanel;
        case 'file-requests':
          return fileRequestsPanel;
        case 'ai-classification':
          return aiClassificationPanel;
        default:
          return null;
      }
    }

    if (section === 'users') {
      switch (tabId) {
        case 'members':
          return (
            <>
              {membersPanel}
              {scimPanel}
            </>
          );
        case 'groups':
          return groupsPanel;
        case 'guests':
          return guestsPanel;
        case 'delegations':
          return delegationsPanel;
        default:
          return null;
      }
    }

    if (section === 'settings') {
      switch (tabId) {
        case 'sharing':
          return (
            <>
              {sharedLinksPanel}
              {guestPolicyPanel}
            </>
          );
        case 'access':
          return accessControlPanel;
        case 'security':
          return (
            <>
              {authControlPanel}
              {sessionsPanel}
            </>
          );
        case 'compliance':
          return compliancePanel;
        case 'integrations':
          return (
            <>
              {scimPanel}
              {siemPanel}
            </>
          );
        default:
          return null;
      }
    }

    if (section === 'reports') {
      switch (tabId) {
        case 'audit-logs':
          return auditLogPanel;
        case 'permissions':
          return permissionAuditPanel;
        case 'jobs':
          return reportsPanel;
        default:
          return null;
      }
    }

    return null;
  })();

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
              {activeTabContent}
            </AdminTabPanel>
          ) : (
            <>{insightsPanel}</>
          )}
        </AdminConsoleShell>
      </main>
    </div>
  );
}
