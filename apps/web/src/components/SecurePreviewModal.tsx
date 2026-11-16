'use client';

import { ChevronDown, ChevronUp, Download, ShieldAlert, X } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { SecurePreviewContent } from '@/components/SecurePreviewContent';
import { useSecurePreview } from '@/lib/use-secure-preview';
import { ModalShell } from '@/components/ModalShell';
import { formatBytes } from '@/lib/formatters';
import type { ClassificationLabel } from '@/types/files';

export interface PreviewTargetFile {
  id: string;
  folderId?: string | null;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  classification: ClassificationLabel;
}

export interface PreResolvedPreviewGrant {
  url: string;
  safeRenderMode?: 'source_text' | 'standard';
  requireWatermark: boolean;
  watermarkText: string | null;
}

type PreviewKind = 'active_source' | 'pdf' | 'image' | 'text' | 'fallback';

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

export function SecurePreviewModal({
  file,
  canDownload,
  preResolvedGrant,
  canNavigatePrev = false,
  canNavigateNext = false,
  onNavigateFile,
  onDownload,
  onClose,
}: {
  file: PreviewTargetFile;
  canDownload: boolean;
  preResolvedGrant?: PreResolvedPreviewGrant;
  canNavigatePrev?: boolean;
  canNavigateNext?: boolean;
  onNavigateFile?: (direction: -1 | 1) => void;
  onDownload?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const {
    loading,
    error,
    signedUrl,
    requireWatermark,
    watermarkText,
    textContent,
    truncatedNotice,
    previewKind,
    canvasRef,
    pdfPage,
    setPdfPage,
    pdfNumPages,
    downloading,
    handleDownloadClick,
  } = useSecurePreview({
    file,
    canDownload,
    preResolvedGrant,
    canNavigatePrev,
    canNavigateNext,
    onNavigateFile,
    onDownload,
    onClose,
  });

  return (
    <ModalShell
      label={`プレビュー: ${file.name}`}
      onClose={onClose}
      backdrop="deep"
      className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 px-5 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="truncate text-sm font-semibold text-slate-900">
              {file.name}
            </h2>
            <ClassificationBadge classification={file.classification} compact />
            <span className="text-xs text-slate-500">{formatBytes(file.sizeBytes)}</span>
          </div>

          <div className="flex items-center gap-2">
            {onNavigateFile && (
              <div className="hidden sm:inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-slate-600">
                <button
                  type="button"
                  title="前のファイル (↑)"
                  aria-label="前のファイル"
                  disabled={!canNavigatePrev}
                  onClick={() => onNavigateFile(-1)}
                  className="flex h-6 w-6 items-center justify-center rounded hover:bg-white hover:text-slate-900 disabled:opacity-35"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="次のファイル (↓)"
                  aria-label="次のファイル"
                  disabled={!canNavigateNext}
                  onClick={() => onNavigateFile(1)}
                  className="flex h-6 w-6 items-center justify-center rounded hover:bg-white hover:text-slate-900 disabled:opacity-35"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            <span className="hidden md:inline-flex items-center rounded bg-slate-100 px-2 py-0.5 font-mono text-[0.625rem] text-slate-500">
              {previewKind === 'pdf' && pdfNumPages > 1 ? '←/→ ページ • ' : ''}
              Space / Esc 閉じる
            </span>
            {canDownload && (
              <button
                type="button"
                onClick={handleDownloadClick}
                disabled={downloading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{downloading ? '準備中...' : 'ダウンロード'}</span>
              </button>
            )}
            <button
              type="button"
              aria-label="閉じる"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {previewKind === 'active_source' && (
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              Stored XSS 防止のため、HTML / SVG ファイルは実行せず安全なソーステキストとして表示しています。
            </span>
          </div>
        )}

        <SecurePreviewContent
          loading={loading}
          error={error}
          previewKind={previewKind}
          requireWatermark={requireWatermark}
          watermarkText={watermarkText}
          pdfPage={pdfPage}
          pdfNumPages={pdfNumPages}
          setPdfPage={setPdfPage}
          canvasRef={canvasRef}
          signedUrl={signedUrl}
          file={file}
          truncatedNotice={truncatedNotice}
          textContent={textContent}
          canDownload={canDownload}
          onDownload={handleDownloadClick}
        />
    </ModalShell>
  );
}
