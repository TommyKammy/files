import { executeBatchChunks } from '../../utils/batch';
import {
  buildInClauseDeleteStmts,
  deleteR2ObjectsAndAbortMultipart,
  fetchVersionObjectsForFiles,
  type FileVersionObjectRow,
} from './r2-gc';

const STALE_PENDING_HOURS = 24;
const CLEANUP_FILE_BATCH_SIZE = 50;

interface PendingFileRow {
  id: string;
}

export async function cleanupStalePendingUploads(
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
