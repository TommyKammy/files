import type { ConditionalWriteGuard } from './statement-guard';

/**
 * Incremental maintenance helpers for `root_folder_stats` (0023).
 *
 * `root_folder_stats` mirrors `user_storage_stats` / `tenant_storage_stats`
 * but aggregates active, non-deleted files (`upload_state = 'active'` AND
 * `deleted_at IS NULL`) per top-level root folder (`folders.parent_id IS NULL`).
 * Every file activation, size change, soft-delete, restore, CoW copy, and
 * file/folder move inside a D1 `batch()` keeps this table synchronized so
 * `GET /api/admin/root-folders` reads root metrics in O(1) without scanning
 * `folder_closures JOIN files`.
 */

export interface RootFolderFileDeltaInput {
  tenantId: string;
  folderId: string | null;
  countDelta: number;
  bytesDelta: number;
  nowIso: string;
}

export interface RootFolderSubtreeDeltaInput {
  tenantId: string;
  subtreeRootId: string;
  sign: 1 | -1;
  /**
   * Filter applied inside SQL when aggregating the subtree's active files:
   * - `null`: match live non-deleted active files (`fl.deleted_at IS NULL`).
   * - `<timestamp>`: match files soft-deleted in the target batch (`fl.deleted_at = ?`).
   */
  deletedAtMatch: string | null;
  nowIso: string;
}

/**
 * Adjust the root folder counters for a single file's folder inside the
 * caller's D1 `batch()`. Returns `null` for workspace-root files (`folderId === null`)
 * or zero-delta changes.
 */
export function buildRootFolderDeltaByFolderStmt(
  db: D1Database,
  input: RootFolderFileDeltaInput,
  guard?: ConditionalWriteGuard
): D1PreparedStatement | null {
  if (
    input.folderId === null ||
    (input.countDelta === 0 && input.bytesDelta === 0)
  ) {
    return null;
  }

  const guardClause = guard ? `\n          AND ${guard.sql}` : '';
  const guardBindings = guard?.bindings ?? [];

  return db
    .prepare(
      `INSERT INTO root_folder_stats (
         tenant_id, root_folder_id, file_count, total_bytes, updated_at
       )
       SELECT fc.tenant_id,
              fc.ancestor_id,
              MAX(0, ?),
              MAX(0, ?),
              ?
         FROM folder_closures fc
         JOIN folders rf
           ON rf.tenant_id = fc.tenant_id
          AND rf.id = fc.ancestor_id
        WHERE fc.tenant_id = ?
          AND fc.descendant_id = ?
          AND rf.parent_id IS NULL${guardClause}
       ON CONFLICT (tenant_id, root_folder_id)
       DO UPDATE SET file_count = MAX(0, file_count + ?),
                     total_bytes = MAX(0, total_bytes + ?),
                     updated_at = excluded.updated_at`
    )
    .bind(
      input.countDelta,
      input.bytesDelta,
      input.nowIso,
      input.tenantId,
      input.folderId,
      ...guardBindings,
      input.countDelta,
      input.bytesDelta
    );
}

/**
 * Adjust the owning root folder's stats by summing all matching active files
 * inside `subtreeRootId` atomically inside `db.batch()`.
 *
 * Placement inside `db.batch()` matters:
 * - Soft-delete / move-out: run BEFORE updating `files.deleted_at` or `folder_closures`.
 * - In-place restore: run BEFORE restoring `files.deleted_at = NULL` with `deletedAtMatch = batchDeletedAt`.
 * - Move-in / move-restore: run AFTER updating `folder_closures`, `folders.parent_id`, and `files.deleted_at`.
 */
