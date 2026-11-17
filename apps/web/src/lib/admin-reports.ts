import type {
  AdminReportCadence,
  AdminReportFilterStatus,
  AdminReportFilters,
  AdminReportStatus,
  AdminReportType,
} from '@/types/files';

/**
 * Pure helpers for the P13-3 admin report console and the enhanced audit-log
 * filters. Keeping query construction and form validation here makes both the
 * UI and the Playwright contract unit-testable without rendering React.
 */

export const ADMIN_REPORT_TYPES: readonly AdminReportType[] = [
  'user_activity',
  'shared_links_inventory',
  'access_stats',
  'users_and_guests',
];

export const ADMIN_REPORT_CADENCES: readonly AdminReportCadence[] = [
  'weekly',
  'monthly',
];

export const ADMIN_REPORT_TYPE_LABELS: Record<AdminReportType, string> = {
  user_activity: 'ユーザーアクティビティ',
  shared_links_inventory: '共有リンク棚卸し',
  access_stats: 'アクセス統計',
  users_and_guests: 'メンバー & ゲスト棚卸し',
};

export const ADMIN_REPORT_TYPE_DESCRIPTIONS: Record<AdminReportType, string> = {
  user_activity: '監査ログを期間・操作者・対象で絞り込んだ全件 CSV',
  shared_links_inventory:
    '共有リンクの有効期限・スコープ・権限・DL 数・失効状態の棚卸し',
  access_stats:
    '指定期間の監査ログをリソース単位で閲覧・DL・編集・拒否回数に集計',
  users_and_guests:
    '社内メンバーと外部ゲストのロール・状態・クォータ・使用量の棚卸し',
};

export const ADMIN_REPORT_STATUS_LABELS: Record<AdminReportStatus, string> = {
  queued: '待機中',
  running: '生成中',
  completed: '完了',
  failed: '失敗',
};

export const ADMIN_REPORT_STATUS_BADGE_CLASSES: Record<
  AdminReportStatus,
  string
> = {
  queued: 'bg-slate-100 text-slate-700',
  running: 'bg-sky-100 text-sky-700',
  completed: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
};

export const ADMIN_REPORT_CADENCE_LABELS: Record<
  AdminReportCadence,
  string
> = {
  weekly: '毎週',
  monthly: '毎月',
};

export const ADMIN_REPORT_MAX_RETENTION_DAYS = 365;
export const ADMIN_REPORT_NAME_MAX_LENGTH = 120;
export const ADMIN_REPORT_API_PREFIXES = ['/api/admin/reports/'] as const;

export function isAdminReportType(
  value: unknown
): value is AdminReportType {
  return (
    typeof value === 'string' &&
    (ADMIN_REPORT_TYPES as readonly string[]).includes(value)
  );
}

export function isAdminReportCadence(
  value: unknown
): value is AdminReportCadence {
  return (
    typeof value === 'string' &&
    (ADMIN_REPORT_CADENCES as readonly string[]).includes(value)
  );
}

export function formatAdminReportType(type: AdminReportType): string {
  return ADMIN_REPORT_TYPE_LABELS[type] ?? type;
}

export function formatAdminReportStatus(status: AdminReportStatus): string {
  return ADMIN_REPORT_STATUS_LABELS[status] ?? status;
}

export function adminReportStatusBadgeClass(
  status: AdminReportStatus
): string {
  return ADMIN_REPORT_STATUS_BADGE_CLASSES[status] ?? 'bg-slate-100 text-slate-700';
}

export function formatAdminReportCadence(cadence: AdminReportCadence): string {
  return ADMIN_REPORT_CADENCE_LABELS[cadence] ?? cadence;
}

export function formatAdminReportBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatAdminReportRowCount(count: number): string {
  return `${Number.isFinite(count) ? Math.max(0, count) : 0} 行`;
}

/* ------------------------------------------------------------------ */
/* Audit query + CSV link                                              */
/* ------------------------------------------------------------------ */

export interface AdminAuditQueryInput {
  action?: string;
  actions?: readonly string[];
  actionPrefix?: string;
  actionPrefixes?: readonly string[];
  targetType?: string;
  status?: AdminReportFilterStatus | '';
  actorEmail?: string;
  targetId?: string;
  from?: string;
  to?: string;
  cursorCreatedAt?: string;
  cursorId?: string;
  limit?: number;
  format?: 'csv';
}

/**
 * Single source of truth for `/api/audit-logs` filters. The pagination hook
 * and the immediate CSV link both use this builder so a new filter can never
 * be applied to one path and forgotten on the other.
 */
export function buildAuditLogQueryString(input: AdminAuditQueryInput = {}): string {
  const qs = new URLSearchParams();
  const action = input.action?.trim();
  if (action) qs.set('action', action);
  if (input.actions && input.actions.length > 0) {
    qs.set('actions', input.actions.join(','));
  }
  if (input.actionPrefix?.trim()) {
    qs.set('actionPrefix', input.actionPrefix.trim());
  }
  if (input.actionPrefixes && input.actionPrefixes.length > 0) {
    qs.set('actionPrefixes', input.actionPrefixes.join(','));
  }
  if (input.targetType?.trim()) qs.set('targetType', input.targetType.trim());
  if (input.status) qs.set('status', input.status);
  if (input.actorEmail?.trim()) qs.set('actorEmail', input.actorEmail.trim());
  if (input.targetId?.trim()) qs.set('targetId', input.targetId.trim());
  if (input.from?.trim()) qs.set('from', input.from.trim());
  if (input.to?.trim()) qs.set('to', input.to.trim());
  if (input.cursorCreatedAt) qs.set('cursorCreatedAt', input.cursorCreatedAt);
  if (input.cursorId) qs.set('cursorId', input.cursorId);
  if (input.limit !== undefined) qs.set('limit', String(input.limit));
  if (input.format) qs.set('format', input.format);
  const suffix = qs.toString();
  return suffix ? `?${suffix}` : '';
}

