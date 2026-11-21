'use client';

import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  Eye,
  FileAudio,
  FileWarning,
  Loader2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { DynamicWatermarkOverlay } from '@/components/DynamicWatermarkOverlay';
import { formatBytes } from '@/lib/formatters';
import {
  PDF_ZOOM_DEFAULT,
  PDF_ZOOM_MAX,
  PDF_ZOOM_MIN,
  type PdfRotation,
  type PreviewKind,
  formatPdfZoomPercent,
  rotatePdfClockwise,
  stepPdfZoom,
} from '@/lib/preview-controls';
import {
  type MarkdownInline,
  parseMarkdownBlocks,
} from '@/lib/preview-markdown';
import type { PreviewTargetFile } from '@/components/SecurePreviewModal';

export type { PreviewKind };

function renderMarkdownInlines(inlines: MarkdownInline[], keyPrefix: string) {
  return inlines.map((node, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (node.kind) {
      case 'code':
        return (
          <code
            key={key}
            className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-800"
          >
            {node.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-slate-900">
            {node.text}
          </strong>
        );
      case 'em':
        return (
          <em key={key} className="italic">
            {node.text}
          </em>
        );
      case 'link':
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-700"
          >
            {node.label}
          </a>
        );
      case 'text':
      default:
        return <span key={key}>{node.text}</span>;
    }
  });
}

