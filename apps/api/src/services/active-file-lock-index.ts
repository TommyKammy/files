import type { FileLockSnapshot } from '../durable-objects/file-lock-hub';
import type { OidcEnv } from '../types/oidc';
import { getFileLockState } from './file-lock';

export interface ActiveFileLockRow {
  file_id: string;
  tenant_id: string;
  mode: 'wopi_collab' | 'desktop_exclusive';
  lock_id: string;
  owner_id: string;
  owner_name: string;
  owner_email: string | null;
  expires_at: string;
  updated_at: string;
}

export function buildActiveFileLockUpsertStmt(
  db: D1Database,
  lock: FileLockSnapshot
): D1PreparedStatement {
  const updatedAt = new Date(lock.updatedAt).toISOString();
  return db
    .prepare(
      `INSERT INTO active_file_locks (
         file_id, tenant_id, mode, lock_id, owner_id, owner_name, owner_email,
         expires_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET
         tenant_id = excluded.tenant_id,
         mode = excluded.mode,
         lock_id = excluded.lock_id,
         owner_id = excluded.owner_id,
         owner_name = excluded.owner_name,
         owner_email = excluded.owner_email,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      lock.fileId,
      lock.tenantId,
      lock.mode,
      lock.lockId,
      lock.ownerId,
      lock.ownerName,
      lock.ownerEmail,
      new Date(lock.expiresAt).toISOString(),
      updatedAt
    );
}

export function buildActiveFileLockDeleteStmt(
  db: D1Database,
  fileId: string,
  tenantId?: string
): D1PreparedStatement {
  if (tenantId) {
    return db
      .prepare('DELETE FROM active_file_locks WHERE file_id = ? AND tenant_id = ?')
      .bind(fileId, tenantId);
  }
  return db.prepare('DELETE FROM active_file_locks WHERE file_id = ?').bind(fileId);
}

/** Apply one already-resolved live lock snapshot to the D1 shadow table. */
export async function applyActiveFileLockShadow(
  db: D1Database,
  lock: FileLockSnapshot | null
): Promise<void> {
  if (!lock) return;
  await buildActiveFileLockUpsertStmt(db, lock).run();
}

/** Remove the shadow row after a lock token has been released (or expired). */
export async function clearActiveFileLockShadow(
  db: D1Database,
  fileId: string,
  tenantId?: string
): Promise<void> {
  await buildActiveFileLockDeleteStmt(db, fileId, tenantId).run();
}

/**
 * Reconcile a D1 row with the authoritative FileLockHub state. Search/detail
 * paths never trust the shadow table for display: they call this with the live
 * snapshot and self-heal stale index rows.
 */
export async function reconcileActiveFileLockShadow(
  db: D1Database,
  fileId: string,
  live: FileLockSnapshot | null,
  tenantId?: string
): Promise<void> {
  if (live) {
    await applyActiveFileLockShadow(db, live);
  } else {
    await clearActiveFileLockShadow(db, fileId, tenantId);
  }
}

/** Read the live DO lock, then keep the D1 shadow table in sync. */
export async function syncActiveFileLockFromHub(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  fileId: string
): Promise<FileLockSnapshot | null> {
  const live = await getFileLockState(env, fileId);
  await reconcileActiveFileLockShadow(env.DB, fileId, live);
  return live;
}

/** Daily maintenance: drop shadow rows whose lock TTL already elapsed. */
export async function purgeExpiredActiveFileLocks(
  db: D1Database,
  nowIso: string
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM active_file_locks WHERE expires_at <= ?')
    .bind(nowIso)
    .run();
  return Number(result.meta?.changes ?? 0);
}
