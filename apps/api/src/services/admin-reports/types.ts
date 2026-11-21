import {
  isValidAuditTimeBoundary,
  normalizeAuditTimeBoundary,
} from '../audit-filters';

export const REPORT_CHUNK_SIZE = 200;
export const ADMIN_REPORT_MAX_ROWS = 10_000;
export const ADMIN_REPORT_DEFAULT_RETENTION_DAYS = 30;
export const ADMIN_REPORT_MAX_RETENTION_DAYS = 365;
export const ADMIN_REPORT_SCHEDULE_BATCH_LIMIT = 50;

export type AdminReportType =
  | 'user_activity'
  | 'shared_links_inventory'
  | 'access_stats'
  | 'users_and_guests';

export type AdminReportStatus = 'queued' | 'running' | 'completed' | 'failed';
export type AdminReportCadence = 'weekly' | 'monthly';
export type AdminReportFilterStatus = 'allowed' | 'blocked';

export interface AdminReportFilters {
  from?: string;
  to?: string;
  actorEmail?: string;
  targetId?: string;
  targetType?: string;
  status?: AdminReportFilterStatus;
  actionPrefix?: string;
}

export interface AdminReportJobRecord {
  id: string;
  tenantId: string;
  scheduleId: string | null;
  reportType: AdminReportType;
  status: AdminReportStatus;
  filters: AdminReportFilters;
  r2ObjectKey: string | null;
  rowCount: number;
  byteSize: number;
  errorMessage: string | null;
  createdBy: string;
  createdByEmail: string | null;
  expiresAt: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminReportScheduleRecord {
  id: string;
  tenantId: string;
  name: string;
  reportType: AdminReportType;
  cadence: AdminReportCadence;
  enabled: boolean;
  filters: AdminReportFilters;
  retentionDays: number;
  nextRunAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class AdminReportsError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly code = 'INVALID_REPORT_REQUEST'
  ) {
    super(message);
    this.name = 'AdminReportsError';
  }
}

const ADMIN_REPORT_TYPES: readonly AdminReportType[] = [
  'user_activity',
  'shared_links_inventory',
  'access_stats',
  'users_and_guests',
];

const ADMIN_REPORT_CADENCES: readonly AdminReportCadence[] = [
  'weekly',
  'monthly',
];

export function isAdminReportType(value: unknown): value is AdminReportType {
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

export function isAdminReportFilterStatus(
  value: unknown
): value is AdminReportFilterStatus {
  return value === 'allowed' || value === 'blocked';
}

function readString(value: unknown, maxLength = 254): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Parse and normalize the additive report filter contract. */
export function normalizeAdminReportFilters(
  raw: unknown
): AdminReportFilters {
  const input = readObject(raw);
  const filters: AdminReportFilters = {};

  const fromRaw =
    readString(input.from, 40) ?? readString(input.fromDate, 40);
  const toRaw = readString(input.to, 40) ?? readString(input.toDate, 40);
  const from = normalizeAuditTimeBoundary(fromRaw, 'from');
  const to = normalizeAuditTimeBoundary(toRaw, 'to');
  if (from) {
    if (!isValidAuditTimeBoundary(from)) {
      throw new AdminReportsError(
        'from must be an ISO timestamp or YYYY-MM-DD',
        400,
        'INVALID_REPORT_FILTER'
      );
    }
    filters.from = from;
  }
  if (to) {
    if (!isValidAuditTimeBoundary(to)) {
      throw new AdminReportsError(
        'to must be an ISO timestamp or YYYY-MM-DD',
        400,
        'INVALID_REPORT_FILTER'
      );
    }
    filters.to = to;
  }
  if (
    filters.from &&
    filters.to &&
    Date.parse(filters.from) > Date.parse(filters.to)
  ) {
    throw new AdminReportsError(
      'from must be earlier than or equal to to',
      400,
      'INVALID_REPORT_FILTER'
    );
  }

  const actorEmail = readString(input.actorEmail ?? input.actor_email, 254);
  if (actorEmail) filters.actorEmail = actorEmail;

  const targetId = readString(input.targetId ?? input.target_id, 200);
  if (targetId) filters.targetId = targetId;

  const targetType = readString(input.targetType ?? input.target_type, 50);
  if (targetType) filters.targetType = targetType;

  const status = input.status;
  if (status !== undefined && status !== null && status !== '') {
    if (!isAdminReportFilterStatus(status)) {
      throw new AdminReportsError(
        'status must be allowed or blocked',
        400,
        'INVALID_REPORT_FILTER'
      );
    }
    filters.status = status;
  }

  const actionPrefix = readString(
    input.actionPrefix ?? input.action_prefix,
    120
  );
  if (actionPrefix) filters.actionPrefix = actionPrefix;

  return filters;
}

export function parseAdminReportRetentionDays(
  raw: unknown,
  fallback = ADMIN_REPORT_DEFAULT_RETENTION_DAYS
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value =
    typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > ADMIN_REPORT_MAX_RETENTION_DAYS
  ) {
    throw new AdminReportsError(
      `retentionDays must be an integer between 1 and ${ADMIN_REPORT_MAX_RETENTION_DAYS}`,
      400,
      'INVALID_REPORT_RETENTION'
    );
  }
  return value;
}

