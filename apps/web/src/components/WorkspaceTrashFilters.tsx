'use client';

import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import type {
  TrashDeleter,
  TrashFilters,
  TrashSort,
  TrashTypeFilter,
} from '@/types/files';

export function WorkspaceTrashFilters({
  filters,
  deleters,
  hasUnknownDeleter,
  showDeleterFilter,
  loading,
  onChange,
  onClear,
}: {
  filters: TrashFilters;
  deleters: TrashDeleter[];
  hasUnknownDeleter: boolean;
  showDeleterFilter: boolean;
  loading: boolean;
  onChange: (patch: Partial<TrashFilters>) => void;
  onClear: () => void;
}) {
  const [searchInput, setSearchInput] = useState(filters.query);

  useEffect(() => {
    setSearchInput(filters.query);
  }, [filters.query]);

  function submitSearch() {
    onChange({ query: searchInput.trim() });
  }

  function clearSearch() {
    setSearchInput('');
    onChange({ query: '' });
  }

  const hasActiveFilter =
    filters.query.trim().length > 0 ||
    filters.type !== 'all' ||
    filters.deletedBy !== null;

  return (
    <section
      aria-label="ゴミ箱の検索とフィルタ"
      data-trash-filters="true"
      aria-busy={loading}
      className="rounded-lg border border-[#e7e7ea] bg-white px-3 py-2.5"
    >
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <form
          className="min-w-[220px] flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <label
            htmlFor="trash-search"
            className="mb-1 block text-[0.6875rem] font-medium text-[#55565a]"
          >
            名前で検索
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a8d94]" />
            <input
              id="trash-search"
              name="trashQuery"
              type="search"
              value={searchInput}
              aria-label="ゴミ箱を検索"
              placeholder="アイテム名の一部を入力"
              autoComplete="off"
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter during IME conversion must not submit a half-composed value.
                if (event.key === 'Enter' && isImeComposingEvent(event)) {
                  event.preventDefault();
                }
              }}
              className="h-8 w-full rounded-md border border-[#d9d9de] bg-white py-1 pl-8 pr-8 text-[0.75rem] text-[#111214] outline-none transition focus:border-[#6d78d5] focus:ring-2 focus:ring-[#6d78d5]/25"
            />
            {searchInput.length > 0 && (
              <button
                type="button"
                aria-label="検索語をクリア"
                onClick={clearSearch}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-[#8a8d94] transition hover:bg-[#f0f0f2] hover:text-[#111214]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </form>

        <div>
          <label
            htmlFor="trash-type-filter"
            className="mb-1 block text-[0.6875rem] font-medium text-[#55565a]"
          >
            種類
          </label>
          <select
            id="trash-type-filter"
            name="trashType"
            aria-label="種類で絞り込み"
            value={filters.type}
            onChange={(event) =>
              onChange({ type: event.target.value as TrashTypeFilter })
            }
            className="h-8 rounded-md border border-[#d9d9de] bg-white px-2 text-[0.75rem] text-[#111214] outline-none focus:border-[#6d78d5] focus:ring-2 focus:ring-[#6d78d5]/25"
          >
            <option value="all">すべて</option>
            <option value="file">ファイル</option>
            <option value="folder">フォルダ</option>
          </select>
        </div>

        {showDeleterFilter && (
          <div>
            <label
              htmlFor="trash-deleter-filter"
              className="mb-1 block text-[0.6875rem] font-medium text-[#55565a]"
            >
              削除者
            </label>
            <select
              id="trash-deleter-filter"
              name="trashDeleter"
              aria-label="削除者で絞り込み"
              value={filters.deletedBy ?? ''}
              onChange={(event) =>
                onChange({ deletedBy: event.target.value || null })
              }
              className="h-8 max-w-[13rem] rounded-md border border-[#d9d9de] bg-white px-2 text-[0.75rem] text-[#111214] outline-none focus:border-[#6d78d5] focus:ring-2 focus:ring-[#6d78d5]/25"
            >
              <option value="">すべての削除者</option>
              {deleters.map((deleter) => (
                <option key={deleter.id} value={deleter.id}>
                  {deleter.name}
                </option>
              ))}
              {hasUnknownDeleter && <option value="unknown">不明</option>}
            </select>
          </div>
        )}

        <div>
          <label
            htmlFor="trash-sort"
            className="mb-1 block text-[0.6875rem] font-medium text-[#55565a]"
          >
            並び順
          </label>
          <select
            id="trash-sort"
            name="trashSort"
            aria-label="並び順"
            value={filters.sort}
            onChange={(event) =>
              onChange({ sort: event.target.value as TrashSort })
            }
            className="h-8 rounded-md border border-[#d9d9de] bg-white px-2 text-[0.75rem] text-[#111214] outline-none focus:border-[#6d78d5] focus:ring-2 focus:ring-[#6d78d5]/25"
          >
            <option value="deletedAt_desc">削除日時（新しい順）</option>
            <option value="deletedAt_asc">削除日時（古い順）</option>
            <option value="name_asc">名前（昇順）</option>
            <option value="name_desc">名前（降順）</option>
          </select>
        </div>

        <div className="flex items-center gap-2 pb-0.5">
          <button
            type="button"
            onClick={submitSearch}
            className="inline-flex h-8 items-center rounded-md border border-[#d9d9de] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
          >
            検索
          </button>
          {hasActiveFilter && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex h-8 items-center rounded-md border border-[#d9d9de] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
            >
              条件をクリア
            </button>
          )}
          {loading && (
            <span className="inline-flex items-center gap-1 text-[0.6875rem] text-[#6b6f76]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              読み込み中…
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
