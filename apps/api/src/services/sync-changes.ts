import type { AuthUser } from '../types/api';
import { GRANTEE_MATCH_SQL } from './authorization';
import type { ConditionalWriteGuard } from './statement-guard';

export type SyncEntityType =
  | 'folder'
  | 'file'
  | 'permission'
  | 'shared_link'
  | 'policy'
  | 'user';

export interface SyncChangeInput {
  tenantId: string;
  entityType: SyncEntityType;
  entityId: string;
  folderId?: string | null;
  targetUserId?: string | null;
  action: string;
  payload?: Record<string, unknown> | null;
  nowIso?: string;
}

export interface SyncDeltaItem {
  seq: number;
  entityType: SyncEntityType;
  entityId: string;
  folderId: string | null;
  targetUserId: string | null;
  action: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface SyncDeltaResult {
  resetRequired: boolean;
  currentSeq: number;
  purgedBeforeSeq: number;
  nextSeq: number;
  hasMore: boolean;
  changes: SyncDeltaItem[];
}

interface RawSyncChangeRow {
  seq: number;
  entity_type: SyncEntityType;
  entity_id: string;
  folder_id: string | null;
  target_user_id: string | null;
  action: string;
  payload_json: string | null;
  created_at: string;
}

/** Build a synchronous D1 statement to append a monotonic change event inside `DB.batch()`. */
export function buildSyncChangeStmt(
  db: D1Database,
  input: SyncChangeInput,
  guard?: ConditionalWriteGuard
): D1PreparedStatement {
  const bindings: Array<string | number | null> = [
    input.tenantId,
    input.entityType,
    input.entityId,
    input.folderId ?? null,
    input.targetUserId ?? null,
    input.action,
    input.payload ? JSON.stringify(input.payload) : null,
    input.nowIso ?? new Date().toISOString(),
  ];

  if (!guard) {
    return db
      .prepare(
        `INSERT INTO sync_changes (
           tenant_id, entity_type, entity_id, folder_id, target_user_id,
           action, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(...bindings);
  }

  return db
    .prepare(
      `INSERT INTO sync_changes (
         tenant_id, entity_type, entity_id, folder_id, target_user_id,
         action, payload_json, created_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${guard.sql}`
    )
    .bind(...bindings, ...(guard.bindings ?? []));
}

/** Read current tenant sync watermark and Cron purge horizon in a single D1 batch round-trip. */
export async function getSyncWatermarks(
  db: D1Database,
  tenantId: string
): Promise<{ currentSeq: number; purgedBeforeSeq: number }> {
  const [horizonRes, maxRes] = await db.batch([
    db
      .prepare('SELECT purged_before_seq FROM tenant_sync_horizons WHERE tenant_id = ?')
      .bind(tenantId),
    db
      .prepare('SELECT MAX(seq) AS max_seq FROM sync_changes WHERE tenant_id = ?')
      .bind(tenantId),
  ]);

  const horizonRow = horizonRes.results[0] as { purged_before_seq?: number } | undefined;
  const maxRow = maxRes.results[0] as { max_seq?: number | null } | undefined;
  const purgedBeforeSeq = horizonRow?.purged_before_seq ?? 0;
  const currentSeq = Math.max(purgedBeforeSeq, maxRow?.max_seq ?? 0);

  return { currentSeq, purgedBeforeSeq };
}

function parsePayloadJson(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Fetch incremental delta changes strictly filtered by the authenticated user's
 * effective RBAC permissions so confidential/restricted items never leak across roles.
 */
export async function listAuthorizedSyncDeltas(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId' | 'role'>,
  options: { sinceSeq: number; limit: number }
): Promise<SyncDeltaResult> {
  const { currentSeq, purgedBeforeSeq } = await getSyncWatermarks(db, user.tenantId);
  const sinceSeq = Math.max(0, Math.floor(options.sinceSeq));
  const limit = Math.min(Math.max(Math.floor(options.limit), 1), 200);

  if (sinceSeq < purgedBeforeSeq || sinceSeq > currentSeq) {
    return {
      resetRequired: true,
      currentSeq,
      purgedBeforeSeq,
      nextSeq: currentSeq,
      hasMore: false,
      changes: [],
    };
  }

  if (sinceSeq === currentSeq) {
    return {
      resetRequired: false,
      currentSeq,
      purgedBeforeSeq,
      nextSeq: currentSeq,
      hasMore: false,
      changes: [],
    };
  }

  const isAdminFlag = user.role === 'sys_admin' || user.role === 'sec_admin' ? 1 : 0;

  const rows = await db
    .prepare(
      `SELECT sc.seq, sc.entity_type, sc.entity_id, sc.folder_id, sc.target_user_id,
              sc.action, sc.payload_json, sc.created_at
         FROM sync_changes sc
        WHERE sc.tenant_id = ?
          AND sc.seq > ?
          AND (
            sc.entity_type = 'policy'
            OR (
              sc.entity_type = 'user'
              AND (sc.target_user_id = ? OR ? = 1)
            )
            OR (
              sc.entity_type = 'folder'
              AND EXISTS (
                SELECT 1
                  FROM folder_closures fc
                  JOIN permissions p
                    ON p.tenant_id = fc.tenant_id
                   AND p.target_type = 'folder'
                   AND p.target_id = fc.ancestor_id
                 WHERE fc.tenant_id = sc.tenant_id
                   AND fc.descendant_id = CASE
                     WHEN sc.action = 'folder.moved_out' AND sc.folder_id IS NOT NULL THEN sc.folder_id
                     ELSE sc.entity_id
                   END
                   AND ${GRANTEE_MATCH_SQL}
              )
            )
            OR (
              sc.entity_type = 'file'
              AND EXISTS (
                SELECT 1
                  FROM permissions p
                 WHERE p.tenant_id = sc.tenant_id
                   AND ${GRANTEE_MATCH_SQL}
                   AND (
                     (p.target_type = 'file' AND p.target_id = sc.entity_id)
                     OR (
                       p.target_type = 'folder'
                       AND sc.folder_id IS NOT NULL
                       AND p.target_id IN (
                         SELECT fc.ancestor_id
                           FROM folder_closures fc
                          WHERE fc.tenant_id = sc.tenant_id
                            AND fc.descendant_id = sc.folder_id
                       )
                     )
                   )
              )
            )
            OR (
              sc.entity_type = 'permission'
              AND (
                sc.target_user_id = ?
                OR ? = 1
                OR (
                  json_extract(sc.payload_json, '$.granteeType') = 'group'
                  AND EXISTS (
                    SELECT 1 FROM group_members gm
                     WHERE gm.group_id = json_extract(sc.payload_json, '$.granteeId')
                       AND gm.user_id = ?
                  )
                )
                OR (
                  sc.folder_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                      FROM folder_closures fc
                      JOIN permissions p
                        ON p.tenant_id = fc.tenant_id
                       AND p.target_type = 'folder'
                       AND p.target_id = fc.ancestor_id
                     WHERE fc.tenant_id = sc.tenant_id
                       AND fc.descendant_id = sc.folder_id
                       AND ${GRANTEE_MATCH_SQL}
                  )
                )
                OR (
                  json_extract(sc.payload_json, '$.targetType') = 'file'
                  AND EXISTS (
                    SELECT 1
                      FROM permissions p
                     WHERE p.tenant_id = sc.tenant_id
                       AND p.target_type = 'file'
                       AND p.target_id = json_extract(sc.payload_json, '$.targetId')
                       AND ${GRANTEE_MATCH_SQL}
                  )
                )
              )
            )
            OR (
              sc.entity_type = 'shared_link'
              AND (
                ? = 1
                OR sc.target_user_id = ?
                OR EXISTS (
                  SELECT 1
                    FROM permissions p
                   WHERE p.tenant_id = sc.tenant_id
                     AND ${GRANTEE_MATCH_SQL}
                     AND (
                       (
                         json_extract(sc.payload_json, '$.targetType') = 'file'
                         AND p.target_type = 'file'
                         AND p.target_id = json_extract(sc.payload_json, '$.targetId')
                       )
                       OR (
                         sc.folder_id IS NOT NULL
                         AND p.target_type = 'folder'
                         AND p.target_id IN (
                           SELECT fc.ancestor_id
                             FROM folder_closures fc
                            WHERE fc.tenant_id = sc.tenant_id
                              AND fc.descendant_id = sc.folder_id
                         )
                       )
                     )
                )
              )
            )
          )
        ORDER BY sc.seq ASC
        LIMIT ?`
    )
    .bind(
      user.tenantId,
      sinceSeq,
      // user
      user.id,
      isAdminFlag,
      // folder
      user.id,
      user.id,
      // file
      user.id,
      user.id,
      // permission
      user.id,
      isAdminFlag,
      user.id,
      user.id,
      user.id,
      user.id,
      user.id,
      // shared_link
      isAdminFlag,
      user.id,
      user.id,
      user.id,
      // limit
      limit + 1
    )
    .all<RawSyncChangeRow>();

  const hasMore = rows.results.length > limit;
  const page = hasMore ? rows.results.slice(0, limit) : rows.results;
  const lastSeq = page[page.length - 1]?.seq;

  return {
    resetRequired: false,
    currentSeq,
    purgedBeforeSeq,
    nextSeq: hasMore && lastSeq !== undefined ? lastSeq : currentSeq,
    hasMore,
    changes: page.map((row) => ({
      seq: row.seq,
      entityType: row.entity_type,
      entityId: row.entity_id,
      folderId: row.folder_id,
      targetUserId: row.target_user_id,
      action: row.action,
      payload: parsePayloadJson(row.payload_json),
      createdAt: row.created_at,
    })),
  };
}

/**
 * Purge sync_changes rows older than `retentionDays` per tenant and advance
 * `tenant_sync_horizons` atomically so stale clients receive `resetRequired: true`.
 */
export async function purgeExpiredSyncChanges(
  db: D1Database,
  nowMs: number,
  retentionDays = 7
): Promise<number> {
  const cutoffIso = new Date(nowMs - Math.max(1, retentionDays) * 86_400_000).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  const expiredByTenant = await db
    .prepare(
      `SELECT tenant_id, MAX(seq) AS max_expired_seq
         FROM sync_changes
        WHERE created_at <= ?
        GROUP BY tenant_id`
    )
    .bind(cutoffIso)
    .all<{ tenant_id: string; max_expired_seq: number }>();

  let deletedTotal = 0;

  for (const row of expiredByTenant.results) {
    const [, deleteRes] = await db.batch([
      db
        .prepare(
          `INSERT INTO tenant_sync_horizons (tenant_id, purged_before_seq, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (tenant_id) DO UPDATE SET
             purged_before_seq = MAX(purged_before_seq, excluded.purged_before_seq),
             updated_at = excluded.updated_at`
        )
        .bind(row.tenant_id, row.max_expired_seq, nowIso),
      db
        .prepare(
          `DELETE FROM sync_changes
            WHERE tenant_id = ? AND seq <= ?`
        )
        .bind(row.tenant_id, row.max_expired_seq),
    ]);
    deletedTotal += deleteRes.meta.changes ?? 0;
  }

  return deletedTotal;
}

/** Parse optional `expectedVersion` from either a query string or parsed JSON body. */
export function parseExpectedVersionInput(
  queryValue: string | undefined,
  body: { expectedVersion?: unknown } | null
): number | undefined {
  if (typeof body?.expectedVersion === 'number' && Number.isInteger(body.expectedVersion)) {
    return body.expectedVersion;
  }
  if (queryValue !== undefined && /^\d+$/.test(queryValue)) {
    return Number(queryValue);
  }
  return undefined;
}
