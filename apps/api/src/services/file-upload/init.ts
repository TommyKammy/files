import type { AuthUser, ClassificationLabel } from '../../types/api';
import { pickStricterClassification } from '../../utils/classification';
import { resolveTargetAccess } from '../authorization';
import { can } from '../capabilities';
import {
  FileUploadError,
  MULTIPART_MAX_BYTES,
  SINGLE_UPLOAD_MAX_BYTES,
  buildR2ObjectKey,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from './shared';

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
  let folderAccess: Awaited<ReturnType<typeof resolveTargetAccess>> = null;
  if (input.folderId !== null) {
    folderAccess = await resolveTargetAccess(db, user, 'folder', input.folderId);
    if (!folderAccess || folderAccess.deletedAt !== null) {
      throw new FileUploadError(404, 'FOLDER_NOT_FOUND', 'Target folder not found');
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
    // Overwriting an existing active file creates a new version; the
    // new-upload-only roles (`uploader`, `previewer_uploader`) must be denied.
    if (!can(fileAccess?.capabilities, 'item.upload_version')) {
      throw new FileUploadError(
        403,
        'FORBIDDEN',
        'Permission required to upload a new version of an existing file'
      );
    }
  } else if (folderAccess && !can(folderAccess.capabilities, 'item.upload_new')) {
    throw new FileUploadError(
      403,
      'FORBIDDEN',
      'Permission required to upload new files to folder'
    );
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
