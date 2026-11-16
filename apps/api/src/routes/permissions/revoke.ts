import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  countEffectiveOwners,
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
export function registerPermissionRevokeRoute(routes: Hono<OidcHonoEnv>) {
  /** DELETE /api/permissions/:id — revoke a direct permission with last-owner protection */
  routes.delete('/permissions/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const permissionId = c.req.param('id');

    const perm = await c.env.DB.prepare(
      `SELECT id, target_type, target_id, grantee_type, grantee_id, role
         FROM permissions
        WHERE tenant_id = ? AND id = ?`
    )
      .bind(user.tenantId, permissionId)
      .first<{
        id: string;
        target_type: 'folder' | 'file';
        target_id: string;
        grantee_type: 'user' | 'group';
        grantee_id: string;
        role: ResourceRole;
      }>();

    if (!perm) {
      return c.json({ error: 'Permission not found' }, 404);
    }

    const access = await resolveTargetAccess(
      c.env.DB,
      user,
      perm.target_type,
      perm.target_id
    );
    if (!access || access.deletedAt !== null) {
      return c.json({ error: 'Target resource not found' }, 404);
    }
    if (!hasAtLeastRole(access.effectiveRole, 'co_owner')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (perm.role === 'owner') {
      if (access.effectiveRole !== 'owner') {
        return c.json(
          { error: 'Forbidden: co_owner cannot revoke an owner permission' },
          403
        );
      }
      const ownerCount = await countEffectiveOwners(
        c.env.DB,
        user.tenantId,
        perm.target_type,
        perm.target_id,
        access.folderId
      );
      if (ownerCount <= 1) {
        return c.json(
          {
            error: 'Cannot remove the last owner of this resource',
            code: 'LAST_OWNER_LOCKOUT',
          },
          409
        );
      }
    }

    const nowIso = new Date().toISOString();
    const syncFolderId = perm.target_type === 'folder' ? perm.target_id : access.folderId;

    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM permissions WHERE tenant_id = ? AND id = ?').bind(
        user.tenantId,
        permissionId
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'permission.revoke',
        targetType: perm.target_type,
        targetId: perm.target_id,
        classificationSnapshot: access.classification,
        metadata: {
          permissionId,
          granteeType: perm.grantee_type,
          granteeId: perm.grantee_id,
          revokedRole: perm.role,
        },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'permission',
        entityId: permissionId,
        folderId: syncFolderId,
        targetUserId: perm.grantee_type === 'user' ? perm.grantee_id : null,
        action: 'permission.revoke',
        payload: {
          permissionId,
          targetType: perm.target_type,
          targetId: perm.target_id,
          granteeType: perm.grantee_type,
          granteeId: perm.grantee_id,
          revokedRole: perm.role,
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'permission.revoke',
      scopeFolderIds: [syncFolderId],
      targetUserId: perm.grantee_type === 'user' ? perm.grantee_id : null,
      revoked: true,
    });

    return c.json({ ok: true, id: permissionId });
  });

}