export function buildRootFolderSubtreeDeltaStmt(
  db: D1Database,
  input: RootFolderSubtreeDeltaInput
): D1PreparedStatement {
  const deletedClause =
    input.deletedAtMatch === null
      ? 'fl.deleted_at IS NULL'
      : 'fl.deleted_at = ?';
  const deletedBindings =
    input.deletedAtMatch === null ? [] : [input.deletedAtMatch];

  if (input.sign === 1) {
    return db
      .prepare(
        `INSERT INTO root_folder_stats (
           tenant_id, root_folder_id, file_count, total_bytes, updated_at
         )
         SELECT rf.tenant_id,
                rf.id,
                agg.cnt,
                agg.bytes,
                ?
           FROM folder_closures fc_root
           JOIN folders rf
             ON rf.tenant_id = fc_root.tenant_id
            AND rf.id = fc_root.ancestor_id
           CROSS JOIN (
             SELECT COUNT(*) AS cnt,
                    COALESCE(SUM(fl.size_bytes), 0) AS bytes
               FROM files fl
              WHERE fl.tenant_id = ?
                AND fl.upload_state = 'active'
                AND ${deletedClause}
                AND fl.folder_id IN (
                  SELECT fc.descendant_id
                    FROM folder_closures fc
                   WHERE fc.tenant_id = ?
                     AND fc.ancestor_id = ?
                )
           ) agg
          WHERE fc_root.tenant_id = ?
            AND fc_root.descendant_id = ?
            AND rf.parent_id IS NULL
            AND agg.cnt > 0
         ON CONFLICT (tenant_id, root_folder_id)
         DO UPDATE SET file_count = file_count + excluded.file_count,
                       total_bytes = total_bytes + excluded.total_bytes,
                       updated_at = excluded.updated_at`
      )
      .bind(
        input.nowIso,
        input.tenantId,
        ...deletedBindings,
        input.tenantId,
        input.subtreeRootId,
        input.tenantId,
        input.subtreeRootId
      );
  }

  return db
    .prepare(
      `UPDATE root_folder_stats
          SET file_count = MAX(0, file_count - agg.cnt),
              total_bytes = MAX(0, total_bytes - agg.bytes),
              updated_at = ?
         FROM (
           SELECT fc_root.ancestor_id AS root_id,
                  COUNT(fl.id) AS cnt,
                  COALESCE(SUM(fl.size_bytes), 0) AS bytes
             FROM folder_closures fc_root
             JOIN folders rf
               ON rf.tenant_id = fc_root.tenant_id
              AND rf.id = fc_root.ancestor_id
             JOIN folder_closures fc_sub
               ON fc_sub.tenant_id = fc_root.tenant_id
              AND fc_sub.ancestor_id = ?
             JOIN files fl
               ON fl.tenant_id = fc_sub.tenant_id
              AND fl.folder_id = fc_sub.descendant_id
              AND fl.upload_state = 'active'
              AND ${deletedClause}
            WHERE fc_root.tenant_id = ?
              AND fc_root.descendant_id = ?
              AND rf.parent_id IS NULL
            GROUP BY fc_root.ancestor_id
         ) AS agg
        WHERE root_folder_stats.tenant_id = ?
          AND root_folder_stats.root_folder_id = agg.root_id`
    )
    .bind(
      input.nowIso,
      input.subtreeRootId,
      ...deletedBindings,
      input.tenantId,
      input.subtreeRootId,
      input.tenantId
    );
}

/** Seed a zeroed row when creating an empty root folder or resetting after archive. */
export function buildRootFolderResetStmt(
  db: D1Database,
  tenantId: string,
  rootFolderId: string,
  nowIso: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO root_folder_stats (
         tenant_id, root_folder_id, file_count, total_bytes, updated_at
       ) VALUES (?, ?, 0, 0, ?)
       ON CONFLICT (tenant_id, root_folder_id)
       DO UPDATE SET file_count = 0,
                     total_bytes = 0,
                     updated_at = excluded.updated_at`
    )
    .bind(tenantId, rootFolderId, nowIso);
}

/** Remove an obsolete stats row when a root folder is moved under another parent. */
export function buildRootFolderDeleteStmt(
  db: D1Database,
  tenantId: string,
  rootFolderId: string
): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM root_folder_stats
        WHERE tenant_id = ? AND root_folder_id = ?`
    )
    .bind(tenantId, rootFolderId);
}

/** Spread-friendly variant of `buildRootFolderDeltaByFolderStmt`. */
export function buildRootFolderDeltaByFolderStmts(
  db: D1Database,
  input: RootFolderFileDeltaInput,
  guard?: ConditionalWriteGuard
): D1PreparedStatement[] {
  const stmt = buildRootFolderDeltaByFolderStmt(db, input, guard);
  return stmt ? [stmt] : [];
}

/** Update both source and destination root folder stats when moving an active file. */
export function buildRootFolderFileMoveStmts(
  db: D1Database,
  input: {
    tenantId: string;
    fromFolderId: string | null;
    toFolderId: string | null;
    sizeBytes: number;
    nowIso: string;
  }
): D1PreparedStatement[] {
  if (input.fromFolderId === input.toFolderId) return [];
  return [
    ...buildRootFolderDeltaByFolderStmts(db, {
      tenantId: input.tenantId,
      folderId: input.fromFolderId,
      countDelta: -1,
      bytesDelta: -input.sizeBytes,
      nowIso: input.nowIso,
    }),
    ...buildRootFolderDeltaByFolderStmts(db, {
      tenantId: input.tenantId,
      folderId: input.toFolderId,
      countDelta: 1,
      bytesDelta: input.sizeBytes,
      nowIso: input.nowIso,
    }),
  ];
}
