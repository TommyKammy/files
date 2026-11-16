import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { can } from '../../services/capabilities';
import {
  authorizeFileContentAccess,
  contentIntentFromQuery,
  deliverFileContent,
} from '../../services/file-content-access';
import type { OidcHonoEnv } from '../../types/oidc';

export function registerFileVersionContentUrlRoute(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/files/:id/versions/:versionId/content-url?intent=preview|download
   * Signs the historical version's R2 object with the same DLP rules as the
   * current-version endpoint; the raw object key never appears in the body.
   */
  routes.get('/:id/versions/:versionId/content-url', async (c) => {
    const user = getAuthenticatedUser(c);
    const fileId = c.req.param('id');
    const versionId = c.req.param('versionId');
    const intent = contentIntentFromQuery(c.req.query('intent'));

    const authorized = await authorizeFileContentAccess(c.env.DB, user, fileId, intent, {
      versionId,
    });
    if (!authorized.ok) {
      return c.json(authorized.body, authorized.status);
    }

    const version = await c.env.DB.prepare(
      `SELECT id, upload_status
         FROM file_versions
        WHERE tenant_id = ? AND file_id = ? AND id = ?`
    )
      .bind(user.tenantId, fileId, versionId)
      .first<{ id: string; upload_status: 'pending' | 'completed' | 'failed' }>();

    if (!version) {
      return c.json({ error: 'File version not found' }, 404);
    }
    if (version.upload_status !== 'completed') {
      return c.json(
        {
          error: 'File version content is not available',
          code: 'VERSION_NOT_COMPLETED',
        },
        409
      );
    }

    const delivered = await deliverFileContent({
      env: c.env,
      user,
      fileId,
      intent,
      versionId,
      forceWatermark: !can(authorized.access.capabilities, 'item.download'),
    });
    if (!delivered.ok) {
      return c.json(delivered.body, delivered.status);
    }

    return c.json(delivered.body);
  });
}
