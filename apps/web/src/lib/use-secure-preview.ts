'use client';

import { useEffect, useRef, useState } from 'react';
import {
  isImeComposingEvent,
  isEditableTarget,
  keyboardScopes,
} from '@/lib/keyboard-shortcuts';
import { ApiClientError, getFileContentUrl } from '@/lib/files-api';
import { isActiveWebFile, isPdfFile, isPlainTextFile, isSafeImageFile } from '@/lib/formatters';
import type {
  PreResolvedPreviewGrant,
  PreviewTargetFile,
} from '@/components/SecurePreviewModal';

export type PreviewKind =
  | 'active_source'
  | 'pdf'
  | 'image'
  | 'text'
  | 'fallback';

const MAX_TEXT_PREVIEW_BYTES = 512 * 1024;

export function useSecurePreview({
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
  const [safeRenderMode, setSafeRenderMode] = useState<
    'source_text' | 'standard'
  >('standard');
  const [requireWatermark, setRequireWatermark] = useState(
    file.classification === 'confidential'
  );
  const [watermarkText, setWatermarkText] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [truncatedNotice, setTruncatedNotice] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfDocRef = useRef<unknown>(null);
  const scopeTokenRef = useRef<string | null>(null);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfNumPages, setPdfNumPages] = useState(0);
  const [downloading, setDownloading] = useState(false);

  const previewKind: PreviewKind =
    safeRenderMode === 'source_text' ||
    isActiveWebFile(file.name, file.mimeType)
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

      if (
        scopeTokenRef.current &&
        !keyboardScopes.isTopToken(scopeTokenRef.current)
      ) {
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
        const isText =
          !isSource && !isPdf && isPlainTextFile(file.name, file.mimeType);

        if (isSource || isText) {
          const res = await fetch(resolved.url, {
            credentials: resolved.url.startsWith('/') ? 'include' : 'omit',
          });
          if (!res.ok) {
            throw new Error(
              `プレビューデータの取得に失敗しました (HTTP ${res.status})`
            );
          }
          const buf = await res.arrayBuffer();
          if (cancelled) return;
          const sliced =
            buf.byteLength > MAX_TEXT_PREVIEW_BYTES
              ? buf.slice(0, MAX_TEXT_PREVIEW_BYTES)
              : buf;
          setTruncatedNotice(buf.byteLength > MAX_TEXT_PREVIEW_BYTES);
          setTextContent(
            new TextDecoder('utf-8', { fatal: false }).decode(sliced)
          );
        } else if (isPdf) {
          const res = await fetch(resolved.url, {
            credentials: resolved.url.startsWith('/') ? 'include' : 'omit',
          });
          if (!res.ok) {
            throw new Error(
              `PDFの取得に失敗しました (HTTP ${res.status})`
            );
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

  useEffect(() => {
    const doc = pdfDocRef.current as
      | {
          getPage: (n: number) => Promise<{
            getViewport: (opts: { scale: number }) => {
              width: number;
              height: number;
            };
            render: (ctx: {
              canvasContext: CanvasRenderingContext2D;
              viewport: { width: number; height: number };
            }) => { promise: Promise<void>; cancel?: () => void };
          }>;
        }
      | null;

    if (
      !doc ||
      previewKind !== 'pdf' ||
      !canvasRef.current ||
      pdfNumPages === 0
    ) {
      return;
    }

    let cancelled = false;
    let renderTask: {
      promise: Promise<void>;
      cancel?: () => void;
    } | null = null;

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
        err instanceof ApiClientError
          ? err.message
          : 'ダウンロードURLの取得に失敗しました'
      );
    } finally {
      setDownloading(false);
    }
  }

  return {
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
  };
}
