import type {
  AdminInsightsBlockedActionRow,
  AdminInsightsRangeDays,
  AdminInsightsTrendPoint,
} from '@/types/files';

/**
 * Pure helpers for the admin insights dashboard.
 *
 * Keeping range parsing, blocked-action grouping, chart geometry and
 * drill-down URLs here makes the admin console contract testable without
 * rendering React.
 */

export const ADMIN_INSIGHTS_RANGE_OPTIONS = [7, 30] as const;

export const ADMIN_INSIGHTS_DEFAULT_DAYS: AdminInsightsRangeDays = 7;

export function isAdminInsightsRangeDays(
  value: unknown
): value is AdminInsightsRangeDays {
  return value === 7 || value === 30;
}

/** `/admin/insights?days=30` query tolerance; unknown values fall back to 7. */
export function parseAdminInsightsDays(
  raw: string | string[] | null | undefined
): AdminInsightsRangeDays {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return ADMIN_INSIGHTS_DEFAULT_DAYS;
  const parsed = Number(value);
  return isAdminInsightsRangeDays(parsed)
    ? parsed
    : ADMIN_INSIGHTS_DEFAULT_DAYS;
}

export function buildAdminInsightsQueryString(
  days: AdminInsightsRangeDays
): string {
  return `?days=${days}`;
}

export type AdminInsightsDrilldownKey =
  | 'unsetSharedFiles'
  | 'lockedFiles'
  | 'blockedAudit'
  | 'activeMembers'
  | 'activeGuests'
  | 'publicSharedLinks';

export const ADMIN_INSIGHTS_DRILLDOWN_HREFS: Record<
  AdminInsightsDrilldownKey,
  string
> = {
  unsetSharedFiles: '/admin/content',
  lockedFiles: '/admin/content',
  blockedAudit: '/admin/reports?auditPreset=security',
  activeMembers: '/admin/users',
  activeGuests: '/admin/users',
  publicSharedLinks: '/admin/settings',
};

export function buildAdminInsightsDrilldownHref(
  key: AdminInsightsDrilldownKey
): string {
  return ADMIN_INSIGHTS_DRILLDOWN_HREFS[key];
}

export type AdminInsightsBlockedCategoryKey =
  | 'dlp'
  | 'password'
  | 'domain'
  | 'ip'
  | 'other';

export interface AdminInsightsBlockedCategory {
  key: AdminInsightsBlockedCategoryKey;
  label: string;
  description: string;
  count: number;
  actions: string[];
}

const BLOCKED_CATEGORY_DEFINITIONS: ReadonlyArray<{
  key: Exclude<AdminInsightsBlockedCategoryKey, 'other'>;
  label: string;
  description: string;
  actions: readonly string[];
}> = [
  {
    key: 'dlp',
    label: 'DLP / ダウンロード制限',
    description: '機密区分・権限不足によるコンテンツ遮断',
    actions: [
      'file.content_access_denied',
      'shared_link.download_blocked',
      'shared_link.active_content_blocked',
      'shared_link.download_limit_exceeded',
      'workspace.copy_denied',
      'file_request.blocked_extension',
    ],
  },
  {
    key: 'password',
    label: 'パスワードロックアウト',
    description: '共有リンクのパスワード失敗・一時ロック',
    actions: ['shared_link.password_failed', 'shared_link.password_locked'],
  },
  {
    key: 'domain',
    label: 'ゲストドメイン拒否',
    description: 'SSO / 外部ドメイン許可リスト外の遮断',
    actions: ['auth.sso_domain_blocked', 'auth.sso_required_blocked'],
  },
  {
    key: 'ip',
    label: 'IP ブロック',
    description: 'IP 許可リスト外からの管理アクセス遮断',
    actions: ['auth.ip_blocked'],
  },
];

/**
 * Group raw `audit_logs.action` counts into stable, human-readable risk
 * categories. Unknown blocked actions remain visible under `other` instead of
 * disappearing from the security card.
 */
