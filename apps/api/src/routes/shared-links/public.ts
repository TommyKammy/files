import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import type { OidcHonoEnv } from '../../types/oidc';
import { registerPublicShareMetaRoutes } from './public/meta';
import { registerPublicSharePasswordRoutes } from './public/password';
import { registerPublicShareUrlRoutes } from './public/url';
import { registerPublicShareUploadRoutes } from './public/upload';
import { registerPublicShareWopiRoutes } from './public/wopi-session';

export const publicShareRoutes = new Hono<OidcHonoEnv>();

publicShareRoutes.use('*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
});

publicShareRoutes.use('*', sessionAuthMiddleware({ required: false }));

registerPublicShareMetaRoutes(publicShareRoutes);
registerPublicSharePasswordRoutes(publicShareRoutes);
registerPublicShareUrlRoutes(publicShareRoutes);
registerPublicShareUploadRoutes(publicShareRoutes);
registerPublicShareWopiRoutes(publicShareRoutes);