export function computeExpiresAt(
  nowIso: string,
  retentionDays: number
): string {
  const nowMs = Date.parse(nowIso);
  const base = Number.isFinite(nowMs) ? nowMs : Date.now();
  return new Date(base + retentionDays * 86_400_000).toISOString();
}

/** Add one cadence period while keeping the original UTC day-of-month. */
function addAdminReportCadence(
  iso: string,
  cadence: AdminReportCadence
): string {
  if (cadence === 'weekly') {
    return new Date(Date.parse(iso) + 7 * 86_400_000).toISOString();
  }
  const source = new Date(iso);
  const day = source.getUTCDate();
  source.setUTCDate(1);
  source.setUTCMonth(source.getUTCMonth() + 1);
  const daysInMonth = new Date(
    Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + 1, 0)
  ).getUTCDate();
  source.setUTCDate(Math.min(day, daysInMonth));
  return source.toISOString();
}

export function computeNextAdminReportRun(
  nowIso: string,
  cadence: AdminReportCadence
): string {
  return addAdminReportCadence(nowIso, cadence);
}

/**
 * Advance a due schedule past `nowIso`. A long Cron outage may leave the
 * stored date several periods behind; skip forward instead of immediately
 * producing a burst of identical exports.
 */
export function advanceAdminReportNextRun(
  currentIso: string,
  cadence: AdminReportCadence,
  nowIso: string
): string {
  let next = addAdminReportCadence(currentIso, cadence);
  let guard = 0;
  while (next <= nowIso && guard < 120) {
    next = addAdminReportCadence(next, cadence);
    guard += 1;
  }
  return next;
}

export interface AdminReportJobRow {
  id: string;
  tenant_id: string;
  schedule_id: string | null;
  report_type: AdminReportType;
  status: AdminReportStatus;
  filters_json: string;
  r2_object_key: string | null;
  row_count: number;
  byte_size: number;
  error_message: string | null;
  created_by: string;
  created_by_email: string | null;
  expires_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminReportScheduleRow {
  id: string;
  tenant_id: string;
  name: string;
  report_type: AdminReportType;
  cadence: AdminReportCadence;
  enabled: number;
  filters_json: string;
  retention_days: number;
  next_run_at: string;
  last_run_at: string | null;
  last_job_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function safeParseFilters(raw: string | null): AdminReportFilters {
  if (!raw) return {};
  try {
    return normalizeAdminReportFilters(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function rowToAdminReportJob(
  row: AdminReportJobRow
): AdminReportJobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scheduleId: row.schedule_id,
    reportType: row.report_type,
    status: row.status,
    filters: safeParseFilters(row.filters_json),
    r2ObjectKey: row.r2_object_key,
    rowCount: row.row_count,
    byteSize: row.byte_size,
    errorMessage: row.error_message,
    createdBy: row.created_by,
    createdByEmail: row.created_by_email,
    expiresAt: row.expires_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToAdminReportSchedule(
  row: AdminReportScheduleRow
): AdminReportScheduleRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    reportType: row.report_type,
    cadence: row.cadence,
    enabled: row.enabled === 1,
    filters: safeParseFilters(row.filters_json),
    retentionDays: row.retention_days,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastJobId: row.last_job_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface BuildAdminReportJobInput {
  tenantId: string;
  scheduleId?: string | null;
  reportType: AdminReportType;
  filters?: AdminReportFilters;
  retentionDays?: number;
  createdBy: string;
  createdByEmail: string | null;
  nowIso: string;
  id?: string;
}

export function buildAdminReportJobInsertStatement(
  db: D1Database,
  input: BuildAdminReportJobInput
): { statement: D1PreparedStatement; job: AdminReportJobRecord } {
  const id = input.id ?? crypto.randomUUID();
  const retentionDays =
    input.retentionDays ?? ADMIN_REPORT_DEFAULT_RETENTION_DAYS;
  const expiresAt = computeExpiresAt(input.nowIso, retentionDays);
  const filters = input.filters ?? {};
  const statement = db
    .prepare(
      `INSERT INTO admin_report_jobs (
         id, tenant_id, schedule_id, report_type, status, filters_json,
         r2_object_key, row_count, byte_size, error_message, created_by,
         created_by_email, expires_at, started_at, completed_at, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 'queued', ?, NULL, 0, 0, NULL, ?, ?, ?, NULL, NULL, ?, ?)`
    )
    .bind(
      id,
      input.tenantId,
      input.scheduleId ?? null,
      input.reportType,
      JSON.stringify(filters),
      input.createdBy,
      input.createdByEmail,
      expiresAt,
      input.nowIso,
      input.nowIso
    );

  return {
    statement,
    job: {
      id,
      tenantId: input.tenantId,
      scheduleId: input.scheduleId ?? null,
      reportType: input.reportType,
      status: 'queued',
      filters,
      r2ObjectKey: null,
      rowCount: 0,
      byteSize: 0,
      errorMessage: null,
      createdBy: input.createdBy,
      createdByEmail: input.createdByEmail,
      expiresAt,
      startedAt: null,
      completedAt: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    },
  };
}
