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

export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MiB
const MULTIPART_CONCURRENCY = 4;
const PART_URL_BATCH_SIZE = 100;

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function buildLoginUrl(returnTo?: string): string {
  const target =
    returnTo ??
    (typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.search}`
      : '/workspace');
  return `/auth/login?returnTo=${encodeURIComponent(target)}`;
}

type AuthRevokedHook = () => Promise<void> | void;
const authRevokedHooks = new Set<AuthRevokedHook>();

/**
 * Register a client cache/store purge hook invoked immediately on HTTP 401 or logout
 * so confidential IndexedDB metadata never lingers across session revocation.
 */
export function registerAuthPurgeHook(hook: AuthRevokedHook): () => void {
  authRevokedHooks.add(hook);
  return () => {
    authRevokedHooks.delete(hook);
  };
}

async function runAuthPurgeHooks(): Promise<void> {
  const tasks: Array<Promise<void>> = [];
  for (const hook of authRevokedHooks) {
    try {
      const res = hook();
      if (res && typeof (res as Promise<void>).then === 'function') {
        tasks.push(res);
      }
    } catch {
      // ignore listener errors during teardown
    }
  }
  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  });

  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (text) {
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      void runAuthPurgeHooks();
    }
    const message =
      typeof parsed?.error === 'string'
        ? parsed.error
        : `Request failed with HTTP ${res.status}`;
    const code = typeof parsed?.code === 'string' ? parsed.code : undefined;
    throw new ApiClientError(res.status, message, code, parsed ?? undefined);
  }

  return (parsed ?? {}) as T;
}

export function fetchCurrentUser(): Promise<{ user: AuthUser }> {
  return apiFetch<{ user: AuthUser }>('/api/auth/me');
}

export function fetchSyncBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  return apiFetch<BootstrapResponse>('/api/sync/bootstrap', { signal });
}

export function fetchSyncDelta(
  sinceSeq: number,
  limit = 200,
  signal?: AbortSignal
): Promise<SyncDeltaResponse> {
  const params = new URLSearchParams({
    sinceSeq: String(Math.max(0, Math.floor(sinceSeq))),
    limit: String(Math.min(Math.max(1, Math.floor(limit)), 200)),
  });
  return apiFetch<SyncDeltaResponse>(`/api/sync/delta?${params.toString()}`, { signal });
}

export function requestSyncWsTicket(
  signal?: AbortSignal
): Promise<SyncWsTicketResponse> {
  return apiFetch<SyncWsTicketResponse>('/api/sync/ws-ticket', {
    method: 'POST',
    signal,
  });
}

function isLocalhostClient(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export async function fetchDevAuthAccounts(): Promise<DevAuthAccountsResponse> {
  if (!isLocalhostClient()) {
    return { enabled: false, accounts: [] };
  }
  try {
    const res = await fetch('/auth/dev-accounts', { credentials: 'include' });
    if (!res.ok) {
      return { enabled: false, accounts: [] };
    }
    const body = (await res.json()) as Partial<DevAuthAccountsResponse>;
    return {
      enabled: Boolean(body.enabled),
      tenantId: body.tenantId,
      accounts: Array.isArray(body.accounts) ? body.accounts : [],
    };
  } catch {
    return { enabled: false, accounts: [] };
  }
}

export async function loginWithDevAccount(payload: {
  userId?: string;
  role?: UserRole;
}): Promise<{ ok: boolean; user: Omit<AuthUser, 'ipAddress'> }> {
  return apiFetch('/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function logoutSession(): Promise<void> {
  await runAuthPurgeHooks();
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
}

export function listRootFolders(
  cursor?: string | null,
  signal?: AbortSignal
): Promise<{
  folders: FolderSummary[];
  nextCursor: string | null;
}> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiFetch(`/api/folders/roots${qs}`, { signal });
}

export function listFolderChildren(
  folderId: string,
  cursor?: string | null,
  limit = 50,
  options?: { includeBreadcrumbs?: boolean; signal?: AbortSignal }
): Promise<FolderChildrenResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set('cursor', cursor);
  } else if (options?.includeBreadcrumbs !== false) {
    params.set('include', 'breadcrumbs');
  }
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/children?${params.toString()}`, {
    signal: options?.signal,
  });
}

