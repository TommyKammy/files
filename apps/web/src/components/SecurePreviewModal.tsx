'use client';

import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  FileWarning,
  Loader2,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { DynamicWatermarkOverlay } from '@/components/DynamicWatermarkOverlay';
import { SecurePreviewContent } from '@/components/SecurePreviewContent';
import { ModalShell } from '@/components/ModalShell';
import { ApiClientError, getFileContentUrl } from '@/lib/files-api';
import {
  formatBytes,
  isActiveWebFile,
  isPdfFile,
  isPlainTextFile,
  isSafeImageFile,
} from '@/lib/formatters';
import {
  isEditableTarget,
  isImeComposingEvent,
  keyboardScopes,
} from '@/lib/keyboard-shortcuts';
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [safeRenderMode, setSafeRenderMode] = useState<'source_text' | 'standard'>('standard');
  const [requireWatermark, setRequireWatermark] = useState(
    file.classification === 'confidential'
  );
  const [watermarkText, setWatermarkText] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [truncatedNotice, setTruncatedNotice] = useState(false);

  // PDF canvas state
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<unknown>(null);
  const scopeTokenRef = useRef<string | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfNumPages, setPdfNumPages] = useState(0);
  const [downloading, setDownloading] = useState(false);

  const previewKind: PreviewKind =
    safeRenderMode === 'source_text' || isActiveWebFile(file.name, file.mimeType)
      ? 'active_source'
      : isPdfFile(file.name, file.mimeType)
        ? 'pdf'
        : isSafeImageFile(file.name, file.mimeType)
          ? 'image'
          : isPlainTextFile(file.name, file.mimeType)
            ? 'text'
            : 'fallback';

  useEffect(() => {
    const token = keyboardScopes.pushScope('preview');
    scopeTokenRef.current = token;
    return () => {
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) {
        scopeTokenRef.current = null;
      }
    };
  }, []);

  // Native <dialog> handles Escape; this listener adds Space close, PDF paging and file nav
  useEffect(() => {
    const restrictActions = requireWatermark || !canDownload;

    function handleKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;

      if (
        restrictActions &&
        (e.metaKey || e.ctrlKey) &&
        ['p', 's', 'c'].includes(e.key.toLowerCase())
      ) {
        e.preventDefault();
      }

      if (scopeTokenRef.current && !keyboardScopes.isTopToken(scopeTokenRef.current)) {
        return;
      }

      if (
        e.key === ' ' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditableTarget(e.target)
      ) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) {
        return;
      }

      if (previewKind === 'pdf' && pdfNumPages > 1) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setPdfPage((p) => Math.max(1, p - 1));
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setPdfPage((p) => Math.min(pdfNumPages, p + 1));
          return;
        }
      }

      if (onNavigateFile) {
        if (e.key === 'ArrowUp' && canNavigatePrev) {
          e.preventDefault();
          onNavigateFile(-1);
        } else if (e.key === 'ArrowDown' && canNavigateNext) {
          e.preventDefault();
          onNavigateFile(1);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    requireWatermark,
    canDownload,
    onClose,
    previewKind,
    pdfNumPages,
    onNavigateFile,
    canNavigatePrev,
    canNavigateNext,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function loadContent() {
      setLoading(true);
      setError(null);
      setTextContent(null);
      setTruncatedNotice(false);
      pdfDocRef.current = null;
      setPdfPage(1);
      setPdfNumPages(0);

      try {
        const resolved: PreResolvedPreviewGrant = preResolvedGrant
          ? preResolvedGrant
          : await getFileContentUrl(file.id, 'preview');

        if (cancelled) return;
        const resolvedRenderMode = resolved.safeRenderMode ?? 'standard';
        setSignedUrl(resolved.url);
        setSafeRenderMode(resolvedRenderMode);
        setRequireWatermark(resolved.requireWatermark);
        setWatermarkText(resolved.watermarkText);

        const isSource =
          resolvedRenderMode === 'source_text' ||
          isActiveWebFile(file.name, file.mimeType);
        const isPdf = !isSource && isPdfFile(file.name, file.mimeType);
        const isText = !isSource && !isPdf && isPlainTextFile(file.name, file.mimeType);

        if (isSource || isText) {
          const res = await fetch(resolved.url, {
            credentials: resolved.url.startsWith('/') ? 'include' : 'omit',
          });
          if (!res.ok) {
            throw new Error(`プレビューデータの取得に失敗しました (HTTP ${res.status})`);
          }
          const buf = await res.arrayBuffer();
          if (cancelled) return;
          const sliced =
            buf.byteLength > MAX_TEXT_PREVIEW_BYTES
              ? buf.slice(0, MAX_TEXT_PREVIEW_BYTES)
              : buf;
          setTruncatedNotice(buf.byteLength > MAX_TEXT_PREVIEW_BYTES);
          setTextContent(new TextDecoder('utf-8', { fatal: false }).decode(sliced));
        } else if (isPdf) {
          const res = await fetch(resolved.url, {
            credentials: resolved.url.startsWith('/') ? 'include' : 'omit',
          });
          if (!res.ok) {
            throw new Error(`PDFの取得に失敗しました (HTTP ${res.status})`);
          }
          const data = await res.arrayBuffer();
          if (cancelled) return;

          const pdfjs = await import('pdfjs-dist');
          pdfjs.GlobalWorkerOptions.workerSrc = new URL(
            'pdfjs-dist/build/pdf.worker.min.mjs',
            import.meta.url
          ).toString();

          const doc = await pdfjs.getDocument({ data }).promise;
          if (cancelled) return;
          pdfDocRef.current = doc;
          setPdfNumPages(doc.numPages);
          setPdfPage(1);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiClientError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'プレビューを読み込めませんでした'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadContent();
    return () => {
      cancelled = true;
    };
  }, [file.id, file.name, file.mimeType, preResolvedGrant]);

  // Render active PDF page onto <canvas> (never <iframe>)
  useEffect(() => {
    const doc = pdfDocRef.current as
      | {
          getPage: (n: number) => Promise<{
            getViewport: (opts: { scale: number }) => { width: number; height: number };
            render: (ctx: {
              canvasContext: CanvasRenderingContext2D;
              viewport: { width: number; height: number };
            }) => { promise: Promise<void>; cancel?: () => void };
          }>;
        }
      | null;

    if (!doc || previewKind !== 'pdf' || !canvasRef.current || pdfNumPages === 0) {
      return;
    }

    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;

    doc
      .getPage(pdfPage)
      .then((page) => {
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTask = page.render({ canvasContext: context, viewport });
        return renderTask.promise;
      })
      .catch(() => {
        if (!cancelled) {
          setError('PDFページの描画に失敗しました');
        }
      });

    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [pdfPage, pdfNumPages, previewKind]);

  async function handleDownloadClick() {
    if (!canDownload || downloading) return;
    setDownloading(true);
    try {
      if (onDownload) {
        await onDownload();
      } else {
        const res = await getFileContentUrl(file.id, 'download');
        window.open(res.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : 'ダウンロードURLの取得に失敗しました'
      );
    } finally {
      setDownloading(false);
    }
  }

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
