'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Folder,
  Loader2,
  Lock,
  LockOpen,
  Search,
  Share2,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ADMIN_CONTENT_CLASSIFICATION_OPTIONS,
  ADMIN_CONTENT_PAGE_SIZE,
  DEFAULT_ADMIN_CONTENT_FILTERS,
  adminContentReasonError,
  formatAdminContentOwner,
  isAdminContentReasonValid,
  mergeAdminContentSearchItems,
} from '@/lib/admin-content';
import {
  adminEmergencyRevokeSharedLink,
  ApiClientError,
  fetchAdminContentDetail,
  forceUnlockAdminContentFile,
  inspectAdminContentFile,
  searchAdminContent,
} from '@/lib/files-api';
import { CLASSIFICATION_META, formatBytes, formatDateTime } from '@/lib/formatters';
import type {
  AdminContentDetail,
  AdminContentInspectResponse,
  AdminContentSearchFilters,
  AdminContentSearchItem,
} from '@/types/files';

const DATE_TIME_OPTIONS = {
  timeZone: 'Asia/Tokyo',
  timeZoneName: 'short' as const,
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiClientError ? err.message : fallback;
}

function TargetIcon({ targetType }: { targetType: 'file' | 'folder' }) {
  const Icon = targetType === 'file' ? FileText : Folder;
  return <Icon className="h-3.5 w-3.5 shrink-0 text-slate-500" />;
}