export function getFolderBreadcrumbs(folderId: string): Promise<{
  breadcrumbs: BreadcrumbItem[];
}> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/breadcrumbs`);
}

export function listTrash(limit = 50): Promise<{
  folders: FolderSummary[];
  files: FileItem[];
}> {
  return apiFetch(`/api/folders/trash?limit=${limit}`);
}

export function createFolder(payload: {
  parentId: string | null;
  name: string;
  classification?: ClassificationLabel;
}): Promise<{ folder: FolderSummary }> {
  return apiFetch('/api/folders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateFolder(
  folderId: string,
  payload: { name?: string; isPinned?: boolean; expectedVersion?: number }
): Promise<{ folder: FolderSummary }> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function softDeleteFolder(
  folderId: string,
  expectedVersion?: number
): Promise<{ ok: boolean; deletedAt?: string; version?: number }> {
  const qs =
    expectedVersion !== undefined
      ? `?expectedVersion=${encodeURIComponent(String(expectedVersion))}`
      : '';
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}${qs}`, {
    method: 'DELETE',
  });
}

export function restoreFolder(
  folderId: string,
  conflictPolicy: 'fail' | 'rename' = 'rename'
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/restore`, {
    method: 'POST',
    body: JSON.stringify({ conflictPolicy }),
  });
}

export function searchWorkspaceFiles(
  query: string,
  limit = 20
): Promise<{ query: string; limit: number; results: SearchResultItem[] }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return apiFetch(`/api/search?${params.toString()}`);
}

export function updateFileMetadata(
  fileId: string,
  payload: { name?: string; folderId?: string | null; expectedVersion?: number }
): Promise<{ file: FileItem }> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function softDeleteFile(
  fileId: string,
  expectedVersion?: number
): Promise<{ ok: boolean; deletedAt?: string }> {
  const qs =
    expectedVersion !== undefined
      ? `?expectedVersion=${encodeURIComponent(String(expectedVersion))}`
      : '';
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}${qs}`, {
    method: 'DELETE',
  });
}

export function restoreFile(
  fileId: string,
  newName?: string
): Promise<{ ok: boolean; file: FileItem }> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}/restore`, {
    method: 'POST',
    body: JSON.stringify(newName ? { newName } : {}),
  });
}

export function updateFileClassification(
  fileId: string,
  payload:
    | { acceptSuggestion: true; expectedVersion?: number }
    | { classification: Exclude<ClassificationLabel, 'unset'>; expectedVersion?: number }
): Promise<{ ok: boolean; file: FileItem }> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}/classification`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function getFileContentUrl(
  fileId: string,
  intent: 'preview' | 'download'
): Promise<{
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
  requireWatermark: boolean;
  watermarkText: string | null;
}> {
  return apiFetch(
    `/api/files/${encodeURIComponent(fileId)}/content-url?intent=${intent}`
  );
}

