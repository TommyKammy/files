import type { AuthUser } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import {
  FileRow,
  FileUploadError,
  FileVersionRow,
  getTenantQuotaStatus,
} from './shared';

export interface FinalizeVerification {
  file: FileRow;
  version: FileVersionRow;
  headObj: R2Object;
  wasActive: boolean;
  netDeltaBytes: number;
  countDelta: number;
  markFailedCleanup: (
    status: 400 | 409 | 413,
    code: string,
    msg: string,
    auditAction: string
  ) => Promise<never>;
}

export async function verifyFinalizeUpload(
  db: D1Database,
  bucket: R2Bucket,
  user: AuthUser,
  input: {
    fileId: string;
    versionId: string;
    maxAllowedBytes?: number;
  }
): Promise<FinalizeVerification> {
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
    throw new FileUploadError(
      409,
      'INVALID_UPLOAD_STATE',
      `Version already in state ${version.upload_status}`
    );
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
        db
          .prepare("UPDATE files SET upload_state = 'failed', updated_at = ? WHERE id = ?")
          .bind(nowIso, file.id)
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

  return {
    file,
    version,
    headObj,
    wasActive,
    netDeltaBytes,
    countDelta: wasActive ? 0 : 1,
    markFailedCleanup,
  };
}
