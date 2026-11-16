import type { ClassificationLabel } from '../../types/api';

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
