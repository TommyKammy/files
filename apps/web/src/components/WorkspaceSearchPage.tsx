'use client';

import {
  FileText,
  Folder,
  Loader2,
  RotateCcw,
  Search,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShellRail } from '@/components/AppShellRail';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  ApiClientError,
  buildSearchQueryString,
  fetchCurrentUser,
  hasActiveSearchFilters,
  mergeSearchPages,
  searchWorkspace,
  type SearchFolderResultItem,
  type SearchTargetType,
  type SearchWorkspaceParams,
  type SearchWorkspaceResponse,
} from '@/lib/files-api';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import type { AuthUser, ClassificationLabel, SearchResultItem } from '@/types/files';

const SEARCH_PAGE_LIMIT = 25;

function parseClassificationParam(raw: string | null): ClassificationLabel | '' {
  if (
    raw === 'confidential' ||
    raw === 'internal' ||
    raw === 'public' ||
    raw === 'unset'
  ) {
    return raw;
  }
  return '';
}

function parseTypeParam(raw: string | null): SearchTargetType {
  if (raw === 'file' || raw === 'folder' || raw === 'all') {
    return raw;
  }
  return 'all';
}

function buildFileHref(item: SearchResultItem): string {
  if (item.folderId) {
    return `/workspace?folderId=${encodeURIComponent(item.folderId)}&preview=${encodeURIComponent(item.id)}`;
  }
  return `/workspace/file/${encodeURIComponent(item.id)}`;
}

function buildFolderHref(folder: SearchFolderResultItem): string {
  return `/workspace?folderId=${encodeURIComponent(folder.id)}`;
}

