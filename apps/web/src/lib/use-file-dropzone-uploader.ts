'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClientError,
  MULTIPART_THRESHOLD_BYTES,
  uploadWorkspaceFile,
} from '@/lib/files-api';
import { getWorkspaceSyncStore } from '@/lib/sync-store';
import type { FileItem, UploadTaskProgress } from '@/types/files';

interface UploadQueueItem {
  localId: string;
  fileName: string;
  sizeBytes: number;
  mode: 'single' | 'multipart';
  status: 'uploading' | 'done' | 'cancelled' | 'error';
  percent: number;
  completedParts?: number;
  totalParts?: number;
  errorMessage?: string;
  controller: AbortController;
}

export function useFileDropzoneUploader({
  folderId,
  disabled = false,
  canUploadVersion = true,
  onUploaded,
  onRegisterEnqueueFiles,
}: {
  folderId: string;
  disabled?: boolean;
  canUploadVersion?: boolean;
  onUploaded?: (file?: FileItem) => void;
  onRegisterEnqueueFiles?: (
    fn: ((files: FileList | File[]) => void) | null
  ) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [conflictPolicyState, setConflictPolicyState] = useState<
    'fail' | 'new_version'
  >('fail');

  // Roles without `item.upload_version` must never send `new_version`.
  const conflictPolicy = canUploadVersion ? conflictPolicyState : 'fail';
  const setConflictPolicy = useCallback(
    (next: 'fail' | 'new_version') => {
      setConflictPolicyState(canUploadVersion ? next : 'fail');
    },
    [canUploadVersion]
  );
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const enqueueFiles = useCallback(
    (fileList: FileList | File[] | null) => {
      if (!fileList || fileList.length === 0 || disabled) return;

      const syncStore = getWorkspaceSyncStore();
      const files = Array.from(fileList);
      for (const file of files) {
        const localId = crypto.randomUUID();
        const optimisticId = `pending:${localId}`;
        const controller = new AbortController();
        const mode: 'single' | 'multipart' =
          file.size >= MULTIPART_THRESHOLD_BYTES ? 'multipart' : 'single';

        const newItem: UploadQueueItem = {
          localId,
          fileName: file.name,
          sizeBytes: file.size,
          mode,
          status: 'uploading',
          percent: 0,
          controller,
        };
        setQueue((prev) => [newItem, ...prev.slice(0, 14)]);
        syncStore.startOptimisticUpload(folderId, optimisticId, {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        });

        uploadWorkspaceFile({
          folderId,
          file,
          conflictPolicy,
          signal: controller.signal,
          onProgress: (progress: UploadTaskProgress) => {
            syncStore.updateOptimisticUploadProgress(
              optimisticId,
              progress.percent
            );
            setQueue((prev) =>
              prev.map((q) =>
                q.localId === localId
                  ? {
                      ...q,
                      percent: progress.percent,
                      completedParts: progress.completedParts,
                      totalParts: progress.totalParts,
                    }
                  : q
              )
            );
          },
        })
          .then((res) => {
            syncStore.completeOptimisticUpload(optimisticId, res.file);
            setQueue((prev) =>
              prev.map((q) =>
                q.localId === localId
                  ? { ...q, status: 'done', percent: 100 }
                  : q
              )
            );
            onUploaded?.(res.file);
          })
          .catch((err) => {
            syncStore.failOrCancelOptimisticUpload(optimisticId);
            const isAbort =
              err instanceof DOMException && err.name === 'AbortError';
            setQueue((prev) =>
              prev.map((q) =>
                q.localId === localId
                  ? {
                      ...q,
                      status: isAbort ? 'cancelled' : 'error',
                      errorMessage: isAbort
                        ? 'キャンセルされました'
                        : err instanceof ApiClientError
                          ? err.message
                          : err instanceof Error
                            ? err.message
                            : 'アップロードに失敗しました',
                    }
                  : q
              )
            );
          });
      }
    },
    [disabled, folderId, conflictPolicy, onUploaded]
  );

  useEffect(() => {
    onRegisterEnqueueFiles?.(enqueueFiles);
    return () => {
      onRegisterEnqueueFiles?.(null);
    };
  }, [enqueueFiles, onRegisterEnqueueFiles]);

  function handleCancel(item: UploadQueueItem) {
    if (item.status === 'uploading') {
      item.controller.abort();
    } else {
      setQueue((prev) => prev.filter((q) => q.localId !== item.localId));
    }
  }

  return {
    dragging,
    setDragging,
    conflictPolicy,
    setConflictPolicy,
    queue,
    fileInputRef,
    enqueueFiles,
    handleCancel,
  };
}