/** PUT a File or Blob slice via XHR for reliable byte progress, abort, & ETag extraction */
function putBlobWithProgress(options: {
  url: string;
  body: Blob;
  headers?: Record<string, string>;
  withCredentials?: boolean;
  signal?: AbortSignal;
  onProgress?: (loadedBytes: number) => void;
}): Promise<{ etag: string }> {
  const { url, body, headers, withCredentials, signal, onProgress } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Upload aborted', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.withCredentials = Boolean(withCredentials);

    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        xhr.setRequestHeader(k, v);
      }
    }

    const onAbortSignal = () => {
      xhr.abort();
    };
    signal?.addEventListener('abort', onAbortSignal, { once: true });

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        onProgress(evt.loaded);
      }
    };

    xhr.onabort = () => {
      signal?.removeEventListener('abort', onAbortSignal);
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbortSignal);
      reject(new Error('Network error while uploading binary payload'));
    };

    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbortSignal);
      if (xhr.status < 200 || xhr.status >= 300) {
        let errMessage = `Upload PUT failed with HTTP ${xhr.status}`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: string };
          if (parsed?.error) errMessage = parsed.error;
        } catch {
          // ignore non-JSON body
        }
        reject(new ApiClientError(xhr.status, errMessage));
        return;
      }

      onProgress?.(body.size);
      let etag = xhr.getResponseHeader('ETag') ?? '';
      if (!etag && xhr.responseText) {
        try {
          const parsed = JSON.parse(xhr.responseText) as { etag?: string };
          if (parsed?.etag) etag = parsed.etag;
        } catch {
          // ignore non-JSON body
        }
      }
      resolve({ etag: etag || 'uploaded' });
    };

    xhr.send(body);
  });
}

export async function abortMultipartUpload(
  fileId: string,
  versionId: string
): Promise<void> {
  await apiFetch('/api/files/multipart/abort', {
    method: 'POST',
    body: JSON.stringify({ fileId, versionId }),
  });
}

