'use client';

import { Loader2, Lock, Share2 } from 'lucide-react';
import { formatAdminContentOwner } from '@/lib/admin-content';
import { CLASSIFICATION_META, formatDateTime } from '@/lib/formatters';
import type { AdminContentSearchItem } from '@/types/files';
import { DATE_TIME_OPTIONS, TargetIcon } from './shared';

interface ContentManagerTableProps {
  items: AdminContentSearchItem[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  appliedQuery: string;
  onOpenInspector: (item: AdminContentSearchItem) => void;
  onLoadMore: () => void;
}

/** Results table and pagination footer for admin content search. */
export function ContentManagerTable({
  items,
  loading,
  loadingMore,
  nextCursor,
  appliedQuery,
  onOpenInspector,
  onLoadMore,
}: ContentManagerTableProps) {
  return (
    <>
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
                        onClick={() => onOpenInspector(item)}
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
          {appliedQuery ? ` / 検索: ${appliedQuery}` : ''}
        </p>
        {nextCursor && (
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-[0.75rem] font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
          >
            {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            さらに読み込む
          </button>
        )}
      </div>
    </>
  );
}
