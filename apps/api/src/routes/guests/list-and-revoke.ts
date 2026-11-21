import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../services/authorization';
import { can } from '../../services/capabilities';
import {
  listTenantGuestInvitations,
  loadGuestDetail,
  loadGuestInvitation,
  projectGuestInvitation,
} from '../../services/guest-detail';
import type { OidcHonoEnv } from '../../types/oidc';
import { VALID_TARGET_TYPES, authorizeInvitationTarget } from './shared';

export function registerGuestListAndRevokeRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/guests/invitations — tenant guest invitation list. */
  routes.get('/invitations', async (c) => {
    const user = getAuthenticatedUser(c);
    const targetType = c.req.query('targetType');
    const targetId = c.req.query('targetId');

    if (targetType && !VALID_TARGET_TYPES.has(targetType)) {
      return c.json({ error: 'targetType must be folder or file' }, 400);
    }
    if ((targetType && !targetId) || (!targetType && targetId)) {
      return c.json(
        { error: 'targetType and targetId must be provided together' },
        400
      );
    }

    if (user.role !== 'sys_admin') {
      if (!targetType || !targetId) {
        return c.json(
          {
            error: 'Only sys_admin can list every guest invitation in the tenant',
            code: 'SYS_ADMIN_REQUIRED',
          },
          403
        );
      }
      const auth = await authorizeInvitationTarget(
        c.env.DB,
        user,
        targetType as 'folder' | 'file',
        targetId
      );
      if (!auth.ok) {
        return c.json(
          { error: auth.error, ...(auth.code ? { code: auth.code } : {}) },
          auth.status
        );
      }
    } else if (targetType && targetId) {
      // sys_admin bypasses ACL checks but never cross-tenant target probing.
      const target = await c.env.DB.prepare(
        targetType === 'folder'
          ? 'SELECT id FROM folders WHERE tenant_id = ? AND id = ?'
          : 'SELECT id FROM files WHERE tenant_id = ? AND id = ?'
      )
        .bind(user.tenantId, targetId)
        .first<{ id: string }>();
      if (!target) {
        return c.json({ error: 'Target resource not found' }, 404);
      }
    }

    return c.json(
      await listTenantGuestInvitations(
        c.env.DB,
        user.tenantId,
        targetType && targetId
          ? { targetType: targetType as 'folder' | 'file', targetId }
          : undefined
      )
    );
  });

  /** POST /api/guests/invitations/:id/revoke — revoke access and live sessions. */
  routes.post('/invitations/:id/revoke', async (c) => {
    const user = getAuthenticatedUser(c);
    const invitation = await loadGuestInvitation(
      c.env.DB,
      user.tenantId,
      c.req.param('id')
    );
    if (!invitation) {
      return c.json(
        { error: 'Guest invitation not found', code: 'INVITATION_NOT_FOUND' },
        404
      );
    }

    const auth = await authorizeInvitationTarget(
      c.env.DB,
      user,
      invitation.target_type,
      invitation.target_id
    );
    if (!auth.ok) {
      return c.json(
        { error: auth.error, ...(auth.code ? { code: auth.code } : {}) },
        auth.status
      );
    }

    if (invitation.status === 'revoked') {
      return c.json({ ok: true, invitation: projectGuestInvitation(invitation) });
    }

    const nowIso = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE guest_invitations
            SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(nowIso, user.id, nowIso, user.tenantId, invitation.id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'guest.revoke',
        targetType: 'guest_invitation',
        targetId: invitation.id,
        metadata: {
          email: invitation.email,
          guestUserId: invitation.user_id,
          targetType: invitation.target_type,
          targetId: invitation.target_id,
          role: invitation.role,
          previousStatus: invitation.status,
        },
        nowIso,
      }),
    ];

    if (invitation.user_id) {
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM permissions
            WHERE tenant_id = ? AND target_type = ? AND target_id = ?
              AND grantee_type = 'user' AND grantee_id = ?`
        ).bind(
          user.tenantId,
          invitation.target_type,
          invitation.target_id,
          invitation.user_id
        ),
        c.env.DB.prepare(
          `UPDATE sessions SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        ).bind(nowIso, user.tenantId, invitation.user_id),
        c.env.DB.prepare(
          `UPDATE users SET status = 'suspended', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
        ).bind(nowIso, user.tenantId, invitation.user_id)
      );
    }

    await c.env.DB.batch(statements);
    const updated = await loadGuestInvitation(c.env.DB, user.tenantId, invitation.id);
    return c.json({
      ok: true,
      invitation: updated ? projectGuestInvitation(updated) : null,
      notice: '招待を取り消し、ゲストの有効セッションを失効させました。',
    });
  });

  /* ----------------------------------------------------------------------- */
  /* P10-2 / TOM-60 guest detail summary                                      */
  /* ----------------------------------------------------------------------- */

  /**
   * GET /api/guests/:userId/summary — internal collaborator view of one guest.
   *
   * The projection itself lives in `services/guest-detail.ts` so the admin
   * governance API and this collaboration summary never drift (and so neither can
   * accidentally expose R2 keys, signed URLs, file bytes or raw tokens).
   *
   * Visibility is intentionally narrow: tenant admins, the original inviter, or
   * a member holding `permission.view` on at least one resource shared with the
   * guest.
   */
  routes.get('/:userId/summary', async (c) => {
    const caller = getAuthenticatedUser(c);
    const guestUserId = c.req.param('userId');
    const detail = await loadGuestDetail(c.env.DB, caller.tenantId, guestUserId);
    if (!detail) {
      return c.json(
        { error: 'Guest account not found', code: 'GUEST_NOT_FOUND' },
        404
      );
    }

    let authorized =
      caller.role === 'sys_admin' || caller.role === 'sec_admin';
    if (!authorized) {
      authorized = detail.invitations.some(
        (invitation) => invitation.invitedBy === caller.id
      );
    }
    if (!authorized) {
      const targets = new Map<
        string,
        { targetType: 'folder' | 'file'; targetId: string }
      >();
      for (const invitation of detail.invitations) {
        targets.set(`${invitation.targetType}:${invitation.targetId}`, {
          targetType: invitation.targetType,
          targetId: invitation.targetId,
        });
      }
      for (const item of detail.sharedItems) {
        targets.set(`${item.itemType}:${item.id}`, {
          targetType: item.itemType,
          targetId: item.id,
        });
      }
      for (const target of targets.values()) {
        const access = await resolveTargetAccess(
          c.env.DB,
          caller,
          target.targetType,
          target.targetId
        );
        if (
          access &&
          access.deletedAt === null &&
          can(access.capabilities, 'permission.view')
        ) {
          authorized = true;
          break;
        }
      }
    }
    if (!authorized) {
      return c.json(
        {
          error: 'Forbidden: guest summary requires resource visibility',
          code: 'FORBIDDEN',
        },
        403
      );
    }

    return c.json({
      guest: {
        id: detail.guest.id,
        email: detail.guest.email,
        displayName: detail.guest.displayName,
        userType: detail.guest.userType,
        externalOrg: detail.guest.externalOrg,
        status: detail.guest.status,
        expiresAt: detail.guest.expiresAt,
        lastLoginAt: detail.guest.lastLoginAt,
        invitedBy: detail.guest.invitedBy,
        invitedByName: detail.guest.invitedByName,
      },
      invitations: detail.invitations,
      effectivePermissions: detail.effectivePermissions,
      sharedItems: detail.sharedItems,
      guestPolicy: {
        allowExternalCollaborators: detail.guestPolicy.allowExternalCollaborators,
        externalDomainAllowlist: detail.guestPolicy.externalDomainAllowlist,
        allowGuestElevatedRoles: detail.guestPolicy.allowGuestElevatedRoles,
        guestGrantableRoles: detail.guestPolicy.guestGrantableRoles,
        guestInvitationExpiryDays: detail.guestPolicy.guestInvitationExpiryDays,
      },
      accessSummary: detail.accessSummary,
    });
  });
}
