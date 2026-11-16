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
import {
  VALID_GRANTEE_TYPES,
  VALID_RESOURCE_ROLES,
  VALID_TARGET_TYPES,
} from './shared';
export function registerPermissionGrantRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/permissions — grant or update a direct RBAC role (UPSERT) */
  routes.post('/permissions', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      targetType?: string;
      targetId?: string;
      granteeType?: string;
      granteeId?: string;
      role?: string;
    } | null;

    if (
      !body ||
      !body.targetType ||
      !VALID_TARGET_TYPES.has(body.targetType) ||
      !body.targetId ||
      !body.granteeType ||
      !VALID_GRANTEE_TYPES.has(body.granteeType) ||
      !body.granteeId ||
      !body.role ||
      !VALID_RESOURCE_ROLES.has(body.role as ResourceRole)
    ) {
      return c.json({ error: 'Invalid permission payload' }, 400);
    }

    const targetType = body.targetType as 'folder' | 'file';
    const targetId = body.targetId;
    const granteeType = body.granteeType as 'user' | 'group';
    const granteeId = body.granteeId;
    const requestedRole = body.role as ResourceRole;

    const access = await resolveTargetAccess(c.env.DB, user, targetType, targetId);
    if (!access || access.deletedAt !== null) {
      return c.json({ error: 'Target resource not found' }, 404);
    }
    if (!hasAtLeastRole(access.effectiveRole, 'co_owner')) {
      return c.json({ error: 'Forbidden: co_owner or owner required to manage permissions' }, 403);
    }

    // Guardrail 1: co_owner cannot grant owner role
    if (requestedRole === 'owner' && access.effectiveRole !== 'owner') {
      return c.json(
        { error: 'Forbidden: only an owner can grant the owner role', code: 'OWNER_ESCALATION_BLOCKED' },
        403
      );
    }

    // Validate grantee exists in same tenant and is not suspended
    if (granteeType === 'user') {
      const granteeUser = await c.env.DB.prepare(
        'SELECT id, status FROM users WHERE tenant_id = ? AND id = ?'
      )
        .bind(user.tenantId, granteeId)
        .first<{ id: string; status: 'active' | 'suspended' }>();
      if (!granteeUser) {
        return c.json({ error: 'Target user not found in tenant' }, 404);
      }
      if (granteeUser.status !== 'active') {
        return c.json(
          { error: 'Cannot grant permissions to a suspended user', code: 'SUSPENDED_USER_BLOCKED' },
          400
        );
      }
    } else {
      const granteeGroup = await c.env.DB.prepare(
        'SELECT id FROM groups WHERE tenant_id = ? AND id = ?'
      )
        .bind(user.tenantId, granteeId)
        .first<{ id: string }>();
      if (!granteeGroup) {
        return c.json({ error: 'Target group not found in tenant' }, 404);
      }
    }

    const existing = await c.env.DB.prepare(
      `SELECT id, role
         FROM permissions
        WHERE tenant_id = ? AND target_type = ? AND target_id = ?
          AND grantee_type = ? AND grantee_id = ?`
    )
      .bind(user.tenantId, targetType, targetId, granteeType, granteeId)
      .first<{ id: string; role: ResourceRole }>();

    // Guardrail 2: co_owner cannot modify/demote an existing owner
    if (existing?.role === 'owner' && access.effectiveRole !== 'owner') {
      return c.json(
        { error: 'Forbidden: co_owner cannot modify an existing owner permission' },
        403
      );
    }

    // Guardrail 3: prevent demoting the last remaining owner
    if (existing?.role === 'owner' && requestedRole !== 'owner') {
      const ownerCount = await countEffectiveOwners(
        c.env.DB,
        user.tenantId,
        targetType,
        targetId,
        access.folderId
      );
      if (ownerCount <= 1) {
        return c.json(
          {
            error: 'Cannot demote the last owner of this resource',
            code: 'LAST_OWNER_LOCKOUT',
          },
          409
        );
      }
    }

    const nowIso = new Date().toISOString();
    const permissionId = existing?.id ?? crypto.randomUUID();
    const syncFolderId = targetType === 'folder' ? targetId : access.folderId;

    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
         DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`
      ).bind(
        permissionId,
        user.tenantId,
        targetType,
        targetId,
        granteeType,
        granteeId,
        requestedRole,
        user.id,
        nowIso
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: existing ? 'permission.update' : 'permission.grant',
        targetType,
        targetId,
        classificationSnapshot: access.classification,
        metadata: {
          permissionId,
          granteeType,
          granteeId,
          previousRole: existing?.role ?? null,
          role: requestedRole,
        },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'permission',
        entityId: permissionId,
        folderId: syncFolderId,
        targetUserId: granteeType === 'user' ? granteeId : null,
        action: existing ? 'permission.update' : 'permission.grant',
        payload: {
          permissionId,
          targetType,
          targetId,
          granteeType,
          granteeId,
          previousRole: existing?.role ?? null,
          role: requestedRole,
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: existing ? 'permission.update' : 'permission.grant',
      scopeFolderIds: [syncFolderId],
      targetUserId: granteeType === 'user' ? granteeId : null,
    });

    return c.json(
      {
        permission: {
          id: permissionId,
          targetType,
          targetId,
          granteeType,
          granteeId,
          role: requestedRole,
          grantedBy: user.id,
        },
      },
      existing ? 200 : 201
    );
  });

}