/** Upload file via single PUT (< 100 MiB) or zero-copy 4-parallel file.slice() multipart (>= 100 MiB) */
export async function uploadWorkspaceFile(options: {
  folderId: string;
  file: File;
  conflictPolicy?: 'fail' | 'new_version';
  signal?: AbortSignal;
  onProgress?: (progress: UploadTaskProgress) => void;
}): Promise<{ file: FileItem; aiClassificationQueued: boolean }> {
  const { folderId, file, conflictPolicy = 'fail', signal, onProgress } = options;
  const mimeType = file.type || 'application/octet-stream';

  if (file.size < MULTIPART_THRESHOLD_BYTES) {
    const init = await apiFetch<{
      fileId: string;
      versionId: string;
      uploadUrl: string;
      requiredHeaders?: Record<string, string>;
    }>('/api/files/upload-init', {
      method: 'POST',
      body: JSON.stringify({
        folderId,
        fileName: file.name,
        mimeType,
        sizeBytes: file.size,
        conflictPolicy,
      }),
      signal,
    });

    onProgress?.({
      mode: 'single',
      loadedBytes: 0,
      totalBytes: file.size,
      percent: 0,
      fileId: init.fileId,
      versionId: init.versionId,
    });

    await putBlobWithProgress({
      url: init.uploadUrl,
      body: file,
      headers: init.requiredHeaders,
      withCredentials: init.uploadUrl.startsWith('/'),
      signal,
      onProgress: (loadedBytes) => {
        onProgress?.({
          mode: 'single',
          loadedBytes,
          totalBytes: file.size,
          percent: file.size > 0 ? Math.round((loadedBytes / file.size) * 100) : 100,
          fileId: init.fileId,
          versionId: init.versionId,
        });
      },
    });

    return apiFetch('/api/files/upload-complete', {
      method: 'POST',
      body: JSON.stringify({ fileId: init.fileId, versionId: init.versionId }),
      signal,
    });
  }

  // >= 100 MiB: S3 Multipart with dynamic part URLs & 4-parallel file.slice()
  const init = await apiFetch<{
    fileId: string;
    versionId: string;
    partSizeBytes: number;
    totalParts: number;
    parts: Array<{ partNumber: number; url: string }>;
  }>('/api/files/multipart/init', {
    method: 'POST',
    body: JSON.stringify({
      folderId,
      fileName: file.name,
      mimeType,
      sizeBytes: file.size,
      conflictPolicy,
    }),
    signal,
  });

  const urlMap = new Map<number, string>(init.parts.map((p) => [p.partNumber, p.url]));
  const partBytesLoaded = new Array<number>(init.totalParts).fill(0);
  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  let completedCount = 0;

  onProgress?.({
    mode: 'multipart',
    loadedBytes: 0,
    totalBytes: file.size,
    percent: 0,
    completedParts: 0,
    totalParts: init.totalParts,
    fileId: init.fileId,
    versionId: init.versionId,
  });

  let batchPromise: Promise<void> | null = null;
  async function getPartUrl(partNumber: number): Promise<string> {
    const existing = urlMap.get(partNumber);
    if (existing) return existing;

    if (!batchPromise) {
      batchPromise = (async () => {
        const missing: number[] = [];
        for (let p = 1; p <= init.totalParts && missing.length < PART_URL_BATCH_SIZE; p++) {
          if (!urlMap.has(p)) missing.push(p);
        }
        if (missing.length > 0) {
          const batch = await apiFetch<{ parts: Array<{ partNumber: number; url: string }> }>(
            '/api/files/multipart/part-urls',
            {
              method: 'POST',
              body: JSON.stringify({
                fileId: init.fileId,
                versionId: init.versionId,
                partNumbers: missing,
              }),
              signal,
            }
          );
          for (const item of batch.parts) {
            urlMap.set(item.partNumber, item.url);
          }
        }
      })().finally(() => {
        batchPromise = null;
      });
    }
    await batchPromise;

    const resolved = urlMap.get(partNumber);
    if (!resolved) {
      throw new Error(`Missing presigned URL for part ${partNumber}`);
    }
    return resolved;
  }

  let nextPartNumber = 1;

  try {
    const workerCount = Math.min(MULTIPART_CONCURRENCY, init.totalParts);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (signal?.aborted) {
          throw new DOMException('Upload aborted', 'AbortError');
        }
        const currentPart = nextPartNumber;
        nextPartNumber += 1;
        if (currentPart > init.totalParts) return;

        const start = (currentPart - 1) * init.partSizeBytes;
        const end = Math.min(start + init.partSizeBytes, file.size);
        const sliceBlob = file.slice(start, end);
        const partUrl = await getPartUrl(currentPart);

        const { etag } = await putBlobWithProgress({
          url: partUrl,
          body: sliceBlob,
          withCredentials: partUrl.startsWith('/'),
          signal,
          onProgress: (loaded) => {
            partBytesLoaded[currentPart - 1] = loaded;
            const totalLoaded = partBytesLoaded.reduce((acc, v) => acc + v, 0);
            onProgress?.({
              mode: 'multipart',
              loadedBytes: totalLoaded,
              totalBytes: file.size,
              percent:
                file.size > 0 ? Math.min(99, Math.round((totalLoaded / file.size) * 100)) : 100,
              completedParts: completedCount,
              totalParts: init.totalParts,
              fileId: init.fileId,
              versionId: init.versionId,
            });
          },
        });

        completedCount += 1;
        completedParts.push({ partNumber: currentPart, etag });
        const totalLoaded = partBytesLoaded.reduce((acc, v) => acc + v, 0);
        onProgress?.({
          mode: 'multipart',
          loadedBytes: totalLoaded,
          totalBytes: file.size,
          percent:
            file.size > 0 ? Math.min(99, Math.round((totalLoaded / file.size) * 100)) : 100,
          completedParts: completedCount,
          totalParts: init.totalParts,
          fileId: init.fileId,
          versionId: init.versionId,
        });
      }
    });

    await Promise.all(workers);
    completedParts.sort((a, b) => a.partNumber - b.partNumber);

    const finalized = await apiFetch<{ file: FileItem; aiClassificationQueued: boolean }>(
      '/api/files/multipart/complete',
      {
        method: 'POST',
        body: JSON.stringify({
          fileId: init.fileId,
          versionId: init.versionId,
          parts: completedParts,
        }),
        signal,
      }
    );

    onProgress?.({
      mode: 'multipart',
      loadedBytes: file.size,
      totalBytes: file.size,
      percent: 100,
      completedParts: init.totalParts,
      totalParts: init.totalParts,
      fileId: init.fileId,
      versionId: init.versionId,
    });

    return finalized;
  } catch (err) {
    // Cleanup incomplete multipart state in R2 & D1 on cancel or failure
    await abortMultipartUpload(init.fileId, init.versionId).catch(() => undefined);
    throw err;
  }
}

