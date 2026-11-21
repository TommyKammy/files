import { Hono } from 'hono';
import {
  isLocalDevBypassAllowed,
  verifyRequestOriginForCsrf,
} from '../../../middleware/session-auth';
import { sha256Hex, timingSafeEqual } from '../../../services/crypto-utils';
import { guestSessionMaxAgeSeconds } from '../../../services/external-guests';
import { maskEmail, type DevMailSinkRow } from '../../../services/mail-provider';
import type { OidcHonoEnv } from '../../../types/oidc';
import { issueSessionForUser } from '../shared';
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_WINDOW,
  OTP_REQUEST_WINDOW_MS,
  createOtpChallenge,
  findGuestUserByEmail,
  loadGuestUser,
  mailErrorResponse,
  normalizeEmail,
  normalizeOtp,
  rateLimited,
  validateGuestEligibility,
  type GuestOtpChallengeRow,
} from './shared';

export function registerGuestOtpRoutes(routes: Hono<OidcHonoEnv>) {
  /** POST /auth/guest/otp/request — re-issue a login OTP with D1 rate limiting. */
  routes.post('/auth/guest/otp/request', async (c) => {
    const csrfError = verifyRequestOriginForCsrf(c);
    if (csrfError) return csrfError;

    const body = (await c.req.json().catch(() => null)) as {
      email?: unknown;
      tenantId?: unknown;
    } | null;
    const email = normalizeEmail(body?.email);
    if (!email) {
      return c.json({ error: 'email must be a valid email address' }, 400);
    }
    const tenantId =
      typeof body?.tenantId === 'string' && body.tenantId.trim()
        ? body.tenantId.trim()
        : undefined;

    const guest = await findGuestUserByEmail(c.env.DB, email, tenantId);
    if (!guest) {
      return c.json(
        { error: 'Guest account not found', code: 'GUEST_ACCOUNT_NOT_FOUND' },
        404
      );
    }
    const eligibility = await validateGuestEligibility(c.env.DB, guest, {
      requireAcceptedInvitation: true,
    });
    if (!eligibility.ok) {
      return c.json(
        { error: eligibility.error, code: eligibility.code },
        eligibility.status ?? 403
      );
    }

    const windowStart = new Date(Date.now() - OTP_REQUEST_WINDOW_MS).toISOString();
    const recent = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt, MIN(created_at) AS first_created_at
         FROM guest_otp_challenges
        WHERE tenant_id = ? AND email = ? AND created_at >= ?`
    )
      .bind(guest.tenant_id, guest.email, windowStart)
      .first<{ cnt: number; first_created_at: string | null }>();
    if ((recent?.cnt ?? 0) >= OTP_MAX_REQUESTS_PER_WINDOW) {
      const first = recent?.first_created_at
        ? Date.parse(recent.first_created_at)
        : Date.now();
      const retryAfter = Math.max(
        1,
        Math.ceil((first + OTP_REQUEST_WINDOW_MS - Date.now()) / 1000)
      );
      return rateLimited(
        c,
        retryAfter,
        'Too many verification code requests. Please wait before retrying.'
      );
    }

    let challenge: { expiresAt: string };
    try {
      challenge = await createOtpChallenge(c, guest, 'login');
    } catch (err) {
      return mailErrorResponse(c, err);
    }

    return c.json({
      ok: true,
      email: guest.email,
      emailMasked: maskEmail(guest.email),
      otpExpiresAt: challenge.expiresAt,
    });
  });

  /** POST /auth/guest/otp/verify — single-use OTP verification + guest session. */
  routes.post('/auth/guest/otp/verify', async (c) => {
    const csrfError = verifyRequestOriginForCsrf(c);
    if (csrfError) return csrfError;

    const body = (await c.req.json().catch(() => null)) as {
      email?: unknown;
      otp?: unknown;
      tenantId?: unknown;
    } | null;
    const email = normalizeEmail(body?.email);
    const otp = normalizeOtp(body?.otp);
    if (!email || !otp) {
      return c.json(
        { error: 'email and a 6-digit otp are required', code: 'INVALID_OTP_INPUT' },
        400
      );
    }
    const tenantId =
      typeof body?.tenantId === 'string' && body.tenantId.trim()
        ? body.tenantId.trim()
        : undefined;

    const challenge = await c.env.DB.prepare(
      `SELECT * FROM guest_otp_challenges
        WHERE email = ? ${tenantId ? 'AND tenant_id = ?' : ''}
          AND consumed_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`
    )
      .bind(...(tenantId ? [email, tenantId] : [email]))
      .first<GuestOtpChallengeRow>();

    if (!challenge) {
      return c.json(
        { error: 'No active verification code was found', code: 'OTP_NOT_FOUND' },
        401
      );
    }
    if (challenge.expires_at <= new Date().toISOString()) {
      return c.json(
        { error: 'The verification code has expired', code: 'OTP_EXPIRED' },
        410
      );
    }
    if (challenge.attempt_count >= OTP_MAX_ATTEMPTS) {
      return rateLimited(
        c,
        OTP_MAX_ATTEMPTS * 60,
        'Too many incorrect verification code attempts. Request a new code later.'
      );
    }

    const expectedHash = await sha256Hex(`${challenge.id}:${otp}`);
    if (!timingSafeEqual(expectedHash, challenge.otp_hash)) {
      const updated = await c.env.DB.prepare(
        `UPDATE guest_otp_challenges
            SET attempt_count = attempt_count + 1
          WHERE id = ? AND consumed_at IS NULL
          RETURNING attempt_count`
      )
        .bind(challenge.id)
        .first<{ attempt_count: number }>();
      const attempts = updated?.attempt_count ?? challenge.attempt_count + 1;
      if (attempts >= OTP_MAX_ATTEMPTS) {
        return rateLimited(
          c,
          OTP_MAX_ATTEMPTS * 60,
          'Too many incorrect verification code attempts. Request a new code later.'
        );
      }
      return c.json(
        {
          error: 'Incorrect verification code',
          code: 'INVALID_OTP',
          attemptsRemaining: OTP_MAX_ATTEMPTS - attempts,
        },
        401
      );
    }

    const nowIso = new Date().toISOString();
    const consumed = await c.env.DB.prepare(
      `UPDATE guest_otp_challenges SET consumed_at = ?
        WHERE id = ? AND consumed_at IS NULL
        RETURNING id`
    )
      .bind(nowIso, challenge.id)
      .first<{ id: string }>();
    if (!consumed) {
      return c.json(
        { error: 'The verification code has already been used', code: 'OTP_ALREADY_USED' },
        401
      );
    }

    const guest = await loadGuestUser(c.env.DB, challenge.tenant_id, challenge.user_id);
    if (!guest) {
      return c.json(
        { error: 'Guest account is no longer active', code: 'GUEST_ACCOUNT_INACTIVE' },
        403
      );
    }
    const eligibility = await validateGuestEligibility(c.env.DB, guest, {
      requireAcceptedInvitation: true,
    });
    if (!eligibility.ok) {
      return c.json(
        { error: eligibility.error, code: eligibility.code },
        eligibility.status ?? 403
      );
    }

    const maxAgeSeconds = guestSessionMaxAgeSeconds(
      Date.now(),
      eligibility.policy!.guestSessionMaxHours,
      guest.expires_at
    );
    if (maxAgeSeconds === null) {
      return c.json(
        { error: 'Guest account has expired', code: 'GUEST_ACCOUNT_EXPIRED' },
        403
      );
    }

    await c.env.DB.prepare(
      `UPDATE users SET last_login_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
    )
      .bind(nowIso, nowIso, guest.tenant_id, guest.id)
      .run();

    const ipAddress = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
    await issueSessionForUser(c, {
      tenantId: guest.tenant_id,
      userId: guest.id,
      email: guest.email,
      ipAddress,
      auditAction: 'guest.login',
      auditMetadata: {
        purpose: challenge.purpose,
        externalOrg: guest.external_org,
        guestExpiresAt: guest.expires_at,
        sessionMaxAgeSeconds: maxAgeSeconds,
      },
      maxAgeSeconds,
    });

    return c.json({
      ok: true,
      user: {
        id: guest.id,
        tenantId: guest.tenant_id,
        email: guest.email,
        displayName: guest.display_name,
        role: 'member',
        userType: 'guest',
        externalOrg: guest.external_org,
        expiresAt: guest.expires_at,
      },
    });
  });

  /**
   * GET /auth/dev-guest-mails — local-only mail sink reader. This must never
   * expose tokens outside `isLocalDevBypassAllowed` (it returns 404 otherwise).
   */
  routes.get('/auth/dev-guest-mails', async (c) => {
    if (!isLocalDevBypassAllowed(c)) {
      return c.json({ error: 'Not Found' }, 404);
    }

    const tenantId = (
      c.req.query('tenant') ??
      c.env.DEFAULT_TENANT_ID ??
      'tenant-default'
    ).trim();
    const to = c.req.query('to')?.trim().toLowerCase();
    const kind = c.req.query('kind');
    const filters = ['tenant_id = ?'];
    const bindings: unknown[] = [tenantId];
    if (to) {
      filters.push('to_email = ?');
      bindings.push(to);
    }
    if (kind === 'guest_invitation' || kind === 'guest_otp') {
      filters.push('kind = ?');
      bindings.push(kind);
    }

    const rows = await c.env.DB.prepare(
      `SELECT * FROM guest_mail_sink
        WHERE ${filters.join(' AND ')}
        ORDER BY created_at DESC, rowid DESC
        LIMIT 50`
    )
      .bind(...bindings)
      .all<DevMailSinkRow>();

    return c.json({
      mails: rows.results.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        kind: row.kind,
        to: row.to_email,
        subject: row.subject,
        text: row.body_text,
        token: row.token,
        otpCode: row.otp_code,
        acceptUrl: row.accept_url,
        createdAt: row.created_at,
      })),
    });
  });
}
