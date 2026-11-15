import { purgeExpiredSyncChanges } from '../services/sync-changes';
import type { ClassificationLabel, Env } from '../types/api';
import { chunkArray, executeBatchChunks } from '../utils/batch';

const SESSION_DELETE_BATCH_SIZE = 500;
const SESSION_MAX_ROUNDS = 10;
const STALE_PENDING_HOURS = 24;
const CLEANUP_FILE_BATCH_SIZE = 50;
const TRASH_FILE_BATCH_SIZE = 100;
const TRASH_FOLDER_BATCH_SIZE = 50;
const R2_DELETE_CHUNK_SIZE = 100;

export interface MaintenanceSummary {
  sessionsDeleted: number;
  pendingFilesDeleted: number;
  pendingVersionsDeleted: number;
  trashedFilesPurged: number;
  trashedFoldersPurged: number;
  syncChangesPurged: number;
}

interface PendingFileRow {
  id: string;
}

interface FileVersionObjectRow {
  id: string;
  file_id: string;
  r2_object_key: string;
  r2_upload_id: string | null;
}

interface TenantPolicyRetentionRow {
  tenant_id: string;
  trash_retention_days: number;
}

interface ExpiredTrashFileRow {
  id: string;
  classification: ClassificationLabel;
  size_bytes: number;
  upload_state: 'pending' | 'active' | 'failed';
}

interface ExpiredTrashFolderRow {
  id: string;
}

/**
 * Determine which R2 object keys from `candidateVersions` have zero remaining
 * references in `file_versions` outside this deletion batch (CoW GC protection).
 */
export async function selectUnreferencedR2Keys(
  db: D1Database,
  candidateVersions: ReadonlyArray<Pick<FileVersionObjectRow, 'id' | 'r2_object_key'>>
): Promise<string[]> {
  if (candidateVersions.length === 0) return [];

  const uniqueVersions = new Map<string, string>();
  for (const row of candidateVersions) {
    if (row.id && row.r2_object_key) {
      uniqueVersions.set(row.id, row.r2_object_key);
    }
  }

  const candidateCountByKey = new Map<string, number>();
  for (const key of uniqueVersions.values()) {
    candidateCountByKey.set(key, (candidateCountByKey.get(key) ?? 0) + 1);
  }

  const uniqueKeys = [...candidateCountByKey.keys()];
  const totalRefsByKey = new Map<string, number>();

  for (const keyChunk of chunkArray(uniqueKeys, 30)) {
    const placeholders = keyChunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT r2_object_key, COUNT(*) AS total_refs
           FROM file_versions
          WHERE r2_object_key IN (${placeholders})
          GROUP BY r2_object_key`
      )
      .bind(...keyChunk)
      .all<{ r2_object_key: string; total_refs: number }>();

    for (const row of res.results) {
      totalRefsByKey.set(row.r2_object_key, Number(row.total_refs ?? 0));
    }
  }

  return uniqueKeys.filter((key) => {
    const totalRefs = totalRefsByKey.get(key) ?? 0;
    const batchRefs = candidateCountByKey.get(key) ?? 0;
    return totalRefs <= batchRefs;
  });
}

async function deleteR2ObjectsAndAbortMultipart(
  db: D1Database,
  bucket: R2Bucket,
  objects: ReadonlyArray<FileVersionObjectRow>
): Promise<void> {
  if (objects.length === 0) return;

  const deletableKeys = await selectUnreferencedR2Keys(db, objects);
  const deletableKeySet = new Set(deletableKeys);

  for (const obj of objects) {
    if (obj.r2_upload_id && deletableKeySet.has(obj.r2_object_key)) {
      try {
        await bucket.resumeMultipartUpload(obj.r2_object_key, obj.r2_upload_id).abort();
      } catch {
        // Upload may already be completed/aborted; proceed to object deletion
      }
    }
  }

  for (const keyChunk of chunkArray(deletableKeys, R2_DELETE_CHUNK_SIZE)) {
    await bucket.delete(keyChunk);
  }
}

function buildInClauseDeleteStmts(
  db: D1Database,
  table: string,
  column: string,
  ids: readonly string[],
  extraWhere = ''
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const chunk of chunkArray(ids, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const whereClause = extraWhere
      ? `${extraWhere} AND ${column} IN (${placeholders})`
      : `${column} IN (${placeholders})`;
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE ${whereClause}`).bind(...chunk));
  }
  return stmts;
}

