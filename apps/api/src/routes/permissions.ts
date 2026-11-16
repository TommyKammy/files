import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { requireMemberUser } from '../services/authorization';
import type { OidcHonoEnv } from '../types/oidc';
import { registerPermissionGrantRoute } from './permissions/grant';
import { registerPermissionListRoute } from './permissions/list';
import { registerPrincipalSearchRoute } from './permissions/principals';
import { registerPermissionRevokeRoute } from './permissions/revoke';

export const permissionsRoutes = new Hono<OidcHonoEnv>();

permissionsRoutes.use(
  '/permissions',
  sessionAuthMiddleware({ required: true })
);
permissionsRoutes.use(
  '/permissions/*',
  sessionAuthMiddleware({ required: true })
);
permissionsRoutes.use(
  '/principals/*',
  sessionAuthMiddleware({ required: true }),
  requireMemberUser
);

registerPermissionListRoute(permissionsRoutes);
registerPermissionGrantRoute(permissionsRoutes);
registerPermissionRevokeRoute(permissionsRoutes);
registerPrincipalSearchRoute(permissionsRoutes);
