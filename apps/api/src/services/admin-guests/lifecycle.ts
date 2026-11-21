import type { AuthUser, Env } from '../../types/api';
import {
  AdminBulkIdempotencyError,
  beginAdminBulkOperation,
  resolveIdempotencyKey,
  type IdempotencySession,
} from '../admin-bulk-idempotency';
import { buildAuditLogStmt } from '../audit';
import { generateRandomToken, sha256Hex } from '../crypto-utils';
import { getGuestPolicy, isGuestEmailDomainAllowed } from '../external-guests';
import { buildGuestInvitationMailPreview } from '../guest-collaboration';
import { loadGuestInvitation, type GuestInvitationRow } from '../guest-detail';
import {
  MailDeliveryError,
  MailProviderConfigurationError,
  resolveMailProvider,
} from '../mail-provider';
import { buildSyncChangeStmt } from '../sync-changes';
import { extractLastSyncSeq } from '../sync-notifier';
import { AdminGuestError } from './types';

export { AdminBulkIdempotencyError, resolveIdempotencyKey };

interface GuestAccountRow {
  id: string;
  email: string;
  display_name: string;
  external_org: string | null;
  status: 'active' | 'suspended';
  expires_at: string | null;
  offboarded_at: string | null;
  invited_by: string | null;
}

