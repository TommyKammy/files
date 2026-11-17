'use client';

import { Download, Loader2, X } from 'lucide-react';
import {
  formatAuditActionLabel,
  isGuestAuditAction,
  isPermissionAuditAction,
  isRootFolderAuditAction,
} from '@/lib/admin-audit';
import { buildAuditLogCsvHref } from '@/lib/admin-reports';
import { formatAuditDateTime } from '@/lib/formatters';
import type { AuditLogEntry } from '@/types/files';

export function AuditLogSection({
  auditLogs,
  auditCursor,
  auditActionFilter,
  auditActionPrefixFilter = '',
  auditActionPrefixes = [],
  auditPresetKind = null,
  auditTargetType = '',
  auditStatusFilter,
  auditActorEmailFilter = '',
  auditTargetIdFilter = '',
  auditFromFilter = '',
  auditToFilter = '',
  auditLoadingMore,
  auditPresetActions = [],
  onActionFilterChange,
  onActionPrefixFilterChange,
  onTargetTypeChange,
  onStatusFilterChange,
  onActorEmailFilterChange,
  onTargetIdFilterChange,
  onFromFilterChange,
  onToFilterChange,
  onClearFilters,
  onLoadMore,
  onClearPreset,
  onClearPrefixPreset,
}: {
  auditLogs: AuditLogEntry[];
  auditCursor: { createdAt: string; id: string } | null;
  auditActionFilter: string;
  auditActionPrefixFilter?: string;
  auditActionPrefixes?: readonly string[];
  auditPresetKind?: 'permission' | 'guest' | 'user' | 'security' | null;
  auditTargetType?: string;
  auditStatusFilter: '' | 'allowed' | 'blocked';
  auditActorEmailFilter?: string;
  auditTargetIdFilter?: string;
  auditFromFilter?: string;
  auditToFilter?: string;
  auditLoadingMore: boolean;
  auditPresetActions?: readonly string[];
  onActionFilterChange: (value: string) => void;
  onActionPrefixFilterChange?: (value: string) => void;
  onTargetTypeChange?: (value: string) => void;
  onStatusFilterChange: (value: '' | 'allowed' | 'blocked') => void;
  onActorEmailFilterChange?: (value: string) => void;
  onTargetIdFilterChange?: (value: string) => void;
  onFromFilterChange?: (value: string) => void;
  onToFilterChange?: (value: string) => void;
  onClearFilters?: () => void;
  onLoadMore: () => void;
  onClearPreset?: () => void;
  onClearPrefixPreset?: () => void;
}) {
  const activePrefixes = [
    ...auditActionPrefixes,
    ...(auditActionPrefixFilter.trim()
      ? [auditActionPrefixFilter.trim()]
      : []),
  ].filter(Boolean);
  const prefixHighlight = auditActionPrefixes.length > 0;
  const csvHref = buildAuditLogCsvHref({
    action: auditActionFilter,
    actionPrefixes: activePrefixes,
    targetType: auditTargetType,
    status: auditStatusFilter,
    actorEmail: auditActorEmailFilter,
    targetId: auditTargetIdFilter,
    from: auditFromFilter,
    to: auditToFilter,
  });

  return (
    <section
      id="admin-audit-logs"
      aria-labelledby="admin-audit-logs-heading"
      className="scroll-mt-6 overflow-hidden rounded-lg border border-[#e7e7ea] bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <h2
          id="admin-audit-logs-heading"
          className="text-sm font-semibold text-slate-900"
        >
          不変監査ログ (Audit Logs — Keyset Pagination)
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {auditPresetActions.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[0.6875rem] font-medium text-blue-800">
              <span>
                {auditPresetKind === 'security'
                  ? 'セキュリティブロック監査のみ'
                  : 'ルートフォルダ監査のみ'}
              </span>
              {onClearPreset && (
                <button
                  type="button"
                  aria-label="監査ログのプリセット絞り込みを解除"
                  onClick={onClearPreset}
                  className="rounded-full p-0.5 hover:bg-blue-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          )}
          {prefixHighlight && (
            <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[0.6875rem] font-medium text-indigo-800">
              <span>
                {auditPresetKind === 'guest'
                  ? 'ゲスト監査のみ'
                  : auditPresetKind === 'user'
                    ? 'メンバー監査のみ'
                    : '権限監査のみ'}
              </span>
              {onClearPrefixPreset && (
                <button
                  type="button"
                  aria-label={
                    auditPresetKind === 'guest'
                      ? 'ゲスト監査ログのプレフィックス絞り込みを解除'
                      : auditPresetKind === 'user'
                        ? 'メンバー監査ログのプレフィックス絞り込みを解除'
                        : '権限監査ログのプレフィックス絞り込みを解除'
                  }
                  onClick={onClearPrefixPreset}
                  className="rounded-full p-0.5 hover:bg-indigo-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          )}
          <input
            id="audit-from-filter"
            name="auditFromFilter"
            aria-label="監査ログの開始日で絞り込む"
            type="date"
            value={auditFromFilter}
            onChange={(e) => onFromFilterChange?.(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <input
            id="audit-to-filter"
            name="auditToFilter"
            aria-label="監査ログの終了日で絞り込む"
            type="date"
            value={auditToFilter}
            onChange={(e) => onToFilterChange?.(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <input
            id="audit-actor-email-filter"
            name="auditActorEmailFilter"
            aria-label="監査ログの操作者メールで絞り込む"
            autoComplete="off"
            spellCheck={false}
            type="email"
            value={auditActorEmailFilter}
            onChange={(e) => onActorEmailFilterChange?.(e.target.value)}
            placeholder="actorEmail (例: user@example.com)"
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <input
            id="audit-target-id-filter"
            name="auditTargetIdFilter"
            aria-label="監査ログの対象 ID で絞り込む"
            autoComplete="off"
            spellCheck={false}
            type="text"
            value={auditTargetIdFilter}
            onChange={(e) => onTargetIdFilterChange?.(e.target.value)}
            placeholder="targetId"
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
          <input
            id="audit-action-prefix-filter"
            name="auditActionPrefixFilter"
            aria-label="監査ログのアクションプレフィックスで絞り込む"
            autoComplete="off"
            spellCheck={false}
            type="text"
            value={auditActionPrefixFilter}
            onChange={(e) => onActionPrefixFilterChange?.(e.target.value)}
            placeholder="actionPrefix (例: permission.,admin.root_folder.)"
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          />
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
            id="audit-target-type-filter"
            name="auditTargetType"
            aria-label="監査ログの対象種別で絞り込む"
            value={auditTargetType}
            onChange={(e) => onTargetTypeChange?.(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs"
          >
            <option value="">すべての対象</option>
            <option value="folder">フォルダ</option>
            <option value="file">ファイル</option>
            <option value="permission">権限</option>
            <option value="guest_invitation">ゲスト招待</option>
            <option value="user">ユーザー / ゲスト</option>
          </select>
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
          {onClearFilters && (
            <button
              type="button"
              data-testid="audit-clear-filters"
              onClick={onClearFilters}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <X className="h-3.5 w-3.5" />
              <span>フィルタをクリア</span>
            </button>
          )}
          <a
            href={csvHref}
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
              <tr
                key={log.id}
                className={`hover:bg-slate-50/70 ${
                  auditPresetActions.length > 0 &&
                  isRootFolderAuditAction(log.action)
                    ? 'bg-blue-50/40'
                    : prefixHighlight && isPermissionAuditAction(log.action)
                      ? 'bg-indigo-50/40'
                      : prefixHighlight && isGuestAuditAction(log.action)
                        ? 'bg-emerald-50/40'
                        : ''
                }`}
              >
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[0.6875rem] text-slate-600">
                  <time dateTime={log.createdAt}>
                    {formatAuditDateTime(log.createdAt)}
                  </time>
                </td>
                <td className="px-4 py-2.5">
                  <span className="block font-mono text-[0.6875rem] font-medium text-slate-900">
                    {log.action}
                  </span>
                  <span className="mt-0.5 block text-[0.625rem] text-slate-500">
                    {formatAuditActionLabel(log.action)}
                  </span>
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
