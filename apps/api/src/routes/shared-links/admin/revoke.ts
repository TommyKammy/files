import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../../services/authorization';
import { buildSyncChangeStmt } from '../../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../../services/sync-notifier';
import type { OidcHonoEnv } from '../../../types/oidc';
import { SharedLinkRow } from '../shared';

export function registerSharedLinkRevokeRoute(routes: Hono<OidcHonoEnv>) {
  routes.delete('/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const linkId = c.req.param('id');

    const link = await c.env.DB.prepare(
      'SELECT * FROM shared_links WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, linkId)
      .first<SharedLinkRow>();

    if (!link || link.revoked_at !== null) {
      return c.json({ error: 'Shared link not found' }, 404);
    }

    let targetFolderId: string | null = link.target_type === 'folder' ? link.target_id : null;
    if (
      link.created_by !== user.id &&
      user.role !== 'sys_admin' &&
      user.role !== 'sec_admin'
    ) {
      const access = await resolveTargetAccess(
        c.env.DB,
        user,
        link.target_type,
        link.target_id
      );
      if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
      targetFolderId = link.target_type === 'folder' ? link.target_id : (access?.folderId ?? null);
    } else if (link.target_type === 'file') {
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
        action: 'shared_link.revoke',
        targetType: link.target_type,
        targetId: link.target_id,
        metadata: { linkId },
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

    return c.json({ ok: true, revokedAt: nowIso });
  });


}
