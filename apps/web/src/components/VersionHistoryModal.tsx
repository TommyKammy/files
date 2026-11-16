'use client';

import {
  AlertTriangle,
  Download,
  Eye,
  History,
  Loader2,
  Lock,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import { SecurePreviewModal } from '@/components/SecurePreviewModal';
import { VersionRestoreConfirmModal } from '@/components/VersionRestoreConfirmModal';
import { formatBytes } from '@/lib/formatters';
import { useVersionHistory } from '@/lib/use-version-history';
import {
  buildVersionHistoryView,
  formatFileLockMode,
  nextVersionNumber,
  VERSION_ACTIONS_RESPONSIVE_CLASS,
  VERSION_ROW_RESPONSIVE_CLASS,
  type VersionHistoryError,
} from '@/lib/version-history';
import type { VersionHistoryRestoreSuccess } from '@/lib/version-history-controller';
import type {
  Capability,
  ClassificationLabel,
  FileItem,
  FileVersionItem,
  ResourceRole,
} from '@/types/files';

export interface VersionHistoryTarget {
  id: string;
  name: string;
  currentVersionNum: number;
  metaVersion: number;
  sizeBytes: number;
  mimeType: string | null;
  classification: ClassificationLabel;
}

function ErrorBanner({
  error,
  testId,
  onDismiss,
}: {
  error: VersionHistoryError;
  testId: string;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="space-y-1.5 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <p className="leading-relaxed">{error.message}</p>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded px-1.5 py-0.5 text-[0.6875rem] font-medium text-red-700 hover:bg-red-100"
          >
            閉じる
          </button>
        )}
      </div>
      {error.lock && (
        <div
          data-testid="version-lock-owner"
          className="ml-6 space-y-0.5 rounded-md border border-red-200 bg-white/70 px-2.5 py-1.5 text-[0.6875rem] text-red-800"
        >
          <p className="inline-flex items-center gap-1 font-semibold">
            <Lock className="h-3 w-3" />
            ロック保有者: {error.lock.ownerName}
          </p>
          {error.lock.ownerEmail && <p>{error.lock.ownerEmail}</p>}
          <p>{formatFileLockMode(error.lock.mode)}</p>
        </div>
      )}
    </div>
  );
}

