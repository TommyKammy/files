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


