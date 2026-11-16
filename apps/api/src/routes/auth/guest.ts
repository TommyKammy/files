import { Hono, type Context } from 'hono';
import {
  isLocalDevBypassAllowed,
  verifyRequestOriginForCsrf,
} from '../../middleware/session-auth';
import { generateRandomToken, sha256Hex, timingSafeEqual } from '../../services/crypto-utils';
import {
  generateSixDigitOtp,
  getGuestPolicy,
  guestSessionMaxAgeSeconds,
  isGuestEmailDomainAllowed,
} from '../../services/external-guests';
import {
  MailDeliveryError,
  MailProviderConfigurationError,
  maskEmail,
  resolveMailProvider,
  type DevMailSinkRow,
} from '../../services/mail-provider';
import type { OidcHonoEnv } from '../../types/oidc';
import { issueSessionForUser, recordAuthAudit } from './shared';

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_REQUEST_WINDOW_MS = 10 * 60 * 1000;
const OTP_MAX_REQUESTS_PER_WINDOW = 5;
const OTP_MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface GuestInvitationAuthRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  email: string;
  display_name: string;
  external_org: string | null;
  invited_by: string;
  target_type: 'folder' | 'file';
  target_id: string;
  role: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  accepted_at: string | null;
  target_name: string | null;
  inviter_name: string | null;
}

interface GuestUserAuthRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  status: 'active' | 'suspended';
  user_type: 'member' | 'guest';
  external_org: string | null;
  expires_at: string | null;
}

interface GuestOtpChallengeRow {
  id: string;
  tenant_id: string;
  user_id: string;
  email: string;
  otp_hash: string;
  purpose: 'accept' | 'login';
  expires_at: string;
  attempt_count: number;
  consumed_at: string | null;
  created_at: string;
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 254 || !EMAIL_RE.test(value)) return null;
  return value;
}

function normalizeOtp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return /^\d{6}$/.test(value) ? value : null;
}

function rateLimited(
  c: Context<OidcHonoEnv>,
  retryAfterSeconds: number,
  message = 'Too many guest authentication attempts'
): Response {
  c.header('Retry-After', String(Math.max(1, retryAfterSeconds)));
  return c.json(
    {
      error: message,
      code: 'GUEST_AUTH_RATE_LIMITED',
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    },
    429
  );
}

function mailErrorResponse(c: Context<OidcHonoEnv>, err: unknown): Response {
  if (err instanceof MailProviderConfigurationError) {
    return c.json(
      {
        error: 'Mail provider is not configured for guest authentication',
        code: 'MAIL_PROVIDER_NOT_CONFIGURED',
      },
      503
    );
  }
  if (err instanceof MailDeliveryError) {
    return c.json(
      { error: 'Failed to deliver the guest email', code: 'MAIL_DELIVERY_FAILED' },
      502
    );
  }
  throw err;
}

async function loadInvitationByToken(
  db: D1Database,
  rawToken: string
): Promise<GuestInvitationAuthRow | null> {
  if (!rawToken || rawToken.length < 16) return null;
  const tokenHash = await sha256Hex(rawToken);
  return db
    .prepare(
      `SELECT gi.*,
              COALESCE(f.name, fl.name) AS target_name,
              inviter.display_name AS inviter_name
         FROM guest_invitations gi
         LEFT JOIN folders f
           ON gi.target_type = 'folder' AND f.tenant_id = gi.tenant_id AND f.id = gi.target_id
         LEFT JOIN files fl
           ON gi.target_type = 'file' AND fl.tenant_id = gi.tenant_id AND fl.id = gi.target_id
         LEFT JOIN users inviter ON inviter.id = gi.invited_by
        WHERE gi.token_hash = ?`
    )
    .bind(tokenHash)
    .first<GuestInvitationAuthRow>();
}

