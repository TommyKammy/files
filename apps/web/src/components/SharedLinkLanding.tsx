'use client';

import { useRef, useState } from 'react';
import {
  AlertTriangle,
  Download,
  Eye,
  EyeOff,
  FileText,
  Folder,
  Loader2,
  Lock,
  Pencil,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import { SecurePreviewModal } from '@/components/SecurePreviewModal';
import { WopiEditorFrame } from '@/components/WopiEditorFrame';
import { useSharedLinkLanding } from '@/lib/use-shared-link-landing';
import { buildLoginUrl } from '@/lib/files-api';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import {
  buildComposedAccessNotice,
  permissionLevelLandingLabel,
} from '@/lib/share-link-levels';
import { isWopiEditableFile } from '@/lib/wopi';

export function SharedLinkLanding({ token }: { token: string }) {
  const {
    meta,
    loading,
    errorCode,
    errorMessage,
    password,
    setPassword,
    showPassword,
    setShowPassword,
    verifyingPassword,
    passwordError,
    previewState,
    setPreviewState,
    actionBusyId,
    uploading,
    uploadError,
    uploadNotice,
    wopiSession,
    setWopiSession,
    wopiBusy,
    handleVerifyPassword,
    handlePreview,
    handleDownload,
    handleUpload,
    handleWopiEdit,
  } = useSharedLinkLanding(token);

  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [dropActive, setDropActive] = useState(false);

  function pickUpload(file: File | null | undefined) {
    if (!file) return;
    void handleUpload(file, { conflictPolicy: 'new_version' });
    if (uploadInputRef.current) uploadInputRef.current.value = '';
  }

  return (
    <main className="min-h-screen bg-[#efeff1] px-4 py-12 text-slate-900">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#5e6ad2] text-sm font-semibold text-white">
              F
            </div>
            <div>
              <div
                data-testid="shared-link-branding-org"
                className="break-words text-sm font-semibold text-slate-900"
              >
                {meta?.branding?.orgName?.trim() || 'Files'}
              </div>
              <div className="text-[0.6875rem] text-slate-700">Secure Share Delivery</div>
            </div>
          </div>
          {meta && (
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 font-mono text-[0.6875rem] text-slate-600">
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
                  <div
                    id="shared-link-password-error"
                    role="alert"
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                  >
                    {passwordError}
                  </div>
                )}
                <div className="text-xs">
                  <label
                    htmlFor="shared-link-password"
                    className="font-medium text-slate-700"
                  >
                    共有パスワード
                  </label>
                  <div className="relative mt-1">
                    <input
                      id="shared-link-password"
                      name="sharedLinkPassword"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      aria-invalid={Boolean(passwordError)}
                      aria-describedby={
                        passwordError ? 'shared-link-password-error' : undefined
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="共有パスワードを入力"
                      className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 pr-10 text-sm focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    />
                    <button
                      type="button"
                      aria-label={
                        showPassword ? 'パスワードを隠す' : 'パスワードを表示'
                      }
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute inset-y-0 right-2 my-auto flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
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
              <div
                role="alert"
                className="border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-700"
              >
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
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span
                  data-testid="shared-link-permission-level"
                  className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[0.6875rem] font-semibold text-blue-700"
                >
                  {permissionLevelLandingLabel(meta.permissionLevel)}
                </span>
                {(meta.file || meta.folder) && (
                  <ClassificationBadge
                    classification={
                      meta.file?.classification ?? meta.folder?.classification ?? 'unset'
                    }
                  />
                )}
              </div>
            </div>

            {buildComposedAccessNotice(meta) && (
              <div
                data-testid="shared-link-composed-access"
                className={`border-b px-6 py-2.5 text-xs ${
                  meta.requiresAuthForEdit
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-indigo-200 bg-indigo-50 text-indigo-800'
                }`}
              >
                {buildComposedAccessNotice(meta)}
              </div>
            )}

            {meta.requiresAuthForEdit && (
              <div className="border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-xs text-amber-800">
                この編集リンクは匿名編集が許可されていません。
                <a
                  href={buildLoginUrl(`/s/${token}`)}
                  className="ml-1 font-semibold underline"
                >
                  サインイン
                </a>
                してから再度開いてください。
              </div>
            )}

            {uploadError && (
              <div
                role="alert"
                data-testid="shared-link-upload-error"
                className="border-b border-red-200 bg-red-50 px-6 py-2.5 text-xs text-red-700"
              >
                {uploadError}
              </div>
            )}
            {uploadNotice && (
              <div
                role="status"
                className="border-b border-emerald-200 bg-emerald-50 px-6 py-2.5 text-xs text-emerald-700"
              >
                {uploadNotice}
              </div>
            )}

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

                  {meta.canEdit && isWopiEditableFile(meta.file) && (
                    <button
                      type="button"
                      disabled={wopiBusy}
                      onClick={() => handleWopiEdit(meta.file!)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-300 bg-indigo-50 px-4 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                    >
                      <Pencil className="h-4 w-4" />
                      <span>オンライン編集</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {meta.canEdit && (
              <div className="border-t border-slate-200 p-6">
                <div
                  data-testid="shared-link-upload-zone"
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropActive(true);
                  }}
                  onDragLeave={() => setDropActive(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropActive(false);
                    pickUpload(e.dataTransfer.files?.[0]);
                  }}
                  className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center text-xs transition ${
                    dropActive
                      ? 'border-blue-400 bg-blue-50 text-blue-700'
                      : 'border-slate-200 bg-slate-50 text-slate-600'
                  }`}
                >
                  {uploading ? (
                    <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                  ) : (
                    <Upload className="h-5 w-5 text-blue-600" />
                  )}
                  <div className="font-medium">
                    {meta.targetType === 'file'
                      ? '新しいバージョンをアップロード'
                      : 'ファイルをアップロード'}
                  </div>
                  <div className="text-[0.6875rem] text-slate-500">
                    同名ファイルは新バージョンとして上書き保存されます。削除・権限変更・共有管理はできません。
                  </div>
                  <input
                    ref={uploadInputRef}
                    id="shared-link-upload-input"
                    name="sharedLinkUpload"
                    type="file"
                    className="sr-only"
                    aria-label={
                      meta.targetType === 'file'
                        ? '新しいバージョンのファイルを選択'
                        : '共有フォルダへアップロードするファイルを選択'
                    }
                    onChange={(e) => pickUpload(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={() => uploadInputRef.current?.click()}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[0.6875rem] font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    <span>ファイルを選択</span>
                  </button>
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
                          <div className="text-[0.6875rem] text-slate-500">
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
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-100"
                        >
                          <Eye className="h-3.5 w-3.5 text-blue-600" />
                          <span>プレビュー</span>
                        </button>
                        {meta.canDownload && (
                          <button
                            type="button"
                            disabled={actionBusyId === item.id}
                            onClick={() => handleDownload(item)}
                            className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1 text-[0.6875rem] font-medium text-white hover:bg-blue-700"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>DL</span>
                          </button>
                        )}
                        {meta.canEdit && isWopiEditableFile(item) && (
                          <button
                            type="button"
                            disabled={wopiBusy}
                            onClick={() => handleWopiEdit(item)}
                            className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[0.6875rem] font-medium text-indigo-700 hover:bg-indigo-100"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            <span>編集</span>
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

      {(meta?.branding?.contactInfo?.trim() ||
        meta?.branding?.footerNote?.trim()) && meta && (
        <footer className="space-y-1 border-t border-slate-200 pt-4 text-[0.6875rem] text-slate-500">
          {meta.branding?.contactInfo?.trim() && (
            <p className="whitespace-pre-wrap break-words">
              お問い合わせ: {meta.branding.contactInfo.trim()}
            </p>
          )}
          {meta.branding?.footerNote?.trim() && (
            <p
              data-testid="shared-link-branding-footer"
              className="whitespace-pre-wrap break-words"
            >
              {meta.branding.footerNote.trim()}
            </p>
          )}
        </footer>
      )}

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

      {wopiSession && meta && (
        <ModalShell
          label={`オンライン編集: ${wopiSession.fileName}`}
          onClose={() => setWopiSession(null)}
          backdrop="deep"
          className="flex h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <WopiEditorFrame
            file={{
              id: wopiSession.fileId,
              name: wopiSession.fileName,
              extension:
                wopiSession.fileName.split('.').pop()?.toLowerCase() ?? null,
            }}
            initialSession={wopiSession}
            onClose={() => setWopiSession(null)}
          />
        </ModalShell>
      )}
    </main>
  );
}