export function listPermissions(
  targetType: 'folder' | 'file',
  targetId: string
): Promise<{ permissions: PermissionEntry[] }> {
  const params = new URLSearchParams({ targetType, targetId });
  return apiFetch(`/api/permissions?${params.toString()}`);
}

export function grantPermission(payload: {
  targetType: 'folder' | 'file';
  targetId: string;
  granteeType: 'user' | 'group';
  granteeId: string;
  role: ResourceRole;
}): Promise<{ ok: boolean }> {
  return apiFetch('/api/permissions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function revokePermission(permissionId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/permissions/${encodeURIComponent(permissionId)}`, {
    method: 'DELETE',
  });
}

export function searchPrincipals(q: string): Promise<{ principals: PrincipalCandidate[] }> {
  return apiFetch(`/api/principals/search?q=${encodeURIComponent(q)}`);
}

export function listSharedLinks(
  targetType: 'file' | 'folder',
  targetId: string
): Promise<{ links: SharedLinkSummary[] }> {
  const params = new URLSearchParams({ targetType, targetId });
  return apiFetch(`/api/shared-links?${params.toString()}`);
}

export function createSharedLink(payload: {
  targetType: 'file' | 'folder';
  targetId: string;
  accessScope: ShareAccessScope;
  canDownload: boolean;
  requireWatermark: boolean;
  password?: string;
  expiresInDays?: number;
  maxDownloads?: number;
}): Promise<{ link: SharedLinkSummary; token: string; shareUrl: string }> {
  return apiFetch('/api/shared-links', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function revokeSharedLink(linkId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/shared-links/${encodeURIComponent(linkId)}`, {
    method: 'DELETE',
  });
}

export function getPublicShareMeta(token: string): Promise<PublicShareMeta> {
  return apiFetch(`/api/s/${encodeURIComponent(token)}/meta`);
}

export function verifyPublicSharePassword(
  token: string,
  password: string
): Promise<{ ok: boolean; unlocked: boolean; unlockToken?: string }> {
  return apiFetch(`/api/s/${encodeURIComponent(token)}/verify-password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function issuePublicShareUrl(
  token: string,
  payload: {
    intent: 'preview' | 'download';
    fileId?: string;
    unlockToken?: string;
  }
): Promise<PublicShareUrlResponse> {
  const headers: Record<string, string> = {};
  if (payload.unlockToken) {
    headers['X-Share-Unlock'] = payload.unlockToken;
  }
  return apiFetch(`/api/s/${encodeURIComponent(token)}/url`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      intent: payload.intent,
      fileId: payload.fileId,
      unlockToken: payload.unlockToken,
    }),
  });
}

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

export function fetchAdminStorageStats(): Promise<StorageStatsResponse> {
  return apiFetch('/api/admin/storage-stats');
}

export function fetchAdminAiSuggestions(params?: {
  suggestedLabel?: ClassificationLabel;
  cursorUpdatedAt?: string;
  cursorId?: string;
  limit?: number;
}): Promise<{
  suggestions: AiSuggestionItem[];
  nextCursor: { updatedAt: string; id: string } | null;
}> {
  const qs = new URLSearchParams();
  if (params?.suggestedLabel) qs.set('suggestedLabel', params.suggestedLabel);
  if (params?.cursorUpdatedAt) qs.set('cursorUpdatedAt', params.cursorUpdatedAt);
  if (params?.cursorId) qs.set('cursorId', params.cursorId);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(`/api/admin/ai-suggestions${suffix}`);
}

