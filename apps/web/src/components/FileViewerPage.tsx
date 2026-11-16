'use client';

import { AlertTriangle, ArrowLeft, Download, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { SecurePreviewContent } from '@/components/SecurePreviewContent';
import { WopiEditorFrame } from '@/components/WopiEditorFrame';
import { getFileViewerInfo } from '@/lib/files-api';
import { formatBytes } from '@/lib/formatters';
import { useSecurePreview } from '@/lib/use-secure-preview';
import { isWopiEditableFile, type WopiEditorFile } from '@/lib/wopi';
import type { FileItem, ResourceRole } from '@/types/files';

interface FileViewerInfo {
  file: FileItem;
  effectiveRole: ResourceRole;
  canDownload: boolean;
}

export function FileViewerPage({ fileId }: { fileId: string }) {
  const router = useRouter();
  const [info, setInfo] = useState<FileViewerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const closeViewer = useCallback(() => {
    const target = info?.file.folder_id
      ? `/workspace?folderId=${encodeURIComponent(info.file.folder_id)}`
      : '/workspace';
    if (typeof window !== 'undefined' && window.opener) {
      window.close();
      window.setTimeout(() => {
        if (!window.closed) router.push(target);
      }, 80);
      return;
    }
    router.push(target);
  }, [info?.file.folder_id, router]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getFileViewerInfo(fileId)
      .then((res) => {
        if (cancelled) return;
        setInfo(res);
        document.title = `${res.file.name} — Files`;
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : 'ファイル情報の取得に失敗しました'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
        ファイルを読み込み中...
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[#efeff1] p-6 text-center">
        <AlertTriangle className="h-9 w-9 text-amber-500" />
        <div>
          <h1 className="text-base font-semibold text-slate-900">
            ファイルを開けませんでした
          </h1>
          <p className="mt-1 max-w-md text-xs text-slate-600">
            {error ?? 'ファイルが見つかりません'}
          </p>
        </div>
        <button
          type="button"
          onClick={closeViewer}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          ワークスペースへ戻る
        </button>
      </div>
    );
  }

  const viewerFile: WopiEditorFile = {
    id: info.file.id,
    name: info.file.name,
    extension: info.file.extension,
  };

  if (isWopiEditableFile(viewerFile)) {
    return (
      <div className="h-screen w-screen overflow-hidden bg-white">
        <WopiEditorFrame file={viewerFile} onClose={closeViewer} />
      </div>
    );
  }

  return (
    <SecurePreviewPage
      info={info}
      onClose={closeViewer}
    />
  );
}

function SecurePreviewPage({
  info,
  onClose,
}: {
  info: FileViewerInfo;
  onClose: () => void;
}) {
  const file = info.file;
  const previewFile = {
    id: file.id,
    folderId: file.folder_id,
    name: file.name,
    mimeType: file.mime_type,
    sizeBytes: file.size_bytes,
    classification: file.classification,
  };
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
    file: previewFile,
    canDownload: info.canDownload,
    onClose,
  });

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-100">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="ワークスペースへ戻る"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="truncate text-sm font-semibold text-slate-900">
            {file.name}
          </h1>
          <ClassificationBadge classification={file.classification} compact />
          <span className="text-xs text-slate-500">
            {formatBytes(file.size_bytes)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {info.canDownload && (
            <button
              type="button"
              onClick={handleDownloadClick}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {downloading ? '準備中...' : 'ダウンロード'}
            </button>
          )}
        </div>
      </header>
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
        file={previewFile}
        truncatedNotice={truncatedNotice}
        textContent={textContent}
        canDownload={info.canDownload}
        onDownload={handleDownloadClick}
      />
    </div>
  );
}
