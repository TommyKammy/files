'use client';

import { ArchiveRestore, Loader2, Trash2 } from 'lucide-react';
import {
  ADMIN_TRASH_RETENTION_OPTIONS,
  ADMIN_TRASH_SORT_OPTIONS,
  isAdminTrashFilterActive,
} from '@/lib/admin-trash';
import type { useAdminTrash } from '@/lib/use-admin-trash';
import type { AdminTrashItem, AdminTrashPerson } from '@/types/files';
import { FIELD_CLASS } from './shared';

type AdminTrashFilters = ReturnType<typeof useAdminTrash>['filters'];

interface TrashFilterBarProps {
  filters: AdminTrashFilters;
  owners: AdminTrashPerson[];
  deleters: AdminTrashPerson[];
  hasUnknownDeleter: boolean;
  loading: boolean;
  busy: boolean;
  canPurge: boolean;
  selectedCount: number;
  selectedItems: AdminTrashItem[];
  onUpdateFilters: (patch: Partial<AdminTrashFilters>) => void;
  onResetFilters: () => void;
  onRefresh: () => void;
  onOpenRestore: (targets: AdminTrashItem[]) => void;
  onOpenPurge: (targets: AdminTrashItem[]) => void;
  onClearSelection: () => void;
}

/** Filter controls and bulk selection action bar for the admin trash table. */
export function TrashFilterBar({
  filters,
  owners,
  deleters,
  hasUnknownDeleter,
  loading,
  busy,
  canPurge,
  selectedCount,
  selectedItems,
  onUpdateFilters,
  onResetFilters,
  onRefresh,
  onOpenRestore,
  onOpenPurge,
  onClearSelection,
}: TrashFilterBarProps) {
  return (
    <div className="space-y-3 border-b border-slate-100 px-5 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[15rem] flex-1 flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
          <span>検索</span>
          <input
            type="search"
            aria-label="管理者ゴミ箱を検索"
            value={filters.query}
            onChange={(event) => onUpdateFilters({ query: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onRefresh();
              }
            }}
            placeholder="ファイル名・フォルダ名"
            className={FIELD_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
          <span>種別</span>
          <select
            aria-label="種別で絞り込む"
            value={filters.type}
            onChange={(event) =>
              onUpdateFilters({
                type: event.target.value as typeof filters.type,
              })
            }
            className={FIELD_CLASS}
          >
            <option value="all">すべて</option>
            <option value="file">ファイル</option>
            <option value="folder">フォルダ</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
          <span>所有者</span>
          <select
            aria-label="所有者で絞り込む"
            value={filters.ownerId ?? ''}
            onChange={(event) =>
              onUpdateFilters({ ownerId: event.target.value || null })
            }
            className={FIELD_CLASS}
          >
            <option value="">すべての所有者</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
          <span>削除者</span>
          <select
            aria-label="削除者で絞り込む"
            value={filters.deletedById ?? ''}
            onChange={(event) =>
              onUpdateFilters({ deletedById: event.target.value || null })
            }
            className={FIELD_CLASS}
          >
            <option value="">すべての削除者</option>
            {deleters.map((deleter) => (
              <option key={deleter.id} value={deleter.id}>
                {deleter.name}
              </option>
            ))}
            {hasUnknownDeleter ? (
              <option value="unknown">不明（旧データ）</option>
            ) : null}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
          <span>保持期限</span>
          <select
            aria-label="保持期限で絞り込む"
            value={filters.retention}
            onChange={(event) =>
              onUpdateFilters({
                retention: event.target.value as typeof filters.retention,
              })
            }
            className={FIELD_CLASS}
          >
            {ADMIN_TRASH_RETENTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
          <span>並び順</span>
          <select
            aria-label="並び順"
            value={filters.sort}
            onChange={(event) =>
              onUpdateFilters({
                sort: event.target.value as typeof filters.sort,
              })
            }
            className={FIELD_CLASS}
          >
            {ADMIN_TRASH_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {isAdminTrashFilterActive(filters) ? (
          <button
            type="button"
            onClick={onResetFilters}
            className="inline-flex h-7 items-center rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#55565a] hover:bg-[#f2f2f4]"
          >
            フィルタを解除
          </button>
        ) : null}

        {loading ? (
          <span className="inline-flex h-7 items-center gap-1.5 text-[0.6875rem] text-[#8a8c91]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            読み込み中
          </span>
        ) : null}
      </div>

      {selectedCount > 0 ? (
        <div
          data-admin-trash-selected-count={selectedCount}
          className="flex flex-wrap items-center gap-2 rounded-md border border-[#dfe2f5] bg-[#eef0fb] px-3 py-1.5 text-[0.75rem] text-[#3c3f46]"
        >
          <span className="font-medium">{selectedCount} 件選択中</span>
          <button
            type="button"
            onClick={() => onOpenRestore(selectedItems)}
            disabled={busy}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
          >
            <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
            選択項目を代理復元
          </button>
          {canPurge ? (
            <button
              type="button"
              onClick={() => onOpenPurge(selectedItems)}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 text-[0.75rem] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              選択項目を完全削除
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClearSelection}
            className="inline-flex h-7 items-center rounded-md px-2 text-[0.75rem] text-[#55565a] hover:bg-white/70"
          >
            選択を解除
          </button>
        </div>
      ) : null}
    </div>
  );
}
