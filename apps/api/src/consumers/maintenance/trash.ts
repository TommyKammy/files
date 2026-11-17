import { chunkArray } from '../../utils/batch';
import {
  purgeFileRows,
  purgeFolderRows,
  type PurgeFileRow,
} from '../../services/trash-purge';

const TRASH_FILE_BATCH_SIZE = 100;
const TRASH_FOLDER_BATCH_SIZE = 50;

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
  const expiredFilesMap = new Map<string, PurgeFileRow>();
  const directExpiredRes = await db
    .prepare(
      `SELECT id, folder_id, classification, size_bytes, upload_state, created_by
         FROM files
        WHERE tenant_id = ? AND deleted_at IS NOT NULL AND deleted_at <= ?
        LIMIT ?`
    )
    .bind(tenantId, cutoffIso, TRASH_FILE_BATCH_SIZE)
    .all<PurgeFileRow>();
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
          `SELECT id, folder_id, classification, size_bytes, upload_state, created_by
             FROM files
            WHERE tenant_id = ? AND folder_id IN (${placeholders})
            LIMIT ?`
        )
        .bind(tenantId, ...fChunk, remaining)
        .all<PurgeFileRow>();
      for (const row of folderFilesRes.results) {
        expiredFilesMap.set(row.id, row);
      }
    }
  }

  const expiredFiles = [...expiredFilesMap.values()];
  const { filesPurged } = await purgeFileRows({
    db,
    bucket,
    tenantId,
    files: expiredFiles,
    nowIso,
  });

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

  const foldersPurged = await purgeFolderRows(db, safeFolderIds);

  return { filesPurged, foldersPurged };
}
