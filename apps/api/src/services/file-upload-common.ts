import type { AuthUser, ClassificationLabel } from '../types/api';
import { pickStricterClassification } from '../utils/classification';
import { buildAuditLogStmt } from './audit';
import { hasAtLeastRole, resolveTargetAccess } from './authorization';
import { buildSyncChangeStmt } from './sync-changes';

export const SINGLE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // < 100 MiB for single PUT
export const MULTIPART_MAX_BYTES = 5_492_059_111_424; // ~4.995 TiB max S3 object size

export class FileUploadError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 413,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'FileUploadError';
  }
}

export interface FileRow {
  id: string;
  tenant_id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string;
  size_bytes: number;
  upload_state: 'pending' | 'active' | 'failed';
  current_version_id: string | null;
  current_version_num: number;
  meta_version: number;
  classification: ClassificationLabel;
  ai_suggested_label: ClassificationLabel | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  deleted_at: string | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface FileVersionRow {
  id: string;
  tenant_id: string;
  file_id: string;
  version_num: number;
  r2_object_key: string;
  r2_upload_id: string | null;
  size_bytes: number;
  mime_type: string;
  upload_status: 'pending' | 'completed' | 'failed';
  uploaded_by: string;
  created_at: string;
}

export function buildR2ObjectKey(tenantId: string, fileId: string, versionNum: number): string {
  return `tenants/${tenantId}/objects/${fileId}/v${versionNum}`;
}

export function validateFileNameAndExt(rawName: unknown): {
  name: string;
  extension: string | null;
} {
  if (typeof rawName !== 'string') {
    throw new FileUploadError(400, 'INVALID_FILENAME', 'fileName must be a string');
  }
  const name = rawName.trim();
  if (!name || name.length > 255) {
    throw new FileUploadError(400, 'INVALID_FILENAME', 'fileName must be 1-255 characters');
  }
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new FileUploadError(400, 'INVALID_FILENAME', 'fileName contains invalid characters');
  }
  const lastDot = name.lastIndexOf('.');
  const extension =
    lastDot > 0 && lastDot < name.length - 1
      ? name.slice(lastDot + 1).toLowerCase()
      : null;
  return { name, extension };
}

export async function getTenantQuotaStatus(
  db: D1Database,
  tenantId: string
): Promise<{ quotaBytes: number; usedBytes: number; remainingBytes: number }> {
  const row = await db
    .prepare(
      `SELECT t.storage_quota_bytes,
              COALESCE((SELECT SUM(s.total_bytes) FROM tenant_storage_stats s WHERE s.tenant_id = t.id), 0) AS used_bytes
         FROM tenants t
        WHERE t.id = ?`
    )
    .bind(tenantId)
    .first<{ storage_quota_bytes: number; used_bytes: number }>();

  if (!row) {
    throw new FileUploadError(404, 'TENANT_NOT_FOUND', 'Tenant not found');
  }

  return {
    quotaBytes: row.storage_quota_bytes,
    usedBytes: row.used_bytes,
    remainingBytes: Math.max(0, row.storage_quota_bytes - row.used_bytes),
  };
}

/**
 * Initialize a pending file + version record after checking folder RBAC, inherited classification,
 * duplicate active file policy, and tenant storage quota.
 */