function SafeMarkdownViewer({
  content,
  truncatedNotice,
}: {
  content: string;
  truncatedNotice: boolean;
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);

  return (
    <div className="space-y-4">
      {truncatedNotice && (
        <div className="rounded bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
          ファイルサイズが大きいため先頭 512 KiB のみを表示しています。
        </div>
      )}
      {blocks.length === 0 ? (
        <p className="text-sm text-slate-500">（空の Markdown ファイル）</p>
      ) : (
        <div className="space-y-3 text-sm leading-relaxed text-slate-700">
          {blocks.map((block, idx) => {
            const key = `md-block-${idx}`;
            if (block.kind === 'heading') {
              const headingStyles: Record<number, string> = {
                1: 'border-b border-slate-200 pb-1.5 text-xl font-bold text-slate-900',
                2: 'border-b border-slate-100 pb-1 text-lg font-semibold text-slate-900',
                3: 'text-base font-semibold text-slate-900',
                4: 'text-sm font-semibold text-slate-900',
                5: 'text-xs font-semibold uppercase tracking-wide text-slate-700',
                6: 'text-xs font-semibold text-slate-600',
              };
              const Tag = `h${block.level}` as
                | 'h1'
                | 'h2'
                | 'h3'
                | 'h4'
                | 'h5'
                | 'h6';
              return (
                <Tag key={key} className={headingStyles[block.level]}>
                  {renderMarkdownInlines(block.inlines, key)}
                </Tag>
              );
            }
            if (block.kind === 'list') {
              const ListTag = block.ordered ? 'ol' : 'ul';
              return (
                <ListTag
                  key={key}
                  className={
                    block.ordered
                      ? 'list-decimal space-y-1 pl-6'
                      : 'list-disc space-y-1 pl-6'
                  }
                >
                  {block.items.map((item, itemIdx) => (
                    <li key={`${key}-item-${itemIdx}`} className="break-words">
                      {renderMarkdownInlines(item, `${key}-item-${itemIdx}`)}
                    </li>
                  ))}
                </ListTag>
              );
            }
            if (block.kind === 'blockquote') {
              return (
                <blockquote
                  key={key}
                  className="border-l-4 border-slate-300 bg-slate-50 py-1.5 pl-4 pr-3 text-slate-600"
                >
                  <p className="whitespace-pre-wrap break-words">
                    {renderMarkdownInlines(block.inlines, key)}
                  </p>
                </blockquote>
              );
            }
            if (block.kind === 'code') {
              return (
                <div
                  key={key}
                  className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-900 text-slate-100"
                >
                  {block.language && (
                    <div className="border-b border-slate-800 px-3 py-1 font-mono text-[0.6875rem] text-slate-400">
                      {block.language}
                    </div>
                  )}
                  <pre className="p-3 font-mono text-xs leading-relaxed">
                    <code>{block.code}</code>
                  </pre>
                </div>
              );
            }
            if (block.kind === 'hr') {
              return <hr key={key} className="border-slate-200" />;
            }
            return (
              <p key={key} className="whitespace-pre-wrap break-words">
                {renderMarkdownInlines(block.inlines, key)}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LineNumberedCodeViewer({
  content,
  truncatedNotice,
}: {
  content: string;
  truncatedNotice: boolean;
}) {
  const lines = useMemo(
    () => content.replace(/\r\n?/g, '\n').split('\n'),
    [content]
  );

  return (
    <div>
      {truncatedNotice && (
        <div className="mb-3 rounded bg-slate-100 px-3 py-1.5 text-xs text-slate-600">
          ファイルサイズが大きいため先頭 512 KiB のみを表示しています。
        </div>
      )}
      <div className="max-h-[65vh] overflow-auto rounded-md border border-slate-200 bg-slate-50/60 font-mono text-xs leading-relaxed">
        <table className="w-full border-collapse">
          <tbody>
            {lines.map((line, idx) => (
              <tr key={idx} className="hover:bg-slate-100/80">
                <td
                  aria-hidden="true"
                  className="w-12 select-none border-r border-slate-200 bg-slate-100/70 px-2.5 py-0.5 text-right align-top text-[0.6875rem] text-slate-400"
                >
                  {idx + 1}
                </td>
                <td className="whitespace-pre-wrap break-words px-3 py-0.5 text-slate-800">
                  <code>{line || '\u00A0'}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SecurePreviewContent({
  loading,
  error,
  previewKind,
  requireWatermark,
  watermarkText,
  pdfPage,
  pdfNumPages,
  setPdfPage,
  pdfZoom = PDF_ZOOM_DEFAULT,
  setPdfZoom,
  pdfRotation = 0,
  setPdfRotation,
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
  pdfZoom?: number;
  setPdfZoom?: React.Dispatch<React.SetStateAction<number>>;
  pdfRotation?: PdfRotation;
  setPdfRotation?: React.Dispatch<React.SetStateAction<PdfRotation>>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  signedUrl: string | null;
  file: PreviewTargetFile;
  truncatedNotice: boolean;
  textContent: string | null;
  canDownload: boolean;
  onDownload: () => void;
}) {
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>(
    'preview'
  );

  useEffect(() => {
    setMarkdownMode('preview');
  }, [file.id]);

  const restrictMedia = !canDownload || requireWatermark;

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
              <div className="flex flex-wrap items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs shadow-2xs">
                <button
                  type="button"
                  aria-label="前のページ"
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
                  aria-label="次のページ"
                  disabled={pdfPage >= pdfNumPages}
                  onClick={() =>
                    setPdfPage((p) => Math.min(pdfNumPages, p + 1))
                  }
                  className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-40"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>

                {setPdfZoom && (
                  <>
                    <span
                      aria-hidden="true"
                      className="mx-1 h-4 w-px bg-slate-200"
                    />
                    <button
                      type="button"
                      aria-label="縮小"
                      title="縮小"
                      disabled={pdfZoom <= PDF_ZOOM_MIN}
                      onClick={() => setPdfZoom((z) => stepPdfZoom(z, -1))}
                      className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-40"
                    >
                      <ZoomOut className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="ズームを100%にリセット"
                      title="100%にリセット"
                      onClick={() => setPdfZoom(PDF_ZOOM_DEFAULT)}
                      className="min-w-[3rem] rounded px-1.5 py-0.5 text-center font-mono text-slate-700 hover:bg-slate-100"
                    >
                      {formatPdfZoomPercent(pdfZoom)}
                    </button>
                    <button
                      type="button"
                      aria-label="拡大"
                      title="拡大"
                      disabled={pdfZoom >= PDF_ZOOM_MAX}
                      onClick={() => setPdfZoom((z) => stepPdfZoom(z, 1))}
                      className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100 disabled:opacity-40"
                    >
                      <ZoomIn className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}

                {setPdfRotation && (
                  <>
                    <span
                      aria-hidden="true"
                      className="mx-1 h-4 w-px bg-slate-200"
                    />
                    <button
                      type="button"
                      aria-label="右に90度回転"
                      title={`90度回転 (現在 ${pdfRotation}°)`}
                      onClick={() =>
                        setPdfRotation((r) => rotatePdfClockwise(r))
                      }
                      className="flex h-6 w-6 items-center justify-center rounded hover:bg-slate-100"
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
              <div className="w-full overflow-auto text-center">
                <canvas
                  ref={canvasRef}
                  className={`mx-auto rounded bg-white shadow-md ${
                    pdfZoom <= 1 ? 'max-w-full' : ''
                  }`}
                />
              </div>
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

          {previewKind === 'video' && signedUrl && (
            <div className="flex min-h-72 items-center justify-center rounded-lg bg-slate-950 p-4 shadow-xs">
              <video
                src={signedUrl}
                controls
                playsInline
                preload="metadata"
                controlsList={
                  restrictMedia ? 'nodownload noplaybackrate' : undefined
                }
                disablePictureInPicture={restrictMedia}
                onContextMenu={
                  restrictMedia ? (e) => e.preventDefault() : undefined
                }
                className="max-h-[68vh] max-w-full rounded"
              />
            </div>
          )}

          {previewKind === 'audio' && signedUrl && (
            <div className="mx-auto my-8 flex max-w-lg flex-col items-center gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-50 text-blue-600">
                <FileAudio className="h-6 w-6" />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-slate-900">
                  {file.name}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {formatBytes(file.sizeBytes)}
                </p>
              </div>
              <audio
                src={signedUrl}
                controls
                preload="metadata"
                controlsList={
                  restrictMedia ? 'nodownload noplaybackrate' : undefined
                }
                onContextMenu={
                  restrictMedia ? (e) => e.preventDefault() : undefined
                }
                className="w-full"
              />
            </div>
          )}

          {previewKind === 'markdown' && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
              <div className="mb-3 flex items-center justify-end gap-1 border-b border-slate-100 pb-2.5">
                <div
                  role="group"
                  aria-label="Markdown 表示切替"
                  className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs"
                >
                  <button
                    type="button"
                    aria-pressed={markdownMode === 'preview'}
                    onClick={() => setMarkdownMode('preview')}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors ${
                      markdownMode === 'preview'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    <span>プレビュー</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={markdownMode === 'source'}
                    onClick={() => setMarkdownMode('source')}
                    className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors ${
                      markdownMode === 'source'
                        ? 'bg-white text-slate-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    <span>ソース</span>
                  </button>
                </div>
              </div>
              {markdownMode === 'preview' ? (
                <div className="max-h-[62vh] overflow-auto pr-1">
                  <SafeMarkdownViewer
                    content={textContent ?? ''}
                    truncatedNotice={truncatedNotice}
                  />
                </div>
              ) : (
                <LineNumberedCodeViewer
                  content={textContent ?? ''}
                  truncatedNotice={truncatedNotice}
                />
              )}
            </div>
          )}

          {(previewKind === 'active_source' ||
            previewKind === 'code' ||
            previewKind === 'text') && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-xs">
              <LineNumberedCodeViewer
                content={textContent ?? ''}
                truncatedNotice={truncatedNotice}
              />
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
