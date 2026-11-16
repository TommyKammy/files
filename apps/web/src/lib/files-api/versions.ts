import type { FileVersionItem, FileVersionListResponse } from '@/types/files';
import { apiFetch } from './core';

/** Raw snake_case file row returned by the restore endpoint. */
export type ApiFileRecord = Record<string, unknown>;

export interface FileVersionContentGrant {
  url: string;
  expiresAt?: string;
  disposition?: 'inline' | 'attachment';
  safeRenderMode?: 'source_text' | 'standard';
  requireWatermark: boolean;
  watermarkText: string | null;
  versionId?: string;
  versionNum?: number;
}

export interface FileVersionRestoreResponse {
  ok: boolean;
  file: ApiFileRecord;
  version: FileVersionItem | null;
  restoredFromVersionId: string;
  restoredFromVersionNum: number;
}

/** GET /api/files/:id/versions — newest first, keyset paginated. */
export function listFileVersions(
  fileId: string,
  options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {}
): Promise<FileVersionListResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor) params.set('cursor', options.cursor);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(
    `/api/files/${encodeURIComponent(fileId)}/versions${suffix}`,
    { signal: options.signal }
  );
}

/** GET /api/files/:id/versions/:versionId/content-url — DLP-equivalent signed URL. */
export function getFileVersionContentUrl(
  fileId: string,
  versionId: string,
  intent: 'preview' | 'download'
): Promise<FileVersionContentGrant> {
  return apiFetch(
    `/api/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(
      versionId
    )}/content-url?intent=${intent}`
  );
}

/** POST /api/files/:id/versions/:versionId/restore — append a new CoW version. */
export function restoreFileVersion(
  fileId: string,
  versionId: string,
  expectedVersion?: number
): Promise<FileVersionRestoreResponse> {
  return apiFetch(
    `/api/files/${encodeURIComponent(fileId)}/versions/${encodeURIComponent(
      versionId
    )}/restore`,
    {
      method: 'POST',
      body: JSON.stringify(
        expectedVersion !== undefined ? { expectedVersion } : {}
      ),
    }
  );
}
