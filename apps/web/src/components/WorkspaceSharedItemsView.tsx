'use client';

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Route,
  Search,
  Share2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { TosAcceptanceModal } from '@/components/TosAcceptanceModal';
import { canAccess, ROLE_META } from '@/lib/capabilities';
import { listSharedItems } from '@/lib/files-api';
import { formatDateTime } from '@/lib/formatters';
import {
  guestSessionIssueFromError,
  type GuestSessionIssue,
} from '@/lib/guest-collaboration';
import {
  DEFAULT_SHARED_ITEMS_FILTER,
  DEFAULT_SHARED_ITEMS_SORT,
  filterSharedItems,
  hasActiveSharedItemsFilter,
  nextSharedItemsSort,
  sortSharedItems,
  type SharedItemsClassificationFilter,
  type SharedItemsFilterState,
  type SharedItemsSortField,
  type SharedItemsSortState,
  type SharedItemsTypeFilter,
} from '@/lib/shared-items-view';
import { useTosAcceptance } from '@/lib/use-tos-acceptance';
import type { SharedItemEntry } from '@/types/files';

const TYPE_FILTER_OPTIONS: Array<{
  value: SharedItemsTypeFilter;
  label: string;
}> = [
  { value: 'all', label: 'すべて' },
  { value: 'folder', label: 'フォルダ' },
  { value: 'file', label: 'ファイル' },
];

const CLASSIFICATION_FILTER_OPTIONS: Array<{
  value: SharedItemsClassificationFilter;
  label: string;
}> = [
  { value: 'all', label: 'すべての機密分類' },
  { value: 'confidential', label: '機密 (Confidential)' },
  { value: 'internal', label: '社内限定 (Internal)' },
  { value: 'public', label: '公開 (Public)' },
  { value: 'unset', label: '未設定' },
];

