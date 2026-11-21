import { buildAuditLogStmt } from '../../services/audit';
import { checkPurgeProtection } from '../../services/legal-hold';
import {
  purgeFileRows,
  purgeFolderRows,
  type PurgeFileRow,
} from '../../services/trash-purge';
import { chunkArray, executeBatchChunks } from '../../utils/batch';

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
      `SELECT id, folder_id, deleted_at, classification, size_bytes, upload_state, created_by
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
          `SELECT id, folder_id, deleted_at, classification, size_bytes, upload_state, created_by
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

  const blockedAuditStmts: D1PreparedStatement[] = [];
  const purgeableFiles: PurgeFileRow[] = [];
  for (const file of expiredFilesMap.values()) {
    const protection = await checkPurgeProtection(
      db,
      tenantId,
      'file',
      file.id,
      {
        createdBy: file.created_by,
        classification: file.classification,
        nowIso,
      }
    );
    if (protection.blocked) {
      console.info(
        `[trash.purge_blocked_legal_hold] skipped file ${file.id} (${protection.reason})`
      );
      blockedAuditStmts.push(
        buildAuditLogStmt(db, {
          tenantId,
          actorId: null,
          actorEmail: null,
          actorIp: null,
          action: 'trash.purge_blocked_legal_hold',
          targetType: 'file',
          targetId: file.id,
          classificationSnapshot: file.classification,
          status: 'blocked',
          metadata: {
            reason: protection.reason,
            holdName: protection.holdName ?? null,
            policyName: protection.policyName ?? null,
          },
          nowIso,
        })
      );
      continue;
    }
    purgeableFiles.push(file);
  }

  const { filesPurged } = await purgeFileRows({
    db,
    bucket,
    tenantId,
    files: purgeableFiles,
    nowIso,
  });

  // Only delete expired folders that have no remaining child folders or files and are not protected
  const safeFolderIds: string[] = [];
  for (const folderId of candidateFolderIds) {
    const protection = await checkPurgeProtection(
      db,
      tenantId,
      'folder',
      folderId,
      { nowIso }
    );
    if (protection.blocked) {
      console.info(
        `[trash.purge_blocked_legal_hold] skipped folder ${folderId} (${protection.reason})`
      );
      blockedAuditStmts.push(
        buildAuditLogStmt(db, {
          tenantId,
          actorId: null,
          actorEmail: null,
          actorIp: null,
          action: 'trash.purge_blocked_legal_hold',
          targetType: 'folder',
          targetId: folderId,
          status: 'blocked',
          metadata: {
            reason: protection.reason,
            holdName: protection.holdName ?? null,
            policyName: protection.policyName ?? null,
          },
          nowIso,
        })
      );
      continue;
    }

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

  if (blockedAuditStmts.length > 0) {
    await executeBatchChunks(db, blockedAuditStmts, 30);
  }

  const foldersPurged = await purgeFolderRows(db, safeFolderIds);

  return { filesPurged, foldersPurged };
}
