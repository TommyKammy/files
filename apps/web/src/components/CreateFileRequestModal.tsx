'use client';

import {
  Check,
  Copy,
  Inbox,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import { useCreateFileRequest } from '@/lib/use-create-file-request';
import { CopyableUrl } from '@/components/ui/CopyableUrl';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import { formatBytes, formatDateTime } from '@/lib/formatters';

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
  const {
    requests,
    loading,
    error,
    title,
    setTitle,
    description,
    setDescription,
    requireSubmitterEmail,
    setRequireSubmitterEmail,
    maxSizeMiB,
    setMaxSizeMiB,
    allowedExtText,
    setAllowedExtText,
    expiresInDays,
    setExpiresInDays,
    creating,
    generatedUrl,
    handleCreate,
    handleDeactivate,
  } = useCreateFileRequest({ folderId, folderName, canEdit });

  const [copiedReqId, setCopiedReqId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    []
  );

  async function handleCopyRequestUrl(reqId: string, requestUrl: string) {
    const fullUrl =
      typeof window !== 'undefined'
        ? `${window.location.origin}${requestUrl}`
        : requestUrl;
    await navigator.clipboard.writeText(fullUrl);
    setCopiedReqId(reqId);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedReqId(null), 1800);
  }

  return (
    <ModalShell
      label={`外部ファイル収集: ${folderName}`}
      onClose={onClose}
      className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
        <ModalHeader
          icon={<Inbox className="h-4 w-4 shrink-0 text-indigo-600" />}
          title={`外部ファイル収集 (Blind Dropbox): ${folderName}`}
          subtitle="送信者はフォルダ内の既存ファイルを閲覧できません（提出専用ページを発行）"
          onClose={onClose}
        />

        <div className="max-h-[78vh] overflow-y-auto p-5 space-y-5">
          <ModalError message={error} />

          {generatedUrl && (
            <CopyableUrl
              title="Blind Dropbox URL を発行しました"
              value={generatedUrl}
              inputId="file-request-generated-url"
              inputName="requestUrl"
              ariaLabel="収集リンクURL"
              tone="indigo"
            />
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

                    <div className="flex flex-wrap items-center gap-2">
                      {req.requestUrl ? (
                        <button
                          type="button"
                          data-testid={`copy-file-request-${req.id}`}
                          onClick={() =>
                            void handleCopyRequestUrl(req.id, req.requestUrl!)
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[0.6875rem] font-medium text-indigo-700 hover:bg-indigo-100"
                        >
                          {copiedReqId === req.id ? (
                            <>
                              <Check className="h-3 w-3" />
                              <span>コピー済み</span>
                            </>
                          ) : (
                            <>
                              <Copy className="h-3 w-3" />
                              <span>URLをコピー</span>
                            </>
                          )}
                        </button>
                      ) : (
                        <span
                          data-testid={`legacy-file-request-${req.id}`}
                          className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[0.625rem] text-slate-500"
                        >
                          再コピー不可（旧リンク）
                        </span>
                      )}

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
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
    </ModalShell>
  );
}