export function AdminContentManagerSection() {
  const [filters, setFilters] = useState<AdminContentSearchFilters>(
    DEFAULT_ADMIN_CONTENT_FILTERS
  );
  const [appliedFilters, setAppliedFilters] =
    useState<AdminContentSearchFilters>(DEFAULT_ADMIN_CONTENT_FILTERS);
  const [items, setItems] = useState<AdminContentSearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selected, setSelected] = useState<{
    targetType: 'file' | 'folder';
    id: string;
  } | null>(null);
  const [detail, setDetail] = useState<AdminContentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [unlockReason, setUnlockReason] = useState('');
  const [inspectReason, setInspectReason] = useState('');
  const [actionBusy, setActionBusy] = useState<
    'unlock' | 'inspect' | 'revoke' | null
  >(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [inspectResult, setInspectResult] =
    useState<AdminContentInspectResponse | null>(null);

  const searchRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const loadPage = useCallback(
    async (
      nextFilters: AdminContentSearchFilters,
      cursor: string | null,
      append: boolean
    ) => {
      const requestId = ++searchRequestRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await searchAdminContent(
          nextFilters,
          cursor,
          ADMIN_CONTENT_PAGE_SIZE
        );
        if (requestId !== searchRequestRef.current) return;
        setItems((prev) =>
          append
            ? mergeAdminContentSearchItems(prev, res.items)
            : res.items
        );
        setNextCursor(res.nextCursor);
      } catch (err) {
        if (requestId !== searchRequestRef.current) return;
        setError(
          errorMessage(err, 'コンテンツ検索に失敗しました')
        );
      } finally {
        if (requestId === searchRequestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    void loadPage(DEFAULT_ADMIN_CONTENT_FILTERS, null, false);
  }, [loadPage]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppliedFilters(filters);
    setNotice(null);
    void loadPage(filters, null, false);
  }

  function handleReset() {
    setFilters(DEFAULT_ADMIN_CONTENT_FILTERS);
    setAppliedFilters(DEFAULT_ADMIN_CONTENT_FILTERS);
    setNotice(null);
    void loadPage(DEFAULT_ADMIN_CONTENT_FILTERS, null, false);
  }

  function openInspector(item: AdminContentSearchItem) {
    const target = { targetType: item.targetType, id: item.id };
    setSelected(target);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setUnlockReason('');
    setInspectReason('');
    setActionBusy(null);
    setActionError(null);
    setActionNotice(null);
    setInspectResult(null);
    const requestId = ++detailRequestRef.current;
    void fetchAdminContentDetail(item.targetType, item.id)
      .then((res) => {
        if (requestId !== detailRequestRef.current) return;
        setDetail(res);
      })
      .catch((err) => {
        if (requestId !== detailRequestRef.current) return;
        setDetailError(
          errorMessage(err, 'コンテンツ詳細の取得に失敗しました')
        );
      })
      .finally(() => {
        if (requestId === detailRequestRef.current) setDetailLoading(false);
      });
  }

  function closeInspector() {
    detailRequestRef.current += 1;
    setSelected(null);
    setDetail(null);
    setDetailError(null);
    setInspectResult(null);
    setActionError(null);
    setActionNotice(null);
  }

  async function handleForceUnlock() {
    if (!detail || detail.targetType !== 'file') return;
    if (!isAdminContentReasonValid(unlockReason) || actionBusy) return;
    setActionBusy('unlock');
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await forceUnlockAdminContentFile(
        detail.id,
        unlockReason.trim()
      );
      setDetail((prev) =>
        prev ? { ...prev, activeLock: null } : prev
      );
      setItems((prev) =>
        prev.map((item) =>
          item.targetType === 'file' && item.id === detail.id
            ? { ...item, activeLock: null }
            : item
        )
      );
      setUnlockReason('');
      setActionNotice(
        `ロックを強制解除しました（${res.lock?.mode ?? 'lock'} / WOPI セッション失効 ${res.revokedWopiSessionCount} 件）。`
      );
    } catch (err) {
      setActionError(
        errorMessage(err, 'ロックの強制解除に失敗しました')
      );
    } finally {
      setActionBusy(null);
    }
  }

  async function handleRevokeSharedLink(linkId: string) {
    if (!detail || actionBusy) return;
    setActionBusy('revoke');
    setActionError(null);
    setActionNotice(null);
    try {
      await adminEmergencyRevokeSharedLink(
        linkId,
        '管理者コンテンツマネージャーからの緊急失効'
      );
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              sharedLinks: prev.sharedLinks.filter(
                (link) => link.id !== linkId
              ),
            }
          : prev
      );
      setItems((prev) =>
        prev.map((item) =>
          item.targetType === detail.targetType && item.id === detail.id
            ? {
                ...item,
                activeSharedLinkCount: Math.max(
                  0,
                  item.activeSharedLinkCount - 1
                ),
              }
            : item
        )
      );
      setActionNotice('共有リンクを緊急失効しました。');
    } catch (err) {
      setActionError(
        errorMessage(err, '共有リンクの失効に失敗しました')
      );
    } finally {
      setActionBusy(null);
    }
  }

  async function handleInspect() {
    if (!detail || detail.targetType !== 'file') return;
    if (!isAdminContentReasonValid(inspectReason) || actionBusy) return;
    setActionBusy('inspect');
    setActionError(null);
    setActionNotice(null);
    setInspectResult(null);
    try {
      const res = await inspectAdminContentFile(
        detail.id,
        inspectReason.trim()
      );
      setInspectResult(res);
      setActionNotice(
        res.watermarkRequired
          ? '監査付きプレビュー URL を発行しました（透かし必須）。'
          : '監査付きプレビュー URL を発行しました。'
      );
    } catch (err) {
      setActionError(
        errorMessage(err, '監査付きプレビューの発行に失敗しました')
      );
    } finally {
      setActionBusy(null);
    }
  }

  const unlockReasonError = unlockReason
    ? adminContentReasonError(unlockReason)
    : null;
  const inspectReasonError = inspectReason
    ? adminContentReasonError(inspectReason)
    : null;
  const inspectPolicy =
    detail?.inspectPolicy ?? 'watermark_confidential';

  return (
    <section
      data-testid="admin-content-manager"
      aria-labelledby="admin-content-manager-heading"
      className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-[#5e6ad2]" />
            <h2
              id="admin-content-manager-heading"
              className="text-sm font-semibold text-slate-900"
            >
              コンテンツマネージャー
            </h2>
          </div>
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-slate-500">
            全アカウントのアクティブなファイル・フォルダを ACL
            非依存で横断検索し、所有者・共有リンク・ロック・監査付きプレビューを確認します。
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
          全社横断
        </span>
      </div>

      <form
        onSubmit={handleSubmit}
        aria-label="コンテンツマネージャー検索"
        className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <label className="md:col-span-2">
            <span className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              ファイル / フォルダ名・全文検索
            </span>
            <input
              data-testid="admin-content-query"
              type="search"
              value={filters.query}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  query: event.target.value,
                }))
              }
              placeholder="例: 契約書, roadmap, is:confidential"
              className="h-8 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-900 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-1 focus-visible:outline-[#5e6ad2]"
            />
          </label>

          <label>
            <span className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              種別
            </span>
            <select
              data-testid="admin-content-target-type"
              value={filters.targetType}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  targetType: event.target
                    .value as AdminContentSearchFilters['targetType'],
                }))
              }
              className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900"
            >
              <option value="all">すべて</option>
              <option value="file">ファイル</option>
              <option value="folder">フォルダ</option>
            </select>
          </label>

          <label>
            <span className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              機密区分
            </span>
            <select
              data-testid="admin-content-classification"
              value={filters.classification}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  classification: event.target
                    .value as AdminContentSearchFilters['classification'],
                }))
              }
              className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900"
            >
              {ADMIN_CONTENT_CLASSIFICATION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              所有者 (userId / email)
            </span>
            <input
              data-testid="admin-content-owner"
              type="text"
              value={filters.createdBy}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  createdBy: event.target.value,
                }))
              }
              placeholder="owner@example.com"
              className="h-8 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-900"
            />
          </label>

          <label>
            <span className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              拡張子
            </span>
            <input
              data-testid="admin-content-extension"
              type="text"
              value={filters.extension}
              onChange={(event) =>
                setFilters((prev) => ({
                  ...prev,
                  extension: event.target.value,
                }))
              }
              placeholder="pdf"
              className="h-8 w-full rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-900"
            />
          </label>

          <div className="flex flex-wrap items-end gap-4 md:col-span-2">
            <label className="flex min-h-8 items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={filters.lockedOnly}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    lockedOnly: event.target.checked,
                  }))
                }
                className="h-4 w-4 accent-[#5e6ad2]"
              />
              ロック中のみ
            </label>
            <label className="flex min-h-8 items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={filters.hasSharedLink}
                onChange={(event) =>
                  setFilters((prev) => ({
                    ...prev,
                    hasSharedLink: event.target.checked,
                  }))
                }
                className="h-4 w-4 accent-[#5e6ad2]"
              />
              共有リンクありのみ
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-3 text-[0.75rem] font-medium text-slate-700 transition hover:bg-slate-100"
          >
            条件をクリア
          </button>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Search className="h-3.5 w-3.5" />
            )}
            <span>{loading ? '検索中...' : '検索'}</span>
          </button>
        </div>
      </form>

      <div aria-live="assertive" aria-atomic="true" className="min-h-0">
        {error && (
          <div
            role="alert"
            data-testid="admin-content-search-error"
            className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {!error && notice && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200">
        <div
          role="region"
          aria-label="コンテンツ検索結果"
          tabIndex={0}
          className="overflow-x-auto focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
        >
          <table className="w-full min-w-[860px] border-collapse text-left text-[0.6875rem]">
            <caption className="sr-only">
              全社横断検索に一致したファイルとフォルダ。
            </caption>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th scope="col" className="px-3 py-2 font-medium">
                  種別
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  名前 / パス
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  所有者
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  機密区分
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  更新
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  共有
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  ロック
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const classification = CLASSIFICATION_META[item.classification];
                return (
                  <tr
                    key={`${item.targetType}:${item.id}`}
                    data-testid="admin-content-result-row"
                    className="border-b border-slate-100 last:border-b-0"
                  >
                    <td className="px-3 py-2 align-top text-slate-600">
                      <span className="inline-flex items-center gap-1">
                        <TargetIcon targetType={item.targetType} />
                        {item.targetType === 'file' ? 'ファイル' : 'フォルダ'}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <button
                        type="button"
                        data-testid="admin-content-result-open"
                        onClick={() => openInspector(item)}
                        className="block max-w-[26rem] truncate text-left font-medium text-[#3c4bb7] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
                        title={item.name}
                      >
                        {item.name}
                      </button>
                      <span className="mt-0.5 block truncate text-[0.625rem] text-slate-500">
                        {item.pathLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top text-slate-700">
                      <span className="block">
                        {formatAdminContentOwner(item.owner)}
                      </span>
                      <span className="block text-[0.625rem] text-slate-500">
                        {item.owner.email ?? item.owner.id}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${classification.badgeClass}`}
                      >
                        {classification.shortJa}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top text-slate-600">
                      {formatDateTime(item.updatedAt, DATE_TIME_OPTIONS)}
                    </td>
                    <td className="px-3 py-2 align-top text-slate-700">
                      <span className="inline-flex items-center gap-1">
                        <Share2 className="h-3 w-3 text-slate-400" />
                        {item.activeSharedLinkCount}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      {item.activeLock ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[0.625rem] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
                          <Lock className="h-3 w-3" />
                          {item.activeLock.mode === 'desktop_exclusive'
                            ? 'Drive'
                            : 'WOPI'}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {items.length === 0 && !loading && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-xs text-slate-500"
                  >
                    条件に一致するアクティブなコンテンツはありません。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && (
          <div
            role="status"
            className="flex items-center justify-center gap-2 border-t border-slate-100 px-3 py-6 text-xs text-slate-500"
          >
            <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
            全社コンテンツを検索中...
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.625rem] text-slate-500">
          {items.length} 件表示
          {appliedFilters.query ? ` / 検索: ${appliedFilters.query}` : ''}
        </p>
        {nextCursor && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={() =>
              void loadPage(appliedFilters, nextCursor, true)
            }
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-[0.75rem] font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
          >
            {loadingMore && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            さらに読み込む
          </button>
        )}
      </div>

      {selected && (
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
                onClick={closeInspector}
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
                          {detail.targetType === 'file'
                            ? 'サイズ / 版数'
                            : '種別'}
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
                          期限: {formatDateTime(
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
                              setUnlockReason(event.target.value)
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
                          onClick={() => void handleForceUnlock()}
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
                                onClick={() =>
                                  void handleRevokeSharedLink(link.id)
                                }
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
                            setInspectReason(event.target.value)
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
                        onClick={() => void handleInspect()}
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
                            {inspectResult.watermarkRequired
                              ? '（透かし必須）'
                              : ''}
                          </p>
                          <p className="mt-0.5 text-[0.625rem]">
                            期限: {formatDateTime(
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
                                {version.uploadedByEmail ?? version.uploadedBy}{' '}
                                /{' '}
                                {formatDateTime(
                                  version.createdAt,
                                  DATE_TIME_OPTIONS
                                )}
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
      )}
    </section>
  );
}
