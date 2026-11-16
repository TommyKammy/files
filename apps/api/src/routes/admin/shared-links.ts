import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import { getAuthenticatedUser } from '../../services/authorization';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';

export function registerAdminSharedLinkRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/shared-links — active shared links feed for governance monitoring */
  routes.get('/shared-links', async (c) => {
    const user = getAuthenticatedUser(c);
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

    const rows = await c.env.DB.prepare(
      `SELECT sl.id, sl.target_type, sl.target_id, sl.access_scope, sl.can_download,
              sl.permission_level, sl.require_watermark,
              sl.failed_password_attempts, sl.locked_until,
              sl.expires_at, sl.max_downloads, sl.download_count, sl.created_by,
              u.email AS creator_email,
              CASE
                WHEN sl.target_type = 'file' THEN (SELECT name FROM files WHERE id = sl.target_id)
                ELSE (SELECT name FROM folders WHERE id = sl.target_id)
              END AS target_name,
              sl.created_at
       FROM shared_links sl
       LEFT JOIN users u ON u.id = sl.created_by
       WHERE sl.tenant_id = ? AND sl.revoked_at IS NULL
       ORDER BY sl.created_at DESC LIMIT ?`
    )
      .bind(user.tenantId, limit)
      .all();

    return c.json({ links: rows.results });
  });

  /** POST /api/admin/shared-links/:id/revoke — emergency admin shared-link revocation */
  routes.post('/shared-links/:id/revoke', async (c) => {
    const user = getAuthenticatedUser(c);
    const linkId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
    const reason =
      typeof body?.reason === 'string' && body.reason.trim()
        ? body.reason.trim().slice(0, 300)
        : 'Admin emergency revocation';

    const link = await c.env.DB.prepare(
      'SELECT id, target_type, target_id, created_by, revoked_at FROM shared_links WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, linkId)
      .first<{
        id: string;
        target_type: 'file' | 'folder';
        target_id: string;
        created_by: string;
        revoked_at: string | null;
      }>();

    if (!link || link.revoked_at !== null) {
      return c.json({ error: 'Active shared link not found' }, 404);
    }

    let targetFolderId: string | null = link.target_type === 'folder' ? link.target_id : null;
    if (link.target_type === 'file') {
      const fileRow = await c.env.DB.prepare(
        'SELECT folder_id FROM files WHERE tenant_id = ? AND id = ?'
      )
        .bind(user.tenantId, link.target_id)
        .first<{ folder_id: string | null }>();
      targetFolderId = fileRow?.folder_id ?? null;
    }

    const nowIso = new Date().toISOString();
    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE shared_links SET revoked_at = ?, revoked_by = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL'
      ).bind(nowIso, user.id, user.tenantId, linkId),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'admin.shared_link_revoked',
        targetType: link.target_type,
        targetId: link.target_id,
        status: 'allowed',
        metadata: { linkId, reason },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'shared_link',
        entityId: linkId,
        folderId: targetFolderId,
        targetUserId: link.created_by,
        action: 'shared_link.revoke',
        payload: {
          linkId,
          targetType: link.target_type,
          targetId: link.target_id,
          reason,
          revokedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'shared_link.revoke',
      scopeFolderIds: [targetFolderId],
      revoked: true,
    });

    return c.json({ ok: true, linkId, revokedAt: nowIso });
  });

}