function SortableHeader({
  label,
  field,
  sort,
  onToggle,
  className = 'px-3 py-2 font-medium',
}: {
  label: string;
  field: SharedItemsSortField;
  sort: SharedItemsSortState;
  onToggle: (field: SharedItemsSortField) => void;
  className?: string;
}) {
  const isActive = sort.field === field;
  const ariaSort = isActive
    ? sort.direction === 'asc'
      ? 'ascending'
      : 'descending'
    : 'none';

  return (
    <th scope="col" aria-sort={ariaSort} className={className}>
      <button
        type="button"
        data-testid={`shared-sort-${field}`}
        onClick={() => onToggle(field)}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition hover:bg-[#f2f2f4] hover:text-[#111214] ${
          isActive ? 'font-semibold text-[#111214]' : 'text-[#6b6f76]'
        }`}
      >
        <span>{label}</span>
        {isActive ? (
          sort.direction === 'asc' ? (
            <ArrowUp className="h-3 w-3 text-[#5e6ad2]" />
          ) : (
            <ArrowDown className="h-3 w-3 text-[#5e6ad2]" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-50" />
        )}
      </button>
    </th>
  );
}

export function WorkspaceSharedItemsView({
  onOpenFolder,
  onOpenFile,
  isGuest = false,
  externalOrg = null,
  expiresAt = null,
}: {
  onOpenFolder: (folderId: string) => void;
  onOpenFile: (fileId: string) => void;
  isGuest?: boolean;
  externalOrg?: string | null;
  expiresAt?: string | null;
}) {
  const [items, setItems] = useState<SharedItemEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [sessionIssue, setSessionIssue] = useState<GuestSessionIssue | null>(
    null
  );
  const [filter, setFilter] = useState<SharedItemsFilterState>(
    DEFAULT_SHARED_ITEMS_FILTER
  );
  const [sort, setSort] = useState<SharedItemsSortState>(
    DEFAULT_SHARED_ITEMS_SORT
  );
  const tosGate = useTosAcceptance({ apiErrorCode: errorCode });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      setErrorCode(null);
      setSessionIssue(null);
      try {
        const res = await listSharedItems(200, signal);
        setItems(res.items);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setErrorCode(
          typeof (err as { code?: unknown })?.code === 'string'
            ? (err as { code: string }).code
            : null
        );
        setSessionIssue(
          isGuest
            ? guestSessionIssueFromError(err, { userType: 'guest' })
            : null
        );
        setError(
          err instanceof Error
            ? err.message
            : '共有アイテムの取得に失敗しました'
        );
      } finally {
        setLoading(false);
      }
    },
    [isGuest]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const visibleItems = useMemo(() => {
    const filtered = filterSharedItems(items, filter);
    return sortSharedItems(filtered, sort);
  }, [items, filter, sort]);

  const filterActive = hasActiveSharedItemsFilter(filter);

  function openItem(item: SharedItemEntry) {
    if (item.itemType === 'folder') {
      onOpenFolder(item.id);
      return;
    }
    if (canAccess({ capabilities: item.capabilities }, 'item.preview')) {
      onOpenFile(item.id);
      return;
    }
    if (item.folderId) onOpenFolder(item.folderId);
  }

  function handleToggleSort(field: SharedItemsSortField) {
    setSort((prev) => nextSharedItemsSort(prev, field));
  }

  return (
    <>
      {tosGate.blocked && (
        <TosAcceptanceModal
          tos={tosGate.status}
          branding={tosGate.branding}
          accepting={tosGate.accepting}
          error={tosGate.error}
          onAccept={() => void tosGate.accept()}
        />
      )}
      <section aria-labelledby="shared-items-heading" className="space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1
              id="shared-items-heading"
              className="flex items-center gap-2 text-[1rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              <Share2 className="h-4 w-4 text-[#5e6ad2]" />
              共有アイテム
            </h1>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-[#6b6f76]">
              あなたまたは所属グループに直接共有されたフォルダとファイルです。継承のみのアイテムは含まれません。
            </p>
            {isGuest && (
              <div
                data-testid="guest-shared-guidance"
                className="mt-2 min-w-0 space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900"
              >
                <p className="break-words font-semibold">
                  外部ゲストとしてサインイン中
                </p>
                <p className="break-words">
                  外部組織: {externalOrg ?? '未設定'} / アカウント有効期限:{' '}
                  {formatDateTime(expiresAt)}
                </p>
                <p className="break-words">
                  共有アイテムのみ表示されます。権限管理・削除・ルートフォルダ作成はできません。操作範囲は各フォルダの実効ロールに従います。
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            />
            <span>再読み込み</span>
          </button>
        </header>

        <div
          data-testid="shared-items-toolbar"
          className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-[#e7e7ea] bg-white px-3.5 py-2.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a8d94]" />
              <input
                type="search"
                data-testid="shared-items-search"
                aria-label="共有アイテムを名前やパスで絞り込み"
                placeholder="名前やパスで絞り込み..."
                value={filter.query}
                onChange={(e) =>
                  setFilter((prev) => ({ ...prev, query: e.target.value }))
                }
                className="h-8 w-56 rounded-lg border border-[#e1e1e4] bg-[#fafafa] pl-8 pr-7 text-[0.75rem] text-[#111214] placeholder:text-[#8a8d94] focus:border-[#5e6ad2] focus:bg-white focus:outline-none sm:w-64"
              />
              {filter.query.length > 0 && (
                <button
                  type="button"
                  aria-label="検索語をクリア"
                  onClick={() =>
                    setFilter((prev) => ({ ...prev, query: '' }))
                  }
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[#8a8d94] hover:bg-[#ececee] hover:text-[#111214]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <div
              role="group"
              aria-label="種別フィルタ"
              data-testid="shared-items-type-filter"
              className="inline-flex h-8 items-center rounded-lg border border-[#e1e1e4] bg-[#f7f7f9] p-0.5"
            >
              {TYPE_FILTER_OPTIONS.map((opt) => {
                const active = filter.type === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      setFilter((prev) => ({ ...prev, type: opt.value }))
                    }
                    className={`rounded-md px-2.5 py-1 text-[0.6875rem] font-medium transition ${
                      active
                        ? 'bg-white text-[#111214] shadow-xs'
                        : 'text-[#6b6f76] hover:text-[#111214]'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <select
              aria-label="機密分類フィルタ"
              data-testid="shared-items-classification-filter"
              value={filter.classification}
              onChange={(e) =>
                setFilter((prev) => ({
                  ...prev,
                  classification: e.target
                    .value as SharedItemsClassificationFilter,
                }))
              }
              className="h-8 rounded-lg border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] focus:border-[#5e6ad2] focus:outline-none"
            >
              {CLASSIFICATION_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 text-[0.6875rem] text-[#6b6f76]">
            <span data-testid="shared-items-count">
              {filterActive
                ? `${visibleItems.length} / ${items.length} 件`
                : `全 ${items.length} 件`}
            </span>
            {filterActive && (
              <button
                type="button"
                onClick={() => setFilter(DEFAULT_SHARED_ITEMS_FILTER)}
                className="rounded-md border border-[#e1e1e4] bg-white px-2 py-1 font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
              >
                リセット
              </button>
            )}
          </div>
        </div>

        {sessionIssue ? (
          <div
            role="alert"
            aria-live="assertive"
            data-testid="guest-shared-session-issue"
            data-code={sessionIssue.code}
            className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
          >
            <div className="min-w-0 space-y-1">
              <p className="break-words font-semibold">{sessionIssue.title}</p>
              <p className="break-words leading-relaxed">
                {sessionIssue.description}
              </p>
            </div>
            <a
              href={sessionIssue.actionHref}
              className="inline-flex min-h-8 shrink-0 items-center rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700"
            >
              {sessionIssue.actionLabel} (/guest/login)
            </a>
          </div>
        ) : error ? (
          <div
            role="alert"
            aria-live="assertive"
            className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : null}

        <div
          role="region"
          aria-label="共有アイテム一覧"
          tabIndex={0}
          className="overflow-x-auto rounded-xl border border-[#e7e7ea] bg-white focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
        >
          <table className="w-full min-w-[760px] border-collapse text-left text-[0.75rem]">
            <caption className="sr-only">
              直接共有されたフォルダとファイルの一覧。名前、機密分類、階層パス、権限、更新日、操作を表示します。
            </caption>
            <thead>
              <tr className="border-b border-[#ececee] text-[0.6875rem] text-[#6b6f76]">
                <SortableHeader
                  label="名前"
                  field="name"
                  sort={sort}
                  onToggle={handleToggleSort}
                  className="px-4 py-2 font-medium"
                />
                <SortableHeader
                  label="機密分類"
                  field="classification"
                  sort={sort}
                  onToggle={handleToggleSort}
                />
                <th scope="col" className="px-3 py-2 font-medium">
                  階層パス
                </th>
                <SortableHeader
                  label="権限"
                  field="role"
                  sort={sort}
                  onToggle={handleToggleSort}
                />
                <SortableHeader
                  label="更新日"
                  field="updatedAt"
                  sort={sort}
                  onToggle={handleToggleSort}
                />
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-[#6b6f76]"
                  >
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin text-blue-600" />
                    共有アイテムを読み込み中...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center">
                    <p className="font-medium text-[#111214]">
                      直接共有されたアイテムはありません
                    </p>
                    <p className="mt-1 text-[0.6875rem] text-[#6b6f76]">
                      フォルダまたはファイルの権限画面から共有すると、ここに表示されます。
                    </p>
                  </td>
                </tr>
              ) : visibleItems.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center">
                    <p className="font-medium text-[#111214]">
                      条件に一致する共有アイテムがありません
                    </p>
                    <p className="mt-1 text-[0.6875rem] text-[#6b6f76]">
                      検索キーワードやフィルタ条件を変更してください。
                    </p>
                    <button
                      type="button"
                      onClick={() => setFilter(DEFAULT_SHARED_ITEMS_FILTER)}
                      className="mt-3 inline-flex items-center rounded-md border border-[#e1e1e4] bg-white px-3 py-1.5 text-[0.6875rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
                    >
                      フィルタをクリア
                    </button>
                  </td>
                </tr>
              ) : (
                visibleItems.map((item) => {
                  const roleLabel = item.effectiveRole
                    ? ROLE_META[item.effectiveRole]?.label ?? item.effectiveRole
                    : '—';
                  const canPreviewFile =
                    item.itemType === 'file' &&
                    canAccess({ capabilities: item.capabilities }, 'item.preview');

                  return (
                    <tr
                      key={`${item.itemType}:${item.id}`}
                      data-testid="shared-item-row"
                      className="border-b border-[#f2f2f4] last:border-b-0 hover:bg-[#f7f7f9]"
                    >
                      <th scope="row" className="px-4 py-2.5 text-left font-medium">
                        <button
                          type="button"
                          onClick={() => openItem(item)}
                          className="flex min-w-0 items-center gap-2 text-left text-[#111214] transition hover:text-[#4f5ac2]"
                        >
                          {item.itemType === 'folder' ? (
                            <Folder className="h-4 w-4 shrink-0 text-[#6b6f76]" />
                          ) : (
                            <FileText className="h-4 w-4 shrink-0 text-[#6b6f76]" />
                          )}
                          <span className="truncate">{item.name}</span>
                        </button>
                      </th>
                      <td className="px-3 py-2.5">
                        <ClassificationBadge
                          classification={item.classification}
                          compact
                        />
                      </td>
                      <td className="px-3 py-2.5 text-[#3c3f46]">
                        <span className="inline-flex items-center gap-1">
                          <Route className="h-3.5 w-3.5 shrink-0 text-[#8a8d94]" />
                          <span data-testid="shared-item-path">
                            {item.pathLabel}
                          </span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                          {roleLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-[#55565a]">
                        {formatDateTime(item.updatedAt)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {item.itemType === 'folder' ? (
                            <button
                              type="button"
                              data-testid={`shared-open-folder-${item.id}`}
                              onClick={() => onOpenFolder(item.id)}
                              className="inline-flex items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2 py-1 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
                            >
                              <FolderOpen className="h-3 w-3 text-[#5e6ad2]" />
                              <span>開く</span>
                            </button>
                          ) : (
                            <>
                              {canPreviewFile && (
                                <button
                                  type="button"
                                  data-testid={`shared-preview-file-${item.id}`}
                                  onClick={() => onOpenFile(item.id)}
                                  className="inline-flex items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2 py-1 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
                                >
                                  <Eye className="h-3 w-3 text-[#5e6ad2]" />
                                  <span>プレビュー</span>
                                </button>
                              )}
                              {item.folderId && (
                                <button
                                  type="button"
                                  data-testid={`shared-open-parent-${item.id}`}
                                  onClick={() => onOpenFolder(item.folderId!)}
                                  className="inline-flex items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2 py-1 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
                                >
                                  <FolderOpen className="h-3 w-3 text-[#6b6f76]" />
                                  <span>フォルダ</span>
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
