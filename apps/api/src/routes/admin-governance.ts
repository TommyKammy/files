import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import {
  requireAdminCapabilityForMethods,
  requireAdminConsoleAccess,
  requireAnyAdminCapability,
  requireMemberUser,
} from '../services/authorization';
import type { OidcHonoEnv } from '../types/oidc';
import { registerAiSuggestionRoutes } from './admin/ai-suggestions';
import { registerAdminContentRoutes } from './admin/content';
import { registerAdminDelegationRoutes } from './admin/delegations';
import { registerAdminFileRequestRoutes } from './admin/file-requests';
import { registerAdminGroupRoutes } from './admin/groups';
import { registerAdminGuestRoutes } from './admin/guests';
import { registerAdminInsightsRoutes } from './admin/insights';
import { registerAdminPermissionRoutes } from './admin/permissions';
import { registerAdminPolicyRoutes } from './admin/policies';
import { registerAdminRootFolderBulkRoutes } from './admin/root-folders-bulk';
import { registerAdminRootFolderRoutes } from './admin/root-folders';
import { registerAdminReportRoutes } from './admin/reports';
import { registerAdminScimTokenRoutes } from './admin/scim-tokens';
import { registerAdminSessionRoutes } from './admin/sessions';
import { registerAdminSettingsBundleRoutes } from './admin/settings-bundle';
import { registerAdminSharedLinkRoutes } from './admin/shared-links';
import { registerAdminSiemRoutes } from './admin/siem';
import { registerAdminSsoRoutes } from './admin/sso';
import { registerStorageStatsRoutes } from './admin/storage';
import { registerAdminTosRoutes } from './admin/tos';
import { registerAdminTrashRoutes } from './admin/trash';
import { registerAdminUserRoutes } from './admin/users';
import { registerAdminBrandingRoutes } from './branding';

export const adminGovernanceRoutes = new Hono<OidcHonoEnv>();
adminGovernanceRoutes.use(
  '*',
  sessionAuthMiddleware({ required: true }),
  requireMemberUser,
  requireAdminConsoleAccess
);

/**
 * P13-1 / TOM-73 capability guards.
 *
 * Registered before every route module so a Co-Admin only reaches the
 * capability surface sys_admin delegated. Route handlers keep their legacy
 * `sys_admin`-only checks for destructive operations; these middlewares are an
 * additional narrowing layer, never a replacement for those guards.
 */
const guards = adminGovernanceRoutes;
guards.use('/insights', requireAdminCapabilityForMethods('admin.insights.read', ['GET']));
guards.use(
  '/storage-stats',
  requireAdminCapabilityForMethods('admin.insights.read', ['GET'])
);

guards.use(
  '/ai-suggestions',
  requireAdminCapabilityForMethods('admin.content.unlock', ['GET', 'POST'])
);
guards.use(
  '/ai-suggestions/*',
  requireAdminCapabilityForMethods('admin.content.unlock', ['GET', 'POST'])
);
guards.use('/content', requireAdminCapabilityForMethods('admin.content.unlock', ['GET', 'POST']));
guards.use(
  '/content/*',
  requireAdminCapabilityForMethods('admin.content.unlock', ['GET', 'POST'])
);

guards.use(
  '/users',
  requireAdminCapabilityForMethods('admin.users.read', ['GET'])
);
guards.use(
  '/users',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);
guards.use(
  '/users/*',
  requireAnyAdminCapability([
    'admin.users.read',
    'admin.users.suspend',
    'admin.users.manage',
  ])
);
guards.use(
  '/users/:id/suspend',
  requireAdminCapabilityForMethods('admin.users.suspend', ['POST'])
);
guards.use(
  '/users/:id/resume',
  requireAdminCapabilityForMethods('admin.users.suspend', ['POST'])
);
guards.use(
  '/users/:id/revoke-sessions',
  requireAdminCapabilityForMethods('admin.users.suspend', ['POST'])
);
guards.use(
  '/users/:id/offboard',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);
guards.use(
  '/users/bulk-import',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);

guards.use(
  '/sessions',
  requireAdminCapabilityForMethods('admin.users.read', ['GET'])
);
guards.use(
  '/sessions/revoke-all',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);
guards.use(
  '/sessions/:id/revoke',
  requireAdminCapabilityForMethods('admin.users.suspend', ['POST'])
);

guards.use(
  '/groups',
  requireAdminCapabilityForMethods('admin.users.read', ['GET'])
);
guards.use(
  '/groups',
  requireAdminCapabilityForMethods('admin.groups.manage', ['POST'])
);
guards.use(
  '/groups/*',
  requireAnyAdminCapability([
    'admin.users.read',
    'admin.groups.manage',
  ])
);
guards.use(
  '/groups/*',
  requireAdminCapabilityForMethods('admin.groups.manage', [
    'POST',
    'PATCH',
    'DELETE',
  ])
);

guards.use(
  '/guests',
  requireAdminCapabilityForMethods('admin.users.read', ['GET'])
);
guards.use(
  '/guests/*',
  requireAnyAdminCapability(['admin.users.read', 'admin.guests.manage'])
);
guards.use(
  '/guests/*',
  requireAdminCapabilityForMethods('admin.guests.manage', ['POST', 'DELETE'])
);

