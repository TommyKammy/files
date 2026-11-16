import { buildAuditLogStmt } from './audit';
import { buildSyncChangeStmt } from './sync-changes';
import type { ConditionalWriteGuard } from './statement-guard';
import type { AuthUser } from '../types/api';
import type { FileRow, FileVersionRow } from './file-upload-common';

export interface FileVersionRestoreBatchInput {
  db: D1Database;
  user: AuthUser;
  file: FileRow;
  sourceVersion: FileVersionRow;
  newVersionId: string;
  newVersionNum: number;
  nowIso: string;
}

/**
 * Build the atomic CoW restore batch. The new `file_versions` row shares the
 * source version's immutable R2 object key (no physical copy) and is inserted
 * only when the optimistic-locked `files` update actually applied, so a losing
 * concurrent restore writes no stats/audit/sync side effects.
 */
export function buildFileVersionRestoreStatements({
  db,
  user,
  file,
  sourceVersion,
  newVersionId,
  newVersionNum,
  nowIso,
}: FileVersionRestoreBatchInput): D1PreparedStatement[] {
  const nextMetaVersion = file.meta_version + 1;
  const netDeltaBytes = sourceVersion.size_bytes - file.size_bytes;
  const restoredVersionGuard: ConditionalWriteGuard = {
    sql: 'EXISTS (SELECT 1 FROM file_versions WHERE id = ?)',
    bindings: [newVersionId],
  };

  return [
    db
      .prepare(
        `UPDATE files
            SET upload_state = 'active',
                size_bytes = ?,
                mime_type = ?,
                current_version_id = ?,
                current_version_num = ?,
                meta_version = meta_version + 1,
                updated_by = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND meta_version = ?`
      )
      .bind(
        sourceVersion.size_bytes,
        sourceVersion.mime_type,
        newVersionId,
        newVersionNum,
        user.id,
        nowIso,
        user.tenantId,
        file.id,
        file.meta_version
      ),
    db
      .prepare(
        `INSERT INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, r2_upload_id,
           size_bytes, mime_type, upload_status, uploaded_by, comment, created_at
         )
         SELECT ?, ?, ?, ?, ?, NULL, ?, ?, 'completed', ?, ?, ?
           FROM files
          WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL
            AND upload_state = 'active' AND current_version_id = ?
            AND meta_version = ?`
      )
      .bind(
        newVersionId,
        user.tenantId,
        file.id,
        newVersionNum,
        sourceVersion.r2_object_key,
        sourceVersion.size_bytes,
        sourceVersion.mime_type,
        user.id,
        `Restored from v${sourceVersion.version_num}`,
        nowIso,
        user.tenantId,
        file.id,
        newVersionId,
        nextMetaVersion
      ),
    db
      .prepare(
        `DELETE FROM files_fts
          WHERE file_id = ? AND EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
      )
      .bind(file.id, newVersionId),
    db
      .prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM file_versions WHERE id = ?)`
      )
      .bind(
        file.id,
        user.tenantId,
        file.classification,
        file.name,
        file.extension ?? '',
        file.ai_reason ?? '',
        newVersionId
      ),
    db
      .prepare(
        `INSERT INTO tenant_storage_stats (
           tenant_id, classification, file_count, total_bytes, updated_at
         )
         SELECT ?, ?, 0, MAX(0, ?), ?
          WHERE EXISTS (SELECT 1 FROM file_versions WHERE id = ?)
         ON CONFLICT (tenant_id, classification)
         DO UPDATE SET total_bytes = MAX(0, total_bytes + ?),
                       updated_at = excluded.updated_at`
      )
      .bind(
        user.tenantId,
        file.classification,
        netDeltaBytes,
        nowIso,
        newVersionId,
        netDeltaBytes
      ),
    buildAuditLogStmt(
      db,
      {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'file.version.restore',
        targetType: 'file',
        targetId: file.id,
        classificationSnapshot: file.classification,
        metadata: {
          fileId: file.id,
          versionId: newVersionId,
          versionNum: newVersionNum,
          newVersionNum,
          restoredFromVersionId: sourceVersion.id,
          restoredFromVersionNum: sourceVersion.version_num,
          description: `restored from v${sourceVersion.version_num}`,
        },
        nowIso,
      },
      restoredVersionGuard
    ),
    buildSyncChangeStmt(
      db,
      {
        tenantId: user.tenantId,
        entityType: 'file',
        entityId: file.id,
        folderId: file.folder_id,
        action: 'file.version_restored',
        payload: {
          name: file.name,
          sizeBytes: sourceVersion.size_bytes,
          mimeType: sourceVersion.mime_type,
          currentVersionNum: newVersionNum,
          metaVersion: nextMetaVersion,
          versionId: newVersionId,
          restoredFromVersionId: sourceVersion.id,
          restoredFromVersionNum: sourceVersion.version_num,
          updatedAt: nowIso,
        },
        nowIso,
      },
      restoredVersionGuard
    ),
  ];
}
