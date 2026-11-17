import { purgeExpiredSyncChanges } from '../services/sync-changes';
import { purgeExpiredWopiDrafts } from '../services/wopi-drafts';
import { purgeExpiredActiveFileLocks } from '../services/active-file-lock-index';
import type { Env } from '../types/api';
import {
  cleanupGuestArtifacts,
  notifyExpiringGuests,
  suspendExpiredGuests,
} from './maintenance/guests';
import { purgeExpiredOrRevokedSessions } from './maintenance/sessions';
import { purgeExpiredTrashForTenant } from './maintenance/trash';
import { cleanupStalePendingUploads } from './maintenance/uploads';

export interface MaintenanceSummary {
  sessionsDeleted: number;
  pendingFilesDeleted: number;
  pendingVersionsDeleted: number;
  trashedFilesPurged: number;
  trashedFoldersPurged: number;
  syncChangesPurged: number;
  wopiDraftsPurged: number;
  wopiSessionsExpired: number;
  activeFileLocksPurged: number;
  guestsExpiredSuspended: number;
  guestSessionsRevoked: number;
  invitationsExpired: number;
  invitationsCleaned: number;
  otpChallengesPurged: number;
  expiringSoonNotified: number;
}

interface TenantPolicyRetentionRow {
  tenant_id: string;
  trash_retention_days: number;
}

/**
 * Daily Cloudflare Workers Cron entrypoint:
 * 1. Expire/auto-suspend guests, expire invitations & clean guest artifacts,
 *    and notify guests whose account expires within 72h
 * 2. Delete expired/revoked sessions
 * 3. Delete >24h stale pending uploads & orphan R2 objects
 * 4. Purge soft-deleted items older than tenant `trash_retention_days` while keeping `tenant_storage_stats` consistent
 */
export async function runDailyMaintenance(
  env: Env,
  now: Date = new Date()
): Promise<MaintenanceSummary> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const { guestsExpiredSuspended, guestSessionsRevoked } =
    await suspendExpiredGuests(env.DB, nowIso);
  const {
    invitationsExpired,
    invitationsCleaned,
    otpChallengesPurged,
  } = await cleanupGuestArtifacts(env.DB, nowIso);
  const { expiringSoonNotified } = await notifyExpiringGuests(env, nowIso);

  const sessionsDeleted = await purgeExpiredOrRevokedSessions(env.DB, nowIso);
  const { pendingFilesDeleted, pendingVersionsDeleted } =
    await cleanupStalePendingUploads(env.DB, env.BUCKET, nowMs);

  const tenants = await env.DB.prepare(
    `SELECT t.id AS tenant_id, COALESCE(tp.trash_retention_days, 30) AS trash_retention_days
       FROM tenants t
       LEFT JOIN tenant_policies tp ON tp.tenant_id = t.id`
  ).all<TenantPolicyRetentionRow>();

  let trashedFilesPurged = 0;
  let trashedFoldersPurged = 0;

  for (const row of tenants.results) {
    const retentionDays = Math.max(1, row.trash_retention_days ?? 30);
    const cutoffIso = new Date(nowMs - retentionDays * 86_400_000).toISOString();
    const res = await purgeExpiredTrashForTenant(
      env.DB,
      env.BUCKET,
      row.tenant_id,
      cutoffIso,
      nowIso
    );
    trashedFilesPurged += res.filesPurged;
    trashedFoldersPurged += res.foldersPurged;
  }

  const { draftsPurged: wopiDraftsPurged, sessionsExpired: wopiSessionsExpired } =
    await purgeExpiredWopiDrafts(env, nowMs);
  const activeFileLocksPurged = await purgeExpiredActiveFileLocks(
    env.DB,
    nowIso
  );
  const syncChangesPurged = await purgeExpiredSyncChanges(env.DB, nowMs);

  return {
    sessionsDeleted,
    pendingFilesDeleted,
    pendingVersionsDeleted,
    trashedFilesPurged,
    trashedFoldersPurged,
    syncChangesPurged,
    wopiDraftsPurged,
    wopiSessionsExpired,
    activeFileLocksPurged,
    guestsExpiredSuspended,
    guestSessionsRevoked,
    invitationsExpired,
    invitationsCleaned,
    otpChallengesPurged,
    expiringSoonNotified,
  };
}
