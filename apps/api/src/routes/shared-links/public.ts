import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { enforcePublicShareIpAllowlist } from '../../services/ip-allowlist';
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

/** TOM-66 all_access enforcement keyed by the shared-link tenant. */
publicShareRoutes.use('/:token/*', async (c, next) => {
  const blocked = await enforcePublicShareIpAllowlist(c);
  if (blocked) return blocked;
  await next();
});

registerPublicShareMetaRoutes(publicShareRoutes);
registerPublicSharePasswordRoutes(publicShareRoutes);
registerPublicShareUrlRoutes(publicShareRoutes);
registerPublicShareUploadRoutes(publicShareRoutes);
registerPublicShareWopiRoutes(publicShareRoutes);
