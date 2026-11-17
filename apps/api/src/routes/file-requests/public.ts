import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { enforceFileRequestIpAllowlist } from '../../services/ip-allowlist';
import type { OidcHonoEnv } from '../../types/oidc';
import { registerPublicFileRequestMetaRoute } from './public/meta';
import { registerPublicFileRequestUploadCompleteRoutes } from './public/upload-complete';
import { registerPublicFileRequestUploadInitRoute } from './public/upload-init';

export const publicFileRequestsRoutes = new Hono<OidcHonoEnv>();

publicFileRequestsRoutes.use('*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
});

publicFileRequestsRoutes.use('*', sessionAuthMiddleware({ required: false }));

/** TOM-66 all_access enforcement keyed by the file-request tenant. */
const fileRequestIpGuard = createMiddleware<OidcHonoEnv>(async (c, next) => {
  const blocked = await enforceFileRequestIpAllowlist(c);
  if (blocked) return blocked;
  await next();
});
publicFileRequestsRoutes.use('/:token', fileRequestIpGuard);
publicFileRequestsRoutes.use('/:token/*', fileRequestIpGuard);

registerPublicFileRequestMetaRoute(publicFileRequestsRoutes);
registerPublicFileRequestUploadInitRoute(publicFileRequestsRoutes);
registerPublicFileRequestUploadCompleteRoutes(publicFileRequestsRoutes);