async function loadGuestAccount(
  db: D1Database,
  tenantId: string,
  guestId: string
): Promise<GuestAccountRow> {
  const guest = await db
    .prepare(
      `SELECT id, email, display_name, external_org, status, expires_at,
              offboarded_at, invited_by
         FROM users
        WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
    )
    .bind(tenantId, guestId)
    .first<GuestAccountRow>();
  if (!guest) {
    throw new AdminGuestError(
      404,
      'GUEST_NOT_FOUND',
      'Guest account not found'
    );
  }
  return guest;
}

function operationPayload(guestId: string, body?: unknown): unknown {
  return { guestId, body: body ?? null };
}

async function beginGuestOperation<T>(
  db: D1Database,
  tenantId: string,
  operation: string,
  guestId: string,
  idempotencyKey: string | null,
  body?: unknown
): Promise<IdempotencySession<T>> {
  return beginAdminBulkOperation<T>({
    db,
    tenantId,
    operation,
    idempotencyKey,
    payload: operationPayload(guestId, body),
  });
}

export async function suspendAdminGuest(input: {
  db: D1Database;
  tenantId: string;
  guestId: string;
  actor: AuthUser;
  idempotencyKey?: string | null;
}): Promise<Record<string, unknown>> {
  const { db, tenantId, guestId, actor } = input;
  const guest = await loadGuestAccount(db, tenantId, guestId);
  const session = await beginGuestOperation<Record<string, unknown>>(
    db,
    tenantId,
    'admin.guest.suspend',
    guestId,
    input.idempotencyKey ?? null
  );
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    if (guest.offboarded_at) {
      throw new AdminGuestError(
        409,
        'GUEST_OFFBOARDED',
        'Guest account has been offboarded'
      );
    }

    const nowIso = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = 'suspended', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
        )
        .bind(nowIso, tenantId, guestId),
      db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, tenantId, guestId),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.guest.suspend',
        targetType: 'user',
        targetId: guestId,
        metadata: {
          email: guest.email,
          externalOrg: guest.external_org,
          previousStatus: guest.status,
          previousExpiresAt: guest.expires_at,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: guestId,
        targetUserId: guestId,
        action: 'admin.guest.suspend',
        payload: { email: guest.email, status: 'suspended' },
        nowIso,
      }),
    ]);

    const response = {
      ok: true,
      guest: { id: guestId, status: 'suspended', offboardedAt: null },
      sessionsRevoked: results[1]?.meta.changes ?? 0,
      syncSeq: extractLastSyncSeq(results),
      notice: 'ゲストを停止し、すべての有効セッションを失効させました。',
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export async function resumeAdminGuest(input: {
  db: D1Database;
  tenantId: string;
  guestId: string;
  actor: AuthUser;
  expiresAt?: unknown;
  extendDays?: unknown;
  idempotencyKey?: string | null;
}): Promise<Record<string, unknown>> {
  const { db, tenantId, guestId, actor } = input;
  const guest = await loadGuestAccount(db, tenantId, guestId);
  const session = await beginGuestOperation<Record<string, unknown>>(
    db,
    tenantId,
    'admin.guest.resume',
    guestId,
    input.idempotencyKey ?? null,
    { expiresAt: input.expiresAt, extendDays: input.extendDays }
  );
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    if (guest.offboarded_at) {
      throw new AdminGuestError(
        409,
        'GUEST_OFFBOARDED',
        'Offboarded guest accounts cannot be resumed'
      );
    }

    let nextExpiresAt = guest.expires_at;
    if (input.expiresAt !== undefined) {
      if (
        typeof input.expiresAt !== 'string' ||
        Number.isNaN(Date.parse(input.expiresAt))
      ) {
        throw new AdminGuestError(
          400,
          'INVALID_GUEST_EXPIRY',
          'expiresAt must be a valid ISO 8601 timestamp'
        );
      }
      nextExpiresAt = new Date(input.expiresAt).toISOString();
      if (nextExpiresAt <= nowIso) {
        throw new AdminGuestError(
          400,
          'INVALID_GUEST_EXPIRY',
          'expiresAt must be in the future'
        );
      }
    } else if (input.extendDays !== undefined) {
      if (
        typeof input.extendDays !== 'number' ||
        !Number.isInteger(input.extendDays) ||
        input.extendDays < 1 ||
        input.extendDays > 3650
      ) {
        throw new AdminGuestError(
          400,
          'INVALID_GUEST_EXPIRY',
          'extendDays must be an integer between 1 and 3650'
        );
      }
      const baseMs = Math.max(
        Date.now(),
        guest.expires_at ? Date.parse(guest.expires_at) : 0
      );
      nextExpiresAt = new Date(
        baseMs + input.extendDays * 86_400_000
      ).toISOString();
    }

    if (
      guest.expires_at &&
      guest.expires_at <= nowIso &&
      nextExpiresAt === guest.expires_at
    ) {
      throw new AdminGuestError(
        409,
        'GUEST_ACCOUNT_EXPIRED',
        'Guest account has expired; provide expiresAt or extendDays to resume'
      );
    }

    const policy = await getGuestPolicy(db, tenantId);
    if (
      policy.externalDomainExistingGuestMode === 'suspend_existing' &&
      !isGuestEmailDomainAllowed(
        guest.email,
        policy.externalDomainAllowlist
      )
    ) {
      throw new AdminGuestError(
        409,
        'GUEST_DOMAIN_NOT_ALLOWED',
        'The guest domain is not on the external domain allowlist'
      );
    }

    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = 'active',
                  expires_at = ?,
                  expiring_notified_at = NULL,
                  updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'
              AND offboarded_at IS NULL`
        )
        .bind(nextExpiresAt, nowIso, tenantId, guestId),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.guest.resume',
        targetType: 'user',
        targetId: guestId,
        metadata: {
          email: guest.email,
          externalOrg: guest.external_org,
          previousStatus: guest.status,
          previousExpiresAt: guest.expires_at,
          expiresAt: nextExpiresAt,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: guestId,
        targetUserId: guestId,
        action: 'admin.guest.resume',
        payload: { email: guest.email, status: 'active', expiresAt: nextExpiresAt },
        nowIso,
      }),
    ]);

    const response = {
      ok: true,
      guest: {
        id: guestId,
        status: 'active',
        offboardedAt: null,
        expiresAt: nextExpiresAt,
      },
      syncSeq: extractLastSyncSeq(results),
      notice: 'ゲストアカウントを再開しました。',
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export async function resendAdminGuestInvite(input: {
  db: D1Database;
  tenantId: string;
  guestId: string;
  actor: AuthUser;
  invitationId?: string | null;
  acceptOrigin: string;
  mailEnv: Pick<
    Env,
    'DB' | 'ENVIRONMENT' | 'MAIL_WEBHOOK_URL' | 'MAIL_API_KEY' | 'MAIL_FROM'
  >;
  idempotencyKey?: string | null;
}): Promise<Record<string, unknown>> {
  const { db, tenantId, guestId, actor } = input;
  const guest = await loadGuestAccount(db, tenantId, guestId);
  const session = await beginGuestOperation<Record<string, unknown>>(
    db,
    tenantId,
    'admin.guest.resend_invite',
    guestId,
    input.idempotencyKey ?? null,
    { invitationId: input.invitationId ?? null }
  );
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    if (guest.offboarded_at) {
      throw new AdminGuestError(
        409,
        'GUEST_OFFBOARDED',
        'Offboarded guest accounts cannot receive invitations'
      );
    }

    let invitation = input.invitationId
      ? await loadGuestInvitation(db, tenantId, input.invitationId)
      : null;
    if (input.invitationId && (!invitation || invitation.user_id !== guestId)) {
      throw new AdminGuestError(
        404,
        'INVITATION_NOT_FOUND',
        'Guest invitation not found for this guest'
      );
    }
    if (!invitation) {
      invitation = await db
        .prepare(
          `SELECT gi.*,
                  COALESCE(f.name, fl.name) AS target_name,
                  inviter.display_name AS invited_by_name
             FROM guest_invitations gi
             LEFT JOIN folders f
               ON gi.target_type = 'folder'
              AND f.tenant_id = gi.tenant_id
              AND f.id = gi.target_id
             LEFT JOIN files fl
               ON gi.target_type = 'file'
              AND fl.tenant_id = gi.tenant_id
              AND fl.id = gi.target_id
             LEFT JOIN users inviter ON inviter.id = gi.invited_by
            WHERE gi.tenant_id = ? AND gi.user_id = ? AND gi.status = 'pending'
            ORDER BY gi.created_at DESC
            LIMIT 1`
        )
        .bind(tenantId, guestId)
        .first<GuestInvitationRow>();
    }
    if (!invitation) {
      throw new AdminGuestError(
        409,
        'NO_PENDING_INVITATION',
        'The guest has no pending invitation to resend'
      );
    }
    if (invitation.status !== 'pending') {
      throw new AdminGuestError(
        409,
        'INVITATION_NOT_PENDING',
        `Guest invitation is ${invitation.status} and cannot be resent`
      );
    }
    if (invitation.expires_at <= nowIso) {
      await db
        .prepare(
          `UPDATE guest_invitations SET status = 'expired', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = 'pending'`
        )
        .bind(nowIso, tenantId, invitation.id)
        .run();
      throw new AdminGuestError(
        410,
        'INVITATION_EXPIRED',
        'Guest invitation has expired'
      );
    }

    const policy = await getGuestPolicy(db, tenantId);
    if (!policy.allowExternalCollaborators) {
      throw new AdminGuestError(
        403,
        'EXTERNAL_COLLABORATORS_DISABLED',
        'External collaborators are disabled for this tenant'
      );
    }
    if (
      !isGuestEmailDomainAllowed(guest.email, policy.externalDomainAllowlist)
    ) {
      throw new AdminGuestError(
        403,
        'EXTERNAL_DOMAIN_NOT_ALLOWED',
        'This external email domain is not on the guest domain allowlist'
      );
    }
    if (
      guest.status !== 'active' ||
      (guest.expires_at && guest.expires_at <= nowIso)
    ) {
      throw new AdminGuestError(
        403,
        'GUEST_ACCOUNT_INACTIVE',
        'Guest account is no longer active'
      );
    }

    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const resendCount = invitation.resend_count + 1;
    const results = await db.batch([
      db
        .prepare(
          `UPDATE guest_invitations
              SET token_hash = ?, resend_count = resend_count + 1,
                  last_sent_at = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = 'pending'`
        )
        .bind(tokenHash, nowIso, nowIso, tenantId, invitation.id),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.guest.resend_invite',
        targetType: 'guest_invitation',
        targetId: invitation.id,
        metadata: {
          email: invitation.email,
          guestUserId: guestId,
          externalOrg: invitation.external_org,
          resendCount,
          targetType: invitation.target_type,
          targetId: invitation.target_id,
          role: invitation.role,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: guestId,
        targetUserId: guestId,
        action: 'admin.guest.resend_invite',
        payload: { invitationId: invitation.id, resendCount },
        nowIso,
      }),
    ]);

    const acceptUrl = `${input.acceptOrigin}/guest/accept?token=${encodeURIComponent(rawToken)}`;
    const provider = resolveMailProvider(input.mailEnv);
    try {
      await provider.send({
        tenantId,
        kind: 'guest_invitation',
        to: invitation.email,
        subject: '【Files】外部ゲストコラボレーターの招待',
        text: [
          `${invitation.display_name} 様`,
          '',
          'Files のワークスペースへ外部ゲストコラボレーターとして招待されました。',
          `共有対象: ${invitation.target_name ?? invitation.target_type}`,
          invitation.external_org ? `外部組織: ${invitation.external_org}` : null,
          `招待の有効期限: ${new Date(invitation.expires_at).toISOString()}`,
          '',
          '以下の URL から招待を承諾し、メールに届く 6 桁の認証コードでサインインしてください。',
          acceptUrl,
          '',
          'このメールに心当たりがない場合は破棄してください。',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
        token: rawToken,
        acceptUrl,
      });
    } catch (err) {
      if (err instanceof MailProviderConfigurationError) {
        throw new AdminGuestError(
          503,
          'MAIL_PROVIDER_NOT_CONFIGURED',
          'Mail provider is not configured for guest invitations'
        );
      }
      if (err instanceof MailDeliveryError) {
        throw new AdminGuestError(
          502,
          'MAIL_DELIVERY_FAILED',
          'Failed to deliver the guest invitation'
        );
      }
      throw err;
    }

    const response = {
      ok: true,
      guestId,
      invitationId: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expires_at,
      resendCount,
      syncSeq: extractLastSyncSeq(results),
      mailPreview: buildGuestInvitationMailPreview({
        displayName: invitation.display_name,
        externalOrg: invitation.external_org,
        targetType: invitation.target_type,
        targetName: invitation.target_name,
        role: invitation.role,
        expiresAt: invitation.expires_at,
        invitedByName: invitation.invited_by_name ?? null,
      }),
      notice: `招待メールを再送しました（再送回数 ${resendCount} 回）。`,
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export async function offboardAdminGuest(input: {
  db: D1Database;
  tenantId: string;
  guestId: string;
  actor: AuthUser;
  idempotencyKey?: string | null;
}): Promise<Record<string, unknown>> {
  const { db, tenantId, guestId, actor } = input;
  const guest = await loadGuestAccount(db, tenantId, guestId);
  const session = await beginGuestOperation<Record<string, unknown>>(
    db,
    tenantId,
    'admin.guest.offboard',
    guestId,
    input.idempotencyKey ?? null
  );
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const counts = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions
             WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL) AS sessions,
           (SELECT COUNT(*) FROM guest_invitations
             WHERE tenant_id = ? AND user_id = ? AND status <> 'revoked') AS invitations,
           (SELECT COUNT(*) FROM guest_otp_challenges
             WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL) AS otps,
           (SELECT COUNT(*) FROM permissions
             WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?) AS permissions`
      )
      .bind(
        tenantId,
        guestId,
        tenantId,
        guestId,
        tenantId,
        guestId,
        tenantId,
        guestId
      )
      .first<{
        sessions: number;
        invitations: number;
        otps: number;
        permissions: number;
      }>();

    const results = await db.batch([
      db
        .prepare(
          `UPDATE sessions SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, tenantId, guestId),
      db
        .prepare(
          `UPDATE guest_invitations
              SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
            WHERE tenant_id = ? AND user_id = ? AND status <> 'revoked'`
        )
        .bind(nowIso, actor.id, nowIso, tenantId, guestId),
      db
        .prepare(
          `UPDATE guest_otp_challenges
              SET consumed_at = ?
            WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL`
        )
        .bind(nowIso, tenantId, guestId),
      db
        .prepare(
          `DELETE FROM permissions
            WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?`
        )
        .bind(tenantId, guestId),
      db
        .prepare(
          `UPDATE users
              SET status = 'suspended',
                  offboarded_at = ?,
                  offboarded_by = ?,
                  updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
        )
        .bind(nowIso, actor.id, nowIso, tenantId, guestId),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.guest.offboard',
        targetType: 'user',
        targetId: guestId,
        metadata: {
          email: guest.email,
          externalOrg: guest.external_org,
          invitedBy: guest.invited_by,
          sessionsRevoked: counts?.sessions ?? 0,
          invitationsRevoked: counts?.invitations ?? 0,
          otpChallengesConsumed: counts?.otps ?? 0,
          permissionsDeleted: counts?.permissions ?? 0,
          offboardedAt: nowIso,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: guestId,
        targetUserId: guestId,
        action: 'admin.guest.offboard',
        payload: {
          email: guest.email,
          status: 'suspended',
          offboardedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    const response = {
      ok: true,
      guest: {
        id: guestId,
        status: 'suspended',
        offboardedAt: nowIso,
      },
      sessionsRevoked: results[0]?.meta.changes ?? counts?.sessions ?? 0,
      invitationsRevoked: results[1]?.meta.changes ?? counts?.invitations ?? 0,
      otpChallengesConsumed: results[2]?.meta.changes ?? counts?.otps ?? 0,
      permissionsDeleted: results[3]?.meta.changes ?? counts?.permissions ?? 0,
      syncSeq: extractLastSyncSeq(results),
      notice:
        'ゲストを完全にオフボーディングしました。セッション・招待・OTP・権限はすべて無効化されています。',
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}
