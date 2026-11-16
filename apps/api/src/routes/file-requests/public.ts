import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
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

registerPublicFileRequestMetaRoute(publicFileRequestsRoutes);
registerPublicFileRequestUploadInitRoute(publicFileRequestsRoutes);
registerPublicFileRequestUploadCompleteRoutes(publicFileRequestsRoutes);
