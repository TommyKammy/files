import type { AuthUser } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import { buildSyncChangeStmt } from '../sync-changes';
import {
  FileRow,
  FileUploadError,
  FileVersionRow,
  getTenantQuotaStatus,
} from './shared';

export async function finalizeUploadedVersion(
  db: D1Database,
  bucket: R2Bucket,
  queue: Queue,
  user: AuthUser,
  input: {
    fileId: string;
    versionId: string;
    maxAllowedBytes?: number;
  }
): Promise<{ file: FileRow; aiClassificationQueued: boolean }> {
  const file = await db
    .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(user.tenantId, input.fileId)
    .first<FileRow>();
  if (!file) {
    throw new FileUploadError(404, 'FILE_NOT_FOUND', 'File record not found');
  }

  const version = await db
    .prepare('SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ? AND id = ?')
    .bind(user.tenantId, input.fileId, input.versionId)
    .first<FileVersionRow>();
  if (!version) {
    throw new FileUploadError(404, 'VERSION_NOT_FOUND', 'File version record not found');
  }
  if (version.upload_status !== 'pending') {
    throw new FileUploadError(409, 'INVALID_UPLOAD_STATE', `Version already in state ${version.upload_status}`);
  }

  if (version.uploaded_by !== user.id) {
    const access = await resolveTargetAccess(db, user, 'file', file.id);
    if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
      throw new FileUploadError(403, 'FORBIDDEN', 'Forbidden');
    }
  }

  // Verify real bytes in R2
  const headObj = await bucket.head(version.r2_object_key);
  if (!headObj) {
    throw new FileUploadError(
      400,
      'UPLOAD_MISSING_IN_STORAGE',
      'Uploaded object was not found in R2 storage'
    );
  }

  const markFailedCleanup = async (
    status: 400 | 409 | 413,
    code: string,
    msg: string,
    auditAction: string
  ): Promise<never> => {
    await bucket.delete(version.r2_object_key);
    const nowIso = new Date().toISOString();
    const failStmts: D1PreparedStatement[] = [
      db
        .prepare("UPDATE file_versions SET upload_status = 'failed' WHERE id = ?")
        .bind(version.id),
    ];
    if (file.upload_state === 'pending') {
      failStmts.push(
        db.prepare("UPDATE files SET upload_state = 'failed', updated_at = ? WHERE id = ?").bind(nowIso, file.id)
      );
    }
    failStmts.push(
      buildAuditLogStmt(db, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: auditAction,
        targetType: 'file',
        targetId: file.id,
        classificationSnapshot: file.classification,
        status: 'blocked',
        metadata: {
          declaredBytes: version.size_bytes,
          actualBytes: headObj.size,
          reason: code,
        },
        nowIso,
      })
    );
    await db.batch(failStmts);
    throw new FileUploadError(status, code, msg);
  };

  if (input.maxAllowedBytes !== undefined && headObj.size >= input.maxAllowedBytes) {
    await markFailedCleanup(
      413,
      'FILE_SIZE_LIMIT_EXCEEDED',
      'Uploaded object exceeded single upload size ceiling',
      'file.upload_blocked_size'
    );
  }

  if (headObj.size !== version.size_bytes) {
    await markFailedCleanup(
      400,
      'SIZE_MISMATCH',
      `Declared size (${version.size_bytes}) does not match uploaded size (${headObj.size})`,
      'file.upload_blocked_size_mismatch'
    );
  }

  const quota = await getTenantQuotaStatus(db, user.tenantId);
  const wasActive = file.upload_state === 'active';
  const netDeltaBytes = wasActive ? headObj.size - file.size_bytes : headObj.size;
  if (netDeltaBytes > 0 && quota.usedBytes + netDeltaBytes > quota.quotaBytes) {
    await markFailedCleanup(
      413,
      'QUOTA_EXCEEDED',
      'Tenant storage quota exceeded at upload finalization',
      'file.upload_blocked_quota'
    );
  }

  const nowIso = new Date().toISOString();
  const countDelta = wasActive ? 0 : 1;

  const statements: D1PreparedStatement[] = [
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

  try {
    await db.batch(statements);
  } catch (err) {
    if (((err as Error).message ?? '').includes('UNIQUE constraint failed')) {
      await markFailedCleanup(
        409,
        'FILE_ALREADY_EXISTS',
        `File "${file.name}" already exists in this folder`,
        'file.upload_blocked_conflict'
      );
    }
    throw err;
  }

  const aiClassificationQueued = file.classification === 'unset';
  if (aiClassificationQueued) {
    await queue.send({
      type: 'classify_file',
      tenantId: user.tenantId,
      fileId: file.id,
      versionId: version.id,
      r2ObjectKey: version.r2_object_key,
      mimeType: version.mime_type,
      fileName: file.name,
      extension: file.extension,
    });
  }

  const updatedFile = await db
    .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, file.id)
    .first<FileRow>();

  return {
    file: updatedFile!,
    aiClassificationQueued,
  };
}
