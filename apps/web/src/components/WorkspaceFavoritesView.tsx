'use client';

import {
  Check,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { TosAcceptanceModal } from '@/components/TosAcceptanceModal';
import { canAccess } from '@/lib/capabilities';
import {
  addCollectionItem,
  COLLECTION_COLOR_OPTIONS,
  createCollection,
  deleteCollection,
  getCollectionDotClass,
  listCollectionItems,
  listCollections,
  removeCollectionItem,
  updateCollection,
  validateCollectionName,
  type CollectionColor,
  type CollectionItemEntry,
  type UserCollection,
} from '@/lib/files-api/collections';
import {
  filterFavoriteRecentItems,
  listFavorites,
  removeFavorite,
  type FavoriteItemEntry,
} from '@/lib/files-api/favorites-recents';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import { useTosAcceptance } from '@/lib/use-tos-acceptance';

type DisplayEntry = (FavoriteItemEntry | CollectionItemEntry) & {
  dateLabel: string;
};

export function WorkspaceFavoritesView({
  onOpenFolder,
  onOpenFile,
}: {
  onOpenFolder: (folderId: string) => void;
  onOpenFile: (fileId: string) => void;
}) {
  const [favorites, setFavorites] = useState<FavoriteItemEntry[]>([]);
  const [collections, setCollections] = useState<UserCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<
    string | null
  >(null);
  const [collectionItems, setCollectionItems] = useState<CollectionItemEntry[]>(
    []
  );

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  // Create collection inline form
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<CollectionColor>('indigo');
  const [savingCollection, setSavingCollection] = useState(false);

  // Rename / edit selected collection inline form
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState<CollectionColor>('slate');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const tosGate = useTosAcceptance({ apiErrorCode: errorCode });

  const loadBase = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setErrorCode(null);
    try {
      const [favRes, colRes] = await Promise.all([
        listFavorites(signal),
        listCollections(signal),
      ]);
      setFavorites(favRes.items);
      setCollections(colRes.collections);
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

  const loadSelectedCollection = useCallback(
    async (collectionId: string, signal?: AbortSignal) => {
      setItemsLoading(true);
      setError(null);
      try {
        const res = await listCollectionItems(collectionId, signal);
        setCollectionItems(res.items);
        setCollections((prev) =>
          prev.map((col) =>
            col.id === collectionId
              ? { ...col, itemCount: res.collection.itemCount }
              : col
          )
        );
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setError(
          err instanceof Error
            ? err.message
            : 'コレクション項目の取得に失敗しました'
        );
      } finally {
        setItemsLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadBase(controller.signal);
    return () => controller.abort();
  }, [loadBase]);

  useEffect(() => {
    if (!selectedCollectionId) {
      setCollectionItems([]);
      return;
    }
    const controller = new AbortController();
    void loadSelectedCollection(selectedCollectionId, controller.signal);
    return () => controller.abort();
  }, [selectedCollectionId, loadSelectedCollection]);

  const activeCollection = useMemo(
    () => collections.find((c) => c.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId]
  );

  const rawDisplayItems: DisplayEntry[] = useMemo(() => {
    if (selectedCollectionId === null) {
      return favorites.map((item) => ({
        ...item,
        dateLabel: item.favoritedAt,
      }));
    }
    return collectionItems.map((item) => ({
      ...item,
      dateLabel: item.addedAt,
    }));
  }, [selectedCollectionId, favorites, collectionItems]);

  const filteredItems = useMemo(
    () => filterFavoriteRecentItems(rawDisplayItems, query),
    [rawDisplayItems, query]
  );

  function openItem(item: DisplayEntry) {
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

  async function handleRefresh() {
    await loadBase();
    if (selectedCollectionId) {
      await loadSelectedCollection(selectedCollectionId);
    }
  }

  async function handleUnfavorite(item: DisplayEntry) {
    const key = `${item.itemType}:${item.id}`;
    setPendingKey(key);
    setError(null);
    try {
      await removeFavorite(item.itemType, item.id);
      setFavorites((prev) =>
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

  async function handleCreateCollection(e: React.FormEvent) {
    e.preventDefault();
    const validation = validateCollectionName(newName);
    if (!validation.valid) {
      setError(validation.error);
      return;
    }
    setSavingCollection(true);
    setError(null);
    try {
      const res = await createCollection({
        name: validation.name,
        color: newColor,
      });
      setCollections((prev) => [...prev, res.collection]);
      setNewName('');
      setNewColor('indigo');
      setCreating(false);
      setSelectedCollectionId(res.collection.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'コレクションの作成に失敗しました'
      );
    } finally {
      setSavingCollection(false);
    }
  }

  function startEditCollection(col: UserCollection) {
    setEditingId(col.id);
    setEditName(col.name);
    setEditColor(col.color);
    setConfirmDeleteId(null);
  }

  async function handleSaveEditCollection(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    const validation = validateCollectionName(editName);
    if (!validation.valid) {
      setError(validation.error);
      return;
    }
    setSavingCollection(true);
    setError(null);
    try {
      const res = await updateCollection(editingId, {
        name: validation.name,
        color: editColor,
      });
      setCollections((prev) =>
        prev.map((col) => (col.id === editingId ? res.collection : col))
      );
      setEditingId(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'コレクションの更新に失敗しました'
      );
    } finally {
      setSavingCollection(false);
    }
  }

  async function handleDeleteCollection(collectionId: string) {
    setSavingCollection(true);
    setError(null);
    try {
      await deleteCollection(collectionId);
      setCollections((prev) => prev.filter((c) => c.id !== collectionId));
      if (selectedCollectionId === collectionId) {
        setSelectedCollectionId(null);
      }
      setConfirmDeleteId(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'コレクションの削除に失敗しました'
      );
    } finally {
      setSavingCollection(false);
    }
  }

  async function handleAssignToCollection(
    item: DisplayEntry,
    targetCollectionId: string
  ) {
    if (!targetCollectionId) return;
    const key = `assign:${item.itemType}:${item.id}`;
    setPendingKey(key);
    setError(null);
    try {
      await addCollectionItem(targetCollectionId, item.itemType, item.id);
      const colRes = await listCollections();
      setCollections(colRes.collections);
      if (selectedCollectionId === targetCollectionId) {
        await loadSelectedCollection(targetCollectionId);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'コレクションへの追加に失敗しました'
      );
    } finally {
      setPendingKey(null);
    }
  }

  async function handleRemoveFromCollection(item: DisplayEntry) {
    if (!selectedCollectionId) return;
    const key = `remove-col:${item.itemType}:${item.id}`;
    setPendingKey(key);
    setError(null);
    try {
      await removeCollectionItem(
        selectedCollectionId,
        item.itemType,
        item.id
      );
      setCollectionItems((prev) =>
        prev.filter(
          (entry) => !(entry.itemType === item.itemType && entry.id === item.id)
        )
      );
      setCollections((prev) =>
        prev.map((col) =>
          col.id === selectedCollectionId
            ? { ...col, itemCount: Math.max(0, col.itemCount - 1) }
            : col
        )
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'コレクションからの削除に失敗しました'
      );
    } finally {
      setPendingKey(null);
    }
  }

  const isBusy = loading || itemsLoading;

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
              お気に入り &amp; コレクション
            </h1>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-[#6b6f76]">
              スターを付けたフォルダ・ファイルをコレクション別に整理できます。アクセス権が取り消された項目は自動的に非表示になります。
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
              onClick={() => void handleRefresh()}
              disabled={isBusy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] font-medium text-[#111214] transition hover:bg-[#f4f4f6] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isBusy ? 'animate-spin' : ''}`}
              />
              更新
            </button>
          </div>
        </header>

        {/* Collections Bar */}
        <div
          aria-label="コレクション一覧"
          className="rounded-xl border border-[#e7e7ea] bg-white p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedCollectionId(null);
                setEditingId(null);
                setConfirmDeleteId(null);
              }}
              className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[0.75rem] font-medium transition ${
                selectedCollectionId === null
                  ? 'bg-[#111214] text-white'
                  : 'border border-[#e7e7ea] bg-[#f7f7f9] text-[#111214] hover:bg-[#ededf0]'
              }`}
            >
              <Star className="h-3.5 w-3.5 fill-current" />
              <span>すべてのお気に入り</span>
              <span className="rounded-full bg-black/10 px-1.5 py-0.2 text-[0.6875rem]">
                {favorites.length}
              </span>
            </button>

            {collections.map((col) => {
              const isSelected = selectedCollectionId === col.id;
              return (
                <button
                  key={col.id}
                  type="button"
                  onClick={() => {
                    setSelectedCollectionId(col.id);
                    setEditingId(null);
                    setConfirmDeleteId(null);
                  }}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[0.75rem] font-medium transition ${
                    isSelected
                      ? 'bg-[#5e6ad2] text-white'
                      : 'border border-[#e7e7ea] bg-white text-[#111214] hover:bg-[#f4f4f6]'
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isSelected ? 'bg-white' : getCollectionDotClass(col.color)
                    }`}
                  />
                  <span>{col.name}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[0.6875rem] ${
                      isSelected
                        ? 'bg-white/20 text-white'
                        : 'bg-[#f4f4f6] text-[#6b6f76]'
                    }`}
                  >
                    {col.itemCount}
                  </span>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => {
                setCreating((prev) => !prev);
                setError(null);
              }}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-dashed border-[#c7c9d1] bg-white px-2.5 text-[0.75rem] font-medium text-[#5e6ad2] transition hover:border-[#5e6ad2] hover:bg-[#f7f7ff]"
            >
              <Plus className="h-3.5 w-3.5" />
              コレクション作成
            </button>
          </div>

          {creating && (
            <form
              onSubmit={(e) => void handleCreateCollection(e)}
              className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#ededf0] pt-3"
            >
              <FolderPlus className="h-4 w-4 text-[#5e6ad2]" />
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                maxLength={60}
                placeholder="コレクション名（例: 重要契約書）"
                aria-label="新しいコレクション名"
                className="h-8 w-60 rounded-lg border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] text-[#111214] focus:border-[#5e6ad2] focus:outline-none"
                autoFocus
              />
              <div className="flex items-center gap-1" role="group" aria-label="コレクションの色">
                {COLLECTION_COLOR_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    title={opt.label}
                    aria-label={`色: ${opt.label}`}
                    onClick={() => setNewColor(opt.value)}
                    className={`flex h-6 w-6 items-center justify-center rounded-full border transition ${
                      newColor === opt.value
                        ? 'border-[#111214] ring-2 ring-[#5e6ad2]/30'
                        : 'border-transparent hover:border-[#d7d7dc]'
                    }`}
                  >
                    <span className={`h-3.5 w-3.5 rounded-full ${opt.dotClass}`} />
                  </button>
                ))}
              </div>
              <button
                type="submit"
                disabled={savingCollection}
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4e59be] disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                作成
              </button>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#e7e7ea] bg-white px-2.5 text-[0.75rem] text-[#6b6f76] hover:bg-[#f4f4f6]"
              >
                <X className="h-3.5 w-3.5" />
                キャンセル
              </button>
            </form>
          )}

          {activeCollection && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#ededf0] pt-2.5 text-[0.75rem]">
              {editingId === activeCollection.id ? (
                <form
                  onSubmit={(e) => void handleSaveEditCollection(e)}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={60}
                    aria-label="コレクション名を変更"
                    className="h-7 w-52 rounded-md border border-[#e7e7ea] px-2 text-[0.75rem] focus:border-[#5e6ad2] focus:outline-none"
                  />
                  <div className="flex items-center gap-1">
                    {COLLECTION_COLOR_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        title={opt.label}
                        onClick={() => setEditColor(opt.value)}
                        className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                          editColor === opt.value
                            ? 'border-[#111214]'
                            : 'border-transparent'
                        }`}
                      >
                        <span className={`h-3 w-3 rounded-full ${opt.dotClass}`} />
                      </button>
                    ))}
                  </div>
                  <button
                    type="submit"
                    disabled={savingCollection}
                    className="inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white hover:bg-[#4e59be] disabled:opacity-50"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="inline-flex h-7 items-center rounded-md border border-[#e7e7ea] px-2 text-[0.75rem] text-[#6b6f76] hover:bg-[#f4f4f6]"
                  >
                    キャンセル
                  </button>
                </form>
              ) : (
                <div className="flex items-center gap-2 text-[#4c5057]">
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${getCollectionDotClass(activeCollection.color)}`}
                  />
                  <span className="font-medium text-[#111214]">
                    {activeCollection.name}
                  </span>
                  <span className="text-[#6b6f76]">
                    ({activeCollection.itemCount}件)
                  </span>
                </div>
              )}

              <div className="flex items-center gap-1.5">
                {editingId !== activeCollection.id && (
                  <button
                    type="button"
                    onClick={() => startEditCollection(activeCollection)}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e7e7ea] bg-white px-2 text-[0.75rem] text-[#4c5057] hover:bg-[#f4f4f6]"
                  >
                    <Pencil className="h-3 w-3" />
                    名前・色を変更
                  </button>
                )}
                {confirmDeleteId === activeCollection.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={savingCollection}
                      onClick={() =>
                        void handleDeleteCollection(activeCollection.id)
                      }
                      className="inline-flex h-7 items-center rounded-md bg-rose-600 px-2.5 text-[0.75rem] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
                    >
                      削除を確定
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="inline-flex h-7 items-center rounded-md border border-[#e7e7ea] px-2 text-[0.75rem] text-[#6b6f76] hover:bg-[#f4f4f6]"
                    >
                      戻る
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(activeCollection.id)}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-200 bg-white px-2 text-[0.75rem] text-rose-600 hover:bg-rose-50"
                  >
                    <Trash2 className="h-3 w-3" />
                    削除
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-[0.75rem] text-rose-800"
          >
            {error}
          </div>
        )}

        {isBusy && rawDisplayItems.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-[#e7e7ea] bg-white py-12 text-[0.8125rem] text-[#6b6f76]">
            <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
            <span>読み込み中...</span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#d7d7dc] bg-white px-6 py-12 text-center">
            <Star className="mx-auto h-6 w-6 text-[#9ea3ae]" />
            <p className="mt-2 text-[0.8125rem] font-medium text-[#111214]">
              {rawDisplayItems.length === 0
                ? selectedCollectionId
                  ? 'このコレクションにはまだ項目がありません'
                  : 'お気に入りに追加された項目はありません'
                : '条件に一致する項目はありません'}
            </p>
            <p className="mt-1 text-[0.75rem] text-[#6b6f76]">
              {rawDisplayItems.length === 0
                ? selectedCollectionId
                  ? '「すべてのお気に入り」から項目のコレクション追加メニューで追加できます。'
                  : 'ワークスペースの右クリックメニューから「お気に入りに追加」を選ぶとここに表示されます。'
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
                  <th className="hidden px-3 py-2.5 sm:table-cell">
                    {selectedCollectionId ? '追加日時' : 'お気に入り登録'}
                  </th>
                  <th className="px-3 py-2.5 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#ededf0]">
                {filteredItems.map((item) => {
                  const key = `${item.itemType}:${item.id}`;
                  const isPending =
                    pendingKey === key ||
                    pendingKey === `assign:${key}` ||
                    pendingKey === `remove-col:${key}`;
                  return (
                    <tr key={key} className="transition hover:bg-[#f7f7f9]">
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
                        <ClassificationBadge
                          classification={item.classification}
                        />
                      </td>
                      <td className="hidden px-3 py-2.5 text-[0.75rem] text-[#6b6f76] lg:table-cell">
                        {item.itemType === 'file' && item.sizeBytes !== null
                          ? formatBytes(item.sizeBytes)
                          : '—'}
                      </td>
                      <td className="hidden whitespace-nowrap px-3 py-2.5 text-[0.75rem] text-[#6b6f76] sm:table-cell">
                        {formatDateTime(item.dateLabel)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex items-center justify-end gap-1.5">
                          {collections.length > 0 && (
                            <select
                              aria-label={`${item.name} をコレクションに追加`}
                              value=""
                              disabled={isPending}
                              onChange={(e) => {
                                const targetId = e.target.value;
                                if (targetId) {
                                  void handleAssignToCollection(item, targetId);
                                }
                              }}
                              className="h-7 max-w-[140px] rounded-md border border-[#e7e7ea] bg-white px-1.5 text-[0.6875rem] text-[#4c5057] focus:border-[#5e6ad2] focus:outline-none disabled:opacity-50"
                            >
                              <option value="">+ コレクション...</option>
                              {collections
                                .filter((c) => c.id !== selectedCollectionId)
                                .map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.name}
                                  </option>
                                ))}
                            </select>
                          )}
                          {selectedCollectionId ? (
                            <button
                              type="button"
                              disabled={isPending}
                              onClick={() => void handleRemoveFromCollection(item)}
                              title="コレクションから外す"
                              aria-label={`${item.name} をコレクションから外す`}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e7e7ea] bg-white px-2 text-[0.6875rem] text-[#6b6f76] transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50"
                            >
                              <X className="h-3.5 w-3.5" />
                              外す
                            </button>
                          ) : (
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
                          )}
                        </div>
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