export function bulkApproveAiSuggestions(
  items: Array<{ fileId: string; label?: Exclude<ClassificationLabel, 'unset'> }>
): Promise<{ ok: boolean; approvedCount: number; approvedIds: string[]; skippedIds: string[] }> {
  return apiFetch('/api/admin/ai-suggestions/bulk-approve', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export function fetchAdminSharedLinks(limit = 50): Promise<{ links: AdminSharedLinkRow[] }> {
  return apiFetch(`/api/admin/shared-links?limit=${limit}`);
}

export function adminEmergencyRevokeSharedLink(
  linkId: string,
  reason?: string
): Promise<{ ok: boolean; linkId: string; revokedAt: string }> {
  return apiFetch(`/api/admin/shared-links/${encodeURIComponent(linkId)}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function fetchAdminPolicies(): Promise<{ policy: TenantPolicyRow }> {
  return apiFetch('/api/admin/policies');
}

export function updateAdminPolicies(payload: {
  enforceCompanyOnlyLinks?: boolean;
  requireWatermarkConfidential?: boolean;
  maxLinkExpirationDays?: number;
  sessionMaxHours?: number;
  trashRetentionDays?: number;
  aiClassificationMode?: AiClassificationMode;
  aiAutoApplyThreshold?: number | null;
}): Promise<{ policy: TenantPolicyRow }> {
  return apiFetch('/api/admin/policies', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function fetchAuditLogs(params?: {
  action?: string;
  status?: 'allowed' | 'blocked';
  actorEmail?: string;
  cursorCreatedAt?: string;
  cursorId?: string;
  limit?: number;
}): Promise<{
  logs: AuditLogEntry[];
  nextCursor: { createdAt: string; id: string } | null;
}> {
  const qs = new URLSearchParams();
  if (params?.action) qs.set('action', params.action);
  if (params?.status) qs.set('status', params.status);
  if (params?.actorEmail) qs.set('actorEmail', params.actorEmail);
  if (params?.cursorCreatedAt) qs.set('cursorCreatedAt', params.cursorCreatedAt);
  if (params?.cursorId) qs.set('cursorId', params.cursorId);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(`/api/audit-logs${suffix}`);
}

/** POST /api/folders/:id/move — single-folder subtree move with optimistic concurrency */
export function moveFolder(
  folderId: string,
  payload: {
    targetParentId: string | null;
    expectedVersion?: number;
  }
): Promise<{
  ok: boolean;
  folder: FolderSummary;
  classificationJobQueued?: boolean;
}> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/move`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/workspace/batch-move — batch move folders and files atomically */
export function batchMoveWorkspaceItems(payload: {
  items: WorkspaceBatchItemRef[];
  targetParentId: string | null;
  conflictPolicy?: WorkspaceConflictPolicy;
}): Promise<BatchMoveWorkspaceResponse> {
  return apiFetch<BatchMoveWorkspaceResponse>('/api/workspace/batch-move', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/workspace/copy — zero-copy CoW duplication into target directory */
export function copyWorkspaceItems(payload: {
  items: Array<{ type: 'file' | 'folder'; id: string }>;
  targetParentId: string | null;
  conflictPolicy?: WorkspaceConflictPolicy;
}): Promise<CopyWorkspaceResponse> {
  return apiFetch<CopyWorkspaceResponse>('/api/workspace/copy', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/workspace/duplicate — in-place CoW duplicate */
export function duplicateWorkspaceItems(payload: {
  items: Array<{ type: 'file' | 'folder'; id: string }>;
}): Promise<CopyWorkspaceResponse> {
  return apiFetch<CopyWorkspaceResponse>('/api/workspace/duplicate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** GET /api/workspace/jobs/:id — inspect background async copy job progress */
export function getWorkspaceJob(
  jobId: string,
  signal?: AbortSignal
): Promise<{ job: WorkspaceJobStatus }> {
  return apiFetch<{ job: WorkspaceJobStatus }>(
    `/api/workspace/jobs/${encodeURIComponent(jobId)}`,
    { signal }
  );
}
