import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { can } from '../../services/capabilities';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  type FileVersionListRow,
  decodeVersionCursor,
  encodeVersionCursor,
  loadActiveFile,
  parseVersionLimit,
  toPublicVersion,
} from './shared';

export function registerFileVersionListRoute(routes: Hono<OidcHonoEnv>) {
  /** GET /api/files/:id/versions — keyset-paginated version history (newest first) */
  routes.get('/:id/versions', async (c) => {
    const user = getAuthenticatedUser(c);
    const fileId = c.req.param('id');
    const limit = parseVersionLimit(c.req.query('limit'));
    const rawCursor = c.req.query('cursor');
    const cursor = decodeVersionCursor(rawCursor);
    if (rawCursor && !cursor) {
      return c.json({ error: 'Invalid pagination cursor' }, 400);
    }

    const loaded = await loadActiveFile(c.env.DB, user, fileId);
    if (!loaded) {
      return c.json({ error: 'File not found' }, 404);
    }
    if (!can(loaded.access.capabilities, 'item.preview')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rows = await c.env.DB.prepare(
      `SELECT fv.id, fv.version_num, fv.size_bytes, fv.mime_type, fv.uploaded_by,
              u.display_name AS uploaded_by_name, fv.created_at, fv.upload_status,
              fv.comment,
              CASE WHEN fv.id = fl.current_version_id THEN 1 ELSE 0 END AS is_current
         FROM file_versions fv
         JOIN files fl ON fl.tenant_id = fv.tenant_id AND fl.id = fv.file_id
         LEFT JOIN users u ON u.tenant_id = fv.tenant_id AND u.id = fv.uploaded_by
        WHERE fv.tenant_id = ? AND fv.file_id = ?
          AND fl.deleted_at IS NULL AND fl.upload_state = 'active'
          ${cursor ? 'AND (fv.version_num, fv.id) < (?, ?)' : ''}
        ORDER BY fv.version_num DESC, fv.id DESC
        LIMIT ?`
    )
      .bind(
        user.tenantId,
        fileId,
        ...(cursor ? [cursor.versionNum, cursor.id] : []),
        limit + 1
      )
      .all<FileVersionListRow>();

    const hasMore = rows.results.length > limit;
    const pageItems = hasMore ? rows.results.slice(0, limit) : rows.results;
    const last = pageItems[pageItems.length - 1];

    return c.json({
      versions: pageItems.map(toPublicVersion),
      nextCursor:
        hasMore && last
          ? encodeVersionCursor({ versionNum: last.version_num, id: last.id })
          : null,
      hasMore,
    });
  });
}
