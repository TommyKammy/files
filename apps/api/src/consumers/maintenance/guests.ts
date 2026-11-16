import type { Env } from '../../types/api';
import { buildAuditLogStmt } from '../../services/audit';
import { executeGroupedBatches } from '../../services/d1-batch';
import { resolveMailProvider } from '../../services/mail-provider';
import { buildSyncChangeStmt } from '../../services/sync-changes';

/**
 * P10-3 / TOM-61 daily guest lifecycle maintenance.
 *
 * - expire active guest accounts and revoke every session
 * - transition pending invitations past `expires_at` to `expired`
 * - remove invitations / OTP challenges / local mail-sink rows past retention
 * - send a 72h expiry reminder at most once per guest (`expiring_notified_at`)
 */

const RETENTION_DAYS = 30;
const EXPIRY_REMINDER_WINDOW_HOURS = 72;

interface ExpiredGuestRow {
  id: string;
  tenant_id: string;
  email: string;
  external_org: string | null;
  expires_at: string;
}

export async function suspendExpiredGuests(
  db: D1Database,
  nowIso: string
): Promise<{ guestsExpiredSuspended: number; guestSessionsRevoked: number }> {
  const rows = await db
    .prepare(
      `SELECT id, tenant_id, email, external_org, expires_at
         FROM users
        WHERE user_type = 'guest'
          AND status = 'active'
          AND offboarded_at IS NULL
          AND expires_at IS NOT NULL
          AND expires_at <= ?`
    )
    .bind(nowIso)
    .all<ExpiredGuestRow>();

  if (rows.results.length === 0) {
    return { guestsExpiredSuspended: 0, guestSessionsRevoked: 0 };
  }

  let guestSessionsRevoked = 0;
  const groups = rows.results.map((guest) => [
    db
      .prepare(
        `UPDATE users
            SET status = 'suspended', updated_at = ?
          WHERE tenant_id = ? AND id = ? AND user_type = 'guest'
            AND offboarded_at IS NULL`
      )
      .bind(nowIso, guest.tenant_id, guest.id),
    db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(nowIso, guest.tenant_id, guest.id),
    buildAuditLogStmt(db, {
      tenantId: guest.tenant_id,
      actorId: null,
      actorEmail: null,
      actorIp: null,
      action: 'guest.auto_suspended_expired',
      targetType: 'user',
      targetId: guest.id,
      metadata: {
        email: guest.email,
        externalOrg: guest.external_org,
        expiresAt: guest.expires_at,
        reason: 'guest_account_expired',
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: guest.tenant_id,
      entityType: 'user',
      entityId: guest.id,
      targetUserId: guest.id,
      action: 'guest.auto_suspended_expired',
      payload: {
        email: guest.email,
        status: 'suspended',
        expiresAt: guest.expires_at,
      },
      nowIso,
    }),
  ]);

  const results = await executeGroupedBatches(db, groups);
  // Every group has the session update in position 1 of 4; grouped batches
  // flush whole groups, so results line up with the statement order.
  for (let index = 1; index < results.length; index += 4) {
    guestSessionsRevoked += results[index]?.meta.changes ?? 0;
  }

  return {
    guestsExpiredSuspended: rows.results.length,
    guestSessionsRevoked,
  };
}

export async function cleanupGuestArtifacts(
  db: D1Database,
  nowIso: string,
  retentionDays = RETENTION_DAYS
): Promise<{
  invitationsExpired: number;
  invitationsCleaned: number;
  otpChallengesPurged: number;
}> {
  const cutoffIso = new Date(
    Date.parse(nowIso) - Math.max(1, retentionDays) * 86_400_000
  ).toISOString();

  const expiredInvitations = await db
    .prepare(
      `UPDATE guest_invitations
          SET status = 'expired', updated_at = ?
        WHERE status = 'pending' AND expires_at <= ?`
    )
    .bind(nowIso, nowIso)
    .run();

  const cleanedInvitations = await db
    .prepare(
      `DELETE FROM guest_invitations
        WHERE status IN ('expired', 'revoked')
          AND updated_at <= ?`
    )
    .bind(cutoffIso)
    .run();

  const purgedOtp = await db
    .prepare(
      `DELETE FROM guest_otp_challenges
        WHERE (consumed_at IS NOT NULL AND consumed_at <= ?)
           OR expires_at <= ?`
    )
    .bind(cutoffIso, cutoffIso)
    .run();

  // Local development / Vitest-only sink. Production uses the HTTP webhook and
  // has no rows here, so this delete is a no-op outside local environments.
  await db
    .prepare('DELETE FROM guest_mail_sink WHERE created_at <= ?')
    .bind(cutoffIso)
    .run();

  return {
    invitationsExpired: expiredInvitations.meta.changes ?? 0,
    invitationsCleaned: cleanedInvitations.meta.changes ?? 0,
    otpChallengesPurged: purgedOtp.meta.changes ?? 0,
  };
}

interface ExpiringGuestRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string;
  expires_at: string;
}

