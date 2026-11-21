'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Lock,
  LockOpen,
  Share2,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  adminContentReasonError,
  formatAdminContentOwner,
  isAdminContentReasonValid,
} from '@/lib/admin-content';
import { CLASSIFICATION_META, formatBytes, formatDateTime } from '@/lib/formatters';
import type {
  AdminContentDetail,
  AdminContentInspectResponse,
} from '@/types/files';
import { DATE_TIME_OPTIONS } from './shared';

interface ContentInspectorDrawerProps {
  detail: AdminContentDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  unlockReason: string;
  inspectReason: string;
  actionBusy: 'unlock' | 'inspect' | 'revoke' | null;
  actionError: string | null;
  actionNotice: string | null;
  inspectResult: AdminContentInspectResponse | null;
  onClose: () => void;
  onUnlockReasonChange: (value: string) => void;
  onInspectReasonChange: (value: string) => void;
  onForceUnlock: () => void;
  onRevokeSharedLink: (linkId: string) => void;
  onInspect: () => void;
}

/** Slide-over detail drawer for inspecting permissions, locks, shared links, and audited previews. */
export function ContentInspectorDrawer({
  detail,
  detailLoading,
  detailError,
  unlockReason,
  inspectReason,
  actionBusy,
  actionError,
  actionNotice,
  inspectResult,
  onClose,
  onUnlockReasonChange,
  onInspectReasonChange,
  onForceUnlock,
  onRevokeSharedLink,
  onInspect,
}: ContentInspectorDrawerProps) {
  const unlockReasonError = unlockReason
    ? adminContentReasonError(unlockReason)
    : null;
  const inspectReasonError = inspectReason
    ? adminContentReasonError(inspectReason)
    : null;
  const inspectPolicy = detail?.inspectPolicy ?? 'watermark_confidential';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-content-inspector-heading"
        data-testid="admin-content-inspector"
        className="h-full w-full max-w-2xl overflow-y-auto bg-white shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <h3
              id="admin-content-inspector-heading"
              className="truncate text-sm font-semibold text-slate-900"
            >
              {detail?.name ?? 'コンテンツ詳細'}
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              {detail?.pathLabel ?? '詳細を読み込み中...'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="閉じる"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-600 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {detailLoading && (
            <div
              role="status"
              className="flex items-center gap-2 text-xs text-slate-500"
            >
              <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
              詳細を読み込み中...
            </div>
          )}
          {detailError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              {detailError}
            </div>
          )}

          {detail && (
            <>
              <section aria-labelledby="admin-content-summary-heading">
                <h4
                  id="admin-content-summary-heading"
                  className="text-xs font-semibold text-slate-900"
                >
                  メタデータ
                </h4>
                <dl className="mt-2 grid grid-cols-2 gap-2 text-[0.6875rem]">
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-slate-500">所有者</dt>
                    <dd className="mt-0.5 font-medium text-slate-900">
                      {formatAdminContentOwner(detail.owner)}
                      <span className="block text-[0.625rem] font-normal text-slate-500">
                        {detail.owner.email ?? detail.owner.id}
                      </span>
                    </dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-slate-500">機密区分</dt>
                    <dd className="mt-0.5">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${CLASSIFICATION_META[detail.classification].badgeClass}`}
                      >
                        {CLASSIFICATION_META[detail.classification].shortJa}
                      </span>
                    </dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-slate-500">
                      {detail.targetType === 'file' ? 'サイズ / 版数' : '種別'}
                    </dt>
                    <dd className="mt-0.5 font-medium text-slate-900">
                      {detail.targetType === 'file'
                        ? `${formatBytes(detail.sizeBytes ?? 0)} / v${detail.currentVersionNum ?? 1} (全${detail.versions.total}版)`
                        : 'フォルダ'}
                    </dd>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-3 py-2">
                    <dt className="text-slate-500">更新</dt>
                    <dd className="mt-0.5 font-medium text-slate-900">
                      {formatDateTime(detail.updatedAt, DATE_TIME_OPTIONS)}
                    </dd>
                  </div>
                </dl>
              </section>

              <section aria-labelledby="admin-content-permissions-heading">
                <h4
                  id="admin-content-permissions-heading"
                  className="text-xs font-semibold text-slate-900"
                >
                  権限一覧 ({detail.permissions.length})
                </h4>
                {detail.permissions.length === 0 ? (
                  <p className="mt-1 text-[0.6875rem] text-slate-500">
                    直接付与された権限はありません。
                  </p>
                ) : (
                  <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                    {detail.permissions.map((permission) => (
                      <li
                        key={permission.id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[0.6875rem]"
                      >
                        <span className="min-w-0">
                          <span className="block font-medium text-slate-900">
                            {permission.granteeName ??
                              permission.granteeEmail ??
                              permission.granteeId}
                          </span>
                          <span className="block text-[0.625rem] text-slate-500">
                            {permission.granteeType === 'group'
                              ? 'グループ'
                              : 'ユーザー'}
                            {permission.granteeEmail
                              ? ` / ${permission.granteeEmail}`
                              : ''}
                          </span>
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
                          {permission.role}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="admin-content-lock-heading">
                <h4
                  id="admin-content-lock-heading"
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-900"
                >
                  <Lock className="h-3.5 w-3.5 text-amber-600" />
                  ロック情報
                </h4>
                {detail.targetType === 'folder' ? (
                  <p className="mt-1 text-[0.6875rem] text-slate-500">
                    フォルダ自体にはファイルロックはありません。
                  </p>
                ) : detail.activeLock ? (
                  <div className="mt-2 space-y-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-[0.6875rem] text-amber-900">
                    <p className="font-medium">
                      {detail.activeLock.mode === 'desktop_exclusive'
                        ? 'Files Drive 排他ロック'
                        : 'WOPI 共同編集ロック'}
                    </p>
                    <p>
                      保持者: {detail.activeLock.ownerName}
                      {detail.activeLock.ownerEmail
                        ? ` (${detail.activeLock.ownerEmail})`
                        : ''}
                    </p>
                    <p>
                      期限:{' '}
                      {formatDateTime(
                        new Date(detail.activeLock.expiresAt).toISOString(),
                        DATE_TIME_OPTIONS
                      )}
                    </p>
                    <label className="block">
                      <span className="mb-1 block font-medium">
                        強制解除の理由 (3〜300文字)
                      </span>
                      <textarea
                        value={unlockReason}
                        onChange={(event) =>
                          onUnlockReasonChange(event.target.value)
                        }
                        rows={2}
                        maxLength={300}
                        className="w-full rounded-md border border-amber-300 bg-white px-2 py-1.5 text-[0.6875rem] text-slate-900"
                      />
                    </label>
                    {unlockReasonError && (
                      <p className="text-[0.625rem] text-red-700">
                        {unlockReasonError}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={onForceUnlock}
                      disabled={
                        !isAdminContentReasonValid(unlockReason) ||
                        actionBusy !== null
                      }
                      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-amber-700 px-3 text-[0.75rem] font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {actionBusy === 'unlock' ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <LockOpen className="h-3.5 w-3.5" />
                      )}
                      ロックを強制解除
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-[0.6875rem] text-slate-500">
                    保持中のロックはありません。
                  </p>
                )}
              </section>

              <section aria-labelledby="admin-content-links-heading">
                <h4
                  id="admin-content-links-heading"
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-900"
                >
                  <Share2 className="h-3.5 w-3.5 text-[#5e6ad2]" />
                  有効な共有リンク ({detail.sharedLinks.length})
                </h4>
                {detail.sharedLinks.length === 0 ? (
                  <p className="mt-1 text-[0.6875rem] text-slate-500">
                    有効な共有リンクはありません。
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {detail.sharedLinks.map((link) => (
                      <li
                        key={link.id}
                        className="rounded-lg border border-slate-200 px-3 py-2 text-[0.6875rem]"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-medium text-slate-900">
                            {link.permissionLevel === 'view'
                              ? '表示のみ'
                              : link.permissionLevel === 'download'
                                ? '表示 + ダウンロード'
                                : '表示 + DL + 編集'}
                            <span className="ml-2 font-normal text-slate-500">
                              {link.accessScope}
                            </span>
                          </span>
                          <button
                            type="button"
                            onClick={() => onRevokeSharedLink(link.id)}
                            disabled={actionBusy !== null}
                            className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-[0.625rem] font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                          >
                            共有リンクを失効
                          </button>
                        </div>
                        <p className="mt-1 text-[0.625rem] text-slate-500">
                          作成: {link.creatorEmail ?? link.createdBy} /{' '}
                          {formatDateTime(link.createdAt, DATE_TIME_OPTIONS)}
                          {link.expiresAt
                            ? ` / 期限: ${formatDateTime(link.expiresAt, DATE_TIME_OPTIONS)}`
                            : ''}
                          {link.requireWatermark ? ' / 透かし必須' : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {detail.targetType === 'file' && (
                <section aria-labelledby="admin-content-inspect-heading">
                  <h4
                    id="admin-content-inspect-heading"
                    className="flex items-center gap-1.5 text-xs font-semibold text-slate-900"
                  >
                    <ShieldAlert className="h-3.5 w-3.5 text-[#5e6ad2]" />
                    監査付きプレビュー
                  </h4>
                  <p className="mt-1 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[0.625rem] leading-relaxed text-blue-900">
                    適用中のポリシー:{' '}
                    {inspectPolicy === 'watermark_confidential'
                      ? '透かし強制付きプレビュー許可'
                      : inspectPolicy === 'deny_confidential'
                        ? 'confidential 検査禁止'
                        : '全面禁止'}
                    。理由は監査ログに記録されます。
                  </p>
                  <label className="mt-2 block">
                    <span className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
                      検査理由 (3〜300文字)
                    </span>
                    <textarea
                      value={inspectReason}
                      onChange={(event) =>
                        onInspectReasonChange(event.target.value)
                      }
                      rows={2}
                      maxLength={300}
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-[0.6875rem] text-slate-900"
                    />
                  </label>
                  {inspectReasonError && (
                    <p className="text-[0.625rem] text-red-700">
                      {inspectReasonError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={onInspect}
                    disabled={
                      !isAdminContentReasonValid(inspectReason) ||
                      actionBusy !== null
                    }
                    className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {actionBusy === 'inspect' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ExternalLink className="h-3.5 w-3.5" />
                    )}
                    監査付きプレビューを開く
                  </button>
                  {inspectResult && (
                    <div
                      data-testid="admin-content-inspect-result"
                      className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-900"
                    >
                      <p className="font-medium">
                        URL 発行済み
                        {inspectResult.watermarkRequired ? '（透かし必須）' : ''}
                      </p>
                      <p className="mt-0.5 text-[0.625rem]">
                        期限:{' '}
                        {formatDateTime(
                          inspectResult.expiresAt,
                          DATE_TIME_OPTIONS
                        )}
                      </p>
                      <a
                        href={inspectResult.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="admin-content-inspect-link"
                        className="mt-1 inline-flex items-center gap-1 font-medium text-emerald-800 underline"
                      >
                        プレビューを開く
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}
                </section>
              )}

              {detail.targetType === 'file' && (
                <section aria-labelledby="admin-content-versions-heading">
                  <h4
                    id="admin-content-versions-heading"
                    className="text-xs font-semibold text-slate-900"
                  >
                    バージョン一覧 ({detail.versions.total})
                  </h4>
                  {detail.versions.items.length === 0 ? (
                    <p className="mt-1 text-[0.6875rem] text-slate-500">
                      バージョンはありません。
                    </p>
                  ) : (
                    <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
                      {detail.versions.items.map((version) => (
                        <li
                          key={version.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[0.6875rem]"
                        >
                          <span>
                            <span className="font-medium text-slate-900">
                              v{version.versionNum}
                            </span>
                            <span className="ml-2 text-slate-500">
                              {formatBytes(version.sizeBytes)} /{' '}
                              {version.uploadStatus}
                            </span>
                          </span>
                          <span className="text-[0.625rem] text-slate-500">
                            {version.uploadedByEmail ?? version.uploadedBy} /{' '}
                            {formatDateTime(version.createdAt, DATE_TIME_OPTIONS)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              <div aria-live="assertive" aria-atomic="true">
                {actionError && (
                  <div
                    role="alert"
                    data-testid="admin-content-action-error"
                    className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{actionError}</span>
                  </div>
                )}
                {!actionError && actionNotice && (
                  <div
                    role="status"
                    data-testid="admin-content-action-notice"
                    className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
                  >
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{actionNotice}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
