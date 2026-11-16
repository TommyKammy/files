import { purgeExpiredSyncChanges } from '../services/sync-changes';
import type { Env } from '../types/api';
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
}

interface TenantPolicyRetentionRow {
  tenant_id: string;
  trash_retention_days: number;
}

/**
 * Daily Cloudflare Workers Cron entrypoint:
 * 1. Delete expired/revoked sessions
 * 2. Delete >24h stale pending uploads & orphan R2 objects
 * 3. Purge soft-deleted items older than tenant `trash_retention_days` while keeping `tenant_storage_stats` consistent
 */
export async function runDailyMaintenance(
  env: Env,
  now: Date = new Date()
): Promise<MaintenanceSummary> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

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

  const syncChangesPurged = await purgeExpiredSyncChanges(env.DB, nowMs);

  return {
    sessionsDeleted,
    pendingFilesDeleted,
    pendingVersionsDeleted,
    trashedFilesPurged,
    trashedFoldersPurged,
    syncChangesPurged,
  };
}
