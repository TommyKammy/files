import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { requireMemberUser, requireSecOrSysAdmin } from '../services/authorization';
import type { OidcHonoEnv } from '../types/oidc';
import { registerAiSuggestionRoutes } from './admin/ai-suggestions';
import { registerAdminContentRoutes } from './admin/content';
import { registerAdminGroupRoutes } from './admin/groups';
import { registerAdminGuestRoutes } from './admin/guests';
import { registerAdminInsightsRoutes } from './admin/insights';
import { registerAdminPermissionRoutes } from './admin/permissions';
import { registerAdminPolicyRoutes } from './admin/policies';
import { registerAdminRootFolderBulkRoutes } from './admin/root-folders-bulk';
import { registerAdminRootFolderRoutes } from './admin/root-folders';
import { registerAdminScimTokenRoutes } from './admin/scim-tokens';
import { registerAdminSessionRoutes } from './admin/sessions';
import { registerAdminSharedLinkRoutes } from './admin/shared-links';
import { registerAdminSsoRoutes } from './admin/sso';
import { registerStorageStatsRoutes } from './admin/storage';
import { registerAdminTrashRoutes } from './admin/trash';
import { registerAdminUserRoutes } from './admin/users';

export const adminGovernanceRoutes = new Hono<OidcHonoEnv>();
adminGovernanceRoutes.use(
  '*',
  sessionAuthMiddleware({ required: true }),
  requireMemberUser,
  requireSecOrSysAdmin
);

registerStorageStatsRoutes(adminGovernanceRoutes);
registerAdminInsightsRoutes(adminGovernanceRoutes);
registerAiSuggestionRoutes(adminGovernanceRoutes);
registerAdminContentRoutes(adminGovernanceRoutes);
registerAdminSharedLinkRoutes(adminGovernanceRoutes);
registerAdminPolicyRoutes(adminGovernanceRoutes);
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

export { auditLogsRoutes } from './admin/audit-logs';
