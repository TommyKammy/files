import type {
  AdminSharedLinkRow,
  AiClassificationMode,
  AiSuggestionItem,
  AuditLogEntry,
  AuthUser,
  BatchMoveWorkspaceResponse,
  BootstrapResponse,
  BreadcrumbItem,
  ClassificationLabel,
  CopyWorkspaceResponse,
  DevAuthAccountsResponse,
  FileItem,
  FileRequestSummary,
  FolderChildrenResponse,
  FolderSummary,
  PermissionEntry,
  PrincipalCandidate,
  PublicFileRequestMeta,
  PublicShareMeta,
  PublicShareUrlResponse,
  ResourceRole,
  SearchResultItem,
  ShareAccessScope,
  SharedLinkSummary,
  StorageStatsResponse,
  SyncDeltaResponse,
  SyncWsTicketResponse,
  TenantPolicyRow,
  UploadTaskProgress,
  UserRole,
  WorkspaceBatchItemRef,
  WorkspaceConflictPolicy,
  WorkspaceJobStatus,
} from '@/types/files';

import {
  apiFetch,
} from './core';
import { putBlobWithProgress } from './upload';

export function listFileRequests(folderId?: string): Promise<{
  fileRequests: FileRequestSummary[];
}> {
  const qs = folderId ? `?folderId=${encodeURIComponent(folderId)}` : '';
  return apiFetch(`/api/file-requests${qs}`);
}

export function createFileRequest(payload: {
  folderId: string;
  title: string;
  description?: string;
  requireSubmitterEmail?: boolean;
  maxFileSizeBytes?: number;
  allowedExtensions?: string[];
  expiresInDays?: number;
}): Promise<{ fileRequest: FileRequestSummary; token: string; requestUrl: string }> {
  return apiFetch('/api/file-requests', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function deactivateFileRequest(id: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/file-requests/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function getPublicFileRequestMeta(token: string): Promise<PublicFileRequestMeta> {
  return apiFetch(`/api/fr/${encodeURIComponent(token)}`);
}

export async function uploadToPublicFileRequest(options: {
  token: string;
  file: File;
  submitterEmail?: string;
  turnstileToken?: string;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}): Promise<{ ok: boolean; submittedAt: string }> {
  const { token, file, submitterEmail, turnstileToken, signal, onProgress } = options;
  const init = await apiFetch<{
    fileId: string;
    versionId: string;
    submissionToken: string;
    uploadUrl: string;
    requiredHeaders?: Record<string, string>;
  }>(`/api/fr/${encodeURIComponent(token)}/upload-init`, {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      submitterEmail: submitterEmail?.trim() || undefined,
      turnstileToken: turnstileToken?.trim() || undefined,
    }),
    signal,
  });

  onProgress?.(5);
  await putBlobWithProgress({
    url: init.uploadUrl,
    body: file,
    headers: init.requiredHeaders,
    withCredentials: init.uploadUrl.startsWith('/'),
    signal,
    onProgress: (loaded) => {
      if (file.size > 0) {
        onProgress?.(Math.min(95, Math.max(5, Math.round((loaded / file.size) * 95))));
      }
    },
  });

  const done = await apiFetch<{ ok: boolean; submittedAt: string }>(
    `/api/fr/${encodeURIComponent(token)}/upload-complete`,
    {
      method: 'POST',
      body: JSON.stringify({
        fileId: init.fileId,
        versionId: init.versionId,
        submissionToken: init.submissionToken,
      }),
      signal,
    }
  );
  onProgress?.(100);
  return done;
}


