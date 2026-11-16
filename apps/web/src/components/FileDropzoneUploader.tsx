'use client';

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  UploadCloud,
  X,
} from 'lucide-react';
import { hasOsFilesDataTransfer } from '@/lib/drag-drop-controller';
import { formatBytes } from '@/lib/formatters';
import { useFileDropzoneUploader } from '@/lib/use-file-dropzone-uploader';
import type { FileItem } from '@/types/files';

export function FileDropzoneUploader({
  folderId,
  disabled = false,
  canUploadVersion = true,
  onUploaded,
  onRegisterEnqueueFiles,
}: {
  folderId: string;
  disabled?: boolean;
  /** When false (`uploader`, `previewer_uploader`) the policy is pinned to fail. */
  canUploadVersion?: boolean;
  onUploaded?: (file?: FileItem) => void;
  onRegisterEnqueueFiles?: (fn: ((files: FileList | File[]) => void) | null) => void;
}) {
  const {
    dragging,
    setDragging,
    conflictPolicy,
    setConflictPolicy,
    queue,
    fileInputRef,
    enqueueFiles,
    handleCancel,
  } = useFileDropzoneUploader({
    folderId,
    disabled,
    canUploadVersion,
    onUploaded,
    onRegisterEnqueueFiles,
  });

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

        <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto">
          <div className="flex w-full min-w-0 flex-col gap-0.5 sm:w-auto">
            <select
              aria-label="同名ファイル衝突時のポリシー"
              aria-describedby={
                !canUploadVersion ? 'upload-conflict-policy-note' : undefined
              }
              value={conflictPolicy}
              onChange={(e) =>
                setConflictPolicy(e.target.value as 'fail' | 'new_version')
              }
              disabled={disabled || !canUploadVersion}
              className="h-7 max-w-full rounded-md border border-[#e1e1e4] bg-white px-2 text-[0.6875rem] text-[#55565a] focus:border-[#5e6ad2] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5e6ad2]/40 disabled:cursor-not-allowed disabled:bg-[#f4f4f5] disabled:text-[#8a8d94]"
            >
              <option value="fail">同名ファイル: エラー通知</option>
              <option value="new_version" disabled={!canUploadVersion}>
                同名ファイル: 新バージョン追記
              </option>
            </select>
            {!canUploadVersion && (
              <p
                id="upload-conflict-policy-note"
                className="max-w-56 text-[0.625rem] leading-4 text-[#8a5a00]"
              >
                ※ 新規アップロードのみ可（既存ファイルの上書き不可）
              </p>
            )}
          </div>

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
