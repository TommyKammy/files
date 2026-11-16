import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import type { OidcHonoEnv } from '../types/oidc';
import { registerFileVersionContentUrlRoute } from './file-versions/content-url';
import { registerFileVersionListRoute } from './file-versions/list';
import { registerFileVersionRestoreRoute } from './file-versions/restore';

export const fileVersionsRoutes = new Hono<OidcHonoEnv>();
fileVersionsRoutes.use('*', sessionAuthMiddleware({ required: true }));

registerFileVersionListRoute(fileVersionsRoutes);
registerFileVersionContentUrlRoute(fileVersionsRoutes);
registerFileVersionRestoreRoute(fileVersionsRoutes);