async function loadGuestUser(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<GuestUserAuthRow | null> {
  return db
    .prepare(
      `SELECT id, tenant_id, email, display_name, status, user_type,
              external_org, expires_at
         FROM users
        WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
    )
    .bind(tenantId, userId)
    .first<GuestUserAuthRow>();
}

async function findGuestUserByEmail(
  db: D1Database,
  email: string,
  tenantId?: string
): Promise<GuestUserAuthRow | null> {
  if (tenantId) {
    return db
      .prepare(
        `SELECT id, tenant_id, email, display_name, status, user_type,
                external_org, expires_at
           FROM users
          WHERE tenant_id = ? AND email = ? AND user_type = 'guest'`
      )
      .bind(tenantId, email)
      .first<GuestUserAuthRow>();
  }
  return db
    .prepare(
      `SELECT id, tenant_id, email, display_name, status, user_type,
              external_org, expires_at
         FROM users
        WHERE email = ? AND user_type = 'guest'
        ORDER BY created_at DESC, id ASC
        LIMIT 1`
    )
    .bind(email)
    .first<GuestUserAuthRow>();
}

interface GuestEligibility {
  ok: boolean;
  status?: 403;
  code?: string;
  error?: string;
  policy?: Awaited<ReturnType<typeof getGuestPolicy>>;
}

/**
 * Revalidate the tenant policy, domain allowlist, guest account status and
 * expiry on every accept / request / verify step. A policy change therefore
 * invalidates in-flight authentication attempts immediately.
 */
async function validateGuestEligibility(
  db: D1Database,
  guest: GuestUserAuthRow,
  options: { requireAcceptedInvitation?: boolean } = {}
): Promise<GuestEligibility> {
  const policy = await getGuestPolicy(db, guest.tenant_id);
  if (!policy.allowExternalCollaborators) {
    return {
      ok: false,
      status: 403,
      code: 'EXTERNAL_COLLABORATORS_DISABLED',
      error: 'External collaborators are disabled for this tenant',
    };
  }
  if (!isGuestEmailDomainAllowed(guest.email, policy.externalDomainAllowlist)) {
    return {
      ok: false,
      status: 403,
      code: 'EXTERNAL_DOMAIN_NOT_ALLOWED',
      error: 'This external email domain is not on the guest domain allowlist',
    };
  }
  if (guest.status !== 'active') {
    return {
      ok: false,
      status: 403,
      code: 'GUEST_ACCOUNT_INACTIVE',
      error: 'Guest account is suspended',
    };
  }
  if (guest.expires_at && guest.expires_at <= new Date().toISOString()) {
    return {
      ok: false,
      status: 403,
      code: 'GUEST_ACCOUNT_EXPIRED',
      error: 'Guest account has expired',
    };
  }
  if (options.requireAcceptedInvitation) {
    const accepted = await db
      .prepare(
        `SELECT 1 AS accepted FROM guest_invitations
          WHERE tenant_id = ? AND user_id = ? AND status = 'accepted'
          LIMIT 1`
      )
      .bind(guest.tenant_id, guest.id)
      .first<{ accepted: number }>();
    if (!accepted) {
      return {
        ok: false,
        status: 403,
        code: 'INVITATION_NOT_ACCEPTED',
        error: 'The guest invitation has not been accepted yet',
      };
    }
  }
  return { ok: true, policy };
}

async function createOtpChallenge(
  c: Context<OidcHonoEnv>,
  guest: GuestUserAuthRow,
  purpose: 'accept' | 'login'
): Promise<{ expiresAt: string }> {
  const otp = generateSixDigitOtp();
  const challengeId = crypto.randomUUID();
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + OTP_TTL_MS).toISOString();
  const otpHash = await sha256Hex(`${challengeId}:${otp}`);

  await c.env.DB.prepare(
    `INSERT INTO guest_otp_challenges (
       id, tenant_id, user_id, email, otp_hash, purpose, expires_at,
       attempt_count, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(
      challengeId,
      guest.tenant_id,
      guest.id,
      guest.email,
      otpHash,
      purpose,
      expiresAt,
      createdAt
    )
    .run();

  const provider = resolveMailProvider(c.env);
  await provider.send({
    tenantId: guest.tenant_id,
    kind: 'guest_otp',
    to: guest.email,
    subject: '【Files】ゲストサインイン認証コード',
    text: [
      `${guest.display_name} 様`,
      '',
      purpose === 'accept'
        ? '外部ゲストコラボレーターの招待を承諾しました。以下の 6 桁の認証コードを入力してください。'
        : '以下の 6 桁の認証コードを入力してサインインしてください。',
      '',
      `認証コード: ${otp}`,
      `有効期限: ${expiresAt} (10 分間)`,
      '',
      'このコードは 1 回だけ使用できます。心当たりがない場合は破棄してください。',
    ].join('\n'),
    otpCode: otp,
  });

  return { expiresAt };
}

function projectInviteMeta(invitation: GuestInvitationAuthRow) {
  const expired =
    invitation.status === 'expired' ||
    (invitation.expires_at <= new Date().toISOString() &&
      invitation.status === 'pending');
  const status = expired ? 'expired' : invitation.status;
  return {
    id: invitation.id,
    status,
    valid: status === 'pending',
    expired,
    revoked: status === 'revoked',
    used: status === 'accepted',
    tenantName: invitation.tenant_id,
    emailMasked: maskEmail(invitation.email),
    displayName: invitation.display_name,
    externalOrg: invitation.external_org,
    targetType: invitation.target_type,
    targetName: invitation.target_name,
    role: invitation.role,
    expiresAt: invitation.expires_at,
    invitedByName: invitation.inviter_name,
    acceptedAt: invitation.accepted_at,
  };
}

export function registerGuestAuthRoutes(routes: Hono<OidcHonoEnv>) {
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

    return c.json({
      invitation: {
        ...projectInviteMeta(invitation),
        tenantName: tenant?.name ?? invitation.tenant_id,
        canAccept:
          invitation.status === 'pending' &&
          eligibility.ok === true,
        reason: eligibility.ok ? null : eligibility.code,
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
      },    });
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
