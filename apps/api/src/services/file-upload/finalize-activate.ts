import type { AuthUser } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import { buildSyncChangeStmt } from '../sync-changes';
import type { FileRow, FileVersionRow } from './shared';

export function buildFinalizeActivationStatements({
  db,
  user,
  file,
  version,
  headObj,
  nowIso,
  netDeltaBytes,
  countDelta,
}: {
  db: D1Database;
  user: AuthUser;
  file: FileRow;
  version: FileVersionRow;
  headObj: R2Object;
  nowIso: string;
  netDeltaBytes: number;
  countDelta: number;
}): D1PreparedStatement[] {
  return [
    db
      .prepare("UPDATE file_versions SET upload_status = 'completed', size_bytes = ? WHERE id = ?")
      .bind(headObj.size, version.id),
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
          WHERE tenant_id = ? AND id = ?`
      )
      .bind(
        headObj.size,
        version.mime_type,
        version.id,
        version.version_num,
        user.id,
        nowIso,
        user.tenantId,
        file.id
      ),
    db.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(file.id),
    db
      .prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        file.id,
        user.tenantId,
        file.classification,
        file.name,
        file.extension ?? '',
        file.ai_reason ?? ''
      ),
    db
      .prepare(
        `INSERT INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, classification)
         DO UPDATE SET file_count = MAX(0, file_count + ?),
                       total_bytes = MAX(0, total_bytes + ?),
                       updated_at = excluded.updated_at`
      )
      .bind(
        user.tenantId,
        file.classification,
        Math.max(0, countDelta),
        Math.max(0, netDeltaBytes),
        nowIso,
        countDelta,
        netDeltaBytes
      ),
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file.upload_complete',
      targetType: 'file',
      targetId: file.id,
      classificationSnapshot: file.classification,
      metadata: {
        versionId: version.id,
        versionNum: version.version_num,
        sizeBytes: headObj.size,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'file',
      entityId: file.id,
      folderId: file.folder_id,
      action: 'file.upload_complete',
      payload: {
        name: file.name,
        extension: file.extension,
        folderId: file.folder_id,
        sizeBytes: headObj.size,
        mimeType: version.mime_type,
        currentVersionNum: version.version_num,
        metaVersion: file.meta_version + 1,
        classification: file.classification,
        updatedAt: nowIso,
      },
      nowIso,
    }),
  ];
}
