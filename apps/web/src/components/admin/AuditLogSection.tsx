'use client';

import { Download, Loader2 } from 'lucide-react';
import { formatAuditDateTime } from '@/lib/formatters';
import type { AuditLogEntry } from '@/types/files';

export function AuditLogSection({
  auditLogs,
  auditCursor,
  auditActionFilter,
  auditStatusFilter,
  auditLoadingMore,
  onActionFilterChange,
  onStatusFilterChange,
  onLoadMore,
}: {
  auditLogs: AuditLogEntry[];
  auditCursor: { createdAt: string; id: string } | null;
  auditActionFilter: string;
  auditStatusFilter: '' | 'allowed' | 'blocked';
  auditLoadingMore: boolean;
  onActionFilterChange: (value: string) => void;
  onStatusFilterChange: (value: '' | 'allowed' | 'blocked') => void;
  onLoadMore: () => void;
}) {
  const csvQuery = new URLSearchParams({ format: 'csv', limit: '200' });
  if (auditActionFilter.trim()) {
    csvQuery.set('action', auditActionFilter.trim());
  }
  if (auditStatusFilter) {
    csvQuery.set('status', auditStatusFilter);
  }

  return (
    <section className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <h2 className="text-sm font-semibold text-slate-900">
          不変監査ログ (Audit Logs — Keyset Pagination)
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          <input
            id="audit-action-filter"
            name="auditActionFilter"
            aria-label="監査ログのアクションで絞り込む"
            autoComplete="off"
            spellCheck={false}
            type="text"
            value={auditActionFilter}
            onChange={(e) => onActionFilterChange(e.target.value)}
            placeholder="action (例: shared_link.create)"
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <select
            id="audit-status-filter"
            name="auditStatusFilter"
            aria-label="監査ログの結果で絞り込む"
            value={auditStatusFilter}
            onChange={(e) =>
              onStatusFilterChange(
                e.target.value as '' | 'allowed' | 'blocked'
              )
            }
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          >
            <option value="">すべての結果</option>
            <option value="allowed">allowed のみ</option>
            <option value="blocked">blocked のみ</option>
          </select>
          <a
            href={`/api/audit-logs?${csvQuery.toString()}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            <span>CSV 出力</span>
          </a>
        </div>
      </div>

      <div
        role="region"
        aria-label="不変監査ログ"
        tabIndex={0}
        className="overflow-x-auto"
      >
        <table className="w-full text-left text-xs">
          <caption className="sr-only">不変監査ログ</caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-2.5">
                日時 (JST)
              </th>
              <th scope="col" className="px-4 py-2.5">
                アクション
              </th>
              <th scope="col" className="px-4 py-2.5">
                ステータス
              </th>
              <th scope="col" className="px-4 py-2.5">
                操作者 / IP
              </th>
              <th scope="col" className="px-4 py-2.5">
                対象
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {auditLogs.map((log) => (
              <tr key={log.id} className="hover:bg-slate-50/70">
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[0.6875rem] text-slate-600">
                  <time dateTime={log.createdAt}>
                    {formatAuditDateTime(log.createdAt)}
                  </time>
                </td>
                <td className="px-4 py-2.5 font-mono text-[0.6875rem] font-medium text-slate-900">
                  {log.action}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${
                      log.status === 'blocked'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-emerald-50 text-emerald-700'
                    }`}
                  >
                    {log.status}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-[0.6875rem] text-slate-600">
                  {log.actorEmail ?? 'anonymous'} ({log.actorIp ?? '—'})
                </td>
                <td className="px-4 py-2.5 font-mono text-[0.6875rem] text-slate-500">
                  {log.targetType ?? '—'}: {log.targetId?.slice(0, 12) ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {auditCursor && (
        <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-center">
          <button
            type="button"
            disabled={auditLoadingMore}
            onClick={onLoadMore}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {auditLoadingMore && (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            <span>ログをさらに読み込む</span>
          </button>
        </div>
      )}
    </section>
  );
}
