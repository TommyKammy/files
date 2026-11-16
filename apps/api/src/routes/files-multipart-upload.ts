import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import type { OidcHonoEnv } from '../types/oidc';
import { registerMultipartAbortRoute } from './files-multipart-upload/abort';
import { registerMultipartCompleteRoute } from './files-multipart-upload/complete';
import { registerMultipartInitRoute } from './files-multipart-upload/init';
import { registerMultipartPartUrlsRoute } from './files-multipart-upload/part-urls';

export const filesMultipartUploadRoutes = new Hono<OidcHonoEnv>();
filesMultipartUploadRoutes.use(
  '*',
  sessionAuthMiddleware({ required: true })
);

registerMultipartInitRoute(filesMultipartUploadRoutes);
registerMultipartPartUrlsRoute(filesMultipartUploadRoutes);
registerMultipartCompleteRoute(filesMultipartUploadRoutes);
registerMultipartAbortRoute(filesMultipartUploadRoutes);
