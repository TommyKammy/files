'use client';

import { Download, Loader2, RefreshCw } from 'lucide-react';
import {
  buildAdminTrashAuditCsvHref,
  formatAdminTrashAuditEntry,
} from '@/lib/admin-trash';
import type { useAdminTrash } from '@/lib/use-admin-trash';

interface TrashAuditTimelineProps {
  auditLogs: ReturnType<typeof useAdminTrash>['auditLogs'];
  timelineEntries: ReturnType<typeof formatAdminTrashAuditEntry>[];
  auditHasMore: boolean;
  auditLoading: boolean;
  auditLoadingMore: boolean;
  onRefresh: () => void;
  onLoadMore: () => void;
}

/** Audit timeline table for admin trash restore and purge actions. */
export function TrashAuditTimeline({
  auditLogs,
  timelineEntries,
  auditHasMore,
  auditLoading,
  auditLoadingMore,
  onRefresh,
  onLoadMore,
}: TrashAuditTimelineProps) {
  return (
    <div className="border-t border-slate-200 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[0.8125rem] font-semibold text-slate-900">
            復元・完全削除監査タイムライン
          </h3>
          <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
            復元・完全削除の 7 アクションを JST で表示します。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={auditLoading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${auditLoading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            監査を更新
          </button>
          <a
            href={buildAdminTrashAuditCsvHref()}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            CSV 出力
          </a>
        </div>
      </div>

      <div
        role="region"
        aria-label="復元・完全削除監査タイムライン"
        tabIndex={0}
        className="mt-3 overflow-x-auto rounded-md border border-slate-200"
      >
        <table className="w-full min-w-[62rem] text-left text-xs">
          <caption className="sr-only">
            復元・完全削除監査タイムライン
          </caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2">
                日時 (JST)
              </th>
              <th scope="col" className="px-3 py-2">
                アクション
              </th>
              <th scope="col" className="px-3 py-2">
                対象名
              </th>
              <th scope="col" className="px-3 py-2">
                バージョン
              </th>
              <th scope="col" className="px-3 py-2">
                復元先
              </th>
              <th scope="col" className="px-3 py-2">
                実行者
              </th>
              <th scope="col" className="px-3 py-2">
                代理対象 / 所有者
              </th>
              <th scope="col" className="px-3 py-2">
                詳細
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {timelineEntries.map((entry, index) => (
              <tr
                key={`${auditLogs[index]?.id ?? entry.action}-${index}`}
                className="hover:bg-slate-50/70"
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[0.625rem] text-slate-500">
                  <time dateTime={auditLogs[index]?.createdAt}>
                    {entry.dateLabel}
                  </time>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[0.6875rem] font-medium text-slate-900">
                  {entry.actionLabel}
                </td>
                <td className="max-w-[14rem] px-3 py-2 align-top text-[0.6875rem] text-slate-700">
                  <span className="line-clamp-2" title={entry.targetName}>
                    {entry.targetName}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-[0.625rem] text-slate-500">
                  {entry.sourceVersion}
                </td>
                <td className="max-w-[14rem] px-3 py-2 align-top text-[0.6875rem] text-slate-600">
                  <span className="line-clamp-2" title={entry.restoredTo}>
                    {entry.restoredTo}
                  </span>
                </td>
                <td className="max-w-[13rem] px-3 py-2 align-top text-[0.6875rem] text-slate-600">
                  <span className="line-clamp-2" title={entry.actorEmail}>
                    {entry.actorEmail}
                  </span>
                </td>
                <td className="max-w-[14rem] px-3 py-2 align-top text-[0.6875rem] text-slate-600">
                  <span className="line-clamp-2" title={entry.onBehalfOf}>
                    {entry.onBehalfOf}
                  </span>
                </td>
                <td className="max-w-[12rem] px-3 py-2 align-top text-[0.625rem] text-slate-500">
                  {entry.detail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!auditLoading && timelineEntries.length === 0 ? (
        <p className="mt-3 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-4 text-center text-[0.75rem] text-[#55565a]">
          復元・完全削除の監査ログはまだありません。
        </p>
      ) : null}

      {auditHasMore ? (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={auditLoadingMore}
            className="inline-flex h-7 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {auditLoadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            監査ログをさらに読み込む
          </button>
        </div>
      ) : null}
    </div>
  );
}
