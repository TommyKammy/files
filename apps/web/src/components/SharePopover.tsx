'use client';

import {
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Lock,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { CopyableUrl } from '@/components/ui/CopyableUrl';
import { useSharePopover } from '@/lib/use-share-popover';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import { ModalShell } from '@/components/ModalShell';
import { formatDateTime } from '@/lib/formatters';
import {
  SHARE_PERMISSION_LEVEL_OPTIONS,
  availablePermissionLevels,
  permissionLevelLabel,
} from '@/lib/share-link-levels';
import type {
  ClassificationLabel,
  ShareAccessScope,
  SharePermissionLevel,
  TenantPolicyRow,
} from '@/types/files';

type SharePolicyLike =
  | Pick<
      TenantPolicyRow,
      | 'allowSharedLinkEdit'
      | 'allowPublicEditLinks'
      | 'allowViewerShareLinks'
      | 'allow_shared_link_edit'
      | 'allow_public_edit_links'
      | 'allow_viewer_share_links'
    >
  | null
  | undefined;

export function SharePopover({
  targetType,
  targetId,
  targetName,
  classification,
  canEdit,
  canManageLinks = canEdit,
  policy = null,
  onClose,
}: {
  targetType: 'file' | 'folder';
  targetId: string;
  targetName: string;
  classification: ClassificationLabel;
  canEdit: boolean;
  /** `share_link.manage`; false makes every new link display-only. */
  canManageLinks?: boolean;
  policy?: SharePolicyLike;
  onClose: () => void;
}) {
  const {
    publicRestricted,
    allowSharedLinkEdit,
    allowPublicEditLinks,
    viewerViewOnly,
    canSelectDownload,
    canSelectEdit,
    links,
    loading,
    error,
    accessScope,
    setAccessScope,
    permissionLevel,
    setPermissionLevel,
    canDownload,
    requireWatermark,
    setRequireWatermark,
    password,
    setPassword,
    showPassword,
    setShowPassword,
    expiresInDays,
    setExpiresInDays,
    maxDownloads,
    setMaxDownloads,
    creating,
    updatingLinkId,
    generatedUrl,
    handleCreate,
    handleRevoke,
    handleUpdateLevel,
  } = useSharePopover({
    targetType,
    targetId,
    classification,
    canEdit,
    canManageLinks,
    policy,
  });

  const levelOptions = availablePermissionLevels({
    canManageLinks,
    allowSharedLinkEdit,
  });
  const publicEditBlocked =
    permissionLevel === 'edit' && accessScope === 'public' && !allowPublicEditLinks;

  return (
    <ModalShell
      label={`共有リンク設定: ${targetName}`}
      onClose={onClose}
      className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <ModalHeader
        icon={<Link2 className="h-4 w-4 shrink-0 text-blue-600" />}
        title={`共有リンク設定: ${targetName}`}
        badge={<ClassificationBadge classification={classification} compact />}
        onClose={onClose}
      />

      <div className="max-h-[78vh] overflow-y-auto p-5 space-y-5">
        <ModalError message={error} />

        {generatedUrl && (
          <CopyableUrl
            title="共有リンクを発行しました（平文トークンは今回のみ表示されます）"
            value={generatedUrl}
            inputId="share-generated-url"
            inputName="shareUrl"
            ariaLabel="共有リンクURL"
          />
        )}

        {canEdit && (
          <form
            onSubmit={handleCreate}
            className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-4"
          >
            {publicRestricted && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span>
                  機密ラベル ({classification}) のリソースでは社外匿名共有 (Public)
                  はガードレールにより禁止されています。
                </span>
              </div>
            )}

            {viewerViewOnly && (
              <div
                id="share-viewer-view-only-banner"
                className="flex items-start gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-[0.6875rem] text-indigo-800"
              >
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-600" />
                <span>
                  Viewer / Viewer + Uploader の共有リンクは
                  <span className="font-semibold">
                    表示専用 (view) のみ
                  </span>
                  です。ダウンロード・編集は付与できません。編集共有リンクが必要な場合は
                  Editor 以上に権限を依頼してください。
                </span>
              </div>
            )}

            <fieldset
              className="space-y-2 rounded-lg border border-slate-200 bg-white p-3"
              aria-describedby="share-permission-level-help"
            >
              <legend className="px-1 text-xs font-semibold text-slate-700">
                リンクの権限レベル
              </legend>
              <p
                id="share-permission-level-help"
                className="text-[0.6875rem] text-slate-500"
              >
                view は単一使用ストリームでプレビューのみ、download は通常の署名付き
                URL、edit はアップロード / WOPI 編集を許可します。
              </p>
              <div className="space-y-1.5">
                {SHARE_PERMISSION_LEVEL_OPTIONS.map((option) => {
                  const disabled =
                    option.value === 'view'
                      ? false
                      : option.value === 'download'
                        ? !canSelectDownload
                        : !canSelectEdit;
                  const describedBy = [
                    `share-level-${option.value}-help`,
                    viewerViewOnly ? 'share-viewer-view-only-banner' : null,
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <label
                      key={option.value}
                      className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${
                        permissionLevel === option.value
                          ? 'border-blue-300 bg-blue-50/60'
                          : 'border-transparent hover:bg-slate-50'
                      } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                    >
                      <input
                        type="radio"
                        name="sharePermissionLevel"
                        value={option.value}
                        checked={permissionLevel === option.value}
                        disabled={disabled || !canEdit}
                        onChange={() =>
                          setPermissionLevel(option.value as SharePermissionLevel)
                        }
                        aria-describedby={describedBy}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block font-medium text-slate-800">
                          {option.label}
                        </span>
                        <span
                          id={`share-level-${option.value}-help`}
                          className="block text-[0.6875rem] text-slate-500"
                        >
                          {option.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {!allowSharedLinkEdit && (
                <p className="text-[0.6875rem] text-amber-700">
                  編集共有リンク (edit)
                  は管理者ポリシーで無効化されています。管理者に「編集共有リンクを許可」を依頼してください。
                </p>
              )}
            </fieldset>

            {permissionLevel === 'edit' && (
              <div
                id="share-edit-warning"
                role="note"
                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
              >
                編集リンクは
                <span className="font-semibold">
                  認証済みユーザー限定
                </span>
                です（公開編集が許可された場合はパスワード・有効期限が必須）。
                削除・権限管理・共有リンク管理は付与されません。
              </div>
            )}

            {publicEditBlocked && (
              <div
                role="note"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
              >
                Public (匿名) 編集リンクは管理者ポリシーで禁止されています。認証済みユーザー限定
                (company_only) を選択してください。
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="text-xs">
                <label
                  htmlFor="share-access-scope"
                  className="font-medium text-slate-700"
                >
                  アクセス範囲
                </label>
                <select
                  id="share-access-scope"
                  name="accessScope"
                  data-autofocus
                  value={accessScope}
                  onChange={(e) =>
                    setAccessScope(e.target.value as ShareAccessScope)
                  }
                  aria-describedby={
                    permissionLevel === 'edit' ? 'share-edit-warning' : undefined
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                >
                  <option value="public" disabled={publicRestricted}>
                    Public (URLを知っている全員)
                  </option>
                  <option value="company_only">
                    Company Only (社内SSOユーザー限定)
                  </option>
                  <option value="collaborators_only">
                    Collaborators Only (アクセス権限保持者のみ)
                  </option>
                </select>
              </div>

              <div className="text-xs">
                <label
                  htmlFor="share-expires-days"
                  className="font-medium text-slate-700"
                >
                  有効期限 (日)
                  {permissionLevel === 'edit' && accessScope === 'public' ? (
                    <span className="ml-1 text-red-600">必須</span>
                  ) : null}
                </label>
                <input
                  id="share-expires-days"
                  name="expiresInDays"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={classification === 'confidential' ? 7 : 365}
                  value={expiresInDays}
                  onChange={(e) =>
                    setExpiresInDays(Number.parseInt(e.target.value || '7', 10))
                  }
                  aria-describedby="share-expires-hint"
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                />
                <p
                  id="share-expires-hint"
                  className="mt-1 text-[0.625rem] text-slate-500"
                >
                  Public 編集リンクは明示的な期限が必須です。
                </p>
              </div>

              <div className="text-xs">
                <label
                  htmlFor="share-password"
                  className="font-medium text-slate-700"
                >
                  パスワード保護
                  {permissionLevel === 'edit' && accessScope === 'public' ? (
                    <span className="ml-1 text-red-600">必須</span>
                  ) : (
                    <span className="text-slate-400"> (任意)</span>
                  )}
                </label>
                <div className="relative mt-1">
                  <input
                    id="share-password"
                    name="sharePassword"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="設定しない場合は空欄"
                    aria-describedby="share-password-hint"
                    className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-2.5 pr-9 text-xs text-slate-900"
                  />
                  <button
                    type="button"
                    aria-label={
                      showPassword ? 'パスワードを隠す' : 'パスワードを表示'
                    }
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute inset-y-0 right-1 my-auto flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  >
                    {showPassword ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <p
                  id="share-password-hint"
                  className="mt-1 text-[0.625rem] text-slate-500"
                >
                  Public 編集リンクでは空欄にできません。
                </p>
              </div>

              <div className="text-xs">
                <label
                  htmlFor="share-max-downloads"
                  className="font-medium text-slate-700"
                >
                  最大ダウンロード回数 (任意)
                </label>
                <input
                  id="share-max-downloads"
                  name="maxDownloads"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={maxDownloads}
                  onChange={(e) => setMaxDownloads(e.target.value)}
                  placeholder="無制限の場合は空欄"
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-slate-700">
              <label className="inline-flex items-center gap-2">
                <input
                  name="canDownload"
                  type="checkbox"
                  checked={canDownload}
                  readOnly
                  disabled
                  aria-describedby={
                    !canSelectDownload
                      ? 'share-viewer-view-only-banner'
                      : 'share-level-download-help'
                  }
                  className="rounded border-slate-300 text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span className={!canSelectDownload ? 'text-slate-500' : ''}>
                  ダウンロードを許可する（権限レベルから自動設定）
                </span>
              </label>

              <label className="inline-flex items-center gap-2">
                <input
                  name="requireWatermark"
                  type="checkbox"
                  checked={
                    classification === 'confidential' || viewerViewOnly
                      ? true
                      : requireWatermark
                  }
                  onChange={(e) => setRequireWatermark(e.target.checked)}
                  disabled={
                    classification === 'confidential' || viewerViewOnly
                  }
                  className="rounded border-slate-300 text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <span>動的透かし (Watermark) を強制</span>
              </label>
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={creating}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>リンクを発行</span>
              </button>
            </div>
          </form>
        )}

        <div className="space-y-2">
          <div className="text-xs font-semibold text-slate-600">
            有効な共有リンク ({links.length})
          </div>

          {!canManageLinks ? (
            <div className="rounded-lg border border-slate-200 py-5 text-center text-xs text-slate-500">
              共有リンクの一覧・失効には
              <span className="font-mono"> share_link.manage </span>
              権限が必要です。新規リンクの発行のみ可能です。
            </div>
          ) : loading ? (
            <div className="py-6 text-center text-xs text-slate-500">
              読み込み中...
            </div>
          ) : links.length === 0 ? (
            <div className="rounded-lg border border-slate-200 py-5 text-center text-xs text-slate-500">
              現在有効な共有リンクはありません
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 divide-y divide-slate-100">
              {links.map((link) => (
                <div
                  key={link.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        data-testid={`shared-link-level-${link.id}`}
                        className="rounded bg-blue-50 px-2 py-0.5 text-[0.625rem] font-semibold text-blue-700"
                      >
                        {permissionLevelLabel(link.permissionLevel)}
                      </span>
                      <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[0.6875rem] font-medium text-slate-700">
                        {link.accessScope}
                      </span>
                      {link.hasPassword && (
                        <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[0.625rem] text-slate-600">
                          <Lock className="h-2.5 w-2.5" />
                          PW保護
                        </span>
                      )}
                      {link.requireWatermark && (
                        <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[0.625rem] text-indigo-700">
                          Watermark
                        </span>
                      )}
                      {link.isLocked && (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[0.625rem] font-semibold text-red-700">
                          ロック中
                        </span>
                      )}
                    </div>
                    <div className="text-[0.6875rem] text-slate-500">
                      DL回数: {link.downloadCount}
                      {link.maxDownloads ? ` / ${link.maxDownloads}` : ''} • 期限:{' '}
                      {formatDateTime(link.expiresAt)}
                    </div>
                  </div>

                  {canManageLinks && (
                    <div className="flex items-center gap-2">
                      <label className="sr-only" htmlFor={`share-level-${link.id}`}>
                        共有リンクの権限レベル
                      </label>
                      <select
                        id={`share-level-${link.id}`}
                        value={link.permissionLevel}
                        disabled={updatingLinkId === link.id}
                        onChange={(e) =>
                          handleUpdateLevel(
                            link.id,
                            e.target.value as SharePermissionLevel
                          )
                        }
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[0.6875rem] text-slate-700"
                      >
                        {levelOptions.map((level) => (
                          <option key={level} value={level}>
                            {permissionLevelLabel(level)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => handleRevoke(link.id)}
                        title="共有リンクを即時失効"
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1 text-[0.6875rem] font-medium text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        <span>失効</span>
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
