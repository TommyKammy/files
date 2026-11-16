import { Hono } from 'hono';
import type { OidcHonoEnv } from '../../../types/oidc';
import { FileRequestRuntimeEnv, getClientIp } from '../shared';
import { loadActiveFileRequest } from './public-shared';
import { createPendingPublicUpload } from './upload-init-create';
import { validateUploadInitRequest } from './upload-init-validation';

export function registerPublicFileRequestUploadInitRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/fr/:token/upload-init — validate extension, size, rate-limit, quota & issue upload URL */
  routes.post('/:token/upload-init', async (c) => {
    const loaded = await loadActiveFileRequest(
      c.env.DB,
      c.req.param('token')
    );
    if (!loaded.ok) {
      return c.json({ error: loaded.error, code: loaded.code }, loaded.status);
    }
    const fr = loaded.fileRequest;
    const runtimeEnv = c.env as FileRequestRuntimeEnv;
    const clientIp = getClientIp(c.req);
    const body = (await c.req.json().catch(() => null)) as {
      fileName?: unknown;
      mimeType?: unknown;
      sizeBytes?: unknown;
      submitterEmail?: unknown;
      turnstileToken?: unknown;
    } | null;
    const nowIso = new Date().toISOString();

    const validation = await validateUploadInitRequest({
      db: c.env.DB,
      fileRequest: fr,
      runtimeEnv,
      body,
      clientIp,
      nowIso,
    });
    if (!validation.ok) {
      return c.json(validation.body, validation.status);
    }

    const { fileId, versionId, signedPut, submissionToken } =
      await createPendingPublicUpload({
        env: c.env,
        fileRequest: fr,
        input: validation.value,
        clientIp,
        nowIso,
      });

    return c.json(
      {
        fileId,
        versionId,
        submissionToken,
        uploadUrl: signedPut.url,
        method: signedPut.method,
        requiredHeaders: signedPut.requiredHeaders,
        expiresAt: signedPut.expiresAt,
      },
      201
    );
  });
}