async function fetchVersionObjectsForFiles(
  db: D1Database,
  fileIds: readonly string[]
): Promise<FileVersionObjectRow[]> {
  const rows: FileVersionObjectRow[] = [];
  for (const chunk of chunkArray(fileIds, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT id, file_id, r2_object_key, r2_upload_id
           FROM file_versions
          WHERE file_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<FileVersionObjectRow>();
    rows.push(...res.results);
  }
  return rows;
}

async function purgeExpiredOrRevokedSessions(db: D1Database, nowIso: string): Promise<number> {
  let totalDeleted = 0;
  for (let round = 0; round < SESSION_MAX_ROUNDS; round++) {
    const res = await db
      .prepare(
        `DELETE FROM sessions
          WHERE id IN (
            SELECT id FROM sessions
             WHERE expires_at <= ? OR revoked_at IS NOT NULL
             LIMIT ?
          )`
      )
      .bind(nowIso, SESSION_DELETE_BATCH_SIZE)
      .run();
    const deleted = res.meta.changes ?? 0;
    totalDeleted += deleted;
    if (deleted < SESSION_DELETE_BATCH_SIZE) break;
  }
  return totalDeleted;
}

async function cleanupStalePendingUploads(
  db: D1Database,
  bucket: R2Bucket,
  nowMs: number
): Promise<{ pendingFilesDeleted: number; pendingVersionsDeleted: number }> {
  const cutoffIso = new Date(nowMs - STALE_PENDING_HOURS * 3600_000).toISOString();

  // 1. Clean up stale pending/failed initial file uploads older than 24h
  const staleFiles = await db
    .prepare(
      `SELECT id
         FROM files
        WHERE upload_state IN ('pending', 'failed')
          AND created_at <= ?
        LIMIT ?`
    )
    .bind(cutoffIso, CLEANUP_FILE_BATCH_SIZE)
    .all<PendingFileRow>();

  const staleFileIds = staleFiles.results.map((r) => r.id);
  if (staleFileIds.length > 0) {
    const versions = await fetchVersionObjectsForFiles(db, staleFileIds);
    await deleteR2ObjectsAndAbortMultipart(db, bucket, versions);

    const stmts: D1PreparedStatement[] = [
      ...staleFileIds.map((fid) =>
        db.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(fid)
      ),
      ...buildInClauseDeleteStmts(db, 'permissions', 'target_id', staleFileIds, "target_type = 'file'"),
      ...buildInClauseDeleteStmts(db, 'shared_links', 'target_id', staleFileIds, "target_type = 'file'"),
      ...buildInClauseDeleteStmts(db, 'file_versions', 'file_id', staleFileIds),
      ...buildInClauseDeleteStmts(db, 'files', 'id', staleFileIds),
    ];
    await executeBatchChunks(db, stmts);
  }

  // 2. Clean up orphan pending/failed replacement versions on existing active files older than 24h
  const staleVersions = await db
    .prepare(
      `SELECT fv.id, fv.file_id, fv.r2_object_key, fv.r2_upload_id
         FROM file_versions fv
         JOIN files f ON f.id = fv.file_id
        WHERE fv.upload_status IN ('pending', 'failed')
          AND fv.created_at <= ?
          AND (f.current_version_id IS NULL OR f.current_version_id != fv.id)
        LIMIT ?`
    )
    .bind(cutoffIso, CLEANUP_FILE_BATCH_SIZE)
    .all<FileVersionObjectRow>();

  const orphanVersions = staleVersions.results;
  if (orphanVersions.length > 0) {
    await deleteR2ObjectsAndAbortMultipart(db, bucket, orphanVersions);
    const stmts = buildInClauseDeleteStmts(
      db,
      'file_versions',
      'id',
      orphanVersions.map((v) => v.id)
    );
    await executeBatchChunks(db, stmts);
  }

  return {
    pendingFilesDeleted: staleFileIds.length,
    pendingVersionsDeleted: orphanVersions.length,
  };
}

async function purgeExpiredTrashForTenant(
  db: D1Database,
  bucket: R2Bucket,
  tenantId: string,
  cutoffIso: string,
  nowIso: string
): Promise<{ filesPurged: number; foldersPurged: number }> {
  // Select expired deleted folders ordered deepest-first
  const expiredFoldersRes = await db
    .prepare(
      `SELECT id
         FROM folders
        WHERE tenant_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?
        ORDER BY depth DESC, id ASC
        LIMIT ?`
    )
    .bind(tenantId, cutoffIso, TRASH_FOLDER_BATCH_SIZE)
    .all<ExpiredTrashFolderRow>();
  const candidateFolderIds = expiredFoldersRes.results.map((r) => r.id);

  // Gather expired trashed files directly marked deleted <= cutoffIso
  const expiredFilesMap = new Map<string, ExpiredTrashFileRow>();
  const directExpiredRes = await db
    .prepare(
      `SELECT id, classification, size_bytes, upload_state
         FROM files
        WHERE tenant_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?
        LIMIT ?`
    )
    .bind(tenantId, cutoffIso, TRASH_FILE_BATCH_SIZE)
    .all<ExpiredTrashFileRow>();
  for (const row of directExpiredRes.results) {
    expiredFilesMap.set(row.id, row);
  }

  // Also include any files inside expired deleted folders before folder cascade deletes D1 rows
  if (candidateFolderIds.length > 0 && expiredFilesMap.size < TRASH_FILE_BATCH_SIZE) {
    for (const fChunk of chunkArray(candidateFolderIds, 30)) {
      const remaining = TRASH_FILE_BATCH_SIZE - expiredFilesMap.size;
      if (remaining <= 0) break;
      const placeholders = fChunk.map(() => '?').join(', ');
      const folderFilesRes = await db
        .prepare(
          `SELECT id, classification, size_bytes, upload_state
             FROM files
            WHERE tenant_id = ? AND folder_id IN (${placeholders})
            LIMIT ?`
        )
        .bind(tenantId, ...fChunk, remaining)
        .all<ExpiredTrashFileRow>();
      for (const row of folderFilesRes.results) {
        expiredFilesMap.set(row.id, row);
      }
    }
  }

  const expiredFiles = [...expiredFilesMap.values()];
  const expiredFileIds = expiredFiles.map((f) => f.id);

  if (expiredFileIds.length > 0) {
    const versions = await fetchVersionObjectsForFiles(db, expiredFileIds);
    await deleteR2ObjectsAndAbortMultipart(db, bucket, versions);

    // Track stats deltas only for files whose upload had reached 'active'
    const statsDelta = new Map<ClassificationLabel, { count: number; bytes: number }>();
    for (const f of expiredFiles) {
      if (f.upload_state !== 'active') continue;
      const prev = statsDelta.get(f.classification) ?? { count: 0, bytes: 0 };
      statsDelta.set(f.classification, {
        count: prev.count + 1,
        bytes: prev.bytes + f.size_bytes,
      });
    }

    const stmts: D1PreparedStatement[] = [
      ...expiredFileIds.map((fid) =>
        db.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(fid)
      ),
      ...buildInClauseDeleteStmts(db, 'permissions', 'target_id', expiredFileIds, "target_type = 'file'"),
      ...buildInClauseDeleteStmts(db, 'shared_links', 'target_id', expiredFileIds, "target_type = 'file'"),
      ...buildInClauseDeleteStmts(db, 'file_versions', 'file_id', expiredFileIds),
      ...buildInClauseDeleteStmts(db, 'files', 'id', expiredFileIds),
    ];

    for (const [classification, delta] of statsDelta.entries()) {
      stmts.push(
        db
          .prepare(
            `UPDATE tenant_storage_stats
                SET file_count = MAX(0, file_count - ?),
                    total_bytes = MAX(0, total_bytes - ?),
                    updated_at = ?
              WHERE tenant_id = ? AND classification = ?`
          )
          .bind(delta.count, delta.bytes, nowIso, tenantId, classification)
      );
    }

    await executeBatchChunks(db, stmts);
  }

  // Only delete expired folders that have no remaining child folders or files
  const safeFolderIds: string[] = [];
  for (const folderId of candidateFolderIds) {
    const childCheck = await db
      .prepare(
        `SELECT (
           (SELECT COUNT(*) FROM folders WHERE parent_id = ?) +
           (SELECT COUNT(*) FROM files WHERE folder_id = ?)
         ) AS remaining_children`
      )
      .bind(folderId, folderId)
      .first<{ remaining_children: number }>();
    if ((childCheck?.remaining_children ?? 0) === 0) {
      safeFolderIds.push(folderId);
    }
  }

  if (safeFolderIds.length > 0) {
    const folderStmts: D1PreparedStatement[] = [
      ...buildInClauseDeleteStmts(db, 'permissions', 'target_id', safeFolderIds, "target_type = 'folder'"),
      ...buildInClauseDeleteStmts(db, 'shared_links', 'target_id', safeFolderIds, "target_type = 'folder'"),
      ...safeFolderIds.map((fid) =>
        db
          .prepare('DELETE FROM folder_closures WHERE ancestor_id = ? OR descendant_id = ?')
          .bind(fid, fid)
      ),
      ...buildInClauseDeleteStmts(db, 'folders', 'id', safeFolderIds),
    ];
    await executeBatchChunks(db, folderStmts);
  }

  return {
    filesPurged: expiredFileIds.length,
    foldersPurged: safeFolderIds.length,
  };
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
