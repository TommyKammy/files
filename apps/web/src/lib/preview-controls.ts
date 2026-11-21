import {
  isActiveWebFile,
  isAudioFile,
  isCodeFile,
  isMarkdownFile,
  isPdfFile,
  isPlainTextFile,
  isSafeImageFile,
  isVideoFile,
} from '@/lib/formatters';

export type PreviewKind =
  | 'active_source'
  | 'pdf'
  | 'image'
  | 'video'
  | 'audio'
  | 'markdown'
  | 'code'
  | 'text'
  | 'fallback';

export type PdfRotation = 0 | 90 | 180 | 270;

export const PDF_ZOOM_MIN = 0.5;
export const PDF_ZOOM_MAX = 2.5;
export const PDF_ZOOM_STEP = 0.25;
export const PDF_ZOOM_DEFAULT = 1.0;
export const PDF_BASE_SCALE = 1.35;

export function resolvePreviewKind(
  name: string,
  mimeType: string | null | undefined,
  safeRenderMode: 'source_text' | 'standard' = 'standard'
): PreviewKind {
  if (safeRenderMode === 'source_text' || isActiveWebFile(name, mimeType)) {
    return 'active_source';
  }
  if (isPdfFile(name, mimeType)) return 'pdf';
  if (isSafeImageFile(name, mimeType)) return 'image';
  if (isVideoFile(name, mimeType)) return 'video';
  if (isAudioFile(name, mimeType)) return 'audio';
  if (isMarkdownFile(name, mimeType)) return 'markdown';
  if (isCodeFile(name, mimeType)) return 'code';
  if (isPlainTextFile(name, mimeType)) return 'text';
  return 'fallback';
}

export function clampPdfZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return PDF_ZOOM_DEFAULT;
  const clamped = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, zoom));
  return Math.round(clamped * 100) / 100;
}

export function stepPdfZoom(current: number, deltaSteps: number): number {
  return clampPdfZoom(current + deltaSteps * PDF_ZOOM_STEP);
}

export function formatPdfZoomPercent(zoom: number): string {
  return `${Math.round(clampPdfZoom(zoom) * 100)}%`;
}

export function rotatePdfClockwise(current: number): PdfRotation {
  const normalized = Number.isFinite(current) ? Math.round(current / 90) * 90 : 0;
  return ((((normalized + 90) % 360) + 360) % 360) as PdfRotation;
}
