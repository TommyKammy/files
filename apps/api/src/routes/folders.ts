import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import type { OidcHonoEnv } from '../types/oidc';
import {
  registerFolderBreadcrumbRoutes,
  registerFolderChildrenRoutes,
  registerFolderRootsRoutes,
} from './folders/list';
import { registerFolderMutationRoutes } from './folders/mutations';
import { registerFolderTrashRoutes } from './folders/trash';

export const foldersRoutes = new Hono<OidcHonoEnv>();

foldersRoutes.use('*', sessionAuthMiddleware({ required: true }));

registerFolderRootsRoutes(foldersRoutes);
registerFolderTrashRoutes(foldersRoutes);
registerFolderChildrenRoutes(foldersRoutes);
registerFolderBreadcrumbRoutes(foldersRoutes);
registerFolderMutationRoutes(foldersRoutes);
