'use client';

import {
  ArrowUpRight,
  BarChart3,
  FileWarning,
  Link2,
  Loader2,
  Lock,
  ShieldAlert,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { StorageStatsSection } from '@/components/admin/StorageStatsSection';
import {
  ADMIN_INSIGHTS_CHART_HEIGHT,
  ADMIN_INSIGHTS_CHART_WIDTH,
  ADMIN_INSIGHTS_RANGE_OPTIONS,
  ADMIN_INSIGHTS_TREND_SERIES,
  buildAdminInsightsChartPoints,
  buildAdminInsightsDrilldownHref,
  buildAdminInsightsTrendTableRows,
  formatAdminInsightsDayLabel,
  getAdminInsightsTrendValues,
  groupAdminInsightsBlockedActions,
  sumAdminInsightsTrendMetric,
} from '@/lib/admin-insights';
import type {
  AdminInsightsRangeDays,
  AdminInsightsResponse,
  StorageStatsResponse,
} from '@/types/files';

interface KpiCard {
  testId: string;
  label: string;
  value: number;
  hint: string;
  href: string;
  tone: string;
  icon: typeof ShieldAlert;
}

function buildKpiCards(insights: AdminInsightsResponse): KpiCard[] {
  return [
    {
      testId: 'insights-kpi-unset-shared',
      label: '未分類の共有リスク',
      value: insights.security.unsetSharedFilesCount,
      hint: 'unset のまま共有リンクが有効なファイル',
      href: buildAdminInsightsDrilldownHref('unsetSharedFiles'),
      tone: 'border-amber-200 bg-amber-50 text-amber-700',
      icon: FileWarning,
    },
    {
      testId: 'insights-kpi-locked',
      label: 'ロック中ファイル',
      value: insights.security.activeFileLocksCount,
      hint: 'WOPI / デスクトップ排他ロック',
      href: buildAdminInsightsDrilldownHref('lockedFiles'),
      tone: 'border-sky-200 bg-sky-50 text-sky-700',
      icon: Lock,
    },
    {
      testId: 'insights-kpi-blocked',
      label: `セキュリティブロック (${insights.rangeDays}日)`,
      value: insights.security.blockedRecentCount,
      hint: 'DLP・パスワード・ドメイン・IP 遮断',
      href: buildAdminInsightsDrilldownHref('blockedAudit'),
      tone: 'border-red-200 bg-red-50 text-red-700',
      icon: ShieldAlert,
    },
    {
      testId: 'insights-kpi-public-links',
      label: '公開共有リンク',
      value: insights.security.publicSharedLinksCount,
      hint: 'アクティブな public リンク',
      href: buildAdminInsightsDrilldownHref('publicSharedLinks'),
      tone: 'border-rose-200 bg-rose-50 text-rose-700',
      icon: Link2,
    },
    {
      testId: 'insights-kpi-active-links',
      label: '有効な共有リンク',
      value: insights.security.activeSharedLinksCount,
      hint: '失効・期限切れを除く総数',
      href: buildAdminInsightsDrilldownHref('publicSharedLinks'),
      tone: 'border-indigo-200 bg-indigo-50 text-indigo-700',
      icon: Link2,
    },
    {
      testId: 'insights-kpi-members',
      label: 'アクティブメンバー',
      value: insights.collaboration.activeMembers,
      hint: `停止中 ${insights.collaboration.suspendedMembers} 名`,
      href: buildAdminInsightsDrilldownHref('activeMembers'),
      tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      icon: Users,
    },
    {
      testId: 'insights-kpi-guests',
      label: 'アクティブゲスト',
      value: insights.collaboration.activeGuests,
      hint: `72時間以内に期限 ${insights.collaboration.expiringGuests72h} 名`,
      href: buildAdminInsightsDrilldownHref('activeGuests'),
      tone: 'border-violet-200 bg-violet-50 text-violet-700',
      icon: Users,
    },
    {
      testId: 'insights-kpi-sessions',
      label: '有効セッション',
      value: insights.collaboration.activeSessionsCount,
      hint: `${insights.collaboration.groupsCount} グループ`,
      href: buildAdminInsightsDrilldownHref('activeMembers'),
      tone: 'border-slate-200 bg-slate-50 text-slate-700',
      icon: Users,
    },
  ];
}

export function AdminInsightsDashboardSection({
  insights,
  stats,
  usedPct,
  days,
  loading,
  onDaysChange,
}: {
  insights: AdminInsightsResponse | null;
  stats: StorageStatsResponse | null;
  usedPct: number;
  days: AdminInsightsRangeDays;
  loading: boolean;
  onDaysChange: (days: AdminInsightsRangeDays) => void;
}) {
  const effectiveStats = stats ?? insights?.storage ?? null;
  const kpiCards = insights ? buildKpiCards(insights) : [];
  const blockedCategories = insights
    ? groupAdminInsightsBlockedActions(insights.security.blockedByAction)
    : [];
  const trendRows = insights
    ? buildAdminInsightsTrendTableRows(insights.trends)
    : [];
  const trendTotals = insights
    ? {
        newFiles: sumAdminInsightsTrendMetric(insights.trends, 'newFiles'),
        downloads: sumAdminInsightsTrendMetric(insights.trends, 'downloads'),
        blocked: sumAdminInsightsTrendMetric(insights.trends, 'blockedAudits'),
      }
    : { newFiles: 0, downloads: 0, blocked: 0 };
  const blockedMax = blockedCategories.reduce(
    (max, category) => Math.max(max, category.count),
    0
  );
  const firstDay = insights?.trends[0]?.day;
  const lastDay = insights?.trends[insights.trends.length - 1]?.day;

  return (
    <section
      aria-labelledby="admin-insights-heading"
      data-testid="admin-insights-dashboard"
      className="space-y-4"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="admin-insights-heading"
            className="text-sm font-semibold text-slate-900"
          >
            組織インサイト
          </h2>
          <p className="text-[0.6875rem] text-[#55565a]">
            事前集計 (`tenant_daily_insights`) と O(1) 統計のみで利用状況とリスクを表示します。
          </p>
        </div>
        <div
          role="group"
          aria-label="インサイトの集計期間"
          className="inline-flex items-center rounded-lg border border-[#e1e1e4] bg-white p-0.5"
        >
          {loading && (
            <span
              data-testid="insights-refreshing"
              className="mr-1 inline-flex items-center gap-1 px-1 text-[0.625rem] text-slate-500"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              更新中
            </span>
          )}
          {ADMIN_INSIGHTS_RANGE_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`insights-range-${option}`}
              aria-pressed={days === option}
              onClick={() => onDaysChange(option)}
              className={`rounded-md px-3 py-1 text-[0.75rem] font-medium transition ${
                days === option
                  ? 'bg-[#5e6ad2] text-white'
                  : 'text-[#3c3f46] hover:bg-[#f2f2f4]'
              }`}
            >
              {option}日間
            </button>
          ))}
        </div>
      </div>

      {effectiveStats && (
        <StorageStatsSection stats={effectiveStats} usedPct={usedPct} />
      )}

      {loading && !insights && (
        <div
          role="status"
          data-testid="insights-loading"
          className="flex min-h-[7rem] items-center justify-center gap-2 rounded-2xl border border-[#e7e7ea] bg-white px-5 py-6 text-[0.75rem] text-[#55565a]"
        >
          <Loader2 className="h-4 w-4 animate-spin text-[#5e6ad2]" />
          <span>インサイトを読み込み中...</span>
        </div>
      )}

      {insights && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {kpiCards.map((card) => {
              const Icon = card.icon;
              return (
                <Link
                  key={card.testId}
                  href={card.href}
                  data-testid={card.testId}
                  className="group flex flex-col justify-between rounded-xl border border-[#e7e7ea] bg-white p-4 transition hover:-translate-y-0.5 hover:border-[#c7c9f2] hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${card.tone}`}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <ArrowUpRight className="h-4 w-4 text-slate-300 transition group-hover:text-[#5e6ad2]" />
                  </div>
                  <p className="mt-3 text-[0.6875rem] font-medium text-[#55565a]">
                    {card.label}
                  </p>
                  <p className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-slate-900">
                    {card.value.toLocaleString('ja-JP')}
                  </p>
                  <p className="mt-1 text-[0.625rem] text-slate-500">
                    {card.hint}
                  </p>
                </Link>
              );
            })}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div
              data-testid="insights-blocked-breakdown"
              className="rounded-lg border border-[#e7e7ea] bg-white p-5 xl:col-span-1"
            >
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-red-500" />
                <h3 className="text-sm font-semibold text-slate-900">
                  ブロック監査アクション内訳
                </h3>
              </div>
              <p className="mt-1 text-[0.6875rem] text-[#55565a]">
                {insights.rangeDays}日間 / 合計{' '}
                {insights.security.blockedRecentCount.toLocaleString('ja-JP')} 件
              </p>
              <dl className="mt-4 space-y-3">
                {blockedCategories.map((category) => {
                  const widthPct =
                    blockedMax > 0 ? (category.count / blockedMax) * 100 : 0;
                  return (
                    <div
                      key={category.key}
                      data-testid={`insights-blocked-${category.key}`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <dt className="text-[0.75rem] font-medium text-slate-800">
                          {category.label}
                        </dt>
                        <dd className="font-mono text-[0.75rem] tabular-nums text-slate-600">
                          {category.count.toLocaleString('ja-JP')}
                        </dd>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-red-400"
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[0.625rem] text-slate-400">
                        {category.description}
                      </p>
                    </div>
                  );
                })}
              </dl>
            </div>

            <div className="rounded-lg border border-[#e7e7ea] bg-white p-5 xl:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-[#5e6ad2]" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    日次トレンド
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {ADMIN_INSIGHTS_TREND_SERIES.map((series) => (
                    <span
                      key={series.key}
                      className="inline-flex items-center gap-1 text-[0.625rem] text-slate-500"
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${series.className}`}
                      />
                      {series.label}
                    </span>
                  ))}
                </div>
              </div>

              <svg
                data-testid="insights-trend-chart"
                role="img"
                aria-label={`${insights.rangeDays}日間の日次トレンド`}
                viewBox={`0 0 ${ADMIN_INSIGHTS_CHART_WIDTH} ${ADMIN_INSIGHTS_CHART_HEIGHT}`}
                preserveAspectRatio="none"
                className="mt-3 h-44 w-full overflow-visible"
              >
                {[0.25, 0.5, 0.75].map((ratio) => (
                  <line
                    key={ratio}
                    x1={0}
                    x2={ADMIN_INSIGHTS_CHART_WIDTH}
                    y1={ADMIN_INSIGHTS_CHART_HEIGHT * ratio}
                    y2={ADMIN_INSIGHTS_CHART_HEIGHT * ratio}
                    stroke="#eef0f4"
                    strokeWidth={1}
                  />
                ))}
                {ADMIN_INSIGHTS_TREND_SERIES.map((series) => {
                  const points = buildAdminInsightsChartPoints(
                    getAdminInsightsTrendValues(insights.trends, series.key)
                  );
                  return (
                    <polyline
                      key={series.key}
                      data-testid={`insights-trend-line-${series.key}`}
                      points={points}
                      fill="none"
                      stroke={series.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  );
                })}
              </svg>
              <div className="mt-1 flex justify-between text-[0.625rem] text-slate-400">
                <span>{firstDay ? formatAdminInsightsDayLabel(firstDay) : ''}</span>
                <span>{lastDay ? formatAdminInsightsDayLabel(lastDay) : ''}</span>
              </div>
              <p className="mt-2 text-[0.625rem] text-slate-500">
                {insights.rangeDays}日合計: 新規 {trendTotals.newFiles.toLocaleString('ja-JP')} / DL{' '}
                {trendTotals.downloads.toLocaleString('ja-JP')} / ブロック{' '}
                {trendTotals.blocked.toLocaleString('ja-JP')}
              </p>

              <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-slate-100">
                <table
                  data-testid="insights-trend-table"
                  className="w-full border-collapse text-left text-[0.6875rem]"
                >
                  <caption className="sr-only">
                    {insights.rangeDays}日間の日次利用・セキュリティトレンド
                  </caption>
                  <thead className="sticky top-0 bg-slate-50 text-slate-500">
                    <tr>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        日付
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        メンバー
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        ゲスト
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        新規
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        DL
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        共有
                      </th>
                      <th scope="col" className="px-2 py-1.5 font-medium">
                        ブロック
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {trendRows.map((row) => (
                      <tr
                        key={row.day}
                        data-testid="insights-trend-row"
                        className="border-t border-slate-100 tabular-nums text-slate-600"
                      >
                        <th
                          scope="row"
                          className="whitespace-nowrap px-2 py-1.5 font-medium text-slate-700"
                        >
                          {row.label}
                        </th>
                        <td className="px-2 py-1.5">{row.activeUsers}</td>
                        <td className="px-2 py-1.5">{row.activeGuests}</td>
                        <td className="px-2 py-1.5">{row.newFiles}</td>
                        <td className="px-2 py-1.5">{row.downloads}</td>
                        <td className="px-2 py-1.5">{row.sharedLinksCreated}</td>
                        <td className="px-2 py-1.5">{row.blockedAudits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