export async function initializePendingUpload(
  db: D1Database,
  user: AuthUser,
  input: {
    folderId: string | null;
    fileName: unknown;
    mimeType: string;
    sizeBytes: number;
    requestedClassification?: ClassificationLabel;
    conflictPolicy?: 'fail' | 'new_version';
    r2UploadId?: string | null;
    multipart?: boolean;
  }
): Promise<{
  fileId: string;
  versionId: string;
  versionNum: number;
  r2ObjectKey: string;
  classification: ClassificationLabel;
  isNewVersion: boolean;
  fileName: string;
  extension: string | null;
}> {
  const { name, extension } = validateFileNameAndExt(input.fileName);
  const mimeType = input.mimeType.trim() || 'application/octet-stream';

  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new FileUploadError(400, 'INVALID_SIZE', 'sizeBytes must be a non-negative integer');
  }
  if (!input.multipart && input.sizeBytes >= SINGLE_UPLOAD_MAX_BYTES) {
    throw new FileUploadError(
      400,
      'USE_MULTIPART_UPLOAD',
      'Files >= 100 MiB must use multipart upload endpoints'
    );
  }
  if (input.sizeBytes > MULTIPART_MAX_BYTES) {
    throw new FileUploadError(400, 'FILE_TOO_LARGE', 'File exceeds maximum 4.995 TiB limit');
  }

  let inheritedClassification: ClassificationLabel = 'unset';
  if (input.folderId !== null) {
    const folderAccess = await resolveTargetAccess(db, user, 'folder', input.folderId);
    if (!folderAccess || folderAccess.deletedAt !== null) {
      throw new FileUploadError(404, 'FOLDER_NOT_FOUND', 'Target folder not found');
    }
    if (!hasAtLeastRole(folderAccess.effectiveRole, 'editor')) {
      throw new FileUploadError(403, 'FORBIDDEN', 'Editor permission required to upload to folder');
    }
    inheritedClassification = folderAccess.classification;

    // Also inspect ancestors to guarantee strictest ancestor policy is honored
    const ancClassRow = await db
      .prepare(
        `SELECT MAX(CASE f.classification
          WHEN 'confidential' THEN 3
          WHEN 'internal' THEN 2
          WHEN 'public' THEN 1
          ELSE 0
        END) AS max_cls
           FROM folder_closures fc
           JOIN folders f ON f.id = fc.ancestor_id
          WHERE fc.tenant_id = ? AND fc.descendant_id = ?`
      )
      .bind(user.tenantId, input.folderId)
      .first<{ max_cls: number | null }>();
    const mapCls: Record<number, ClassificationLabel> = {
      0: 'unset',
      1: 'public',
      2: 'internal',
      3: 'confidential',
    };
    const ancLabel = ancClassRow?.max_cls ? mapCls[ancClassRow.max_cls] ?? 'unset' : 'unset';
    inheritedClassification = pickStricterClassification(inheritedClassification, ancLabel);
  }

  const existing = await db
    .prepare(
      `SELECT id, size_bytes, current_version_num, classification
         FROM files
        WHERE tenant_id = ?
          AND COALESCE(folder_id, '__ROOT__') = COALESCE(?, '__ROOT__')
          AND name = ?
          AND deleted_at IS NULL
          AND upload_state = 'active'`
    )
    .bind(user.tenantId, input.folderId, name)
    .first<{
      id: string;
      size_bytes: number;
      current_version_num: number;
      classification: ClassificationLabel;
    }>();

  if (existing && input.conflictPolicy !== 'new_version') {
    throw new FileUploadError(
      409,
      'FILE_ALREADY_EXISTS',
      `File "${name}" already exists in this folder`
    );
  }

  if (existing) {
    const fileAccess = await resolveTargetAccess(db, user, 'file', existing.id);
    if (!hasAtLeastRole(fileAccess?.effectiveRole, 'editor')) {
      throw new FileUploadError(403, 'FORBIDDEN', 'Editor permission required to upload new version');
    }
  }

  const quota = await getTenantQuotaStatus(db, user.tenantId);
  const additionalBytes = existing
    ? Math.max(0, input.sizeBytes - existing.size_bytes)
    : input.sizeBytes;
  if (quota.usedBytes + additionalBytes > quota.quotaBytes) {
    throw new FileUploadError(
      413,
      'QUOTA_EXCEEDED',
      `Tenant storage quota exceeded (remaining ${quota.remainingBytes} bytes)`
    );
  }

  const fileId = existing ? existing.id : crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const versionNum = existing ? existing.current_version_num + 1 : 1;
  const r2ObjectKey = buildR2ObjectKey(user.tenantId, fileId, versionNum);
  const effectiveBaseCls = existing
    ? pickStricterClassification(inheritedClassification, existing.classification)
    : inheritedClassification;
  const classification = input.requestedClassification
    ? pickStricterClassification(effectiveBaseCls, input.requestedClassification)
    : effectiveBaseCls;

  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  if (!existing) {
    statements.push(
      db
        .prepare(
          `INSERT INTO files (
             id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
             upload_state, current_version_id, current_version_num, classification,
             created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, ?, ?)`
        )
        .bind(
          fileId,
          user.tenantId,
          input.folderId,
          name,
          extension,
          mimeType,
          input.sizeBytes,
          versionId,
          classification,
          user.id,
          user.id,
          nowIso,
          nowIso
        )
    );

    if (input.folderId === null) {
      statements.push(
        db
          .prepare(
            `INSERT INTO permissions (
               id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
             ) VALUES (?, ?, 'file', ?, 'user', ?, 'owner', ?, ?)`
          )
          .bind(crypto.randomUUID(), user.tenantId, fileId, user.id, user.id, nowIso)
      );
    }
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, r2_upload_id,
           size_bytes, mime_type, upload_status, uploaded_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        versionId,
        user.tenantId,
        fileId,
        versionNum,
        r2ObjectKey,
        input.r2UploadId ?? null,
        input.sizeBytes,
        mimeType,
        user.id,
        nowIso
      )
  );

  await db.batch(statements);

  return {
    fileId,
    versionId,
    versionNum,
    r2ObjectKey,
    classification,
    isNewVersion: Boolean(existing),
    fileName: name,
    extension,
  };
}

/**
 * Verify uploaded R2 object metadata via `BUCKET.head()`, re-validate quota,
 * atomically activate metadata + FTS5 + `tenant_storage_stats` in one `DB.batch()`,
 * and enqueue AI classification if `classification === 'unset'`.
 */
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
