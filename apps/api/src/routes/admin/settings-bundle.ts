import { Hono } from 'hono';
import {
  getAdminScope,
  hasAdminCapability,
} from '../../services/admin-delegations';
import {
  ADMIN_SESSION_DEFAULT_LIMIT,
  listAdminSessions,
} from '../../services/admin-sessions';
import { getAuthenticatedUser } from '../../services/authorization';
import { listTenantGuestInvitations } from '../../services/guest-detail';
import type { OidcHonoEnv } from '../../types/oidc';
import { loadTenantPoliciesPayload } from './policies';
import { listAdminSharedLinks } from './shared-links';
import { loadAdminSiemPayload } from './siem';
import { loadAdminSsoStatusPayload } from './sso';
import { loadAdminTosPayload } from './tos';

export function registerAdminSettingsBundleRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/admin/settings-bundle — consolidated governance & settings read
   * endpoint that eliminates the 3-stage mount waterfall on `/admin/settings`
   * (and settings widgets on `/admin`).
   *
   * Capability isolation mirrors the individual routes: each sub-payload is
   * computed and serialized only when the caller's role or Co-Admin delegation
   * grants access to that surface; otherwise it is returned as `null`.
   */
  routes.get('/settings-bundle', async (c) => {
    const user = getAuthenticatedUser(c);
    const canReadPolicies = hasAdminCapability(user, 'admin.policies.read');
    const canRevokeLinks = hasAdminCapability(user, 'admin.links.revoke');
    const canReadUsers = hasAdminCapability(user, 'admin.users.read');
    const canReadGuests = user.role === 'sys_admin';

    const [
      policies,
      sharedLinks,
      ssoStatus,
      tos,
      siem,
      sessions,
      guestInvitations,
    ] = await Promise.all([
      canReadPolicies
        ? loadTenantPoliciesPayload(c.env.DB, user.tenantId)
        : Promise.resolve(null),
      canRevokeLinks
        ? listAdminSharedLinks(c.env.DB, user, 50)
        : Promise.resolve(null),
      canReadPolicies
        ? loadAdminSsoStatusPayload(c, user, false)
        : Promise.resolve(null),
      canReadPolicies
        ? loadAdminTosPayload(c.env.DB, user.tenantId)
        : Promise.resolve(null),
      canReadPolicies
        ? loadAdminSiemPayload(c.env.DB, user.tenantId)
        : Promise.resolve(null),
      canReadUsers
        ? listAdminSessions({
            db: c.env.DB,
            tenantId: user.tenantId,
            actorSessionId: user.sessionId ?? null,
            filters: {
              userId: null,
              userType: 'all',
              ip: null,
              query: null,
              limit: ADMIN_SESSION_DEFAULT_LIMIT,
              cursor: null,
            },
            scopeGroupId: getAdminScope(user)?.groupId ?? null,
          })
        : Promise.resolve(null),
      canReadGuests
        ? listTenantGuestInvitations(c.env.DB, user.tenantId)
        : Promise.resolve(null),
    ]);

    return c.json({
      policies,
      sharedLinks,
      ssoStatus,
      tos,
      siem,
      sessions,
      guestInvitations,
    });
  });
}