export function WorkspaceSearchPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [user, setUser] = useState<AuthUser | null>(null);
  const [queryInput, setQueryInput] = useState(() => searchParams.get('q') ?? '');
  const [searchType, setSearchType] = useState<SearchTargetType>(() =>
    parseTypeParam(searchParams.get('type'))
  );
  const [classification, setClassification] = useState<ClassificationLabel | ''>(() =>
    parseClassificationParam(searchParams.get('classification'))
  );
  const [extension, setExtension] = useState(() => searchParams.get('extension') ?? '');
  const [updatedFrom, setUpdatedFrom] = useState(() => searchParams.get('updatedFrom') ?? '');
  const [updatedTo, setUpdatedTo] = useState(() => searchParams.get('updatedTo') ?? '');
  const [folderId, setFolderId] = useState(() => searchParams.get('folderId') ?? '');

  const [response, setResponse] = useState<SearchWorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    fetchCurrentUser()
      .then((res) => {
        if (active) setUser(res.user);
      })
      .catch(() => {
        if (active) setUser(null);
      });
    return () => {
      active = false;
    };
  }, []);

  const currentParams: SearchWorkspaceParams = {
    q: queryInput,
    type: searchType,
    classification,
    extension,
    folderId: folderId || undefined,
    updatedFrom,
    updatedTo,
    limit: SEARCH_PAGE_LIMIT,
  };

  const executeSearch = useCallback(
    async (params: SearchWorkspaceParams, syncUrl: boolean) => {
      abortRef.current?.abort();
      if (!hasActiveSearchFilters(params)) {
        setResponse(null);
        setError(null);
        setLoading(false);
        if (syncUrl) {
          router.replace('/workspace/search');
        }
        return;
      }

      if (syncUrl) {
        const qs = buildSearchQueryString({ ...params, limit: undefined, offset: undefined });
        router.replace(qs ? `/workspace/search?${qs}` : '/workspace/search');
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);

      try {
        const data = await searchWorkspace(
          { ...params, limit: SEARCH_PAGE_LIMIT, offset: 0 },
          controller.signal
        );
        if (!controller.signal.aborted) {
          setResponse(data);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : '検索の実行中にエラーが発生しました'
        );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [router]
  );

  useEffect(() => {
    const initialParams: SearchWorkspaceParams = {
      q: searchParams.get('q') ?? '',
      type: parseTypeParam(searchParams.get('type')),
      classification: parseClassificationParam(searchParams.get('classification')),
      extension: searchParams.get('extension') ?? '',
      folderId: searchParams.get('folderId') ?? undefined,
      updatedFrom: searchParams.get('updatedFrom') ?? '',
      updatedTo: searchParams.get('updatedTo') ?? '',
      limit: SEARCH_PAGE_LIMIT,
    };
    if (hasActiveSearchFilters(initialParams)) {
      void executeSearch(initialParams, false);
    }
    return () => {
      abortRef.current?.abort();
    };
    // Run on initial mount / URL change from external navigation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void executeSearch(currentParams, true);
  }

  function handleReset() {
    setQueryInput('');
    setSearchType('all');
    setClassification('');
    setExtension('');
    setUpdatedFrom('');
    setUpdatedTo('');
    setFolderId('');
    setResponse(null);
    setError(null);
    router.replace('/workspace/search');
  }

  async function handleLoadMore() {
    if (!response?.hasMore || response.nextOffset === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const nextPage = await searchWorkspace({
        ...currentParams,
        limit: SEARCH_PAGE_LIMIT,
        offset: response.nextOffset,
      });
      setResponse((prev) => (prev ? mergeSearchPages(prev, nextPage) : nextPage));
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '追加の検索結果の読み込みに失敗しました'
      );
    } finally {
      setLoadingMore(false);
    }
  }

  const folders = response?.folders ?? [];
  const files = response?.results ?? [];
  const totalShown = folders.length + files.length;

  return (
    <div className="flex min-h-screen bg-[#efeff1] text-[#111214]">
      <AppShellRail user={user} activeView="search" />

      <main className="min-w-0 flex-1 p-4 md:p-6">
        <div className="mx-auto max-w-6xl space-y-4">
          <div className="rounded-xl border border-[#e2e2e6] bg-white p-5 shadow-xs">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h1 className="text-base font-semibold text-[#111214]">
                  ワークスペース詳細検索
                </h1>
                <p className="text-xs text-[#676b72]">
                  権限範囲内のフォルダ・ファイルをキーワードや属性フィルタで横断検索します
                </p>
              </div>
              <Link
                href="/workspace"
                className="rounded-md border border-[#e2e2e6] bg-[#f9f9fa] px-3 py-1.5 text-xs font-medium text-[#3c3f46] transition hover:bg-[#f0f0f2]"
              >
                マイファイルへ戻る
              </Link>
            </div>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#676b72]" />
                  <input
                    type="text"
                    value={queryInput}
                    onChange={(e) => setQueryInput(e.target.value)}
                    placeholder="キーワード検索 (例: 契約書, is:confidential)"
                    aria-label="検索キーワード"
                    className="h-9 w-full rounded-lg border border-[#d7d7dc] bg-white pl-9 pr-3 text-sm text-[#111214] placeholder:text-[#8a8d94] focus:border-[#5e6ad2] focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]/20"
                  />
                </div>
                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[#5e6ad2] px-4 text-xs font-medium text-white transition hover:bg-[#4e5ac2] disabled:opacity-60"
                >
                  {loading ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  <span>検索</span>
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#d7d7dc] bg-white px-3 text-xs font-medium text-[#3c3f46] transition hover:bg-[#f5f5f7]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>リセット</span>
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block space-y-1 text-xs">
                  <span className="font-medium text-[#3c3f46]">種別</span>
                  <select
                    value={searchType}
                    onChange={(e) => {
                      const next = parseTypeParam(e.target.value);
                      setSearchType(next);
                      void executeSearch({ ...currentParams, type: next }, true);
                    }}
                    className="h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-xs text-[#111214] focus:border-[#5e6ad2] focus:outline-none"
                  >
                    <option value="all">すべて</option>
                    <option value="file">ファイル</option>
                    <option value="folder">フォルダ</option>
                  </select>
                </label>

                <label className="block space-y-1 text-xs">
                  <span className="font-medium text-[#3c3f46]">機密分類</span>
                  <select
                    value={classification}
                    onChange={(e) => {
                      const next = parseClassificationParam(e.target.value);
                      setClassification(next);
                      void executeSearch({ ...currentParams, classification: next }, true);
                    }}
                    className="h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-xs text-[#111214] focus:border-[#5e6ad2] focus:outline-none"
                  >
                    <option value="">すべて</option>
                    <option value="confidential">機密 (confidential)</option>
                    <option value="internal">社外秘 (internal)</option>
                    <option value="public">公開 (public)</option>
                    <option value="unset">未設定 (unset)</option>
                  </select>
                </label>

                <label className="block space-y-1 text-xs">
                  <span className="font-medium text-[#3c3f46]">拡張子</span>
                  <input
                    type="text"
                    value={extension}
                    onChange={(e) => setExtension(e.target.value)}
                    placeholder="例: pdf, docx"
                    className="h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2.5 text-xs text-[#111214] placeholder:text-[#8a8d94] focus:border-[#5e6ad2] focus:outline-none"
                  />
                </label>

                <label className="block space-y-1 text-xs">
                  <span className="font-medium text-[#3c3f46]">更新日 (From)</span>
                  <input
                    type="date"
                    value={updatedFrom}
                    onChange={(e) => {
                      const next = e.target.value;
                      setUpdatedFrom(next);
                      void executeSearch({ ...currentParams, updatedFrom: next }, true);
                    }}
                    className="h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-xs text-[#111214] focus:border-[#5e6ad2] focus:outline-none"
                  />
                </label>

                <label className="block space-y-1 text-xs">
                  <span className="font-medium text-[#3c3f46]">更新日 (To)</span>
                  <input
                    type="date"
                    value={updatedTo}
                    onChange={(e) => {
                      const next = e.target.value;
                      setUpdatedTo(next);
                      void executeSearch({ ...currentParams, updatedTo: next }, true);
                    }}
                    className="h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-xs text-[#111214] focus:border-[#5e6ad2] focus:outline-none"
                  />
                </label>
              </div>
            </form>
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700"
            >
              {error}
            </div>
          )}

          {!response && !loading && (
            <div className="rounded-xl border border-[#e2e2e6] bg-white px-6 py-12 text-center text-sm text-[#676b72]">
              キーワードを入力するか、種別・機密分類・拡張子・更新日などのフィルタを指定して検索してください。
            </div>
          )}

          {loading && !response && (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-[#e2e2e6] bg-white px-6 py-12 text-sm text-[#676b72]">
              <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
              <span>検索中...</span>
            </div>
          )}

          {response && (
            <div className="space-y-4">
              <div className="flex items-center justify-between px-1 text-xs text-[#676b72]">
                <span>
                  表示中: フォルダ {folders.length} 件 / ファイル {files.length} 件
                  {response.hasMore ? '（さらに結果があります）' : ''}
                </span>
              </div>

              {totalShown === 0 ? (
                <div className="rounded-xl border border-[#e2e2e6] bg-white px-6 py-12 text-center text-sm text-[#676b72]">
                  条件に一致するフォルダまたはファイルは見つかりませんでした。
                </div>
              ) : (
                <>
                  {folders.length > 0 && (
                    <section className="overflow-hidden rounded-xl border border-[#e2e2e6] bg-white">
                      <div className="border-b border-[#f0f0f1] bg-[#f9f9fa] px-4 py-2 text-xs font-semibold text-[#3c3f46]">
                        フォルダ ({folders.length})
                      </div>
                      <div className="divide-y divide-[#f0f0f1]">
                        {folders.map((folder) => (
                          <Link
                            key={folder.id}
                            href={buildFolderHref(folder)}
                            className="flex items-center justify-between gap-4 px-4 py-2.5 transition hover:bg-[#f6f6f9]"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-[#111214]">
                                  {folder.name}
                                </div>
                                <div className="truncate text-xs text-[#676b72]">
                                  {folder.parentName ?? 'Root'} • 更新:{' '}
                                  {formatDateTime(folder.updatedAt)}
                                </div>
                              </div>
                            </div>
                            <ClassificationBadge
                              classification={folder.classification}
                              compact
                            />
                          </Link>
                        ))}
                      </div>
                    </section>
                  )}

                  {files.length > 0 && (
                    <section className="overflow-hidden rounded-xl border border-[#e2e2e6] bg-white">
                      <div className="border-b border-[#f0f0f1] bg-[#f9f9fa] px-4 py-2 text-xs font-semibold text-[#3c3f46]">
                        ファイル ({files.length})
                      </div>
                      <div className="divide-y divide-[#f0f0f1]">
                        {files.map((file) => (
                          <Link
                            key={file.id}
                            href={buildFileHref(file)}
                            className="flex items-center justify-between gap-4 px-4 py-2.5 transition hover:bg-[#f6f6f9]"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <FileText className="h-4 w-4 shrink-0 text-[#676b72]" />
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-[#111214]">
                                  {file.name}
                                </div>
                                <div className="truncate text-xs text-[#676b72]">
                                  {file.folderName ?? 'Root'} •{' '}
                                  {formatBytes(file.sizeBytes)} • 更新:{' '}
                                  {formatDateTime(file.updatedAt)}
                                </div>
                              </div>
                            </div>
                            <ClassificationBadge
                              classification={file.classification}
                              compact
                            />
                          </Link>
                        ))}
                      </div>
                    </section>
                  )}

                  {response.hasMore && response.nextOffset !== null && (
                    <div className="flex justify-center pt-1">
                      <button
                        type="button"
                        onClick={() => void handleLoadMore()}
                        disabled={loadingMore}
                        className="inline-flex items-center gap-2 rounded-lg border border-[#d7d7dc] bg-white px-5 py-2 text-xs font-medium text-[#111214] shadow-xs transition hover:bg-[#f5f5f7] disabled:opacity-60"
                      >
                        {loadingMore && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#5e6ad2]" />
                        )}
                        <span>さらに読み込む</span>
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
