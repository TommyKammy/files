'use client';

import {
  AlertTriangle,
  Ban,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiClientError,
  disableAdminFileRequest,
  fetchAdminFileRequests,
} from '@/lib/files-api';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import type { AdminFileRequestRow } from '@/types/files';

type StatusFilter = 'active' | 'inactive' | 'all';

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    return err.code ? `${err.message} (${err.code})` : err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

export function AdminFileRequestsSection() {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<AdminFileRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetchAdminFileRequests({ status, search });
        setRows(response.fileRequests);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setError(errorText(err, 'ファイルリクエスト一覧の取得に失敗しました'));
      } finally {
        setLoading(false);
      }
    },
    [status, search]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleDisable(row: AdminFileRequestRow) {
    if (busyId) return;
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      const response = await disableAdminFileRequest(row.id);
      setRows((current) =>
        current.map((item) =>
          item.id === row.id ? { ...item, isActive: false } : item
        )
      );
      setNotice(
        `「${row.title}」を緊急停止しました${
          response.alreadyDisabled ? ' (既に停止済み)' : ''
        }`
      );
    } catch (err) {
      setError(errorText(err, 'ファイルリクエストの緊急停止に失敗しました'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      aria-labelledby="admin-file-requests-heading"
      data-testid="admin-file-requests-section"
      className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="admin-file-requests-heading"
            className="flex items-center gap-2 text-sm font-semibold text-slate-900"
          >
            <Inbox className="h-4 w-4 text-[#5e6ad2]" />
            全社ファイルリクエスト
          </h2>
          <p className="mt-1 text-[0.6875rem] text-[#55565a]">
            全テナントの Blind Dropbox を横断確認し、提出件数・所有者・宛先フォルダを
            確認できます。漏えい疑い時はその場で緊急停止できます。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          再読み込み
        </button>
      </div>

      <form
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(searchDraft.trim());
        }}
      >
        <label className="text-[0.75rem]">
          <span className="block font-medium text-slate-700">ステータス</span>
          <select
            data-testid="admin-file-request-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            className="mt-1 h-8 rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem]"
          >
            <option value="all">すべて</option>
            <option value="active">受付中</option>
            <option value="inactive">停止済み</option>
          </select>
        </label>
        <label className="min-w-[14rem] flex-1 text-[0.75rem]">
          <span className="block font-medium text-slate-700">検索</span>
          <input
            data-testid="admin-file-request-search"
            type="search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="タイトル / 所有者 / フォルダ名"
            className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] px-2.5 text-[0.75rem]"
          />
        </label>
        <button
          type="submit"
          data-testid="admin-file-request-search-submit"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2]"
        >
          <Search className="h-3.5 w-3.5" />
          検索
        </button>
      </form>

      {error && (
        <p
          role="alert"
          data-testid="admin-file-request-error"
          className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          data-testid="admin-file-request-notice"
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
        >
          {notice}
        </p>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-[#ececef]">
        <table className="min-w-full text-left text-[0.75rem]">
          <thead className="bg-[#f7f7f9] text-[0.625rem] uppercase tracking-[0.04em] text-[#6b6f76]">
            <tr>
              <th scope="col" className="px-3 py-2">タイトル</th>
              <th scope="col" className="px-3 py-2">宛先フォルダ</th>
              <th scope="col" className="px-3 py-2">所有者</th>
              <th scope="col" className="px-3 py-2">提出件数</th>
              <th scope="col" className="px-3 py-2">上限 / 期限</th>
              <th scope="col" className="px-3 py-2">状態</th>
              <th scope="col" className="px-3 py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                data-testid="admin-file-request-row"
                data-active={row.isActive ? 'true' : 'false'}
                className="border-t border-[#f2f2f4] align-top"
              >
                <td className="max-w-[16rem] px-3 py-2.5">
                  <div className="truncate font-medium text-[#111214]">
                    {row.title}
                  </div>
                  {row.allowedExtensions?.length ? (
                    <div className="mt-0.5 truncate text-[0.625rem] text-[#6b6f76]">
                      許可: {row.allowedExtensions.map((ext) => `.${ext}`).join(', ')}
                    </div>
                  ) : null}
                </td>
                <td className="max-w-[12rem] px-3 py-2.5 text-[#3c3f46]">
                  <div className="truncate">{row.folderName ?? '（削除済み）'}</div>
                </td>
                <td className="max-w-[12rem] px-3 py-2.5 text-[#3c3f46]">
                  <div className="truncate">{row.ownerName ?? row.createdBy}</div>
                  {row.ownerEmail && (
                    <div className="truncate text-[0.625rem] text-[#6b6f76]">
                      {row.ownerEmail}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 tabular-nums text-[#111214]">
                  {row.submissionCount}
                </td>
                <td className="px-3 py-2.5 text-[#3c3f46]">
                  <div>{formatBytes(row.maxFileSizeBytes)}</div>
                  <div className="text-[0.625rem] text-[#6b6f76]">
                    {row.expiresAt ? formatDateTime(row.expiresAt) : '無期限'}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${
                      row.isActive
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-slate-200 bg-slate-100 text-slate-600'
                    }`}
                  >
                    {row.isActive ? '受付中' : '停止済み'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    type="button"
                    data-testid={`admin-file-request-disable-${row.id}`}
                    disabled={!row.isActive || busyId === row.id}
                    onClick={() => void handleDisable(row)}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2 text-[0.6875rem] font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-40"
                  >
                    {busyId === row.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Ban className="h-3 w-3" />
                    )}
                    緊急停止
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && (
          <p
            data-testid="admin-file-request-empty"
            className="px-3 py-6 text-center text-[0.75rem] text-[#6b6f76]"
          >
            条件に一致するファイルリクエストはありません。
          </p>
        )}
        {loading && rows.length === 0 && (
          <div className="flex items-center justify-center gap-2 px-3 py-6 text-[0.75rem] text-[#55565a]">
            <Loader2 className="h-4 w-4 animate-spin" />
            読み込み中...
          </div>
        )}
      </div>
    </section>
  );
}
