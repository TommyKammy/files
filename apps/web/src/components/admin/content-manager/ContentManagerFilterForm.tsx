'use client';

import { Loader2, Search } from 'lucide-react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { ADMIN_CONTENT_CLASSIFICATION_OPTIONS } from '@/lib/admin-content';
import type { AdminContentSearchFilters } from '@/types/files';

interface ContentManagerFilterFormProps {
  filters: AdminContentSearchFilters;
  loading: boolean;
  onFiltersChange: Dispatch<SetStateAction<AdminContentSearchFilters>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onReset: () => void;
}

/** Search and filter form for tenant-wide admin content discovery. */
export function ContentManagerFilterForm({
  filters,
  loading,
  onFiltersChange,
  onSubmit,
  onReset,
}: ContentManagerFilterFormProps) {
  return (
    <form
      onSubmit={onSubmit}
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
              onFiltersChange((prev) => ({
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
              onFiltersChange((prev) => ({
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
              onFiltersChange((prev) => ({
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
              onFiltersChange((prev) => ({
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
              onFiltersChange((prev) => ({
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
                onFiltersChange((prev) => ({
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
                onFiltersChange((prev) => ({
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
          onClick={onReset}
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
  );
}
