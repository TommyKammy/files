import type { ClassificationLabel } from '../../types/api';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import {
  buildInClauseDeleteStmts,
  deleteR2ObjectsAndAbortMultipart,
  fetchVersionObjectsForFiles,
} from './r2-gc';

const TRASH_FILE_BATCH_SIZE = 100;
const TRASH_FOLDER_BATCH_SIZE = 50;

interface ExpiredTrashFileRow {
  id: string;
  classification: ClassificationLabel;
  size_bytes: number;
  upload_state: 'pending' | 'active' | 'failed';
}

interface ExpiredTrashFolderRow {
  id: string;
}

export async function purgeExpiredTrashForTenant(
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