export function groupAdminInsightsBlockedActions(
  rows: readonly AdminInsightsBlockedActionRow[]
): AdminInsightsBlockedCategory[] {
  const remaining = new Map<string, number>();
  for (const row of rows) {
    remaining.set(
      row.action,
      (remaining.get(row.action) ?? 0) + Math.max(0, row.count)
    );
  }

  const categories: AdminInsightsBlockedCategory[] = BLOCKED_CATEGORY_DEFINITIONS.map(
    (definition) => {
    let count = 0;
    const actions: string[] = [];
    for (const action of definition.actions) {
      const value = remaining.get(action);
      if (value) {
        count += value;
        actions.push(action);
        remaining.delete(action);
      }
    }
    return {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      count,
      actions,
    };
  });

  const otherActions = [...remaining.entries()]
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  categories.push({
    key: 'other',
    label: 'その他のブロック',
    description: '上記カテゴリ以外の拒否イベント',
    count: otherActions.reduce((total, [, count]) => total + count, 0),
    actions: otherActions.map(([action]) => action),
  });

  return categories;
}

export type AdminInsightsTrendMetric =
  | 'activeUsers'
  | 'activeGuests'
  | 'newFiles'
  | 'downloads'
  | 'sharedLinksCreated'
  | 'blockedAudits';

export const ADMIN_INSIGHTS_TREND_SERIES: ReadonlyArray<{
  key: AdminInsightsTrendMetric;
  label: string;
  color: string;
  className: string;
}> = [
  {
    key: 'newFiles',
    label: '新規ファイル',
    color: '#0ea5e9',
    className: 'bg-sky-500',
  },
  {
    key: 'downloads',
    label: 'ダウンロード',
    color: '#10b981',
    className: 'bg-emerald-500',
  },
  {
    key: 'blockedAudits',
    label: 'セキュリティブロック',
    color: '#ef4444',
    className: 'bg-red-500',
  },
];

export const ADMIN_INSIGHTS_CHART_WIDTH = 720;
export const ADMIN_INSIGHTS_CHART_HEIGHT = 180;
export const ADMIN_INSIGHTS_CHART_PADDING = 10;

export function getAdminInsightsTrendValues(
  trends: readonly AdminInsightsTrendPoint[],
  metric: AdminInsightsTrendMetric
): number[] {
  return trends.map((trend) => Math.max(0, trend[metric] ?? 0));
}

export function sumAdminInsightsTrendMetric(
  trends: readonly AdminInsightsTrendPoint[],
  metric: AdminInsightsTrendMetric
): number {
  return trends.reduce(
    (total, trend) => total + Math.max(0, trend[metric] ?? 0),
    0
  );
}

/** Scale non-negative values into 0..1 with a zero-safe denominator. */
export function normalizeAdminInsightsTrendValues(
  values: readonly number[]
): number[] {
  const max = values.reduce(
    (current, value) => Math.max(current, Math.max(0, value)),
    0
  );
  if (max <= 0) return values.map(() => 0);
  return values.map((value) => Math.min(1, Math.max(0, value) / max));
}

/** SVG polyline points for the normalised series (padding keeps strokes visible). */
export function buildAdminInsightsChartPoints(
  values: readonly number[],
  width = ADMIN_INSIGHTS_CHART_WIDTH,
  height = ADMIN_INSIGHTS_CHART_HEIGHT,
  padding = ADMIN_INSIGHTS_CHART_PADDING
): string {
  if (values.length === 0) return '';
  const normalized = normalizeAdminInsightsTrendValues(values);
  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0;

  return normalized
    .map((value, index) => {
      const x = padding + index * step;
      const y = height - padding - value * innerHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
}

/** `2026-11-17` -> `11/17` for compact axis/table labels. */
export function formatAdminInsightsDayLabel(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  return `${Number(match[2])}/${Number(match[3])}`;
}

export interface AdminInsightsTrendTableRow {
  day: string;
  label: string;
  activeUsers: number;
  activeGuests: number;
  newFiles: number;
  downloads: number;
  sharedLinksCreated: number;
  blockedAudits: number;
}

export function buildAdminInsightsTrendTableRows(
  trends: readonly AdminInsightsTrendPoint[]
): AdminInsightsTrendTableRow[] {
  return trends.map((trend) => ({
    day: trend.day,
    label: formatAdminInsightsDayLabel(trend.day),
    activeUsers: Math.max(0, trend.activeUsers),
    activeGuests: Math.max(0, trend.activeGuests),
    newFiles: Math.max(0, trend.newFiles),
    downloads: Math.max(0, trend.downloads),
    sharedLinksCreated: Math.max(0, trend.sharedLinksCreated),
    blockedAudits: Math.max(0, trend.blockedAudits),
  }));
}
