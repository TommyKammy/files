'use client';

import type { ReactNode } from 'react';
import { isAdminConsoleRole } from '@/lib/admin-console-nav';
import { hasAdminCapability } from '@/lib/admin-delegations';
import type {
  EnterpriseSettingGroupId,
  EnterpriseSettingStatusState,
  EnterpriseSettingTopicId,
} from '@/lib/admin-enterprise-settings';
import type { GovernanceDashboardState } from '@/lib/use-governance-dashboard';
import type { AuthUser } from '@/types/files';
import {
  AccessControlSettingsSection,
  AdminAuthControlSection,
  AdminComplianceSettingsSection,
  AdminContentManagerSection,
  AdminDelegationsSection,
  AdminEnterpriseSettingsWorkbench,
  AdminFileRequestsSection,
  AdminGroupsSection,
  AdminGuestsSection,
  AdminInsightsDashboardSection,
  AdminIntegrationsSection,
  AdminMembersSection,
  AdminMetadataTemplatesSection,
  AdminPermissionAuditSection,
  AdminReportsSection,
  AdminRootFoldersSection,
  AdminScimTokensSection,
  AdminSessionsSection,
  AdminTrashSection,
  AiSuggestionQueue,
  AuditLogSection,
  GuestPolicySection,
  SharedLinksPolicySection,
} from './admin-section-loaders';

interface GovernanceTabContentProps {
  dashboard: GovernanceDashboardState;
  user: AuthUser;
  usedPct: number;
  initialTopic?: string | string[] | null;
}

/**
 * Projects the active `(section, activeTab)` into its lazily loaded admin
 * section panels while keeping capability gates and enterprise workbench
 * topic/group routing intact.
 */
