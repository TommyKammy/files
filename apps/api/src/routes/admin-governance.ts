import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { requireSecOrSysAdmin } from '../services/authorization';
import type { OidcHonoEnv } from '../types/oidc';
import { registerAiSuggestionRoutes } from './admin/ai-suggestions';
import { registerAdminPolicyRoutes } from './admin/policies';
import { registerAdminSharedLinkRoutes } from './admin/shared-links';
import { registerStorageStatsRoutes } from './admin/storage';
import { registerAdminTrashRoutes } from './admin/trash';

export const adminGovernanceRoutes = new Hono<OidcHonoEnv>();
adminGovernanceRoutes.use(
  '*',
  sessionAuthMiddleware({ required: true }),
  requireSecOrSysAdmin
);

registerStorageStatsRoutes(adminGovernanceRoutes);
registerAiSuggestionRoutes(adminGovernanceRoutes);
registerAdminSharedLinkRoutes(adminGovernanceRoutes);
registerAdminPolicyRoutes(adminGovernanceRoutes);
registerAdminTrashRoutes(adminGovernanceRoutes);

export { auditLogsRoutes } from './admin/audit-logs';
