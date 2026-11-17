/**
 * Per-member storage accounting (P11-2 / TOM-64).
 *
 * `user_storage_stats` mirrors `tenant_storage_stats` but is keyed by the file
 * owner. Every path that changes the tenant's active byte/file counters must
 * apply the same delta here so the upload-time personal quota guard can stay an
 * O(1) read instead of scanning `files`.
 */

export interface UserStorageDelta {
  tenantId: string;
  userId: string;
  countDelta: number;
  bytesDelta: number;
  nowIso: string;
}

/** Optional guard mirroring `buildAuditLogStmt` / `buildSyncChangeStmt`. */
export interface UserStorageDeltaGuard {
  sql: string;
  bindings?: readonly (string | number | null)[];
}

/** Build the atomic upsert used inside an existing `DB.batch()` sequence. */
export function buildUserStorageDeltaStmt(
  db: D1Database,
  delta: UserStorageDelta,
  guard?: UserStorageDeltaGuard
): D1PreparedStatement {
  const bindings: Array<string | number | null> = [
    delta.tenantId,
    delta.userId,
    delta.countDelta,
    delta.bytesDelta,
    delta.nowIso,
  ];

  if (!guard) {
    return db
      .prepare(
        `INSERT INTO user_storage_stats (
         tenant_id, user_id, file_count, total_bytes, updated_at
       ) VALUES (?, ?, MAX(0, ?), MAX(0, ?), ?)
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET file_count = MAX(0, file_count + ?),
                     total_bytes = MAX(0, total_bytes + ?),
                     updated_at = excluded.updated_at`
      )
      .bind(...bindings, delta.countDelta, delta.bytesDelta);
  }

  return db
    .prepare(
      `INSERT INTO user_storage_stats (
         tenant_id, user_id, file_count, total_bytes, updated_at
       )
       SELECT ?, ?, MAX(0, ?), MAX(0, ?), ?
        WHERE ${guard.sql}
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET file_count = MAX(0, file_count + ?),
                     total_bytes = MAX(0, total_bytes + ?),
                     updated_at = excluded.updated_at`
    )
    .bind(
      ...bindings,
      ...(guard.bindings ?? []),
      delta.countDelta,
      delta.bytesDelta
    );
}

export interface UserStorageQuotaStatus {
  /** `null` means no personal limit; only the tenant quota applies. */
  quotaBytes: number | null;
  usedBytes: number;
  fileCount: number;
}

/**
 * Resolve the member's personal quota snapshot. Unknown users (local dev
 * headers, SCIM race) simply have no personal quota rather than failing the
 * upload with an unrelated 404.
 */
export async function getUserStorageQuotaStatus(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<UserStorageQuotaStatus> {
  const row = await db
    .prepare(
      `SELECT u.storage_quota_bytes AS quota_bytes,
              COALESCE(s.file_count, 0) AS file_count,
              COALESCE(s.total_bytes, 0) AS used_bytes
         FROM users u
         LEFT JOIN user_storage_stats s
           ON s.tenant_id = u.tenant_id AND s.user_id = u.id
        WHERE u.tenant_id = ? AND u.id = ?`
    )
    .bind(tenantId, userId)
    .first<{
      quota_bytes: number | null;
      file_count: number;
      used_bytes: number;
    }>();

  return {
    quotaBytes: row?.quota_bytes ?? null,
    usedBytes: row?.used_bytes ?? 0,
    fileCount: row?.file_count ?? 0,
  };
}
