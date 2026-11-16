import type { ClassificationLabel } from '../types/api';
import { pickStricterClassification } from '../utils/classification';
import {
  FileUploadError,
  SINGLE_UPLOAD_MAX_BYTES,
  buildR2ObjectKey,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from './file-upload/shared';

interface SharedLinkUploadFileRow {
  id: string;
  name: string;
  extension: string | null;
  mime_type: string;
  size_bytes: number;
  current_version_num: number;
  classification: ClassificationLabel;
}

export interface SharedLinkTargetInfo {
  classification: ClassificationLabel;
  folderId: string | null;
  isConfidential: boolean;
  file: SharedLinkUploadFileRow | null;
  folderName: string | null;
}

async function strictestAncestorClassification(
  db: D1Database,
  tenantId: string,
  folderId: string | null
): Promise<ClassificationLabel> {
  if (!folderId) return 'unset';
  const row = await db
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
    .bind(tenantId, folderId)
    .first<{ max_cls: number | null }>();
  const map: Record<number, ClassificationLabel> = {
    0: 'unset',
    1: 'public',
    2: 'internal',
    3: 'confidential',
  };
  return row?.max_cls !== null && row?.max_cls !== undefined
    ? map[row.max_cls] ?? 'unset'
    : 'unset';
}

export async function isFileConfidential(
  db: D1Database,
  tenantId: string,
  classification: ClassificationLabel,
  folderId: string | null
): Promise<boolean> {
  const ancestor = await strictestAncestorClassification(db, tenantId, folderId);
  return pickStricterClassification(classification, ancestor) === 'confidential';
}

export async function resolveSharedLinkTargetInfo(
  db: D1Database,
  tenantId: string,
  targetType: 'file' | 'folder',
  targetId: string
): Promise<SharedLinkTargetInfo | null> {
  if (targetType === 'file') {
    const file = await db
      .prepare(
        `SELECT id, name, extension, mime_type, size_bytes, current_version_num,
                classification, folder_id
           FROM files
          WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND upload_state = 'active'`
      )
      .bind(tenantId, targetId)
      .first<SharedLinkUploadFileRow & { folder_id: string | null }>();
    if (!file) return null;
    const ancestor = await strictestAncestorClassification(db, tenantId, file.folder_id);
    const classification = pickStricterClassification(file.classification, ancestor);
    return {
      classification,
      folderId: file.folder_id,
      isConfidential: classification === 'confidential',
      file: {
        id: file.id,
        name: file.name,
        extension: file.extension,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        current_version_num: file.current_version_num,
        classification: file.classification,
      },
      folderName: null,
    };
  }

  const folder = await db
    .prepare(
      'SELECT id, name, classification FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
    )
    .bind(tenantId, targetId)
    .first<{ id: string; name: string; classification: ClassificationLabel }>();
  if (!folder) return null;
  const ancestor = await strictestAncestorClassification(db, tenantId, folder.id);
  const classification = pickStricterClassification(folder.classification, ancestor);
  return {
    classification,
    folderId: folder.id,
    isConfidential: classification === 'confidential',
    file: null,
    folderName: folder.name,
  };
}

export interface SharedLinkUploadInitResult {
  fileId: string;
  versionId: string;
  versionNum: number;
  r2ObjectKey: string;
  fileName: string;
  classification: ClassificationLabel;
  isNewVersion: boolean;
}

/**
 * Shared-link version of `initializePendingUpload`. It authorizes against the
 * link (validated by the caller) instead of RBAC grants, so anonymous public
 * edit links can create pending rows for the shared folder only.
 */
export async function initializeSharedLinkPendingUpload(
  db: D1Database,
  input: {
    tenantId: string;
    actorUserId: string;
    targetType: 'file' | 'folder';
    targetId: string;
    requestedFileId?: string | null;
    fileName: unknown;
    mimeType: string;
    sizeBytes: number;
    conflictPolicy: 'fail' | 'new_version';
    target: SharedLinkTargetInfo;
  }
): Promise<SharedLinkUploadInitResult> {
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new FileUploadError(400, 'INVALID_SIZE', 'sizeBytes must be a non-negative integer');
  }
  if (input.sizeBytes >= SINGLE_UPLOAD_MAX_BYTES) {
    throw new FileUploadError(
      400,
      'USE_MULTIPART_UPLOAD',
      'Shared-link uploads must be smaller than 100 MiB'
    );
  }
  if (input.target.isConfidential) {
    throw new FileUploadError(
      403,
      'CONFIDENTIAL_EDIT_LINK_FORBIDDEN',
      'Shared-link editing is forbidden for confidential content'
    );
  }

  const validated = validateFileNameAndExt(input.fileName);
  const mimeType = input.mimeType.trim() || 'application/octet-stream';

  let existing: SharedLinkUploadFileRow | null = null;
  if (input.targetType === 'file') {
    existing = input.target.file;
    if (!existing) {
      throw new FileUploadError(404, 'FILE_NOT_FOUND', 'Shared file not found');
    }
  } else if (input.requestedFileId) {
    existing = await db
      .prepare(
        `SELECT id, name, extension, mime_type, size_bytes, current_version_num, classification
           FROM files
          WHERE tenant_id = ? AND id = ? AND folder_id = ?
            AND deleted_at IS NULL AND upload_state = 'active'`
      )
      .bind(input.tenantId, input.requestedFileId, input.targetId)
      .first<SharedLinkUploadFileRow>();
    if (!existing) {
      throw new FileUploadError(
        404,
        'FILE_NOT_FOUND',
        'File is not inside the shared folder'
      );
    }
  } else {
    existing = await db
      .prepare(
        `SELECT id, name, extension, mime_type, size_bytes, current_version_num, classification
           FROM files
          WHERE tenant_id = ? AND folder_id = ? AND name = ?
            AND deleted_at IS NULL AND upload_state = 'active'`
      )
      .bind(input.tenantId, input.targetId, validated.name)
      .first<SharedLinkUploadFileRow>();
  }

  if (existing && input.conflictPolicy !== 'new_version') {
    throw new FileUploadError(
      409,
      'FILE_ALREADY_EXISTS',
      `File "${existing.name}" already exists in this folder`
    );
  }

  const quota = await getTenantQuotaStatus(db, input.tenantId);
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

  const fileName = existing ? existing.name : validated.name;
  const extension = existing ? existing.extension : validated.extension;
  const fileId = existing ? existing.id : crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const versionNum = existing ? existing.current_version_num + 1 : 1;
  const r2ObjectKey = buildR2ObjectKey(input.tenantId, fileId, versionNum);
  const classification = existing
    ? pickStricterClassification(input.target.classification, existing.classification)
    : input.target.classification;

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
          input.tenantId,
          input.targetId,
          fileName,
          extension,
          mimeType,
          input.sizeBytes,
          versionId,
          classification,
          input.actorUserId,
          input.actorUserId,
          nowIso,
          nowIso
        )
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, r2_upload_id,
           size_bytes, mime_type, upload_status, uploaded_by, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'pending', ?, ?)`
      )
      .bind(
        versionId,
        input.tenantId,
        fileId,
        versionNum,
        r2ObjectKey,
        input.sizeBytes,
        mimeType,
        input.actorUserId,
        nowIso
      )
  );

  await db.batch(statements);

  return {
    fileId,
    versionId,
    versionNum,
    r2ObjectKey,
    fileName,
    classification,
    isNewVersion: Boolean(existing),
  };
}
