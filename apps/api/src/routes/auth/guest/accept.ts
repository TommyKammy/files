import { Hono } from 'hono';
import { verifyRequestOriginForCsrf } from '../../../middleware/session-auth';
import { loadTenantBranding } from '../../../services/branding';
import {
  enforceIpAllowlistForTenant,
  resolveGuestAuthTenantId,
} from '../../../services/ip-allowlist';
import { maskEmail } from '../../../services/mail-provider';
import type { OidcHonoEnv } from '../../../types/oidc';
import { recordAuthAudit } from '../shared';
import {
  createOtpChallenge,
  loadGuestUser,
  loadInvitationByToken,
  mailErrorResponse,
  projectInviteMeta,
  validateGuestEligibility,
} from './shared';

export function registerGuestAcceptRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * TOM-66 all_access enforcement for anonymous guest authentication. The
   * tenant is resolved from the invitation token or guest email before the
   * route consumes anything, then the normal handler still validates the
   * token/OTP exactly as before.
   */
  routes.use('/auth/guest/*', async (c, next) => {
    let token = c.req.query('token');
    let email: string | undefined;
    let tenantId: string | undefined;

    if (!token) {
      const body = (await c.req.json().catch(() => null)) as {
        token?: unknown;
        email?: unknown;
        tenantId?: unknown;
      } | null;
      token = typeof body?.token === 'string' ? body.token : undefined;
      email = typeof body?.email === 'string' ? body.email : undefined;
      tenantId =
        typeof body?.tenantId === 'string' ? body.tenantId.trim() : undefined;
    }

    const resolvedTenantId = await resolveGuestAuthTenantId(c.env.DB, {
      token,
      email,
      tenantId,
    });
    if (resolvedTenantId) {
      const blocked = await enforceIpAllowlistForTenant(c, {
        tenantId: resolvedTenantId,
        kind: 'guest_auth',
      });
      if (blocked) return blocked;
    }

    await next();
  });

  /** GET /auth/guest/invite-meta?token=... — non-consuming invitation preview. */
  routes.get('/auth/guest/invite-meta', async (c) => {
    const rawToken = c.req.query('token') ?? '';
    const invitation = await loadInvitationByToken(c.env.DB, rawToken);
    if (!invitation) {
      return c.json(
        { error: 'Guest invitation not found', code: 'INVITATION_NOT_FOUND' },
        404
      );
    }

    const tenant = await c.env.DB.prepare('SELECT name FROM tenants WHERE id = ?')
      .bind(invitation.tenant_id)
      .first<{ name: string }>();

    if (
      invitation.status === 'pending' &&
      invitation.expires_at <= new Date().toISOString()
    ) {
      await c.env.DB.prepare(
        `UPDATE guest_invitations SET status = 'expired', updated_at = ?
          WHERE id = ? AND status = 'pending'`
      )
        .bind(new Date().toISOString(), invitation.id)
        .run();
      invitation.status = 'expired';
    }

    const guest = invitation.user_id
      ? await loadGuestUser(c.env.DB, invitation.tenant_id, invitation.user_id)
      : null;
    const eligibility = guest
      ? await validateGuestEligibility(c.env.DB, guest)
      : { ok: false, code: 'GUEST_ACCOUNT_INACTIVE', error: 'Guest account not found' };
    const branding = await loadTenantBranding(c.env.DB, invitation.tenant_id);

    return c.json({
      invitation: {
        ...projectInviteMeta(invitation),
        tenantName: branding.orgName ?? tenant?.name ?? invitation.tenant_id,
        canAccept: invitation.status === 'pending' && eligibility.ok === true,
        reason: eligibility.ok ? null : eligibility.code,
        branding,
      },
    });
  });

  /**
   * POST /auth/guest/accept — consume the invitation exactly once, then issue a
   * fresh email OTP. The raw invitation token is never reusable afterwards.
   */
  routes.post('/auth/guest/accept', async (c) => {
    const csrfError = verifyRequestOriginForCsrf(c);
    if (csrfError) return csrfError;

    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null;
    const rawToken = typeof body?.token === 'string' ? body.token : '';
    const invitation = await loadInvitationByToken(c.env.DB, rawToken);
    if (!invitation) {
      return c.json(
        { error: 'Guest invitation not found', code: 'INVITATION_NOT_FOUND' },
        404
      );
    }

    if (invitation.status === 'accepted') {
      return c.json(
        { error: 'This invitation has already been used', code: 'INVITATION_ALREADY_USED' },
        410
      );
    }
    if (invitation.status === 'revoked') {
      return c.json(
        { error: 'This invitation has been revoked', code: 'INVITATION_REVOKED' },
        410
      );
    }
    if (invitation.status === 'expired' || invitation.expires_at <= new Date().toISOString()) {
      await c.env.DB.prepare(
        `UPDATE guest_invitations SET status = 'expired', updated_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'pending'`
      )
        .bind(new Date().toISOString(), invitation.tenant_id, invitation.id)
        .run();
      return c.json(
        { error: 'This invitation has expired', code: 'INVITATION_EXPIRED' },
        410
      );
    }
    if (!invitation.user_id) {
      return c.json(
        { error: 'Guest account is no longer active', code: 'GUEST_ACCOUNT_INACTIVE' },
        403
      );
    }

    const guest = await loadGuestUser(
      c.env.DB,
      invitation.tenant_id,
      invitation.user_id
    );
    if (!guest) {
      return c.json(
        { error: 'Guest account is no longer active', code: 'GUEST_ACCOUNT_INACTIVE' },
        403
      );
    }
    const eligibility = await validateGuestEligibility(c.env.DB, guest);
    if (!eligibility.ok) {
      return c.json({ error: eligibility.error, code: eligibility.code }, 403);
    }

    const nowIso = new Date().toISOString();
    const consumed = await c.env.DB.prepare(
      `UPDATE guest_invitations
          SET status = 'accepted', accepted_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND status = 'pending'
        RETURNING id`
    )
      .bind(nowIso, nowIso, invitation.tenant_id, invitation.id)
      .first<{ id: string }>();
    if (!consumed) {
      return c.json(
        { error: 'This invitation has already been used', code: 'INVITATION_ALREADY_USED' },
        410
      );
    }

    // Access is granted only when the invitation is consumed. Pending,
    // revoked or expired invitations therefore never leave a live permission.
    await c.env.DB.prepare(
      `INSERT INTO permissions (
         id, tenant_id, target_type, target_id, grantee_type, grantee_id,
         role, granted_by, created_at
       ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)
       ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
       DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`
    )
      .bind(
        crypto.randomUUID(),
        invitation.tenant_id,
        invitation.target_type,
        invitation.target_id,
        guest.id,
        invitation.role,
        invitation.invited_by,
        nowIso
      )
      .run();

    let challenge: { expiresAt: string };
    await recordAuthAudit(c.env.DB, {
      tenantId: invitation.tenant_id,
      actorId: guest.id,
      actorEmail: guest.email,
      actorIp: c.req.header('CF-Connecting-IP') ?? '127.0.0.1',
      action: 'guest.accept',
      targetId: invitation.id,
      status: 'allowed',
      metadata: {
        targetType: invitation.target_type,
        targetId: invitation.target_id,
        role: invitation.role,
        externalOrg: guest.external_org,
        guestUserId: guest.id,
      },
    });
    try {
      challenge = await createOtpChallenge(c, guest, 'accept');
    } catch (err) {
      return mailErrorResponse(c, err);
    }

    return c.json({
      ok: true,
      email: guest.email,
      emailMasked: maskEmail(guest.email),
      targetName: invitation.target_name,
      otpExpiresAt: challenge.expiresAt,
    });
  });
}
