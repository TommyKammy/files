'use client';

import {
  Check,
  Copy,
  Link2,
  Loader2,
  Lock,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  ApiClientError,
  createSharedLink,
  listSharedLinks,
  revokeSharedLink,
} from '@/lib/files-api';
import { formatDateTime } from '@/lib/formatters';
import type {
  ClassificationLabel,
  ShareAccessScope,
  SharedLinkSummary,
} from '@/types/files';

export function SharePopover({
  targetType,
  targetId,
  targetName,
  classification,
  canEdit,
  onClose,
}: {
  targetType: 'file' | 'folder';
  targetId: string;
  targetName: string;
  classification: ClassificationLabel;
  canEdit: boolean;
  onClose: () => void;
}) {
  const publicRestricted =
    classification === 'confidential' || classification === 'unset';

  const [links, setLinks] = useState<SharedLinkSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [accessScope, setAccessScope] = useState<ShareAccessScope>(
    publicRestricted ? 'company_only' : 'public'
  );
  const [canDownload, setCanDownload] = useState(true);
  const [requireWatermark, setRequireWatermark] = useState(
    classification === 'confidential'
  );
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(
    classification === 'confidential' ? 7 : 30
  );
  const [maxDownloads, setMaxDownloads] = useState('');
  const [creating, setCreating] = useState(false);

  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function reloadLinks() {
    setLoading(true);
    setError(null);
    try {
      const res = await listSharedLinks(targetType, targetId);
      setLinks(res.links);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : '共有リンクの取得に失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reloadLinks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetType, targetId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || creating) return;
    setCreating(true);
    setError(null);
    setGeneratedUrl(null);
    setCopied(false);

    try {
      const parsedMaxDownloads = maxDownloads.trim()
        ? Number.parseInt(maxDownloads.trim(), 10)
        : undefined;

      const res = await createSharedLink({
        targetType,
        targetId,
        accessScope,
        canDownload,
        requireWatermark,
        password: password.trim() || undefined,
        expiresInDays,
        maxDownloads:
          parsedMaxDownloads && parsedMaxDownloads > 0
            ? parsedMaxDownloads
            : undefined,
      });

      const fullUrl =
        typeof window !== 'undefined'
          ? `${window.location.origin}${res.shareUrl}`
          : res.shareUrl;
      setGeneratedUrl(fullUrl);
      setPassword('');
      await reloadLinks();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : '共有リンクの作成に失敗しました'
      );
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!generatedUrl) return;
    await navigator.clipboard.writeText(generatedUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function handleRevoke(linkId: string) {
    setError(null);
    try {
      await revokeSharedLink(linkId);
      await reloadLinks();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : '共有リンクの無効化に失敗しました'
      );
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <Link2 className="h-4 w-4 shrink-0 text-blue-600" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-slate-900">
                  共有リンク設定: {targetName}
                </h2>
                <ClassificationBadge classification={classification} compact />
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[78vh] overflow-y-auto p-5 space-y-5">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
              {error}
            </div>
          )}

          {generatedUrl && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 space-y-2">
              <div className="text-xs font-semibold text-emerald-900">
                共有リンクを発行しました（平文トークンは今回のみ表示されます）
              </div>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={generatedUrl}
                  className="flex-1 rounded-lg border border-emerald-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-800"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>コピー済み</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>コピー</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {canEdit && (
            <form
              onSubmit={handleCreate}
              className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3"
            >
              {publicRestricted && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>
                    機密ラベル ({classification}) のリソースでは社外匿名共有 (Public) はガードレールにより禁止されています。
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs">
                  <span className="font-medium text-slate-700">アクセス範囲</span>
                  <select
                    value={accessScope}
                    onChange={(e) =>
                      setAccessScope(e.target.value as ShareAccessScope)
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
                </label>

                <label className="block text-xs">
                  <span className="font-medium text-slate-700">有効期限 (日)</span>
                  <input
                    type="number"
                    min={1}
                    max={classification === 'confidential' ? 7 : 365}
                    value={expiresInDays}
                    onChange={(e) =>
                      setExpiresInDays(Number.parseInt(e.target.value || '7', 10))
                    }
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </label>

                <label className="block text-xs">
                  <span className="font-medium text-slate-700">
                    パスワード保護 (任意)
                  </span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="設定しない場合は空欄"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </label>

                <label className="block text-xs">
                  <span className="font-medium text-slate-700">
                    最大ダウンロード回数 (任意)
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={maxDownloads}
                    onChange={(e) => setMaxDownloads(e.target.value)}
                    placeholder="無制限の場合は空欄"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-slate-700">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={canDownload}
                    onChange={(e) => setCanDownload(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600"
                  />
                  <span>ダウンロードを許可する</span>
                </label>

                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={requireWatermark}
                    onChange={(e) => setRequireWatermark(e.target.checked)}
                    disabled={classification === 'confidential'}
                    className="rounded border-slate-300 text-blue-600"
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

            {loading ? (
              <div className="py-6 text-center text-xs text-slate-400">
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
                    className="flex items-center justify-between gap-3 px-4 py-3 text-xs"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[11px] font-medium text-slate-700">
                          {link.accessScope}
                        </span>
                        {link.hasPassword && (
                          <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                            <Lock className="h-2.5 w-2.5" />
                            PW保護
                          </span>
                        )}
                        {!link.canDownload && (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                            プレビュー限定
                          </span>
                        )}
                        {link.requireWatermark && (
                          <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700">
                            Watermark
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        DL回数: {link.downloadCount}
                        {link.maxDownloads ? ` / ${link.maxDownloads}` : ''} • 期限:{' '}
                        {formatDateTime(link.expiresAt)}
                      </div>
                    </div>

                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleRevoke(link.id)}
                        title="共有リンクを即時失効"
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1 text-[11px] font-medium text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        <span>失効</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
