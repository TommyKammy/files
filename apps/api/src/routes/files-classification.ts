import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import type { OidcHonoEnv } from '../types/oidc';
import { registerFileClassificationRoute } from './files-classification/classification';
import { registerFileUpdateRoute } from './files-classification/file-update';
import { registerFileRestoreRoute } from './files-classification/restore';

export const filesClassificationRoutes = new Hono<OidcHonoEnv>();
filesClassificationRoutes.use(
  '*',
  sessionAuthMiddleware({ required: true })
);

registerFileClassificationRoute(filesClassificationRoutes);
registerFileRestoreRoute(filesClassificationRoutes);
registerFileUpdateRoute(filesClassificationRoutes);
