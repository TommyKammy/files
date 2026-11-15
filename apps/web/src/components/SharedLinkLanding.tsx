'use client';

import {
  AlertTriangle,
  Download,
  Eye,
  FileText,
  Folder,
  Loader2,
  Lock,
  ShieldAlert,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  type PreResolvedPreviewGrant,
  type PreviewTargetFile,
  SecurePreviewModal,
} from '@/components/SecurePreviewModal';
import {
  ApiClientError,
  buildLoginUrl,
  getPublicShareMeta,
  issuePublicShareUrl,
  verifyPublicSharePassword,
} from '@/lib/files-api';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import type { PublicShareFileMeta, PublicShareMeta } from '@/types/files';

export function SharedLinkLanding({ token }: { token: string }) {
  const [meta, setMeta] = useState<PublicShareMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [verifyingPassword, setVerifyingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [unlockToken, setUnlockToken] = useState<string | undefined>(undefined);

  const [previewState, setPreviewState] = useState<{
    file: PreviewTargetFile;
    grant: PreResolvedPreviewGrant;
  } | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  const loadMeta = useCallback(async () => {
    setLoading(true);
    setErrorCode(null);
    setErrorMessage(null);
    try {
      const data = await getPublicShareMeta(token);
      setMeta(data);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setErrorCode(err.code ?? String(err.status));
        setErrorMessage(err.message);
      } else {
        setErrorCode('LOAD_ERROR');
        setErrorMessage('共有リンクの読み込みに失敗しました');
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  async function handleVerifyPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!password || verifyingPassword) return;
    setVerifyingPassword(true);
    setPasswordError(null);
    try {
      const res = await verifyPublicSharePassword(token, password);
      if (res.unlockToken) {
        setUnlockToken(res.unlockToken);
      }
      setPassword('');
      await loadMeta();
    } catch (err) {
      if (err instanceof ApiClientError) {
        const remaining =
          typeof err.details?.remainingAttempts === 'number'
            ? ` (残り試行回数: ${err.details.remainingAttempts})`
            : '';
        setPasswordError(`${err.message}${remaining}`);
        if (err.code === 'LINK_LOCKED') {
          await loadMeta();
        }
      } else {
        setPasswordError('パスワード検証に失敗しました');
      }
    } finally {
      setVerifyingPassword(false);
    }
  }

  async function handlePreview(file: PublicShareFileMeta) {
    if (actionBusyId) return;
    setActionBusyId(file.id);
    setErrorMessage(null);
    try {
      const granted = await issuePublicShareUrl(token, {
        intent: 'preview',
        fileId: file.id,
        unlockToken,
      });
      setPreviewState({
        file: {
          id: granted.file.id,
          name: granted.file.name,
          mimeType: granted.file.mimeType,
          sizeBytes: granted.file.sizeBytes,
          classification: granted.file.classification,
        },
        grant: {
          url: granted.url,
          safeRenderMode: granted.safeRenderMode,
          requireWatermark: granted.requireWatermark,
          watermarkText: granted.watermarkText,
        },
      });
    } catch (err) {
      setErrorMessage(
        err instanceof ApiClientError
          ? err.message
          : 'プレビューURLの発行に失敗しました'
      );
    } finally {
      setActionBusyId(null);
    }
  }

  async function handleDownload(file: PublicShareFileMeta) {
    if (!meta?.canDownload || actionBusyId) return;
    setActionBusyId(file.id);
    setErrorMessage(null);
    try {
      const granted = await issuePublicShareUrl(token, {
        intent: 'download',
        fileId: file.id,
        unlockToken,
      });
      setMeta((prev) =>
        prev ? { ...prev, downloadCount: granted.downloadCount } : prev
      );
      window.open(granted.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setErrorMessage(
        err instanceof ApiClientError
          ? err.message
          : 'ダウンロードURLの発行に失敗しました'
      );
    } finally {
      setActionBusyId(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#F8FAFC] px-4 py-12 text-slate-900">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#131B2E] text-sm font-bold text-white">
              F
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">Files</div>
              <div className="text-[11px] text-slate-500">Secure Share Delivery</div>
            </div>
          </div>
          {meta && (
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 font-mono text-[11px] text-slate-600">
              {meta.accessScope}
            </span>
          )}
        </div>

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center shadow-xs">
            <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-blue-600" />
            <p className="text-sm text-slate-500">共有メタデータを検証中...</p>
          </div>
        ) : errorCode === 'AUTH_REQUIRED' ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-xs space-y-4">
            <ShieldAlert className="mx-auto h-9 w-9 text-blue-600" />
            <h1 className="text-lg font-semibold text-slate-900">
              社内 SSO 認証が必要です
            </h1>
            <p className="text-xs text-slate-500">
              {errorMessage ?? 'この共有リンクは組織メンバー限定です。'}
            </p>
            <a
              href={buildLoginUrl(`/s/${token}`)}
              className="inline-flex rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              SSO でサインインして開く
            </a>
          </div>
        ) : !meta ? (
          <div className="rounded-2xl border border-red-200 bg-white p-8 text-center shadow-xs space-y-3">
            <AlertTriangle className="mx-auto h-8 w-8 text-red-500" />
            <h1 className="text-base font-semibold text-slate-900">
              共有リンクを開けませんでした
            </h1>
            <p className="text-xs text-red-600">
              {errorMessage ?? 'リンクが存在しないか、有効期限切れまたは失効済みです。'}
            </p>
          </div>
        ) : meta.requiresPassword && !meta.unlocked ? (
          <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-xs space-y-4">
            <div className="flex items-center gap-2.5">
              <Lock className="h-5 w-5 text-blue-600" />
              <h1 className="text-base font-semibold text-slate-900">
                パスワード保護された共有リンク
              </h1>
            </div>

            {meta.isLocked ? (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
                パスワード失敗回数が上限に達したため一時ロック中です。解除時刻:{' '}
                {formatDateTime(meta.lockedUntil)}
              </div>
            ) : (
              <form onSubmit={handleVerifyPassword} className="space-y-3">
                {passwordError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {passwordError}
                  </div>
                )}
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="共有パスワードを入力"
                  className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={verifyingPassword}
                  className="w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {verifyingPassword ? '確認中...' : 'ロックを解除'}
                </button>
              </form>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-xs overflow-hidden">
            {errorMessage && (
              <div className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700">
                {errorMessage}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-6 py-4 bg-slate-50/70">
              <div className="flex items-center gap-2.5">
                {meta.targetType === 'folder' ? (
                  <Folder className="h-5 w-5 text-amber-500" />
                ) : (
                  <FileText className="h-5 w-5 text-blue-600" />
                )}
                <div>
                  <h1 className="text-base font-semibold text-slate-900">
                    {meta.file?.name ?? meta.folder?.name ?? '共有リソース'}
                  </h1>
                  <div className="text-xs text-slate-500">
                    期限: {formatDateTime(meta.expiresAt)} • ダウンロード:{' '}
                    {meta.downloadCount}
                    {meta.maxDownloads ? ` / ${meta.maxDownloads}` : ''}
                    {!meta.canDownload ? ' • プレビュー専用 (DL不可)' : ''}
                  </div>
                </div>
              </div>

              {(meta.file || meta.folder) && (
                <ClassificationBadge
                  classification={
                    meta.file?.classification ?? meta.folder?.classification ?? 'unset'
                  }
                />
              )}
            </div>

            {meta.targetType === 'file' && meta.file && (
              <div className="p-6 flex flex-wrap items-center justify-between gap-4">
                <div className="text-xs text-slate-600">
                  <div>サイズ: {formatBytes(meta.file.sizeBytes)}</div>
                  <div>MIME: {meta.file.mimeType ?? 'application/octet-stream'}</div>
                </div>

                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    disabled={actionBusyId === meta.file.id}
                    onClick={() => handlePreview(meta.file!)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Eye className="h-4 w-4 text-blue-600" />
                    <span>セキュアプレビュー</span>
                  </button>

                  {meta.canDownload && (
                    <button
                      type="button"
                      disabled={actionBusyId === meta.file.id}
                      onClick={() => handleDownload(meta.file!)}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Download className="h-4 w-4" />
                      <span>ダウンロード</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {meta.targetType === 'folder' && (
              <div className="divide-y divide-slate-100">
                {meta.folderFiles.length === 0 ? (
                  <div className="px-6 py-10 text-center text-xs text-slate-500">
                    この共有フォルダ内にアクティブなファイルはありません
                  </div>
                ) : (
                  meta.folderFiles.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-4 px-6 py-3.5 text-xs hover:bg-slate-50/70"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <FileText className="h-4 w-4 shrink-0 text-blue-500" />
                        <div className="min-w-0">
                          <div className="truncate font-medium text-slate-900">
                            {item.name}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {formatBytes(item.sizeBytes)}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <ClassificationBadge
                          classification={item.classification}
                          compact
                        />
                        <button
                          type="button"
                          disabled={actionBusyId === item.id}
                          onClick={() => handlePreview(item)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                        >
                          <Eye className="h-3.5 w-3.5 text-blue-600" />
                          <span>プレビュー</span>
                        </button>
                        {meta.canDownload && (
                          <button
                            type="button"
                            disabled={actionBusyId === item.id}
                            onClick={() => handleDownload(item)}
                            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-700"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>DL</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {previewState && meta && (
        <SecurePreviewModal
          file={previewState.file}
          canDownload={meta.canDownload}
          preResolvedGrant={previewState.grant}
          onDownload={async () => {
            const target = meta.folderFiles.find(
              (f) => f.id === previewState.file.id
            ) ?? {
              id: previewState.file.id,
              name: previewState.file.name,
              mimeType: previewState.file.mimeType,
              sizeBytes: previewState.file.sizeBytes,
              classification: previewState.file.classification,
            };
            await handleDownload(target);
          }}
          onClose={() => setPreviewState(null)}
        />
      )}
    </main>
  );
}