guards.use(
  '/scim-tokens',
  requireAnyAdminCapability(['admin.users.read', 'admin.users.manage'])
);
guards.use(
  '/scim-tokens/*',
  requireAnyAdminCapability(['admin.users.read', 'admin.users.manage'])
);
guards.use(
  '/scim-tokens/*',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);
guards.use(
  '/scim-tokens',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);

guards.use(
  '/branding/logo',
  requireAdminCapabilityForMethods('admin.policies.edit', ['POST', 'DELETE'])
);
guards.use(
  '/policies',
  requireAdminCapabilityForMethods('admin.policies.read', ['GET'])
);
guards.use(
  '/policies',
  requireAdminCapabilityForMethods('admin.policies.edit', ['PATCH'])
);
guards.use(
  '/policies/inheritance-conflicts',
  requireAdminCapabilityForMethods('admin.policies.read', ['GET'])
);
guards.use('/tos', requireAdminCapabilityForMethods('admin.policies.read', ['GET']));
guards.use('/tos', requireAdminCapabilityForMethods('admin.policies.edit', ['PUT']));
guards.use('/siem', requireAdminCapabilityForMethods('admin.policies.read', ['GET']));
guards.use(
  '/siem',
  requireAdminCapabilityForMethods('admin.policies.edit', ['PUT', 'POST'])
);
guards.use(
  '/sso/status',
  requireAdminCapabilityForMethods('admin.policies.read', ['GET'])
);
guards.use(
  '/settings-bundle',
  requireAnyAdminCapability([
    'admin.policies.read',
    'admin.links.revoke',
    'admin.users.read',
  ])
);

guards.use(
  '/shared-links',
  requireAdminCapabilityForMethods('admin.links.revoke', ['GET'])
);
guards.use(
  '/shared-links/*',
  requireAdminCapabilityForMethods('admin.links.revoke', ['GET', 'POST'])
);

guards.use(
  '/file-requests',
  requireAdminCapabilityForMethods('admin.content.unlock', ['GET'])
);
guards.use(
  '/file-requests/*',
  requireAdminCapabilityForMethods('admin.content.unlock', ['GET', 'POST'])
);

guards.use(
  '/root-folders',
  requireAdminCapabilityForMethods('admin.root_folders.read', ['GET'])
);
guards.use(
  '/root-folders',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);
guards.use(
  '/root-folders/*',
  requireAdminCapabilityForMethods('admin.root_folders.read', ['GET'])
);
guards.use(
  '/root-folders/*',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);

guards.use(
  '/permissions',
  requireAdminCapabilityForMethods('admin.permissions.audit', ['GET'])
);
guards.use(
  '/permissions/*',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);

guards.use(
  '/trash',
  requireAdminCapabilityForMethods('admin.trash.manage', ['GET'])
);
guards.use(
  '/trash/restore',
  requireAdminCapabilityForMethods('admin.trash.manage', ['POST'])
);
guards.use(
  '/trash/empty',
  requireAdminCapabilityForMethods('admin.users.manage', ['POST'])
);
guards.use(
  '/trash/items',
  requireAdminCapabilityForMethods('admin.users.manage', ['DELETE'])
);

guards.use(
  '/reports',
  requireAdminCapabilityForMethods('admin.reports.run', ['GET', 'POST', 'PATCH', 'DELETE'])
);
guards.use(
  '/reports/*',
  requireAdminCapabilityForMethods('admin.reports.run', ['GET', 'POST', 'PATCH', 'DELETE'])
);

registerStorageStatsRoutes(adminGovernanceRoutes);
registerAdminInsightsRoutes(adminGovernanceRoutes);
registerAiSuggestionRoutes(adminGovernanceRoutes);
registerAdminContentRoutes(adminGovernanceRoutes);
registerAdminSharedLinkRoutes(adminGovernanceRoutes);
registerAdminPolicyRoutes(adminGovernanceRoutes);
registerAdminTosRoutes(adminGovernanceRoutes);
registerAdminSiemRoutes(adminGovernanceRoutes);
registerAdminFileRequestRoutes(adminGovernanceRoutes);
registerAdminSsoRoutes(adminGovernanceRoutes);
registerAdminGuestRoutes(adminGovernanceRoutes);
registerAdminUserRoutes(adminGovernanceRoutes);
registerAdminSessionRoutes(adminGovernanceRoutes);
registerAdminGroupRoutes(adminGovernanceRoutes);
registerAdminScimTokenRoutes(adminGovernanceRoutes);
registerAdminRootFolderRoutes(adminGovernanceRoutes);
registerAdminRootFolderBulkRoutes(adminGovernanceRoutes);
registerAdminPermissionRoutes(adminGovernanceRoutes);
registerAdminTrashRoutes(adminGovernanceRoutes);
registerAdminReportRoutes(adminGovernanceRoutes);
registerAdminDelegationRoutes(adminGovernanceRoutes);
registerAdminSettingsBundleRoutes(adminGovernanceRoutes);
registerAdminBrandingRoutes(adminGovernanceRoutes);

export { auditLogsRoutes } from './admin/audit-logs';
