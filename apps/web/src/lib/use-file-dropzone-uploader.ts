'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClientError,
  MULTIPART_THRESHOLD_BYTES,
  uploadWorkspaceFile,
} from '@/lib/files-api';
import {
  ensureFolderTree,
  extractUploadEntriesFromDataTransfer,
  extractUploadEntriesFromFileList,
  type ExtractedUploadTree,
} from '@/lib/folder-upload-tree';
import { getWorkspaceSyncStore } from '@/lib/sync-store';
import type { FileItem, UploadTaskProgress } from '@/types/files';

export interface UploadQueueItem {
  localId: string;
  fileName: string;
  relativePath?: string;
  folderPath?: string;
  folderResolved: boolean;
  file: File;
  targetFolderId: string;
  sizeBytes: number;
  mode: 'single' | 'multipart';
  status: 'uploading' | 'done' | 'cancelled' | 'error';
  percent: number;
  completedParts?: number;
  totalParts?: number;
  errorMessage?: string;
  controller: AbortController;
}

const MAX_QUEUE_ITEMS = 50;

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
  const folderInputRef = useRef<HTMLInputElement>(null);

  const runUploadTask = useCallback(
    (
      localId: string,
      file: File,
      targetFolderId: string,
      controller: AbortController
    ) => {
      const syncStore = getWorkspaceSyncStore();
      const optimisticId = `pending:${localId}`;

      syncStore.startOptimisticUpload(targetFolderId, optimisticId, {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });

      uploadWorkspaceFile({
        folderId: targetFolderId,
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
    },
    [conflictPolicy, onUploaded]
  );

  const processExtractedTree = useCallback(
    async (tree: ExtractedUploadTree) => {
      if (tree.files.length === 0 && tree.folderPaths.length === 0) {
        return;
      }

      let folderIdByPath = new Map<string, string>([['', folderId]]);
      if (tree.folderPaths.length > 0) {
        try {
          folderIdByPath = await ensureFolderTree({
            rootFolderId: folderId,
            folderPaths: tree.folderPaths,
          });
        } catch (err) {
          const message =
            err instanceof ApiClientError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'フォルダの作成に失敗しました';
          const failedItems: UploadQueueItem[] = tree.files.map((entry) => ({
            localId: crypto.randomUUID(),
            fileName: entry.file.name,
            relativePath: entry.relativePath,
            folderPath: entry.folderPath,
            folderResolved: entry.folderPath === '',
            file: entry.file,
            targetFolderId: folderId,
            sizeBytes: entry.file.size,
            mode:
              entry.file.size >= MULTIPART_THRESHOLD_BYTES
                ? 'multipart'
                : 'single',
            status: 'error',
            percent: 0,
            errorMessage: `フォルダ作成エラー: ${message}`,
            controller: new AbortController(),
          }));
          if (failedItems.length > 0) {
            setQueue((prev) =>
              [...failedItems.reverse(), ...prev].slice(0, MAX_QUEUE_ITEMS)
            );
          }
          return;
        }
      }

      for (const entry of tree.files) {
        const localId = crypto.randomUUID();
        const controller = new AbortController();
        const targetFolderId = folderIdByPath.get(entry.folderPath) ?? folderId;
        const mode: 'single' | 'multipart' =
          entry.file.size >= MULTIPART_THRESHOLD_BYTES ? 'multipart' : 'single';

        const newItem: UploadQueueItem = {
          localId,
          fileName: entry.file.name,
          relativePath: entry.relativePath,
          folderPath: entry.folderPath,
          folderResolved: true,
          file: entry.file,
          targetFolderId,
          sizeBytes: entry.file.size,
          mode,
          status: 'uploading',
          percent: 0,
          controller,
        };
        setQueue((prev) => [newItem, ...prev.slice(0, MAX_QUEUE_ITEMS - 1)]);
        runUploadTask(localId, entry.file, targetFolderId, controller);
      }
    },
    [folderId, runUploadTask]
  );

  const enqueueFiles = useCallback(
    (fileList: FileList | File[] | null) => {
      if (!fileList || fileList.length === 0 || disabled) return;
      const tree = extractUploadEntriesFromFileList(fileList);
      void processExtractedTree(tree);
    },
    [disabled, processExtractedTree]
  );

  const enqueueDataTransfer = useCallback(
    (dataTransfer: DataTransfer | null) => {
      if (!dataTransfer || disabled) return;
      // Extract FileSystemEntry handles and fallback files synchronously before DataTransfer clears.
      const fallbackFiles = Array.from(dataTransfer.files ?? []);
      const treePromise = extractUploadEntriesFromDataTransfer(dataTransfer);
      void treePromise
        .then((tree) => processExtractedTree(tree))
        .catch(() => {
          if (fallbackFiles.length === 0) return;
          const fallbackTree = extractUploadEntriesFromFileList(fallbackFiles);
          return processExtractedTree(fallbackTree);
        })
        .catch(() => undefined);
    },
    [disabled, processExtractedTree]
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

  function handleRetry(item: UploadQueueItem) {
    if (disabled || (item.status !== 'error' && item.status !== 'cancelled')) {
      return;
    }
    const controller = new AbortController();
    setQueue((prev) =>
      prev.map((q) =>
        q.localId === item.localId
          ? {
              ...q,
              status: 'uploading',
              percent: 0,
              completedParts: undefined,
              totalParts: undefined,
              errorMessage: undefined,
              controller,
            }
          : q
      )
    );

    if (!item.folderResolved && item.folderPath) {
      const folderPath = item.folderPath;
      void ensureFolderTree({
        rootFolderId: item.targetFolderId,
        folderPaths: [folderPath],
      })
        .then((folderIdByPath) => {
          if (controller.signal.aborted) {
            setQueue((prev) =>
              prev.map((q) =>
                q.localId === item.localId
                  ? {
                      ...q,
                      status: 'cancelled',
                      errorMessage: 'キャンセルされました',
                    }
                  : q
              )
            );
            return;
          }
          const resolvedFolderId =
            folderIdByPath.get(folderPath) ?? item.targetFolderId;
          setQueue((prev) =>
            prev.map((q) =>
              q.localId === item.localId
                ? {
                    ...q,
                    targetFolderId: resolvedFolderId,
                    folderResolved: true,
                  }
                : q
            )
          );
          runUploadTask(item.localId, item.file, resolvedFolderId, controller);
        })
        .catch((err) => {
          const message =
            err instanceof ApiClientError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'フォルダの作成に失敗しました';
          setQueue((prev) =>
            prev.map((q) =>
              q.localId === item.localId
                ? {
                    ...q,
                    status: 'error',
                    errorMessage: `フォルダ作成エラー: ${message}`,
                  }
                : q
            )
          );
        });
      return;
    }

    runUploadTask(item.localId, item.file, item.targetFolderId, controller);
  }

  return {
    dragging,
    setDragging,
    conflictPolicy,
    setConflictPolicy,
    queue,
    fileInputRef,
    folderInputRef,
    enqueueFiles,
    enqueueDataTransfer,
    handleCancel,
    handleRetry,
  };
}
