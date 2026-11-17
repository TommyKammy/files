'use client';

import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { AccessControlSettingsSection } from '@/components/admin/AccessControlSettingsSection';
import { AdminAuthControlSection } from '@/components/admin/AdminAuthControlSection';
import { AdminContentManagerSection } from '@/components/admin/AdminContentManagerSection';
import { AdminComplianceSettingsSection } from '@/components/admin/AdminComplianceSettingsSection';
import { AdminDelegationsSection } from '@/components/admin/AdminDelegationsSection';
import { AdminFileRequestsSection } from '@/components/admin/AdminFileRequestsSection';
import { AdminInsightsDashboardSection } from '@/components/admin/AdminInsightsDashboardSection';
import { AdminQuotaWarningBanner } from '@/components/admin/AdminQuotaWarningBanner';
import { AdminSiemSettingsSection } from '@/components/admin/AdminSiemSettingsSection';
import { AiSuggestionQueue } from '@/components/admin/AiSuggestionQueue';
import { AdminGuestsSection } from '@/components/admin/AdminGuestsSection';
import { AdminGroupsSection } from '@/components/admin/AdminGroupsSection';
import { AdminMembersSection } from '@/components/admin/AdminMembersSection';
import { AdminPermissionAuditSection } from '@/components/admin/AdminPermissionAuditSection';
import { AdminReportsSection } from '@/components/admin/AdminReportsSection';
import { AdminRootFoldersSection } from '@/components/admin/AdminRootFoldersSection';
import { AdminScimTokensSection } from '@/components/admin/AdminScimTokensSection';
import { AdminSessionsSection } from '@/components/admin/AdminSessionsSection';
import { AdminTrashSection } from '@/components/admin/AdminTrashSection';
import { AuditLogSection } from '@/components/admin/AuditLogSection';
import { GuestPolicySection } from '@/components/admin/GuestPolicySection';
import { SharedLinksPolicySection } from '@/components/admin/SharedLinksPolicySection';
import { AdminConsoleShell } from '@/components/AdminConsoleShell';
import { AppShellRail } from '@/components/AppShellRail';
import {
  adminSectionHasDashboardFetch,
  canViewAdminConsoleSection,
  getAdminConsoleNavItem,
  getVisibleAdminNavItems,
  type AdminConsoleSection,
} from '@/lib/admin-console-nav';
import {
  canAccessAdminSurface,
  hasAdminCapability,
} from '@/lib/admin-delegations';
import { readQuotaThresholds } from '@/lib/admin-compliance';
import { useGovernanceDashboard } from '@/lib/use-governance-dashboard';
import { LocalDevQuickLoginPanel, SignInCard } from '@/components/SignInCard';

export function HybridGovernanceDashboard({
  section = 'all',
  auditPreset = null,
}: {
  section?: AdminConsoleSection;
  auditPreset?: string | string[] | null;
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
  } = useGovernanceDashboard({ section, auditPreset });

  const navItem = getAdminConsoleNavItem(section);
  const hasDashboardFetch = adminSectionHasDashboardFetch(section);
  const showSection = (target: Exclude<AdminConsoleSection, 'all'>) =>
    (section === 'all' || section === target) &&
    canAccessAdminSurface(user, target);

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
          ) : (
            <>
              {showSection('insights') && (
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
              )}

              {showSection('content') &&
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
              )}

              {showSection('content') &&
                hasAdminCapability(user, 'admin.content.unlock') && (
                  <AdminContentManagerSection />
                )}

              {showSection('content') &&
                hasAdminCapability(user, 'admin.content.unlock') && (
                  <AdminFileRequestsSection />
                )}

              {showSection('settings') &&
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
                  onSavePermissionInheritanceMode={
                    handlePermissionInheritanceUpdate
                  }
                  onSaveInvitePolicy={handleInvitePolicyUpdate}
                  onSaveAdminContentInspectPolicy={
                    handleAdminContentInspectPolicyUpdate
                  }
                  onDirtyChange={setAdvancedRolesDirty}
                />
              )}

              {showSection('settings') &&
                hasAdminCapability(user, 'admin.policies.read') && (
                <AdminAuthControlSection
                  user={user}
                  policy={policy}
                  onPolicyUpdated={setPolicy}
                />
              )}

              {showSection('settings') &&
                hasAdminCapability(user, 'admin.policies.read') && (
                <AdminComplianceSettingsSection
                  policy={policy}
                  canManage={user.role === 'sys_admin'}
                  onPolicyUpdated={setPolicy}
                />
              )}

              {showSection('settings') &&
                hasAdminCapability(user, 'admin.policies.read') && (
                <AdminSiemSettingsSection canManage={user.role === 'sys_admin'} />
              )}

              {showSection('settings') &&
                hasAdminCapability(user, 'admin.users.read') && (
                <AdminSessionsSection user={user} />
              )}

              {showSection('settings') &&
                hasAdminCapability(user, 'admin.links.revoke') && (
                <SharedLinksPolicySection
                  sharedLinks={sharedLinks}
                  policy={policy}
                  policySaving={policySaving}
                  onEmergencyRevoke={handleEmergencyRevoke}
                  onPolicySubmit={handlePolicySubmit}
                  onPolicyChange={setPolicy}
                />
              )}

              {showSection('content') &&
                hasAdminCapability(user, 'admin.trash.manage') && (
                  <AdminTrashSection user={user} />
                )}

              {showSection('reports') &&
                hasAdminCapability(user, 'admin.reports.run') && (
                  <AdminReportsSection />
                )}

              {showSection('reports') &&
                hasAdminCapability(user, 'admin.permissions.audit') && (
                <AdminPermissionAuditSection
                  user={user}
                  onShowPermissionAudit={handleShowPermissionAudit}
                />
              )}

              {showSection('content') &&
                hasAdminCapability(user, 'admin.root_folders.read') && (
                <AdminRootFoldersSection
                  user={user}
                  onShowAuditLogs={handleShowRootFolderAudit}
                />
              )}

              {showSection('settings') &&
                hasAdminCapability(user, 'admin.policies.read') && (
                <GuestPolicySection
                  policy={policy}
                  canManage={user.role === 'sys_admin'}
                  onPolicyUpdated={setPolicy}
                />
              )}

              {showSection('users') && (
                <div className="space-y-4">
                  {(hasAdminCapability(user, 'admin.users.read') ||
                    hasAdminCapability(user, 'admin.users.suspend')) && (
                    <AdminMembersSection
                      user={user}
                      onShowAuditLogs={handleShowMemberAudit}
                    />
                  )}
                  {(hasAdminCapability(user, 'admin.users.read') ||
                    hasAdminCapability(user, 'admin.groups.manage')) && (
                    <AdminGroupsSection user={user} />
                  )}
                  {hasAdminCapability(user, 'admin.users.read') && (
                    <AdminScimTokensSection user={user} />
                  )}
                  {hasAdminCapability(user, 'admin.guests.manage') && (
                    <AdminGuestsSection
                      user={user}
                      onShowAuditLogs={handleShowGuestAudit}
                    />
                  )}
                  <AdminDelegationsSection user={user} />
                </div>
              )}

              {showSection('reports') &&
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
              )}
            </>
          )}
        </AdminConsoleShell>
      </main>
    </div>
  );
}