export function GovernanceTabContent({
  dashboard,
  user,
  usedPct,
  initialTopic = null,
}: GovernanceTabContentProps) {
  const {
    section,
    activeTab,
    selectTab,
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
  } = dashboard;

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

  const metadataTemplatesPanel =
    isAdminConsoleRole(user?.role) && <AdminMetadataTemplatesSection />;

  const renderAccessControlPanel = (
    topicFilter:
      | 'roles-and-invite'
      | 'folder-structure'
      | 'content-inspection'
      | 'all'
  ) =>
    (hasAdminCapability(user, 'admin.policies.read') ||
      hasAdminCapability(user, 'admin.policies.edit')) && (
      <AccessControlSettingsSection
        topicFilter={topicFilter}
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

  const renderAuthControlPanel = (
    topicFilter: 'ip-allowlist' | 'sso-oidc' | 'all'
  ) =>
    (hasAdminCapability(user, 'admin.policies.read') ||
      hasAdminCapability(user, 'admin.policies.edit')) && (
      <AdminAuthControlSection
        user={user}
        policy={policy}
        topicFilter={topicFilter}
        initialSsoStatus={
          settingsBundle ? settingsBundle.ssoStatus : undefined
        }
        onPolicyUpdated={setPolicy}
      />
    );

  const renderCompliancePanel = (
    topicFilter: 'tos' | 'file-requests' | 'retention-quota-ai' | 'branding' | 'all'
  ) =>
    (hasAdminCapability(user, 'admin.policies.read') ||
      hasAdminCapability(user, 'admin.policies.edit')) && (
      <AdminComplianceSettingsSection
        policy={policy}
        canManage={user.role === 'sys_admin'}
        topicFilter={topicFilter}
        tenantPolicy={policy}
        onTenantPolicyChange={setPolicy}
        initialTos={
          settingsBundle ? (settingsBundle.tos?.tos ?? null) : undefined
        }
        onPolicyUpdated={setPolicy}
      />
    );

  const integrationsPanel = (
    <AdminIntegrationsSection
      user={user}
      policy={policy}
      ssoStatus={settingsBundle?.ssoStatus ?? null}
      initialSiem={
        settingsBundle ? (settingsBundle.siem?.siem ?? null) : undefined
      }
      onSelectSettingsTab={selectTab}
      integratedView={section === 'all'}
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
    (hasAdminCapability(user, 'admin.links.revoke') ||
      hasAdminCapability(user, 'admin.policies.read') ||
      hasAdminCapability(user, 'admin.policies.edit')) && (
      <SharedLinksPolicySection
        sharedLinks={sharedLinks}
        policy={policy}
        policySaving={policySaving}
        showLegacyFields={false}
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

  const delegationsPanel = <AdminDelegationsSection user={user} />;

  const reportsPanel =
    hasAdminCapability(user, 'admin.reports.run') && <AdminReportsSection />;

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

  const enterpriseStatusState: EnterpriseSettingStatusState = {
    policy,
    sharedLinks,
    guestInvitations: settingsBundle?.guestInvitations?.invitations ?? null,
    sessions: settingsBundle?.sessions ?? null,
    tos: settingsBundle ? (settingsBundle.tos?.tos ?? null) : undefined,
    ssoStatus: settingsBundle?.ssoStatus ?? undefined,
    siem: settingsBundle?.siem?.siem ?? null,
  };

  const renderEnterpriseTopic = (topicId: EnterpriseSettingTopicId): ReactNode => {
    switch (topicId) {
      case 'shared-links':
        return sharedLinksPanel;
      case 'guest-policy':
        return guestPolicyPanel;
      case 'file-requests':
        return renderCompliancePanel('file-requests');
      case 'roles-and-invite':
        return renderAccessControlPanel('roles-and-invite');
      case 'folder-structure':
        return renderAccessControlPanel('folder-structure');
      case 'content-inspection':
        return renderAccessControlPanel('content-inspection');
      case 'ip-allowlist':
        return renderAuthControlPanel('ip-allowlist');
      case 'sso-oidc':
        return renderAuthControlPanel('sso-oidc');
      case 'sessions':
        return sessionsPanel;
      case 'tos':
        return renderCompliancePanel('tos');
      case 'retention-quota-ai':
        return renderCompliancePanel('retention-quota-ai');
      case 'branding':
        return renderCompliancePanel('branding');
      case 'integrations-catalog':
        return integrationsPanel;
      default:
        return null;
    }
  };

  const renderEnterpriseGroup = (groupId: EnterpriseSettingGroupId): ReactNode => {
    switch (groupId) {
      case 'sharing':
        return (
          <div className="space-y-4">
            {sharedLinksPanel}
            {guestPolicyPanel}
            {renderCompliancePanel('file-requests')}
          </div>
        );
      case 'access':
        return renderAccessControlPanel('all');
      case 'security':
        return (
          <div className="space-y-4">
            {renderAuthControlPanel('all')}
            {sessionsPanel}
          </div>
        );
      case 'compliance':
        return renderCompliancePanel('all');
      case 'integrations':
        return integrationsPanel;
      default:
        return null;
    }
  };

  const enterpriseSettingsWorkbench = (
    <AdminEnterpriseSettingsWorkbench
      user={user}
      activeTabId={activeTab?.id ?? null}
      initialTopic={initialTopic}
      statusState={enterpriseStatusState}
      onSelectTab={(tabId) => {
        // `/admin?tab=settings` renders one integrated pane: switching a
        // workbench group must not replace the outer tab.
        if (section === 'settings') selectTab(tabId);
      }}
      renderTopic={renderEnterpriseTopic}
      renderGroup={renderEnterpriseGroup}
    />
  );

  // Only the selected tab's panels are mounted. This keeps focused routes
  // from paying for every child section's independent fetches.
  const tabId = activeTab?.id;
  if (!tabId) return <>{insightsPanel}</>;

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
            {metadataTemplatesPanel}
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
        return enterpriseSettingsWorkbench;
      case 'integrations':
        return integrationsPanel;
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
      case 'metadata-templates':
        return metadataTemplatesPanel;
      default:
        return null;
    }
  }

  if (section === 'users') {
    switch (tabId) {
      case 'members':
        // SCIM tokens live on the Integrations tab, so the default members
        // view mounts only the member panel (no `/api/admin/scim-tokens`
        // request on first paint).
        return membersPanel;
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
    // Every settings tab is projected through the 2-pane workbench so a
    // single topic owns the viewport while the tree and search stay put.
    return enterpriseSettingsWorkbench;
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
}
