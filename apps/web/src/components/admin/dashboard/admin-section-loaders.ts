'use client';

import dynamic from 'next/dynamic';
import type { AdminSectionChunkId } from '@/lib/admin-console-tabs';

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
const loadAdminIntegrations = () =>
  import('@/components/admin/AdminIntegrationsSection').then(
    (m) => m.AdminIntegrationsSection
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
const loadAdminMetadataTemplates = () =>
  import('@/components/admin/AdminMetadataTemplatesSection').then(
    (m) => m.AdminMetadataTemplatesSection
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
const loadAdminEnterpriseSettingsWorkbench = () =>
  import('@/components/admin/AdminEnterpriseSettingsWorkbench').then(
    (m) => m.AdminEnterpriseSettingsWorkbench
  );

export const AccessControlSettingsSection = dynamic(loadAccessControlSettings);
export const AdminAuthControlSection = dynamic(loadAdminAuthControl);
export const AdminContentManagerSection = dynamic(loadAdminContentManager);
export const AdminComplianceSettingsSection = dynamic(
  loadAdminComplianceSettings
);
export const AdminDelegationsSection = dynamic(loadAdminDelegations);
export const AdminFileRequestsSection = dynamic(loadAdminFileRequests);
export const AdminInsightsDashboardSection = dynamic(
  loadAdminInsightsDashboard
);
export const AdminIntegrationsSection = dynamic(loadAdminIntegrations);
export const AiSuggestionQueue = dynamic(loadAiSuggestionQueue);
export const AdminGuestsSection = dynamic(loadAdminGuests);
export const AdminGroupsSection = dynamic(loadAdminGroups);
export const AdminMembersSection = dynamic(loadAdminMembers);
export const AdminPermissionAuditSection = dynamic(loadAdminPermissionAudit);
export const AdminReportsSection = dynamic(loadAdminReports);
export const AdminRootFoldersSection = dynamic(loadAdminRootFolders);
export const AdminMetadataTemplatesSection = dynamic(
  loadAdminMetadataTemplates
);
export const AdminScimTokensSection = dynamic(loadAdminScimTokens);
export const AdminSessionsSection = dynamic(loadAdminSessions);
export const AdminTrashSection = dynamic(loadAdminTrash);
export const AuditLogSection = dynamic(loadAuditLog);
export const GuestPolicySection = dynamic(loadGuestPolicy);
export const SharedLinksPolicySection = dynamic(loadSharedLinksPolicy);
export const AdminEnterpriseSettingsWorkbench = dynamic(
  loadAdminEnterpriseSettingsWorkbench
);

// Map the pure `getAdminTabPreloadChunkIds` plan to the actual dynamic
// import loaders. Only the active tab's chunks are preloaded, so `/admin`
// does not download every section chunk and `/admin/content` does not
// download all five content tabs on first paint.
export const ADMIN_SECTION_PRELOADERS: Record<
  AdminSectionChunkId,
  () => Promise<unknown>
> = {
  'insights-dashboard': loadAdminInsightsDashboard,
  'content-manager': loadAdminContentManager,
  'ai-suggestion-queue': loadAiSuggestionQueue,
  'admin-file-requests': loadAdminFileRequests,
  'admin-trash': loadAdminTrash,
  'admin-root-folders': loadAdminRootFolders,
  'admin-metadata-templates': loadAdminMetadataTemplates,
  'admin-members': loadAdminMembers,
  'admin-groups': loadAdminGroups,
  'admin-guests': loadAdminGuests,
  'admin-delegations': loadAdminDelegations,
  'admin-scim-tokens': loadAdminScimTokens,
  'admin-integrations': loadAdminIntegrations,
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
