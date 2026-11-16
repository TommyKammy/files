import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import type { OidcHonoEnv } from '../../types/oidc';
import { registerSharedLinkCreateRoute } from './admin/create';
import { registerSharedLinkListRoute } from './admin/list';
import { registerSharedLinkRevokeRoute } from './admin/revoke';

export const sharedLinksRoutes = new Hono<OidcHonoEnv>();
sharedLinksRoutes.use('*', sessionAuthMiddleware({ required: true }));

registerSharedLinkListRoute(sharedLinksRoutes);
registerSharedLinkCreateRoute(sharedLinksRoutes);
registerSharedLinkRevokeRoute(sharedLinksRoutes);
