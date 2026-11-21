import type { FileItem, UploadTaskProgress } from '@/types/files';
import {
  ApiClientError,
  MULTIPART_CONCURRENCY,
  MULTIPART_THRESHOLD_BYTES,
  PART_URL_BATCH_SIZE,
  apiFetch,
} from './core';

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
export function putBlobWithProgress(options: {
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

export const MULTIPART_PART_MAX_ATTEMPTS = 3;
export const MULTIPART_PART_RETRY_BASE_DELAY_MS = 500;

export interface PartUploadRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function isRetryablePartUploadError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return false;
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return false;
  }
  if (err instanceof ApiClientError) {
    return err.status === 429 || err.status >= 500;
  }
  return err instanceof Error;
}

export function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Upload aborted', 'AbortError'));
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Upload aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function uploadPartWithRetry<T>(
  attemptFn: (attempt: number) => Promise<T>,
  options?: PartUploadRetryOptions & { signal?: AbortSignal; onRetry?: (attempt: number, err: unknown) => void }
): Promise<T> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? MULTIPART_PART_MAX_ATTEMPTS);
  const baseDelayMs = options?.baseDelayMs ?? MULTIPART_PART_RETRY_BASE_DELAY_MS;
  const sleepFn = options?.sleepFn ?? sleepWithSignal;
  const signal = options?.signal;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException('Upload aborted', 'AbortError');
    }
    try {
      return await attemptFn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryablePartUploadError(err)) {
        throw err;
      }
      options?.onRetry?.(attempt, err);
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      await sleepFn(delayMs, signal);
    }
  }
  throw lastError;
}

export async function abortMultipartUpload(
  fileId: string,
  versionId: string,
  apiFetchFn: typeof apiFetch = apiFetch
): Promise<void> {
  await apiFetchFn('/api/files/multipart/abort', {
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
  retryOptions?: PartUploadRetryOptions;
  deps?: {
    apiFetchFn?: typeof apiFetch;
    putBlobFn?: typeof putBlobWithProgress;
  };
}): Promise<{ file: FileItem; aiClassificationQueued: boolean }> {
  const {
    folderId,
    file,
    conflictPolicy = 'fail',
    signal,
    onProgress,
    retryOptions,
    deps,
  } = options;
  const apiFetchFn = deps?.apiFetchFn ?? apiFetch;
  const putBlobFn = deps?.putBlobFn ?? putBlobWithProgress;
  const mimeType = file.type || 'application/octet-stream';

  if (file.size < MULTIPART_THRESHOLD_BYTES) {
    const init = await apiFetchFn<{
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

    await putBlobFn({
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

    return apiFetchFn('/api/files/upload-complete', {
      method: 'POST',
      body: JSON.stringify({ fileId: init.fileId, versionId: init.versionId }),
      signal,
    });
  }

  // >= 100 MiB: S3 Multipart with dynamic part URLs & 4-parallel file.slice()
  const init = await apiFetchFn<{
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
          const batch = await apiFetchFn<{ parts: Array<{ partNumber: number; url: string }> }>(
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

        const { etag } = await uploadPartWithRetry(
          () => {
            partBytesLoaded[currentPart - 1] = 0;
            return putBlobFn({
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
          },
          {
            ...retryOptions,
            signal,
          }
        );

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

    const finalized = await apiFetchFn<{ file: FileItem; aiClassificationQueued: boolean }>(
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
    await abortMultipartUpload(init.fileId, init.versionId, apiFetchFn).catch(() => undefined);
    throw err;
  }
}


