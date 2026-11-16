'use client';

import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  FileWarning,
  Loader2,
} from 'lucide-react';
import type { RefObject } from 'react';
import { DynamicWatermarkOverlay } from '@/components/DynamicWatermarkOverlay';
import { formatBytes } from '@/lib/formatters';
import type { PreviewTargetFile } from '@/components/SecurePreviewModal';

export type PreviewKind = 'pdf' | 'image' | 'text' | 'active_source' | 'fallback';

export function SecurePreviewContent({
  loading,
  error,
  previewKind,
  requireWatermark,
  watermarkText,
  pdfPage,
  pdfNumPages,
  setPdfPage,
  canvasRef,
  signedUrl,
  file,
  truncatedNotice,
  textContent,
  canDownload,
  onDownload,
}: {
  loading: boolean;
  error: string | null;
  previewKind: PreviewKind;
  requireWatermark: boolean;
  watermarkText: string | null;
  pdfPage: number;
  pdfNumPages: number;
  setPdfPage: React.Dispatch<React.SetStateAction<number>>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  signedUrl: string | null;
  file: PreviewTargetFile;
  truncatedNotice: boolean;
  textContent: string | null;
  canDownload: boolean;
  onDownload: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="プレビュー内容"
      tabIndex={-1}
      data-autofocus
      className="flex-1 overflow-auto bg-slate-100 p-4"
    >
      {loading ? (
        <div className="flex h-80 flex-col items-center justify-center gap-3 text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
          <span className="text-sm">署名付きプレビューを読み込み中...</span>
        </div>
      ) : error ? (
        <div
          role="alert"
          className="mx-auto my-12 max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700"
        >
          <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-red-500" />
          <p>{error}</p>
        </div>
      ) : (
        <DynamicWatermarkOverlay
          enabled={requireWatermark}
          watermarkText={watermarkText}
        >
          {previewKind === 'pdf' && (
            <div className="flex flex-col items-center gap-3 rounded-lg bg-slate-200/70 p-4">
              <div className="flex items-center gap-3 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs shadow-2xs">
                <button
                  type="button"
                  disabled={pdfPage <= 1}
                  onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                  className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="font-mono text-slate-700">
                  Page {pdfPage} / {pdfNumPages}
                </span>
                <button
                  type="button"
                  disabled={pdfPage >= pdfNumPages}
                  onClick={() =>
                    setPdfPage((p) => Math.min(pdfNumPages, p + 1))
                  }
                  className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-40"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
              <canvas
                ref={canvasRef}
                className="max-w-full rounded bg-white shadow-md"
              />
            </div>
          )}

          {previewKind === 'image' && signedUrl && (
            <div className="flex min-h-72 items-center justify-center rounded-lg bg-white p-4 shadow-xs">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={signedUrl}
                alt={file.name}
                draggable={false}
                className="max-h-[68vh] max-w-full object-contain"
              />
            </div>
          )}

          {(previewKind === 'active_source' || previewKind === 'text') && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
              {truncatedNotice && (
                <div className="mb-3 rounded bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
                  ファイルサイズが大きいため先頭 512 KiB のみを表示しています。
                </div>
              )}
              <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-800">
                <code>{textContent ?? ''}</code>
              </pre>
            </div>
          )}

          {previewKind === 'fallback' && (
            <div className="mx-auto my-12 max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-xs">
              <FileWarning className="mx-auto mb-3 h-10 w-10 text-slate-500" />
              <h3 className="text-sm font-semibold text-slate-900">
                この形式のブラウザ内プレビューには対応していません
              </h3>
              <p className="mt-1.5 text-xs text-slate-500">
                {file.mimeType ?? 'application/octet-stream'} •{' '}
                {formatBytes(file.sizeBytes)}
              </p>
              {canDownload ? (
                <button
                  type="button"
                  onClick={onDownload}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700"
                >
                  <Download className="h-3.5 w-3.5" />
                  <span>ファイルをダウンロード</span>
                </button>
              ) : (
                <p className="mt-4 text-xs text-amber-700">
                  この共有設定ではダウンロードが許可されていません。
                </p>
              )}
            </div>
          )}
        </DynamicWatermarkOverlay>
      )}
    </div>
  );
}
