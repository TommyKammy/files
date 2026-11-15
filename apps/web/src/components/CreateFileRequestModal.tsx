'use client';

import {
  Check,
  Copy,
  Inbox,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  ApiClientError,
  createFileRequest,
  deactivateFileRequest,
  listFileRequests,
} from '@/lib/files-api';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import type { FileRequestSummary } from '@/types/files';

export function CreateFileRequestModal({
  folderId,
  folderName,
  canEdit,
  onClose,
}: {
  folderId: string;
  folderName: string;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [requests, setRequests] = useState<FileRequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState(`${folderName} 資料回収ボックス`);
  const [description, setDescription] = useState('');
  const [requireSubmitterEmail, setRequireSubmitterEmail] = useState(true);
  const [maxSizeMiB, setMaxSizeMiB] = useState(50);
  const [allowedExtText, setAllowedExtText] = useState('pdf, docx, xlsx, csv, png');
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [creating, setCreating] = useState(false);

  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await listFileRequests(folderId);
      setRequests(res.fileRequests);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ファイル収集ボックス一覧の取得に失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || creating || !title.trim()) return;
    setCreating(true);
    setError(null);
    setGeneratedUrl(null);
    setCopied(false);

    try {
      const allowedExtensions = allowedExtText
        .split(',')
        .map((s) => s.replace(/^\./, '').trim().toLowerCase())
        .filter(Boolean);

      const res = await createFileRequest({
        folderId,
        title: title.trim(),
        description: description.trim() || undefined,
        requireSubmitterEmail,
        maxFileSizeBytes: Math.max(1, maxSizeMiB) * 1024 * 1024,
        allowedExtensions:
          allowedExtensions.length > 0 ? allowedExtensions : undefined,
        expiresInDays: Math.max(1, expiresInDays),
      });

      const fullUrl =
        typeof window !== 'undefined'
          ? `${window.location.origin}${res.requestUrl}`
          : res.requestUrl;
      setGeneratedUrl(fullUrl);
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ファイル収集リクエストの作成に失敗しました'
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

  async function handleDeactivate(id: string) {
    setError(null);
    try {
      await deactivateFileRequest(id);
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ファイル収集リクエストの停止に失敗しました'
      );
    }
  }

  return (
    <ModalShell
      label={`外部ファイル収集: ${folderName}`}
      onClose={onClose}
      className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <Inbox className="h-4 w-4 shrink-0 text-indigo-600" />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-slate-900">
                外部ファイル収集 (Blind Dropbox): {folderName}
              </h2>
              <p className="text-[0.6875rem] text-slate-500">
                送信者はフォルダ内の既存ファイルを閲覧できません（提出専用ページを発行）
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[78vh] overflow-y-auto p-5 space-y-5">
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700"
            >
              {error}
            </div>
          )}

          {generatedUrl && (
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3.5 space-y-2">
              <div className="text-xs font-semibold text-indigo-950">
                Blind Dropbox URL を発行しました
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="file-request-generated-url"
                  name="requestUrl"
                  aria-label="収集リンクURL"
                  readOnly
                  value={generatedUrl}
                  className="flex-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-800"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700"
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
              <label className="block text-xs">
                <span className="font-medium text-slate-700">収集タイトル</span>
                <input
                  id="file-request-title"
                  name="title"
                  data-autofocus
                  required
                  type="text"
                  maxLength={160}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                />
              </label>

              <label className="block text-xs">
                <span className="font-medium text-slate-700">
                  説明文・提出案内 (任意)
                </span>
                <input
                  id="file-request-description"
                  name="description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="例: 見積書・NDA締結済みPDFをご提出ください"
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                />
              </label>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block text-xs">
                  <span className="font-medium text-slate-700">上限サイズ (MiB)</span>
                  <input
                    id="file-request-max-size"
                    name="maxSizeMiB"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    value={maxSizeMiB}
                    onChange={(e) =>
                      setMaxSizeMiB(Number.parseInt(e.target.value || '50', 10))
                    }
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </label>

                <label className="block text-xs">
                  <span className="font-medium text-slate-700">有効期限 (日)</span>
                  <input
                    id="file-request-expires-days"
                    name="expiresInDays"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={365}
                    value={expiresInDays}
                    onChange={(e) =>
                      setExpiresInDays(Number.parseInt(e.target.value || '14', 10))
                    }
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </label>

                <label className="block text-xs">
                  <span className="font-medium text-slate-700">
                    許可拡張子 (カンマ区切り)
                  </span>
                  <input
                    id="file-request-allowed-extensions"
                    name="allowedExtensions"
                    type="text"
                    spellCheck={false}
                    autoCapitalize="none"
                    value={allowedExtText}
                    onChange={(e) => setAllowedExtText(e.target.value)}
                    placeholder="pdf, docx, png"
                    className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900"
                  />
                </label>
              </div>

              <div className="flex items-center justify-between pt-1">
                <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                  <input
                    id="file-request-require-email"
                    name="requireSubmitterEmail"
                    type="checkbox"
                    checked={requireSubmitterEmail}
                    onChange={(e) => setRequireSubmitterEmail(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600"
                  />
                  <span>提出者メールアドレスの入力を必須にする</span>
                </label>

                <button
                  type="submit"
                  disabled={creating}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>収集リンクを発行</span>
                </button>
              </div>
            </form>
          )}

          <div className="space-y-2">
            <div className="text-xs font-semibold text-slate-600">
              稼働中の収集ボックス ({requests.length})
            </div>

            {loading ? (
              <div className="py-6 text-center text-xs text-slate-500">
                読み込み中...
              </div>
            ) : requests.length === 0 ? (
              <div className="rounded-lg border border-slate-200 py-5 text-center text-xs text-slate-500">
                このフォルダに対する有効な収集リクエストはありません
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200 divide-y divide-slate-100">
                {requests.map((req) => (
                  <div
                    key={req.id}
                    className="flex items-center justify-between gap-3 px-4 py-3 text-xs"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="font-medium text-slate-900">{req.title}</div>
                      <div className="text-[0.6875rem] text-slate-500">
                        提出数: {req.submissionCount}件 • 上限:{' '}
                        {formatBytes(req.maxFileSizeBytes)} • 期限:{' '}
                        {formatDateTime(req.expiresAt)}
                      </div>
                    </div>

                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleDeactivate(req.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2.5 py-1 text-[0.6875rem] font-medium text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-3 w-3" />
                        <span>受付停止</span>
                      </button>
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