export async function notifyExpiringGuests(
  env: Pick<
    Env,
    | 'DB'
    | 'ENVIRONMENT'
    | 'MAIL_WEBHOOK_URL'
    | 'MAIL_API_KEY'
    | 'MAIL_FROM'
  >,
  nowIso: string,
  windowHours = EXPIRY_REMINDER_WINDOW_HOURS
): Promise<{ expiringSoonNotified: number }> {
  const nowMs = Date.parse(nowIso);
  const windowEndIso = new Date(
    nowMs + Math.max(1, windowHours) * 3_600_000
  ).toISOString();

  const rows = await env.DB.prepare(
    `SELECT id, tenant_id, email, display_name, expires_at
       FROM users
      WHERE user_type = 'guest'
        AND status = 'active'
        AND offboarded_at IS NULL
        AND expires_at IS NOT NULL
        AND expires_at > ?
        AND expires_at <= ?
        AND expiring_notified_at IS NULL
      ORDER BY expires_at ASC`
  )
    .bind(nowIso, windowEndIso)
    .all<ExpiringGuestRow>();

  if (rows.results.length === 0) return { expiringSoonNotified: 0 };

  let notified = 0;
  for (const guest of rows.results) {
    try {
      const provider = resolveMailProvider(env);
      await provider.send({
        tenantId: guest.tenant_id,
        kind: 'guest_otp',
        to: guest.email,
        subject: '【Files】外部ゲストアカウントの有効期限が近づいています',
        text: [
          `${guest.display_name} 様`,
          '',
          `外部ゲストアカウントの有効期限が ${new Date(guest.expires_at).toISOString()} に到来します。`,
          '引き続きアクセスが必要な場合は、ワークスペースの管理者へ更新を依頼してください。',
          '期限を過ぎるとアカウントは自動的に停止され、すべてのセッションが失効します。',
          '',
          'このメールに心当たりがない場合は破棄してください。',
        ].join('\n'),
      });
    } catch (err) {
      // A missing webhook or a transient provider failure must never fail the
      // whole cron. Leave `expiring_notified_at` untouched so the next run
      // retries instead of silently dropping the reminder.
      console.warn(
        `[maintenance-cron] guest expiry reminder failed for ${guest.id}:`,
        err
      );
      continue;
    }

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE users
            SET expiring_notified_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND expiring_notified_at IS NULL`
      ).bind(nowIso, nowIso, guest.tenant_id, guest.id),
      buildAuditLogStmt(env.DB, {
        tenantId: guest.tenant_id,
        actorId: null,
        actorEmail: null,
        actorIp: null,
        action: 'guest.expiry_reminder',
        targetType: 'user',
        targetId: guest.id,
        metadata: {
          email: guest.email,
          expiresAt: guest.expires_at,
          windowHours,
        },
        nowIso,
      }),
    ]);
    notified += 1;
  }

  return { expiringSoonNotified: notified };
}
