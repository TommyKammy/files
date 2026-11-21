import type { Context } from 'hono';
import { sha256Hex } from '../../../services/crypto-utils';
import {
  generateSixDigitOtp,
  getGuestPolicy,
  isGuestEmailDomainAllowed,
} from '../../../services/external-guests';
import {
  MailDeliveryError,
  MailProviderConfigurationError,
  maskEmail,
  resolveMailProvider,
} from '../../../services/mail-provider';
import type { OidcHonoEnv } from '../../../types/oidc';

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_REQUEST_WINDOW_MS = 10 * 60 * 1000;
export const OTP_MAX_REQUESTS_PER_WINDOW = 5;
export const OTP_MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface GuestInvitationAuthRow {
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

export interface GuestUserAuthRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  status: 'active' | 'suspended';
  user_type: 'member' | 'guest';
  external_org: string | null;
  expires_at: string | null;
}

export interface GuestOtpChallengeRow {
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

export interface GuestEligibility {
  ok: boolean;
  status?: 403;
  code?: string;
  error?: string;
  policy?: Awaited<ReturnType<typeof getGuestPolicy>>;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > 254 || !EMAIL_RE.test(value)) return null;
  return value;
}

export function normalizeOtp(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return /^\d{6}$/.test(value) ? value : null;
}

export function rateLimited(
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

export function mailErrorResponse(c: Context<OidcHonoEnv>, err: unknown): Response {
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

export async function loadInvitationByToken(
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

export async function loadGuestUser(
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

export async function findGuestUserByEmail(
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

/**
 * Revalidate the tenant policy, domain allowlist, guest account status and
 * expiry on every accept / request / verify step. A policy change therefore
 * invalidates in-flight authentication attempts immediately.
 */
export async function validateGuestEligibility(
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

export async function createOtpChallenge(
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

export function projectInviteMeta(invitation: GuestInvitationAuthRow) {
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
