import type { AuthUser } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import { executeGroupedBatches } from '../d1-batch';
import {
  emailDomain,
  isGuestDomainAllowed,
  type ExternalDomainExistingGuestMode,
} from '../external-guests';
import { buildSyncChangeStmt } from '../sync-changes';
import { extractLastSyncSeq } from '../sync-notifier';

export interface ExternalDomainPolicyResult {
  mode: ExternalDomainExistingGuestMode;
  affectedGuestCount: number;
  suspendedGuestIds: string[];
  syncSeq: number | null;
}

/**
 * Apply `externalDomainExistingGuestMode` to guests that are already active.
 *
 * `reject_new_only` only reports the candidates (new invitations and OTP
 * reauthentication are already rejected by the existing allowlist checks).
 * `suspend_existing` suspends every candidate and revokes their sessions.
 */
export async function applyExternalDomainGuestPolicy(input: {
  db: D1Database;
  tenantId: string;
  allowlist: readonly string[];
  mode: ExternalDomainExistingGuestMode;
  actor: AuthUser;
  nowIso?: string;
}): Promise<ExternalDomainPolicyResult> {
  const { db, tenantId, allowlist, mode, actor } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();

  const rows = await db
    .prepare(
      `SELECT id, email
         FROM users
        WHERE tenant_id = ?
          AND user_type = 'guest'
          AND status = 'active'
          AND offboarded_at IS NULL`
    )
    .bind(tenantId)
    .all<{ id: string; email: string }>();

  const candidates = rows.results.filter((row) => {
    const domain = emailDomain(row.email);
    return !domain || !isGuestDomainAllowed(domain, allowlist);
  });

  if (mode === 'reject_new_only' || candidates.length === 0) {
    return {
      mode,
      affectedGuestCount: candidates.length,
      suspendedGuestIds: [],
      syncSeq: null,
    };
  }

  const groups = candidates.map((guest) => [
    db
      .prepare(
        `UPDATE users
            SET status = 'suspended', updated_at = ?
          WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
      )
      .bind(nowIso, tenantId, guest.id),
    db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(nowIso, tenantId, guest.id),
    buildAuditLogStmt(db, {
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: actor.ipAddress,
      action: 'admin.guest.suspend',
      targetType: 'user',
      targetId: guest.id,
      metadata: {
        email: guest.email,
        domain: emailDomain(guest.email),
        reason: 'domain_removed_from_allowlist',
        mode,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId,
      entityType: 'user',
      entityId: guest.id,
      targetUserId: guest.id,
      action: 'admin.guest.suspend',
      payload: {
        email: guest.email,
        status: 'suspended',
        reason: 'domain_removed_from_allowlist',
      },
      nowIso,
    }),
  ]);

  const results = await executeGroupedBatches(db, groups);
  return {
    mode,
    affectedGuestCount: candidates.length,
    suspendedGuestIds: candidates.map((guest) => guest.id),
    syncSeq: extractLastSyncSeq(results),
  };
}
