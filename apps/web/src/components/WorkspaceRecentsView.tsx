'use client';

import {
  Clock,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  Star,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { TosAcceptanceModal } from '@/components/TosAcceptanceModal';
import { canAccess } from '@/lib/capabilities';
import {
  addFavorite,
  buildFavoriteKey,
  filterFavoriteRecentItems,
  listFavorites,
  listRecents,
  recentActionLabel,
  removeFavorite,
  type RecentItemEntry,
} from '@/lib/files-api/favorites-recents';
import { formatDateTime } from '@/lib/formatters';
import { useTosAcceptance } from '@/lib/use-tos-acceptance';

export function WorkspaceRecentsView({
  onOpenFolder,
  onOpenFile,
}: {
  onOpenFolder: (folderId: string) => void;
  onOpenFile: (fileId: string) => void;
}) {
  const [items, setItems] = useState<RecentItemEntry[]>([]);
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const tosGate = useTosAcceptance({ apiErrorCode: errorCode });

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const [recentsRes, favoritesRes] = await Promise.all([
        listRecents(50, signal),
        listFavorites(signal).catch(() => ({ items: [] })),
      ]);
      setItems(recentsRes.items);
      setFavoriteKeys(
        new Set(
          favoritesRes.items.map((fav) => buildFavoriteKey(fav.itemType, fav.id))
        )
      );
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setErrorCode(
        typeof (err as { code?: unknown })?.code === 'string'
          ? (err as { code: string }).code
          : null
      );
      setError(
        err instanceof Error
          ? err.message
          : '最近使用した項目の取得に失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const filteredItems = useMemo(
    () => filterFavoriteRecentItems(items, query),
    [items, query]
  );

  function openItem(item: RecentItemEntry) {
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

  async function handleToggleFavorite(item: RecentItemEntry) {
    const key = buildFavoriteKey(item.itemType, item.id);
    const currentlyFav = favoriteKeys.has(key);
    setPendingKey(key);
    setError(null);
    try {
      if (currentlyFav) {
        await removeFavorite(item.itemType, item.id);
        setFavoriteKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      } else {
        await addFavorite(item.itemType, item.id);
        setFavoriteKeys((prev) => new Set(prev).add(key));
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'お気に入りの更新に失敗しました'
      );
    } finally {
      setPendingKey(null);
    }
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
      <section aria-labelledby="recents-heading" className="space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1
              id="recents-heading"
              className="flex items-center gap-2 text-[1rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              <Clock className="h-4 w-4 text-[#5e6ad2]" />
              最近使用した項目
            </h1>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-[#6b6f76]">
              最近閲覧・編集・ダウンロードしたフォルダとファイルの一覧です。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6b6f76]" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="名前やパスで絞り込み..."
                aria-label="最近使用した項目を絞り込む"
                className="h-8 w-56 rounded-lg border border-[#e7e7ea] bg-white pl-8 pr-2.5 text-[0.75rem] text-[#111214] placeholder:text-[#8c9099] focus:border-[#5e6ad2] focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] font-medium text-[#111214] transition hover:bg-[#f4f4f6] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              />
              更新
            </button>
          </div>
        </header>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[0.75rem] text-rose-800"
          >
            {error}
          </div>
        )}

        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-[#e7e7ea] bg-white py-12 text-[0.8125rem] text-[#6b6f76]">
            <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
            <span>最近使用した項目を読み込み中...</span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#d7d7dc] bg-white px-6 py-12 text-center">
            <Clock className="mx-auto h-6 w-6 text-[#9ea3ae]" />
            <p className="mt-2 text-[0.8125rem] font-medium text-[#111214]">
              {items.length === 0
                ? '最近使用した項目はまだありません'
                : '条件に一致する項目はありません'}
            </p>
            <p className="mt-1 text-[0.75rem] text-[#6b6f76]">
              {items.length === 0
                ? 'フォルダを開いたりファイルをプレビューするとここに履歴が表示されます。'
                : '検索キーワードを変更してお試しください。'}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[#e7e7ea] bg-white">
            <table className="w-full border-collapse text-left text-[0.8125rem]">
              <thead>
                <tr className="border-b border-[#e7e7ea] bg-[#f4f4f6] text-[0.6875rem] font-medium text-[#6b6f76]">
                  <th className="px-4 py-2.5">名前</th>
                  <th className="hidden px-3 py-2.5 md:table-cell">場所</th>
                  <th className="hidden px-3 py-2.5 sm:table-cell">操作種別</th>
                  <th className="hidden px-3 py-2.5 lg:table-cell">機密区分</th>
                  <th className="hidden px-3 py-2.5 sm:table-cell">最終アクセス</th>
                  <th className="w-12 px-3 py-2.5 text-right">お気に入り</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ededf0]">
                {filteredItems.map((item) => {
                  const key = buildFavoriteKey(item.itemType, item.id);
                  const isFav = favoriteKeys.has(key);
                  const isPending = pendingKey === key;
                  return (
                    <tr
                      key={key}
                      className="transition hover:bg-[#f7f7f9]"
                    >
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => openItem(item)}
                          className="flex min-w-0 items-center gap-2.5 text-left font-medium text-[#111214] hover:text-[#5e6ad2]"
                        >
                          {item.itemType === 'folder' ? (
                            <Folder className="h-4 w-4 shrink-0 text-[#5e6ad2]" />
                          ) : (
                            <FileText className="h-4 w-4 shrink-0 text-[#676b72]" />
                          )}
                          <span className="truncate">{item.name}</span>
                        </button>
                      </td>
                      <td className="hidden max-w-[220px] truncate px-3 py-2.5 text-[0.75rem] text-[#6b6f76] md:table-cell">
                        {item.pathLabel}
                      </td>
                      <td className="hidden px-3 py-2.5 sm:table-cell">
                        <span className="inline-flex items-center rounded-md bg-[#f1f2f5] px-2 py-0.5 text-[0.6875rem] font-medium text-[#3c3f46]">
                          {recentActionLabel(item.lastAction)}
                        </span>
                      </td>
                      <td className="hidden px-3 py-2.5 lg:table-cell">
                        <ClassificationBadge classification={item.classification} />
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-2.5 text-[0.75rem] text-[#6b6f76] sm:table-cell">
                        {formatDateTime(item.accessedAt)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => void handleToggleFavorite(item)}
                          title={isFav ? 'お気に入りから解除' : 'お気に入りに追加'}
                          aria-label={
                            isFav
                              ? `${item.name} をお気に入りから解除`
                              : `${item.name} をお気に入りに追加`
                          }
                          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition disabled:opacity-50 ${
                            isFav
                              ? 'text-[#f59e0b] hover:bg-[#fef3c7]'
                              : 'text-[#9ea3ae] hover:bg-[#f1f2f5] hover:text-[#676b72]'
                          }`}
                        >
                          <Star
                            className={`h-4 w-4 ${isFav ? 'fill-[#f59e0b]' : ''}`}
                          />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
