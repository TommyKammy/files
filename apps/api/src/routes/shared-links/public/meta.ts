import { Hono } from 'hono';
import { getShareUnlockSecret, verifyShareUnlockToken } from '../../../services/shared-link-security';
import type { ClassificationLabel } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import { ShareTargetFileRow, ShareTargetFolderRow } from '../shared';
import {
  loadAndAuthorizeShareLink,
  readUnlockToken,
} from './public-shared';

export function registerPublicShareMetaRoutes(routes: Hono<OidcHonoEnv>) {
  routes.get('/:token/meta', async (c) => {
    const user = c.get('user');
    const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }
    const { link, tokenHash } = auth;

    let unlocked = true;
    if (link.password_hash) {
      const unlockSecret = getShareUnlockSecret(c.env);
      unlocked = await verifyShareUnlockToken(
        unlockSecret,
        readUnlockToken(c, link.id),
        link.id,
        tokenHash
      );
    }

    let fileMeta: {
      id: string;
      name: string;
      extension: string | null;
      mimeType: string | null;
      sizeBytes: number;
      classification: ClassificationLabel;
    } | null = null;
    let folderMeta: { id: string; name: string; classification: ClassificationLabel } | null = null;
    let folderFiles: Array<{
      id: string;
      name: string;
      mimeType: string | null;
      sizeBytes: number;
      classification: ClassificationLabel;
    }> = [];

    if (link.target_type === 'file') {
      const file = await c.env.DB.prepare(
        `SELECT id, name, extension, mime_type, size_bytes, classification, upload_state, deleted_at
         FROM files WHERE tenant_id = ? AND id = ?`
      )
        .bind(link.tenant_id, link.target_id)
        .first<ShareTargetFileRow>();
      if (!file || file.deleted_at !== null || file.upload_state !== 'active') {
        return c.json({ error: 'Shared file is no longer available', code: 'TARGET_UNAVAILABLE' }, 404);
      }
      if (unlocked) {
        fileMeta = {
          id: file.id,
          name: file.name,
          extension: file.extension,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          classification: file.classification,
        };
      }
    } else {
      const folder = await c.env.DB.prepare(
        'SELECT id, name, classification, deleted_at FROM folders WHERE tenant_id = ? AND id = ?'
      )
        .bind(link.tenant_id, link.target_id)
        .first<ShareTargetFolderRow>();
      if (!folder || folder.deleted_at !== null) {
        return c.json({ error: 'Shared folder is no longer available', code: 'TARGET_UNAVAILABLE' }, 404);
      }
      if (unlocked) {
        folderMeta = {
          id: folder.id,
          name: folder.name,
          classification: folder.classification,
        };
        const listed = await c.env.DB.prepare(
          `SELECT id, name, mime_type, size_bytes, classification
           FROM files
           WHERE tenant_id = ? AND folder_id = ? AND upload_state = 'active' AND deleted_at IS NULL
           ORDER BY name ASC LIMIT 200`
        )
          .bind(link.tenant_id, folder.id)
          .all<{
            id: string;
            name: string;
            mime_type: string | null;
            size_bytes: number;
            classification: ClassificationLabel;
          }>();
        folderFiles = listed.results.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mime_type,
          sizeBytes: f.size_bytes,
          classification: f.classification,
        }));
      }
    }

    const nowMs = Date.now();
    return c.json({
      targetType: link.target_type,
      accessScope: link.access_scope,
      canDownload: link.can_download === 1,
      requireWatermark: link.require_watermark === 1,
      requiresPassword: Boolean(link.password_hash),
      unlocked,
      isLocked: Boolean(link.locked_until && Date.parse(link.locked_until) > nowMs),
      lockedUntil: link.locked_until,
      expiresAt: link.expires_at,
      maxDownloads: link.max_downloads,
      downloadCount: link.download_count,
      file: fileMeta,
      folder: folderMeta,
      folderFiles,
    });
  });

}
