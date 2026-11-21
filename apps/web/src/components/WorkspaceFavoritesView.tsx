'use client';

import {
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
  filterFavoriteRecentItems,
  listFavorites,
  removeFavorite,
  type FavoriteItemEntry,
} from '@/lib/files-api/favorites-recents';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import { useTosAcceptance } from '@/lib/use-tos-acceptance';

export function WorkspaceFavoritesView({
  onOpenFolder,
  onOpenFile,
}: {
  onOpenFolder: (folderId: string) => void;
  onOpenFile: (fileId: string) => void;
}) {
  const [items, setItems] = useState<FavoriteItemEntry[]>([]);
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
      const res = await listFavorites(signal);
      setItems(res.items);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setErrorCode(
        typeof (err as { code?: unknown })?.code === 'string'
          ? (err as { code: string }).code
          : null
      );
      setError(
        err instanceof Error ? err.message : 'お気に入りの取得に失敗しました'
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

  function openItem(item: FavoriteItemEntry) {
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

  async function handleUnfavorite(item: FavoriteItemEntry) {
    const key = `${item.itemType}:${item.id}`;
    setPendingKey(key);
    setError(null);
    try {
      await removeFavorite(item.itemType, item.id);
      setItems((prev) =>
        prev.filter(
          (entry) => !(entry.itemType === item.itemType && entry.id === item.id)
        )
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'お気に入りの解除に失敗しました'
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
      <section aria-labelledby="favorites-heading" className="space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1
              id="favorites-heading"
              className="flex items-center gap-2 text-[1rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              <Star className="h-4 w-4 fill-[#f59e0b] text-[#f59e0b]" />
              お気に入り
            </h1>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-[#6b6f76]">
              スターを付けたフォルダとファイルです。アクセス権が取り消された項目は自動的に非表示になります。
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
                aria-label="お気に入りを絞り込む"
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
            <span>お気に入りを読み込み中...</span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#d7d7dc] bg-white px-6 py-12 text-center">
            <Star className="mx-auto h-6 w-6 text-[#9ea3ae]" />
            <p className="mt-2 text-[0.8125rem] font-medium text-[#111214]">
              {items.length === 0
                ? 'お気に入りに追加された項目はありません'
                : '条件に一致するお気に入りはありません'}
            </p>
            <p className="mt-1 text-[0.75rem] text-[#6b6f76]">
              {items.length === 0
                ? 'ワークスペースの右クリックメニューから「お気に入りに追加」を選ぶとここに表示されます。'
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
                  <th className="hidden px-3 py-2.5 sm:table-cell">機密区分</th>
                  <th className="hidden px-3 py-2.5 lg:table-cell">サイズ</th>
                  <th className="hidden px-3 py-2.5 sm:table-cell">お気に入り登録</th>
                  <th className="w-12 px-3 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ededf0]">
                {filteredItems.map((item) => {
                  const key = `${item.itemType}:${item.id}`;
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
                        <ClassificationBadge classification={item.classification} />
                      </td>
                      <td className="hidden px-3 py-2.5 text-[0.75rem] text-[#6b6f76] lg:table-cell">
                        {item.itemType === 'file' && item.sizeBytes !== null
                          ? formatBytes(item.sizeBytes)
                          : '—'}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-2.5 text-[0.75rem] text-[#6b6f76] sm:table-cell">
                        {formatDateTime(item.favoritedAt)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => void handleUnfavorite(item)}
                          title="お気に入りから解除"
                          aria-label={`${item.name} をお気に入りから解除`}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[#f59e0b] transition hover:bg-[#fef3c7] disabled:opacity-50"
                        >
                          <Star className="h-4 w-4 fill-[#f59e0b]" />
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
