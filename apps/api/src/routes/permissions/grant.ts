import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import {
  areAdvancedRolesEnabled,
  countEffectiveOwners,
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../services/authorization';
import {
  can,
  isAdvancedResourceRole,
  isResourceRole,
} from '../../services/capabilities';
import {
  computeEffectivePermissionsCapabilities,
  isRoleWithinCapabilitySubset,
  resolveEffectiveInvitePolicy,
} from '../../services/invite-policy';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import {
  findInheritedAncestorGrant,
  getPermissionInheritanceMode,
} from '../../services/permission-inheritance';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  VALID_GRANTEE_TYPES,
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
      !isResourceRole(body.role)
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

    // Step 1: resolve the policy that governs this invitation.
    const policyFolderId = targetType === 'folder' ? targetId : access.folderId;
    const resolvedInvitePolicy = await resolveEffectiveInvitePolicy(
      c.env.DB,
      user.tenantId,
      policyFolderId
    );
    const effectiveCapabilities = computeEffectivePermissionsCapabilities(
      access.capabilities,
      access.effectiveRole,
      resolvedInvitePolicy.effectivePolicy,
      user.role
    );
    const canManage = can(access.capabilities, 'permission.manage');
    const canInvite = can(effectiveCapabilities, 'permission.invite');

    // Step 2: distinguish a brand-new invitation from an existing grant update.
    const existing = await c.env.DB.prepare(
      `SELECT id, role
         FROM permissions
        WHERE tenant_id = ? AND target_type = ? AND target_id = ?
          AND grantee_type = ? AND grantee_id = ?`
    )
      .bind(user.tenantId, targetType, targetId, granteeType, granteeId)
      .first<{ id: string; role: ResourceRole }>();

    if (existing) {
      // Inviting is not enough to modify an existing collaborator.
      if (!canManage) {
        return c.json(
          {
            error: 'Only co_owner or owner can modify existing permissions',
            code: 'MANAGE_PERMISSION_REQUIRED',
            effectiveInvitePolicy: resolvedInvitePolicy.effectivePolicy,
          },
          403
        );
      }
    } else if (!canInvite) {
      const roleWouldAllowInvite =
        access.effectiveRole === 'owner' ||
        access.effectiveRole === 'co_owner' ||
        access.effectiveRole === 'editor';
      if (roleWouldAllowInvite) {
        return c.json(
          {
            error: `Invitations are restricted by the effective invite policy (${resolvedInvitePolicy.effectivePolicy})`,
            code: 'INVITE_POLICY_RESTRICTED',
            effectiveInvitePolicy: resolvedInvitePolicy.effectivePolicy,
          },
          403
        );
      }
      return c.json({ error: 'Forbidden', code: 'FORBIDDEN' }, 403);
    }

    // Guardrail 0a: advanced roles are folder-only, independent of tenant policy.
    if (isAdvancedResourceRole(requestedRole) && targetType !== 'folder') {
      return c.json(
        {
          error: 'Advanced roles can only be granted on folders',
          code: 'ROLE_FOLDER_ONLY',
        },
        400
      );
    }

    // Guardrail 0b: advanced roles are opt-in per tenant (default disabled).
    if (
      isAdvancedResourceRole(requestedRole) &&
      !(await areAdvancedRolesEnabled(c.env.DB, user.tenantId))
    ) {
      return c.json(
        {
          error: 'Advanced roles are disabled for this tenant',
          code: 'ADVANCED_ROLES_DISABLED',
        },
        403
      );
    }

    // Step 3a: an invite-only caller may never exceed their own capabilities.
    // Checked before the owner guard so `editor -> owner` reports the subset
    // violation, while `co_owner -> owner` still reports OWNER_ESCALATION_BLOCKED.
    if (
      !canManage &&
      !isRoleWithinCapabilitySubset(requestedRole, access.capabilities)
    ) {
      return c.json(
        {
          error: 'Requested role exceeds your capabilities',
          code: 'ROLE_EXCEEDS_CALLER_CAPABILITIES',
        },
        403
      );
    }

    // Guardrail 1: co_owner cannot grant owner role
    if (requestedRole === 'owner' && access.effectiveRole !== 'owner') {
      return c.json(
        { error: 'Forbidden: only an owner can grant the owner role', code: 'OWNER_ESCALATION_BLOCKED' },
        403
      );
    }

    // Step 3b: managers are also capped by their own capability set, which
    // keeps an owner as the only principal able to grant `owner`.
    if (
      canManage &&
      !isRoleWithinCapabilitySubset(requestedRole, access.capabilities)
    ) {
      return c.json(
        {
          error: 'Requested role exceeds your capabilities',
          code: 'ROLE_EXCEEDS_CALLER_CAPABILITIES',
        },
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

    // Step 4: waterfall inheritance makes ancestor grants authoritative.
    // The invite-policy gate above runs first, so a caller who cannot invite
    // never learns about inherited grants.
    if ((await getPermissionInheritanceMode(c.env.DB, user.tenantId)) === 'waterfall') {
      const inherited = await findInheritedAncestorGrant(
        c.env.DB,
        user.tenantId,
        targetType,
        targetId,
        granteeType,
        granteeId
      );
      if (inherited) {
        return c.json(
          {
            error: `Permission is inherited from ancestor folder "${inherited.ancestorFolderName}" under waterfall inheritance; update it on the parent folder instead`,
            code: 'WATERFALL_INHERITED_LOCKED',
            ancestorFolderId: inherited.ancestorFolderId,
            ancestorFolderName: inherited.ancestorFolderName,
            inheritedRole: inherited.inheritedRole,
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
          invitePolicy: resolvedInvitePolicy.effectivePolicy,
          viaCapability: existing ? 'permission.manage' : 'permission.invite',
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
          invitePolicy: resolvedInvitePolicy.effectivePolicy,
          viaCapability: existing ? 'permission.manage' : 'permission.invite',
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
        effectiveInvitePolicy: resolvedInvitePolicy.effectivePolicy,
        effectiveCapabilities,
      },
      existing ? 200 : 201
    );
  });

}
