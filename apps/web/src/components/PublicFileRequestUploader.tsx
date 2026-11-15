'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Loader2,
  ShieldCheck,
  UploadCloud,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  ApiClientError,
  getPublicFileRequestMeta,
  uploadToPublicFileRequest,
} from '@/lib/files-api';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import type { PublicFileRequestMeta } from '@/types/files';

interface SubmittedRecord {
  id: string;
  fileName: string;
  sizeBytes: number;
  status: 'uploading' | 'done' | 'error';
  percent: number;
  submittedAt?: string;
  errorMessage?: string;
}

export function PublicFileRequestUploader({ token }: { token: string }) {
  const [meta, setMeta] = useState<PublicFileRequestMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [submitterEmail, setSubmitterEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [dragging, setDragging] = useState(false);
  const [submissions, setSubmissions] = useState<SubmittedRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    getPublicFileRequestMeta(token)
      .then((res) => setMeta(res))
      .catch((err) => {
        setLoadError(
          err instanceof ApiClientError
            ? err.message
            : 'ファイル収集リンクの読み込みに失敗しました'
        );
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function handleFiles(fileList: FileList | null) {
    if (!meta || !fileList || fileList.length === 0) return;
    if (meta.requireSubmitterEmail && !submitterEmail.trim()) {
      setSubmissions((prev) => [
        {
          id: crypto.randomUUID(),
          fileName: fileList[0].name,
          sizeBytes: fileList[0].size,
          status: 'error',
          percent: 0,
          errorMessage: '送信前にメールアドレスを入力してください。',
        },
        ...prev,
      ]);
      return;
    }

    for (const file of Array.from(fileList)) {
      const recId = crypto.randomUUID();
      setSubmissions((prev) => [
        {
          id: recId,
          fileName: file.name,
          sizeBytes: file.size,
          status: 'uploading',
          percent: 0,
        },
        ...prev,
      ]);

      try {
        const res = await uploadToPublicFileRequest({
          token,
          file,
          submitterEmail,
          turnstileToken: meta.turnstileEnabled ? turnstileToken : undefined,
          onProgress: (percent) => {
            setSubmissions((prev) =>
              prev.map((s) => (s.id === recId ? { ...s, percent } : s))
            );
          },
        });
        setSubmissions((prev) =>
          prev.map((s) =>
            s.id === recId
              ? {
                  ...s,
                  status: 'done',
                  percent: 100,
                  submittedAt: res.submittedAt,
                }
              : s
          )
        );
      } catch (err) {
        setSubmissions((prev) =>
          prev.map((s) =>
            s.id === recId
              ? {
                  ...s,
                  status: 'error',
                  errorMessage:
                    err instanceof ApiClientError
                      ? err.message
                      : 'ファイルのアップロードに失敗しました',
                }
              : s
          )
        );
      }
    }
  }

  return (
    <main className="min-h-screen bg-[#F8FAFC] px-4 py-12 text-slate-900">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#131B2E] text-sm font-bold text-white">
              F
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">Files</div>
              <div className="text-[11px] text-slate-500">
                Blind Dropbox — Secure File Submission
              </div>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-[11px] font-medium text-indigo-700">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>提出専用・フォルダ非公開</span>
          </span>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center shadow-xs">
            <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-indigo-600" />
            <p className="text-sm text-slate-500">収集ボックスを確認中...</p>
          </div>
        ) : loadError || !meta ? (
          <div className="rounded-2xl border border-red-200 bg-white p-8 text-center shadow-xs space-y-3">
            <AlertTriangle className="mx-auto h-8 w-8 text-red-500" />
            <h1 className="text-base font-semibold text-slate-900">
              このファイル収集リンクは現在利用できません
            </h1>
            <p className="text-xs text-red-600">
              {loadError ?? 'リンクが終了したか期限切れです。'}
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs space-y-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                <Inbox className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-lg font-semibold text-slate-900">
                  {meta.title}
                </h1>
                {meta.description && (
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">
                    {meta.description}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
                  <span>上限サイズ: {formatBytes(meta.maxFileSizeBytes)}</span>
                  <span>•</span>
                  <span>
                    許可拡張子:{' '}
                    {meta.allowedExtensions?.length
                      ? meta.allowedExtensions.map((e) => `.${e}`).join(', ')
                      : '実行ファイル等を除く一般形式'}
                  </span>
                  {meta.expiresAt && (
                    <>
                      <span>•</span>
                      <span>期限: {formatDateTime(meta.expiresAt)}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <label className="block text-xs">
              <span className="font-medium text-slate-700">
                提出者メールアドレス{' '}
                {meta.requireSubmitterEmail ? '(必須)' : '(任意)'}
              </span>
              <input
                type="email"
                required={meta.requireSubmitterEmail}
                value={submitterEmail}
                onChange={(e) => setSubmitterEmail(e.target.value)}
                placeholder="sender@partner.co.jp"
                className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
              />
            </label>

            {meta.turnstileEnabled && (
              <label className="block text-xs">
                <span className="font-medium text-slate-700">
                  Turnstile 認証トークン
                </span>
                <input
                  type="text"
                  required
                  value={turnstileToken}
                  onChange={(e) => setTurnstileToken(e.target.value)}
                  placeholder="Cloudflare Turnstile verification token"
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3.5 py-2 text-xs text-slate-900"
                />
              </label>
            )}

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                handleFiles(e.dataTransfer.files);
              }}
              className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${
                dragging
                  ? 'border-indigo-500 bg-indigo-50/70'
                  : 'border-slate-300 bg-slate-50/50 hover:border-slate-400'
              }`}
            >
              <UploadCloud className="mx-auto mb-3 h-8 w-8 text-indigo-600" />
              <div className="text-sm font-medium text-slate-900">
                提出ファイルをドラッグ＆ドロップ
              </div>
              <p className="mt-1 text-xs text-slate-500">
                アップロードされたファイルは組織内の安全なストレージへ直接格納されます
              </p>

              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="mt-4 rounded-xl bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700"
              >
                ファイルを選択して提出
              </button>
            </div>

            {submissions.length > 0 && (
              <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
                {submissions.map((sub) => (
                  <div
                    key={sub.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-slate-900">
                        {sub.fileName}{' '}
                        <span className="font-normal text-slate-400">
                          ({formatBytes(sub.sizeBytes)})
                        </span>
                      </div>
                      {sub.status === 'uploading' && (
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full bg-indigo-600 transition-all"
                            style={{ width: `${sub.percent}%` }}
                          />
                        </div>
                      )}
                      {sub.status === 'done' && (
                        <div className="mt-0.5 text-[11px] text-emerald-700">
                          提出完了 ({formatDateTime(sub.submittedAt)})
                        </div>
                      )}
                      {sub.errorMessage && (
                        <div className="mt-0.5 text-[11px] text-red-600">
                          {sub.errorMessage}
                        </div>
                      )}
                    </div>

                    <div className="shrink-0">
                      {sub.status === 'uploading' && (
                        <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                      )}
                      {sub.status === 'done' && (
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      )}
                      {sub.status === 'error' && (
                        <AlertTriangle className="h-4 w-4 text-red-500" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
