'use client';

import { ArchiveRestore, Loader2, Trash2 } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { TrashRetentionBadge } from '@/components/TrashRetentionBadge';
import type { getAdminTrashEmptyState } from '@/lib/admin-trash';
import {
  formatAdminTrashPermissionSummary,
  formatAdminTrashPerson,
} from '@/lib/admin-trash';
import { formatAuditDateTime, formatBytes } from '@/lib/formatters';
import type { AdminTrashItem } from '@/types/files';
import { TrashIcon } from './shared';

interface TrashItemsTableProps {
  items: AdminTrashItem[];
  selectedKeys: Set<string>;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  busy: boolean;
  canPurge: boolean;
  emptyState: ReturnType<typeof getAdminTrashEmptyState>;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onToggleSelection: (key: string) => void;
  onOpenRestore: (targets: AdminTrashItem[]) => void;
  onOpenPurge: (targets: AdminTrashItem[]) => void;
  onResetFilters: () => void;
  onLoadMore: () => void;
}

/** Tenant-wide deleted items table with selection, per-row actions, and pagination. */
export function TrashItemsTable({
  items,
  selectedKeys,
  loading,
  loadingMore,
  hasMore,
  busy,
  canPurge,
  emptyState,
  onSelectAll,
  onClearSelection,
  onToggleSelection,
  onOpenRestore,
  onOpenPurge,
  onResetFilters,
  onLoadMore,
}: TrashItemsTableProps) {
  return (
    <>
      <div
        role="region"
        aria-label="管理者ゴミ箱一覧"
        tabIndex={0}
        className="overflow-x-auto"
      >
        <table className="w-full min-w-[78rem] text-left text-xs">
          <caption className="sr-only">
            テナント全体の削除済みファイルとフォルダ
          </caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
            <tr>
              <th scope="col" className="w-9 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="表示中の項目をすべて選択"
                  checked={items.length > 0 && selectedKeys.size === items.length}
                  onChange={(event) =>
                    event.target.checked ? onSelectAll() : onClearSelection()
                  }
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
              </th>
              <th scope="col" className="px-3 py-2">
                対象名
              </th>
              <th scope="col" className="px-3 py-2">
                種別
              </th>
              <th scope="col" className="px-3 py-2">
                機密区分
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                サイズ
              </th>
              <th scope="col" className="px-3 py-2">
                元の親フォルダ
              </th>
              <th scope="col" className="px-3 py-2">
                所有者
              </th>
              <th scope="col" className="px-3 py-2">
                削除者
              </th>
              <th scope="col" className="px-3 py-2">
                削除日時 (JST)
              </th>
              <th scope="col" className="px-3 py-2">
                保持期限
              </th>
              <th scope="col" className="px-3 py-2">
                権限要約
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => {
              const key = `${item.type}:${item.id}`;
              return (
                <tr
                  key={key}
                  className={
                    selectedKeys.has(key)
                      ? 'bg-[#eef0fb] hover:bg-[#eef0fb]'
                      : 'hover:bg-slate-50/70'
                  }
                >
                  <td className="px-3 py-2 align-top">
                    <input
                      type="checkbox"
                      aria-label={`「${item.name}」を選択`}
                      checked={selectedKeys.has(key)}
                      onChange={() => onToggleSelection(key)}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                  </td>
                  <td className="max-w-[16rem] px-3 py-2 align-top">
                    <div className="flex items-center gap-1.5">
                      <TrashIcon type={item.type} />
                      <span
                        className="truncate font-medium text-slate-900"
                        title={item.name}
                      >
                        {item.name}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[0.625rem] text-slate-400">
                      {item.id.slice(0, 12)}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top text-[#55565a]">
                    {item.type === 'folder' ? 'フォルダ' : 'ファイル'}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <ClassificationBadge
                      classification={item.classification}
                      compact
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums text-[#55565a]">
                    {item.type === 'file' && item.sizeBytes !== null
                      ? formatBytes(item.sizeBytes)
                      : '—'}
                  </td>
                  <td className="max-w-[12rem] px-3 py-2 align-top text-[0.6875rem] text-[#55565a]">
                    <span
                      className="line-clamp-2"
                      title={item.parentFolder?.name}
                    >
                      {item.parentFolder?.name ?? 'マイファイル (ルート)'}
                    </span>
                  </td>
                  <td className="max-w-[13rem] px-3 py-2 align-top text-[0.6875rem] text-[#55565a]">
                    <div
                      className="truncate"
                      title={formatAdminTrashPerson(item.owner)}
                    >
                      {item.owner?.name ?? '不明'}
                    </div>
                    <div className="truncate text-[0.625rem] text-slate-400">
                      {item.owner?.email ?? '—'}
                    </div>
                  </td>
                  <td className="max-w-[13rem] px-3 py-2 align-top text-[0.6875rem] text-[#55565a]">
                    <div
                      className="truncate"
                      title={formatAdminTrashPerson(item.deletedBy)}
                    >
                      {item.deletedBy?.name ?? '不明'}
                    </div>
                    <div className="truncate text-[0.625rem] text-slate-400">
                      {item.deletedBy?.email ?? '—'}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-[0.625rem] text-slate-500">
                    <time dateTime={item.deletedAt}>
                      {formatAuditDateTime(item.deletedAt)}
                    </time>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top">
                    <TrashRetentionBadge daysRemaining={item.daysRemaining} />
                  </td>
                  <td
                    className="max-w-[13rem] px-3 py-2 align-top text-[0.625rem] leading-snug text-[#55565a]"
                    title={formatAdminTrashPermissionSummary(
                      item.permissionSummary
                    )}
                  >
                    <span className="line-clamp-2">
                      {formatAdminTrashPermissionSummary(
                        item.permissionSummary
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right align-top">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => onOpenRestore([item])}
                        disabled={busy}
                        aria-label={`「${item.name}」を代理復元`}
                        className="inline-flex h-6 items-center gap-1 rounded border border-[#e1e1e4] bg-white px-1.5 text-[0.6875rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
                      >
                        <ArchiveRestore
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                        代理復元
                      </button>
                      {canPurge ? (
                        <button
                          type="button"
                          onClick={() => onOpenPurge([item])}
                          disabled={busy}
                          aria-label={`「${item.name}」を完全削除`}
                          className="inline-flex h-6 items-center gap-1 rounded border border-red-200 bg-white px-1.5 text-[0.6875rem] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          完全削除
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && items.length === 0 ? (
        <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-8 text-center text-[0.75rem] text-[#55565a]">
          {emptyState === 'empty' ? (
            <p>ゴミ箱は空です</p>
          ) : (
            <div className="space-y-2">
              <p>条件に一致するアイテムがありません</p>
              <button
                type="button"
                onClick={onResetFilters}
                className="inline-flex h-7 items-center rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
              >
                フィルタを解除
              </button>
            </div>
          )}
        </div>
      ) : null}

      {hasMore ? (
        <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="inline-flex h-7 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            <span>さらに読み込む</span>
          </button>
        </div>
      ) : null}
    </>
  );
}
