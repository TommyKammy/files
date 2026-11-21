import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import {
  areAdvancedRolesEnabled,
  getAuthenticatedUser,
} from '../../services/authorization';
import { isResourceRole } from '../../services/capabilities';
import { generateRandomToken, sha256Hex } from '../../services/crypto-utils';
import {
  guestRoleRestriction,
  isGuestEmailDomainAllowed,
} from '../../services/external-guests';
import {
  loadGuestInvitation,
  projectGuestInvitation,
} from '../../services/guest-detail';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  VALID_TARGET_TYPES,
  authorizeInvitationTarget,
  mailErrorResponse,
  normalizeEmail,
  sendInvitationMail,
  type GuestUserRow,
} from './shared';

export function registerGuestInviteRoutes(routes: Hono<OidcHonoEnv>) {
  /** POST /api/guests/invitations — create a guest account + single-use invitation. */
  routes.post('/invitations', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      email?: unknown;
      displayName?: unknown;
      externalOrg?: unknown;
      targetType?: unknown;
      targetId?: unknown;
      role?: unknown;
    } | null;

    if (!body) return c.json({ error: 'JSON body required' }, 400);

    const email = normalizeEmail(body.email);
    if (!email) {
      return c.json(
        { error: 'email must be a valid email address', code: 'INVALID_EMAIL' },
        400
      );
    }
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim().slice(0, 120)
        : email.split('@')[0];
    const externalOrg =
      typeof body.externalOrg === 'string' && body.externalOrg.trim()
        ? body.externalOrg.trim().slice(0, 120)
        : null;
    if (
      typeof body.targetType !== 'string' ||
      !VALID_TARGET_TYPES.has(body.targetType) ||
      typeof body.targetId !== 'string' ||
      !body.targetId.trim()
    ) {
      return c.json({ error: 'targetType and targetId are required' }, 400);
    }
    if (typeof body.role !== 'string' || !isResourceRole(body.role)) {
      return c.json({ error: 'Invalid role' }, 400);
    }

    const targetType = body.targetType as 'folder' | 'file';
    const targetId = body.targetId.trim();
    const role = body.role as ResourceRole;

    const auth = await authorizeInvitationTarget(
      c.env.DB,
      user,
      targetType,
      targetId,
      role
    );
    if (!auth.ok) {
      return c.json(
        { error: auth.error, ...(auth.code ? { code: auth.code } : {}) },
        auth.status
      );
    }
    const policy = auth.policy!;

    // Domain allowlist is fail-closed: an empty list rejects every domain.
    if (!isGuestEmailDomainAllowed(email, policy.externalDomainAllowlist)) {
      return c.json(
        {
          error: 'This external email domain is not on the guest domain allowlist',
          code: 'EXTERNAL_DOMAIN_NOT_ALLOWED',
        },
        403
      );
    }

    const roleError = guestRoleRestriction(role, {
      allowGuestElevatedRoles: policy.allowGuestElevatedRoles,
      advancedRolesEnabled: await areAdvancedRolesEnabled(c.env.DB, user.tenantId),
      targetType,
    });
    if (roleError) {
      return c.json({ error: roleError.message, code: roleError.code }, roleError.status);
    }

    const existingUser = await c.env.DB.prepare(
      `SELECT id, email, display_name, user_type, status, expires_at
         FROM users WHERE tenant_id = ? AND email = ?`
    )
      .bind(user.tenantId, email)
      .first<GuestUserRow>();

    if (existingUser && existingUser.user_type !== 'guest') {
      return c.json(
        {
          error: 'An internal member already uses this email address',
          code: 'EMAIL_ALREADY_MEMBER',
        },
        409
      );
    }

    const target = await c.env.DB.prepare(
      targetType === 'folder'
        ? 'SELECT name FROM folders WHERE tenant_id = ? AND id = ?'
        : 'SELECT name FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, targetId)
      .first<{ name: string }>();
    if (!target) {
      return c.json({ error: 'Target resource not found' }, 404);
    }

    const nowIso = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + policy.guestInvitationExpiryDays * 24 * 3600 * 1000
    ).toISOString();
    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const invitationId = crypto.randomUUID();
    const guestUserId = existingUser?.id ?? crypto.randomUUID();

    const statements: D1PreparedStatement[] = [];
    if (existingUser) {
      statements.push(
        c.env.DB.prepare(
          `UPDATE users
              SET display_name = ?, external_org = ?, invited_by = ?,
                  expires_at = ?, status = 'active', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
        ).bind(
          displayName,
          externalOrg,
          user.id,
          expiresAt,
          nowIso,
          user.tenantId,
          guestUserId
        ),
        // A new invitation supersedes any previous pending token for this guest.
        c.env.DB.prepare(
          `UPDATE guest_invitations
              SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
            WHERE tenant_id = ? AND user_id = ? AND status = 'pending'`
        ).bind(nowIso, user.id, nowIso, user.tenantId, guestUserId)
      );
    } else {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO users (
             id, tenant_id, email, display_name, role, status, user_type,
             external_org, invited_by, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'member', 'active', 'guest', ?, ?, ?, ?, ?)`
        ).bind(
          guestUserId,
          user.tenantId,
          email,
          displayName,
          externalOrg,
          user.id,
          expiresAt,
          nowIso,
          nowIso
        )
      );
    }

    statements.push(
      c.env.DB.prepare(
        `INSERT INTO guest_invitations (
           id, tenant_id, user_id, email, display_name, external_org, invited_by,
           token_hash, target_type, target_id, role, status, expires_at,
           resend_count, last_sent_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)`
      ).bind(
        invitationId,
        user.tenantId,
        guestUserId,
        email,
        displayName,
        externalOrg,
        user.id,
        tokenHash,
        targetType,
        targetId,
        role,
        expiresAt,
        nowIso,
        nowIso,
        nowIso
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'guest.invite',
        targetType: 'guest_invitation',
        targetId: invitationId,
        metadata: {
          email,
          externalOrg,
          guestUserId,
          targetType,
          targetId,
          role,
          expiresAt,
        },
        nowIso,
      })
    );

    await c.env.DB.batch(statements);

    try {
      await sendInvitationMail(
        c,
        user.tenantId,
        {
          id: invitationId,
          email,
          display_name: displayName,
          external_org: externalOrg,
          target_type: targetType,
          target_name: target.name,
          expires_at: expiresAt,
        },
        rawToken,
        tokenHash
      );
    } catch (err) {
      return mailErrorResponse(c, err);
    }

    const created = await loadGuestInvitation(c.env.DB, user.tenantId, invitationId);
    return c.json(
      {
        invitation: created ? projectGuestInvitation(created) : null,
        notice: `外部ゲスト「${displayName}」へ招待メールを送信しました。有効期限は ${expiresAt} です。`,
      },
      201
    );
  });

  /** POST /api/guests/invitations/:id/resend — rotate the token and resend. */
  routes.post('/invitations/:id/resend', async (c) => {
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

    if (invitation.status !== 'pending') {
      return c.json(
        {
          error: `Guest invitation is ${invitation.status} and cannot be resent`,
          code:
            invitation.status === 'expired'
              ? 'INVITATION_EXPIRED'
              : 'INVITATION_NOT_PENDING',
        },
        invitation.status === 'expired' ? 410 : 409
      );
    }
    if (invitation.expires_at <= new Date().toISOString()) {
      await c.env.DB.prepare(
        `UPDATE guest_invitations SET status = 'expired', updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
        .bind(new Date().toISOString(), user.tenantId, invitation.id)
        .run();
      return c.json(
        { error: 'Guest invitation has expired', code: 'INVITATION_EXPIRED' },
        410
      );
    }

    const guest = invitation.user_id
      ? await c.env.DB.prepare(
          `SELECT status, expires_at FROM users
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
        )
          .bind(user.tenantId, invitation.user_id)
          .first<{ status: string; expires_at: string | null }>()
      : null;
    if (
      !guest ||
      guest.status !== 'active' ||
      (guest.expires_at && guest.expires_at <= new Date().toISOString())
    ) {
      return c.json(
        { error: 'Guest account is no longer active', code: 'GUEST_ACCOUNT_INACTIVE' },
        403
      );
    }
    if (
      !isGuestEmailDomainAllowed(invitation.email, auth.policy!.externalDomainAllowlist)
    ) {
      return c.json(
        {
          error: 'This external email domain is not on the guest domain allowlist',
          code: 'EXTERNAL_DOMAIN_NOT_ALLOWED',
        },
        403
      );
    }

    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE guest_invitations
            SET token_hash = ?, resend_count = resend_count + 1, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'pending'`
      ).bind(tokenHash, nowIso, user.tenantId, invitation.id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'guest.resend',
        targetType: 'guest_invitation',
        targetId: invitation.id,
        metadata: {
          email: invitation.email,
          resend: true,
          resendCount: invitation.resend_count + 1,
          externalOrg: invitation.external_org,
        },
        nowIso,
      }),
    ]);

    try {
      await sendInvitationMail(
        c,
        user.tenantId,
        {
          id: invitation.id,
          email: invitation.email,
          display_name: invitation.display_name,
          external_org: invitation.external_org,
          target_type: invitation.target_type,
          target_name: invitation.target_name,
          expires_at: invitation.expires_at,
        },
        rawToken,
        tokenHash
      );
    } catch (err) {
      return mailErrorResponse(c, err);
    }

    const updated = await loadGuestInvitation(c.env.DB, user.tenantId, invitation.id);
    return c.json({
      invitation: updated ? projectGuestInvitation(updated) : null,
      notice: `招待メールを再送しました（再送回数 ${
        updated?.resend_count ?? invitation.resend_count + 1
      } 回）。`,
    });
  });
}