export function buildAuditLogCsvHref(
  input: AdminAuditQueryInput = {},
  limit = 200
): string {
  return `/api/audit-logs${buildAuditLogQueryString({
    ...input,
    limit,
    format: 'csv',
  })}`;
}

/* ------------------------------------------------------------------ */
/* Form validation                                                     */
/* ------------------------------------------------------------------ */

export interface AdminReportFilterFormInput {
  from?: string;
  to?: string;
  actorEmail?: string;
  targetId?: string;
  actionPrefix?: string;
  status?: AdminReportFilterStatus | '';
}

export interface ValidateAdminReportJobInput extends AdminReportFilterFormInput {
  reportType: string;
}

export type AdminReportValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function normalizeDateBoundary(
  raw: string | undefined,
  boundary: 'from' | 'to'
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return boundary === 'from'
      ? `${value}T00:00:00.000Z`
      : `${value}T23:59:59.999Z`;
  }
  return value;
}

function validateFilters(
  input: AdminReportFilterFormInput
): AdminReportValidationResult<AdminReportFilters> {
  const filters: AdminReportFilters = {};
  const from = normalizeDateBoundary(input.from, 'from');
  const to = normalizeDateBoundary(input.to, 'to');

  if (from) {
    if (Number.isNaN(Date.parse(from))) {
      return { ok: false, error: '開始日時は YYYY-MM-DD または ISO 日時で指定してください。' };
    }
    filters.from = from;
  }
  if (to) {
    if (Number.isNaN(Date.parse(to))) {
      return { ok: false, error: '終了日時は YYYY-MM-DD または ISO 日時で指定してください。' };
    }
    filters.to = to;
  }
  if (
    filters.from &&
    filters.to &&
    Date.parse(filters.from) > Date.parse(filters.to)
  ) {
    return { ok: false, error: '開始日時は終了日時以前にしてください。' };
  }

  const actorEmail = input.actorEmail?.trim();
  if (actorEmail) {
    if (actorEmail.length > 254) {
      return { ok: false, error: '操作者メールは 254 文字以内で指定してください。' };
    }
    filters.actorEmail = actorEmail;
  }

  const targetId = input.targetId?.trim();
  if (targetId) {
    if (targetId.length > 200) {
      return { ok: false, error: '対象 ID は 200 文字以内で指定してください。' };
    }
    filters.targetId = targetId;
  }

  const actionPrefix = input.actionPrefix?.trim();
  if (actionPrefix) {
    if (actionPrefix.length > 120) {
      return { ok: false, error: 'アクションプレフィックスは 120 文字以内で指定してください。' };
    }
    filters.actionPrefix = actionPrefix;
  }

  if (input.status) filters.status = input.status;
  return { ok: true, value: filters };
}

export function validateAdminReportJobInput(
  input: ValidateAdminReportJobInput
): AdminReportValidationResult<{
  reportType: AdminReportType;
  filters: AdminReportFilters;
}> {
  if (!isAdminReportType(input.reportType)) {
    return { ok: false, error: 'レポート種別を選択してください。' };
  }
  const filters = validateFilters(input);
  if (!filters.ok) return filters;
  return {
    ok: true,
    value: { reportType: input.reportType, filters: filters.value },
  };
}

export interface AdminReportScheduleFormInput extends AdminReportFilterFormInput {
  name: string;
  reportType: string;
  cadence: string;
  retentionDays: string | number;
}

export function validateAdminReportScheduleInput(
  input: AdminReportScheduleFormInput
): AdminReportValidationResult<{
  name: string;
  reportType: AdminReportType;
  cadence: AdminReportCadence;
  retentionDays: number;
  filters: AdminReportFilters;
}> {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: 'スケジュール名を入力してください。' };
  }
  if (name.length > ADMIN_REPORT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `スケジュール名は ${ADMIN_REPORT_NAME_MAX_LENGTH} 文字以内で指定してください。`,
    };
  }
  if (!isAdminReportType(input.reportType)) {
    return { ok: false, error: 'レポート種別を選択してください。' };
  }
  if (!isAdminReportCadence(input.cadence)) {
    return { ok: false, error: '実行頻度は毎週または毎月を選択してください。' };
  }
  const retentionDays = Number.parseInt(String(input.retentionDays), 10);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > ADMIN_REPORT_MAX_RETENTION_DAYS
  ) {
    return {
      ok: false,
      error: `保存期間は 1〜${ADMIN_REPORT_MAX_RETENTION_DAYS} 日で指定してください。`,
    };
  }
  const filters = validateFilters(input);
  if (!filters.ok) return filters;
  return {
    ok: true,
    value: {
      name,
      reportType: input.reportType,
      cadence: input.cadence,
      retentionDays,
      filters: filters.value,
    },
  };
}

/** Human-readable summary used in the job history table. */
export function describeAdminReportFilters(filters: AdminReportFilters): string {
  const parts: string[] = [];
  if (filters.from || filters.to) {
    parts.push(
      `${filters.from?.slice(0, 10) || '…'} 〜 ${filters.to?.slice(0, 10) || '…'}`
    );
  }
  if (filters.actorEmail) parts.push(`actor: ${filters.actorEmail}`);
  if (filters.targetId) parts.push(`target: ${filters.targetId}`);
  if (filters.status) parts.push(filters.status);
  if (filters.actionPrefix) parts.push(`prefix: ${filters.actionPrefix}`);
  return parts.length > 0 ? parts.join(' / ') : '全期間・全対象';
}
