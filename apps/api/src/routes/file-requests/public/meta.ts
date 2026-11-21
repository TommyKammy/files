import { Hono } from 'hono';
import type { OidcHonoEnv } from '../../../types/oidc';
import { loadTenantBranding } from '../../../services/branding';
import { FileRequestRuntimeEnv, parseAllowedExtensionsJson } from '../shared';
import {
  loadActiveFileRequest,
} from './public-shared';

export function registerPublicFileRequestMetaRoute(routes: Hono<OidcHonoEnv>) {
  /** GET /api/fr/:token — strict blind metadata (never exposes folderId or existing files) */
  routes.get('/:token', async (c) => {
    const loaded = await loadActiveFileRequest(c.env.DB, c.req.param('token'));
    if (!loaded.ok) {
      return c.json({ error: loaded.error, code: loaded.code }, loaded.status);
    }
    const fr = loaded.fileRequest;
    const runtimeEnv = c.env as FileRequestRuntimeEnv;
    const branding = await loadTenantBranding(c.env.DB, fr.tenant_id);
    const turnstileEnabled = Boolean(runtimeEnv.TURNSTILE_SECRET_KEY);
    const trimmedSiteKey = runtimeEnv.TURNSTILE_SITE_KEY?.trim() || null;
    const turnstileSiteKey = turnstileEnabled ? trimmedSiteKey : null;

    return c.json({
      title: fr.title,
      description: fr.description,
      requireSubmitterEmail: fr.require_submitter_email === 1,
      maxFileSizeBytes: fr.max_file_size_bytes,
      allowedExtensions: parseAllowedExtensionsJson(fr.allowed_extensions),
      expiresAt: fr.expires_at,
      turnstileEnabled,
      turnstileSiteKey,
      branding,
    });
  });


}
