'use client';

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  UploadCloud,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { hasOsFilesDataTransfer } from '@/lib/drag-drop-controller';
import {
  ApiClientError,
  MULTIPART_THRESHOLD_BYTES,
  uploadWorkspaceFile,
} from '@/lib/files-api';
import { formatBytes } from '@/lib/formatters';
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

export function FileDropzoneUploader({
  folderId,
  disabled = false,
  onUploaded,
  onRegisterEnqueueFiles,
}: {
  folderId: string;
  disabled?: boolean;
  onUploaded?: (file?: FileItem) => void;
  onRegisterEnqueueFiles?: (fn: ((files: FileList | File[]) => void) | null) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [conflictPolicy, setConflictPolicy] = useState<'fail' | 'new_version'>('fail');
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
          syncStore.updateOptimisticUploadProgress(optimisticId, progress.percent);
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
              q.localId === localId ? { ...q, status: 'done', percent: 100 } : q
            )
          );
          onUploaded?.(res.file);
        })
        .catch((err) => {
          syncStore.failOrCancelOptimisticUpload(optimisticId);
          const isAbort = err instanceof DOMException && err.name === 'AbortError';
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

  function isInternalWorkspaceDragActive(): boolean {
    return (
      typeof document !== 'undefined' &&
      document.body.dataset.workspaceDragging === '1'
    );
  }

  return (
    <div className="space-y-3">
      <div
        onDragEnter={(e) => {
          if (!hasOsFilesDataTransfer(e.dataTransfer, isInternalWorkspaceDragActive())) {
            return;
          }
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragOver={(e) => {
          if (!hasOsFilesDataTransfer(e.dataTransfer, isInternalWorkspaceDragActive())) {
            if (dragging) setDragging(false);
            return;
          }
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!hasOsFilesDataTransfer(e.dataTransfer, isInternalWorkspaceDragActive())) {
            setDragging(false);
            return;
          }
          e.preventDefault();
          setDragging(false);
          enqueueFiles(e.dataTransfer.files);
        }}
        className={`flex flex-col gap-2 rounded-lg border border-dashed bg-[#fbfbfc] px-3 py-2.5 transition sm:flex-row sm:items-center sm:justify-between ${
          disabled
            ? 'border-[#e7e7ea] bg-[#f4f4f5] opacity-60'
            : dragging
              ? 'border-[#5e6ad2] bg-[#eef0fb]'
              : 'border-[#d7d7dc] bg-[#fbfbfc] hover:border-[#b9b9c0]'
        }`}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#eef0fb] text-[#5e6ad2]">
            <UploadCloud className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[0.8125rem] font-medium text-[#111214]">
              ファイルをドラッグ＆ドロップ、または選択してアップロード
            </div>
            <div className="text-[0.6875rem] text-[#6b6f76]">
              100 MiB 未満は単一 PUT、100 MiB 以上は 4並列 Zero-copy S3 Multipart で自動転送されます
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <select
            aria-label="同名ファイル衝突時のポリシー"
            value={conflictPolicy}
            onChange={(e) =>
              setConflictPolicy(e.target.value as 'fail' | 'new_version')
            }
            disabled={disabled}
            className="h-7 rounded-md border border-[#e1e1e4] bg-white px-2 text-[0.6875rem] text-[#55565a] focus:border-[#5e6ad2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5e6ad2]/40"
          >
            <option value="fail">同名ファイル: エラー通知</option>
            <option value="new_version">同名ファイル: 新バージョン追記</option>
          </select>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              enqueueFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className="h-7 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            ファイルを選択
          </button>
        </div>
      </div>

      {queue.length > 0 && (
        <div className="rounded-lg border border-[#e7e7ea] bg-white divide-y divide-[#f0f0f1]">
          {queue.map((item) => (
            <div
              key={item.localId}
              className="flex items-center justify-between gap-3 px-3 py-2 text-[0.6875rem]"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-[#111214]">
                    {item.fileName}
                  </span>
                  <span className="rounded bg-[#f4f4f5] px-1.5 py-0.5 font-mono text-[0.625rem] text-[#55565a]">
                    {item.mode === 'multipart' ? '4x Multipart' : 'Single PUT'}
                  </span>
                  <span className="text-[#6b6f76]">{formatBytes(item.sizeBytes)}</span>
                </div>

                {item.status === 'uploading' && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#f0f0f1]">
                      <div
                        className="h-full bg-[#5e6ad2] transition-all"
                        style={{ width: `${item.percent}%` }}
                      />
                    </div>
                    <span className="w-24 text-right font-mono text-[0.6875rem] text-[#55565a]">
                      {item.percent}%
                      {item.totalParts
                        ? ` (${item.completedParts ?? 0}/${item.totalParts})`
                        : ''}
                    </span>
                  </div>
                )}

                {item.errorMessage && (
                  <div className="mt-1 flex items-center gap-1 text-[#d9343f]">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span>{item.errorMessage}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {item.status === 'uploading' && (
                  <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
                )}
                {item.status === 'done' && (
                  <CheckCircle2 className="h-4 w-4 text-[#2f9e5f]" />
                )}
                <button
                  type="button"
                  onClick={() => handleCancel(item)}
                  title={
                    item.status === 'uploading' ? 'アップロード中止' : 'リストから消去'
                  }
                  className="flex h-6 w-6 items-center justify-center rounded text-[#6b6f76] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
