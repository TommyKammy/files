import { base64UrlToBytes, bytesToBase64Url } from '../../services/crypto-utils';
import {
  resolveTargetAccess,
  type TargetMetadata,
} from '../../services/authorization';
import type { FileRow } from '../../services/file-upload-common';
import type { AuthUser } from '../../types/api';

export const DEFAULT_VERSION_LIMIT = 50;
export const MAX_VERSION_LIMIT = 200;

export interface VersionCursor {
  versionNum: number;
  id: string;
}

export function encodeVersionCursor(cursor: VersionCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeVersionCursor(raw: string | undefined): VersionCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(raw))
    ) as Partial<VersionCursor>;
    if (
      typeof parsed.versionNum !== 'number' ||
      !Number.isInteger(parsed.versionNum) ||
      parsed.versionNum < 1 ||
      typeof parsed.id !== 'string' ||
      parsed.id.length === 0
    ) {
      return null;
    }
    return { versionNum: parsed.versionNum, id: parsed.id };
  } catch {
    return null;
  }
}

/** Match the existing list API convention: invalid values fall back, oversized values clamp. */
export function parseVersionLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? String(DEFAULT_VERSION_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_VERSION_LIMIT;
  return Math.min(parsed, MAX_VERSION_LIMIT);
}

export interface FileVersionListRow {
  id: string;
  version_num: number;
  size_bytes: number;
  mime_type: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
  upload_status: 'pending' | 'completed' | 'failed';
  is_current: number;
}

export interface PublicFileVersion {
  id: string;
  versionNum: number;
  sizeBytes: number;
  mimeType: string;
  uploadedBy: string;
  uploadedByName: string | null;
  createdAt: string;
  uploadStatus: 'pending' | 'completed' | 'failed';
  isCurrent: boolean;
}

/** Map a version row to the public shape; `r2_object_key` is never selected or exposed. */
export function toPublicVersion(row: FileVersionListRow): PublicFileVersion {
  return {
    id: row.id,
    versionNum: row.version_num,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    uploadedBy: row.uploaded_by,
    uploadedByName: row.uploaded_by_name ?? null,
    createdAt: row.created_at,
    uploadStatus: row.upload_status,
    isCurrent: row.is_current === 1,
  };
}

export interface LoadedActiveFile {
  file: FileRow;
  access: TargetMetadata;
}

/** Resolve access and require an active, non-deleted, same-tenant file. */
export async function loadActiveFile(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId'>,
  fileId: string
): Promise<LoadedActiveFile | null> {
  const [access, file] = await Promise.all([
    resolveTargetAccess(db, user, 'file', fileId),
    db
      .prepare(
        'SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
      )
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);
  if (!access || !file || access.deletedAt !== null || file.upload_state !== 'active') {
    return null;
  }
  return { file, access };
}