export function VersionHistoryModal({
  file,
  effectiveRole,
  capabilities,
  canDownload,
  returnFocus = null,
  onFileUpdated,
  onRestored,
  onClose,
}: {
  file: VersionHistoryTarget;
  effectiveRole: ResourceRole;
  capabilities?: Capability[];
  canDownload: boolean;
  returnFocus?: HTMLElement | null;
  onFileUpdated?: (file: FileItem) => void;
  onRestored?: (result: VersionHistoryRestoreSuccess) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [restoreConfirm, setRestoreConfirm] = useState<{
    version: FileVersionItem;
    returnFocus: HTMLElement | null;
  } | null>(null);

  const {
    versions,
    currentVersionNum,
    loading,
    loadingMore,
    hasMore,
    error,
    restoreError,
    restoringVersionId,
    preparingVersionId,
    preview,
    loadMore,
    restore,
    preparePreview,
    closePreview,
    download,
    clearRestoreError,
  } = useVersionHistory({
    fileId: file.id,
    initialCurrentVersionNum: file.currentVersionNum,
    initialMetaVersion: file.metaVersion,
    onFileUpdated,
    onRestored,
  });

  const rows = buildVersionHistoryView(versions, {
    currentVersionNum,
    effectiveRole,
    capabilities,
    canDownload,
  });
  const currentRow = rows.find((row) => row.isCurrent) ?? rows[0] ?? null;
  const currentSizeLabel = currentRow?.sizeLabel ?? formatBytes(file.sizeBytes);

  // Keep the grant identity stable so controller state changes (download
  // spinner, errors) do not re-trigger SecurePreviewModal's content fetch.
  const previewGrant = useMemo(
    () =>
      preview
        ? {
            url: preview.grant.url,
            safeRenderMode: preview.grant.safeRenderMode,
            requireWatermark: preview.grant.requireWatermark,
            watermarkText: preview.grant.watermarkText,
          }
        : undefined,
    [preview]
  );

  async function handleConfirmRestore() {
    if (!restoreConfirm) return;
    const outcome = await restore(restoreConfirm.version);
    if (outcome.ok || outcome.error.code === 'VERSION_ALREADY_CURRENT') {
      setRestoreConfirm(null);
    }
  }

  return (
    <>
      <ModalShell
        label={`版履歴: ${file.name}`}
        labelledBy={titleId}
        onClose={onClose}
        returnFocus={returnFocus}
        backdrop="dark"
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <History className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2
                id={titleId}
                className="truncate text-sm font-semibold text-slate-900"
              >
                版履歴: {file.name}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.6875rem] text-slate-500">
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono">
                  現在 v{currentVersionNum}
                </span>
                <span>{currentSizeLabel}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">
                  {effectiveRole}
                </span>
                <ClassificationBadge
                  classification={file.classification}
                  compact
                />
              </div>
            </div>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            ×
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {!restoreConfirm && restoreError && (
            <ErrorBanner
              error={restoreError}
              testId="version-restore-banner"
              onDismiss={clearRestoreError}
            />
          )}
          {error && <ErrorBanner error={error} testId="version-history-error" />}

          {!canDownload && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span>
                Previewer 権限のためダウンロードはできません (DLP)。プレビューのみ利用できます。
              </span>
            </div>
          )}

          {loading && rows.length === 0 ? (
            <div className="flex h-52 flex-col items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
              <span>版履歴を読み込み中...</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-xs text-slate-500">
              版履歴はまだありません。
            </div>
          ) : (
            <ul
              aria-label="バージョン一覧"
              data-testid="version-history-list"
              className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200"
            >
              {rows.map((row) => {
                const version = row.version;
                const isPreparing = preparingVersionId === version.id;
                return (
                  <li
                    key={version.id}
                    data-testid={`version-row-${version.versionNum}`}
                    data-version-num={version.versionNum}
                    data-current={row.isCurrent ? 'true' : 'false'}
                    className={`${VERSION_ROW_RESPONSIVE_CLASS} px-3.5 py-3 ${
                      row.isCurrent ? 'bg-indigo-50/40' : 'bg-white'
                    }`}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-sm font-semibold text-slate-900">
                          {row.versionLabel}
                        </span>
                        {row.isCurrent && (
                          <span
                            data-testid={`version-current-${version.versionNum}`}
                            className="rounded-full border border-indigo-200 bg-indigo-600 px-2 py-0.5 text-[0.625rem] font-semibold text-white"
                          >
                            現在版
                          </span>
                        )}
                        <span
                          className={`rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${row.status.className}`}
                        >
                          {row.status.label}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-slate-500">
                        <span className="font-mono">{row.sizeLabel}</span>
                        <span>作成者: {row.authorLabel}</span>
                        <span>{row.createdAtLabel}</span>
                      </div>
                      {row.comment && (
                        <p
                          data-testid={`version-comment-${version.versionNum}`}
                          className="text-[0.6875rem] text-slate-600"
                        >
                          {row.comment}
                        </p>
                      )}
                    </div>

                    <div
                      data-testid={`version-actions-${version.versionNum}`}
                      className={VERSION_ACTIONS_RESPONSIVE_CLASS}
                    >
                      <button
                        type="button"
                        data-testid={`version-preview-${version.versionNum}`}
                        disabled={!row.canPreview || isPreparing}
                        title={
                          row.canPreview
                            ? `${row.versionLabel} をプレビュー`
                            : 'アップロードが完了していないためプレビューできません'
                        }
                        onClick={() => {
                          void preparePreview(version);
                        }}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {isPreparing ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Eye className="h-3.5 w-3.5 text-blue-600" />
                        )}
                        <span>
                          {isPreparing
                            ? '準備中...'
                            : row.canPreview
                              ? 'プレビュー'
                              : 'プレビュー不可'}
                        </span>
                      </button>

                      <button
                        type="button"
                        data-testid={`version-download-${version.versionNum}`}
                        disabled={!row.canDownload}
                        title={
                          !row.canPreview
                            ? 'アップロードが完了していないためダウンロードできません'
                            : row.canDownload
                              ? `${row.versionLabel} をダウンロード`
                              : 'Previewer 権限のためダウンロードできません (DLP)'
                        }
                        onClick={() => {
                          void download(version).catch(() => undefined);
                        }}
                        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {row.canDownload ? (
                          <Download className="h-3.5 w-3.5 text-slate-600" />
                        ) : (
                          <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />
                        )}
                        <span>
                          {row.canDownload ? 'ダウンロード' : 'ダウンロード不可'}
                        </span>
                      </button>

                      {row.canRestore && (
                        <button
                          type="button"
                          data-testid={`version-restore-${version.versionNum}`}
                          onClick={(event) => {
                            setRestoreConfirm({
                              version,
                              returnFocus: event.currentTarget,
                            });
                          }}
                          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[0.6875rem] font-semibold text-amber-800 hover:bg-amber-100"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>このバージョンに戻す</span>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {hasMore && (
            <div className="flex justify-center pt-1">
              <button
                type="button"
                data-testid="version-load-more"
                disabled={loadingMore}
                onClick={() => {
                  void loadMore();
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {loadingMore && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                <span>さらに読み込む</span>
              </button>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3 text-[0.6875rem] text-slate-500">
          <span>
            復元は新しいバージョンとして追加され、既存の履歴は削除されません。
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            閉じる
          </button>
        </footer>
      </ModalShell>

      {restoreConfirm && (
        <VersionRestoreConfirmModal
          sourceVersion={restoreConfirm.version}
          currentVersionNum={currentVersionNum}
          nextVersionNum={nextVersionNumber(versions, currentVersionNum)}
          submitting={restoringVersionId === restoreConfirm.version.id}
          error={restoreError}
          returnFocus={restoreConfirm.returnFocus}
          onConfirm={() => {
            void handleConfirmRestore();
          }}
          onClose={() => {
            setRestoreConfirm(null);
            clearRestoreError();
          }}
        />
      )}

      {preview && (
        <SecurePreviewModal
          file={{
            id: file.id,
            name: file.name,
            mimeType: preview.version.mimeType || file.mimeType,
            sizeBytes: preview.version.sizeBytes,
            classification: file.classification,
            versionLabel: `v${preview.version.versionNum} (過去版)`,
          }}
          canDownload={canDownload}
          preResolvedGrant={previewGrant}
          onDownload={() => download(preview.version)}
          onClose={closePreview}
        />
      )}
    </>
  );
}
