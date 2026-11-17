import type { AuthUser, Env } from '../types/api';
import type { GenerateAdminReportQueueMessage } from '../types/classification';
import { buildAuditLogStmt } from './audit';
import {
  escapeAuditLikePrefix,
  isValidAuditTimeBoundary,
  normalizeAuditTimeBoundary,
  splitAuditActionPrefixes,
} from './audit-filters';

/**
 * P13-3 / TOM-68 asynchronous & scheduled admin reports.
 *
 * Generation deliberately runs in the `JOBS_QUEUE` consumer. Reads are keyset
 * chunks (`REPORT_CHUNK_SIZE`) so a 10k-row export never needs one large D1
 * result set, and every report is materialized once into R2 so downloads are
 * cheap and can be purged by `expires_at`.
 */

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

function parseEnabled(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === 0 || raw === '0' || raw === 'false') return false;
  throw new AdminReportsError(
    'enabled must be a boolean',
    400,
    'INVALID_REPORT_SCHEDULE'
  );
}

function computeExpiresAt(nowIso: string, retentionDays: number): string {
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

interface AdminReportJobRow {
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

interface AdminReportScheduleRow {
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

function rowToAdminReportJob(row: AdminReportJobRow): AdminReportJobRecord {
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

function rowToAdminReportSchedule(
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

interface BuildAdminReportJobInput {
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

function buildAdminReportJobInsertStatement(
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

export async function enqueueAdminReportJob(
  env: Pick<Env, 'JOBS_QUEUE'>,
  job: Pick<AdminReportJobRecord, 'id' | 'tenantId'>
): Promise<void> {
  await env.JOBS_QUEUE.send({
    type: 'generate_admin_report',
    jobId: job.id,
    tenantId: job.tenantId,
  } satisfies GenerateAdminReportQueueMessage);
}

/** Insert a queued job without side effects (used by the schedule Cron). */
export async function insertAdminReportJob(
  db: D1Database,
  input: BuildAdminReportJobInput
): Promise<AdminReportJobRecord> {
  const { statement, job } = buildAdminReportJobInsertStatement(db, input);
  await statement.run();
  return job;
}

/**
 * API-facing job creation: persists the job, appends `admin.report.requested`
 * and enqueues the consumer message.
 */
export async function createAdminReportJob(
  env: Pick<Env, 'DB' | 'JOBS_QUEUE'>,
  input: BuildAdminReportJobInput
): Promise<AdminReportJobRecord> {
  const { statement, job } = buildAdminReportJobInsertStatement(env.DB, input);
  await env.DB.batch([
    statement,
    buildAuditLogStmt(env.DB, {
      tenantId: job.tenantId,
      actorId: job.createdBy,
      actorEmail: job.createdByEmail,
      actorIp: null,
      action: 'admin.report.requested',
      targetType: 'admin_report_job',
      targetId: job.id,
      status: 'allowed',
      metadata: {
        reportType: job.reportType,
        scheduleId: job.scheduleId,
        filters: job.filters,
        expiresAt: job.expiresAt,
      },
      nowIso: job.createdAt,
    }),
  ]);
  await enqueueAdminReportJob(env, job);
  return job;
}

export async function getAdminReportJob(
  db: D1Database,
  tenantId: string,
  jobId: string
): Promise<AdminReportJobRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM admin_report_jobs WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, jobId)
    .first<AdminReportJobRow>();
  return row ? rowToAdminReportJob(row) : null;
}

export async function listAdminReportJobs(
  db: D1Database,
  tenantId: string,
  limit = 50
): Promise<AdminReportJobRecord[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM admin_report_jobs
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    )
    .bind(tenantId, limit)
    .all<AdminReportJobRow>();
  return rows.results.map(rowToAdminReportJob);
}

/* ------------------------------------------------------------------ */
/* CSV generation                                                      */
/* ------------------------------------------------------------------ */

interface CsvAccumulator {
  lines: string[];
  rowCount: number;
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function createCsvAccumulator(header: readonly string[]): CsvAccumulator {
  return { lines: [header.join(',')], rowCount: 0 };
}

function appendCsvRow(
  accumulator: CsvAccumulator,
  values: readonly unknown[]
): void {
  accumulator.lines.push(values.map(csvEscape).join(','));
  accumulator.rowCount += 1;
}

function toCsv(accumulator: CsvAccumulator): string {
  return accumulator.lines.join('\n');
}

interface ReportGenerationResult {
  csv: string;
  rowCount: number;
}

interface AuditLogReportRow {
  id: string;
  created_at: string;
  action: string;
  status: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_ip: string | null;
  target_type: string;
  target_id: string;
  classification_snapshot: string | null;
  metadata_json: string | null;
}

function buildAuditLogFilterClause(
  tenantId: string,
  filters: AdminReportFilters
): { conditions: string[]; binds: unknown[] } {
  const conditions = ['tenant_id = ?'];
  const binds: unknown[] = [tenantId];

  if (filters.from) {
    conditions.push('created_at >= ?');
    binds.push(filters.from);
  }
  if (filters.to) {
    conditions.push('created_at <= ?');
    binds.push(filters.to);
  }
  if (filters.actorEmail) {
    conditions.push('actor_email = ?');
    binds.push(filters.actorEmail);
  }
  if (filters.targetId) {
    conditions.push('target_id = ?');
    binds.push(filters.targetId);
  }
  if (filters.targetType) {
    conditions.push('target_type = ?');
    binds.push(filters.targetType);
  }
  if (filters.status) {
    conditions.push('status = ?');
    binds.push(filters.status);
  }

  const prefixes = splitAuditActionPrefixes(filters.actionPrefix);
  if (prefixes.length > 0) {
    conditions.push(
      `(${prefixes.map(() => `action LIKE ? ESCAPE '\\'`).join(' OR ')})`
    );
    binds.push(
      ...prefixes.map((prefix) => `${escapeAuditLikePrefix(prefix)}%`)
    );
  }

  return { conditions, binds };
}

async function generateUserActivityCsv(
  db: D1Database,
  tenantId: string,
  filters: AdminReportFilters
): Promise<ReportGenerationResult> {
  const accumulator = createCsvAccumulator([
    'id',
    'created_at',
    'action',
    'status',
    'actor_id',
    'actor_email',
    'actor_ip',
    'target_type',
    'target_id',
    'classification_snapshot',
    'metadata_json',
  ]);
  const base = buildAuditLogFilterClause(tenantId, filters);
  let cursor: { createdAt: string; id: string } | null = null;

  while (accumulator.rowCount < ADMIN_REPORT_MAX_ROWS) {
    const limit = Math.min(
      REPORT_CHUNK_SIZE,
      ADMIN_REPORT_MAX_ROWS - accumulator.rowCount
    );
    const conditions = [...base.conditions];
    const binds = [...base.binds];
    if (cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    binds.push(limit);

    const rows = await db
      .prepare(
        `SELECT id, created_at, action, status, actor_id, actor_email,
                actor_ip, target_type, target_id, classification_snapshot,
                metadata_json
           FROM audit_logs
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`
      )
      .bind(...binds)
      .all<AuditLogReportRow>();

    for (const row of rows.results) {
      appendCsvRow(accumulator, [
        row.id,
        row.created_at,
        row.action,
        row.status,
        row.actor_id,
        row.actor_email,
        row.actor_ip,
        row.target_type,
        row.target_id,
        row.classification_snapshot,
        row.metadata_json,
      ]);
    }

    if (rows.results.length < limit) break;
    const last = rows.results[rows.results.length - 1]!;
    cursor = { createdAt: last.created_at, id: last.id };
  }

  return { csv: toCsv(accumulator), rowCount: accumulator.rowCount };
}

interface SharedLinkInventoryRow {
  id: string;
  created_at: string;
  target_type: 'file' | 'folder';
  target_id: string;
  target_name: string | null;
  access_scope: string;
  permission_level: string;
  can_download: number;
  require_watermark: number;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  created_by: string;
  creator_email: string | null;
  revoked_at: string | null;
}

async function generateSharedLinksInventoryCsv(
  db: D1Database,
  tenantId: string,
  nowIso: string
): Promise<ReportGenerationResult> {
  const accumulator = createCsvAccumulator([
    'link_id',
    'created_at',
    'target_type',
    'target_id',
    'target_name',
    'access_scope',
    'permission_level',
    'can_download',
    'require_watermark',
    'expires_at',
    'max_downloads',
    'download_count',
    'creator_id',
    'creator_email',
    'revoked_at',
    'status',
  ]);
  const nowMs = Date.parse(nowIso);
  let cursor: { createdAt: string; id: string } | null = null;

  while (accumulator.rowCount < ADMIN_REPORT_MAX_ROWS) {
    const limit = Math.min(
      REPORT_CHUNK_SIZE,
      ADMIN_REPORT_MAX_ROWS - accumulator.rowCount
    );
    const conditions = ['sl.tenant_id = ?'];
    const binds: unknown[] = [tenantId];
    if (cursor) {
      conditions.push(
        '(sl.created_at < ? OR (sl.created_at = ? AND sl.id < ?))'
      );
      binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    binds.push(limit);

    const rows = await db
      .prepare(
        `SELECT sl.id, sl.created_at, sl.target_type, sl.target_id,
                CASE
                  WHEN sl.target_type = 'file'
                    THEN (SELECT name FROM files WHERE id = sl.target_id)
                  ELSE (SELECT name FROM folders WHERE id = sl.target_id)
                END AS target_name,
                sl.access_scope, sl.permission_level, sl.can_download,
                sl.require_watermark, sl.expires_at, sl.max_downloads,
                sl.download_count, sl.created_by,
                u.email AS creator_email, sl.revoked_at
           FROM shared_links sl
           LEFT JOIN users u ON u.id = sl.created_by
          WHERE ${conditions.join(' AND ')}
          ORDER BY sl.created_at DESC, sl.id DESC
          LIMIT ?`
      )
      .bind(...binds)
      .all<SharedLinkInventoryRow>();

    for (const row of rows.results) {
      const expired =
        row.expires_at !== null &&
        Number.isFinite(nowMs) &&
        Date.parse(row.expires_at) <= nowMs;
      const status = row.revoked_at
        ? 'revoked'
        : expired
          ? 'expired'
          : 'active';
      appendCsvRow(accumulator, [
        row.id,
        row.created_at,
        row.target_type,
        row.target_id,
        row.target_name,
        row.access_scope,
        row.permission_level,
        row.can_download,
        row.require_watermark,
        row.expires_at,
        row.max_downloads,
        row.download_count,
        row.created_by,
        row.creator_email,
        row.revoked_at,
        status,
      ]);
    }

    if (rows.results.length < limit) break;
    const last = rows.results[rows.results.length - 1]!;
    cursor = { createdAt: last.created_at, id: last.id };
  }

  return { csv: toCsv(accumulator), rowCount: accumulator.rowCount };
}

interface AccessStatsBucket {
  targetType: string;
  targetId: string;
  viewCount: number;
  downloadCount: number;
  editCount: number;
  deniedCount: number;
  totalCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

type AuditActionCategory = 'view' | 'download' | 'edit' | 'other';

/**
 * Coarse action taxonomy for the access statistics report. It is intentionally
 * additive: a future audit action still contributes to totals instead of being
 * dropped, and `blocked` is counted separately from the action category.
 */
export function classifyAuditActionForReport(
  action: string
): AuditActionCategory {
  const lower = action.toLowerCase();
  if (lower.includes('download')) return 'download';
  if (
    lower.includes('preview') ||
    lower.includes('view') ||
    lower.includes('read') ||
    lower.endsWith('.access')
  ) {
    return 'view';
  }
  if (
    /(edit|update|rename|move|upload|create|delete|restore|revoke)/.test(lower)
  ) {
    return 'edit';
  }
  return 'other';
}

interface AccessStatsAuditRow {
  id: string;
  target_type: string;
  target_id: string;
  action: string;
  status: string;
  created_at: string;
}

async function generateAccessStatsCsv(
  db: D1Database,
  tenantId: string,
  filters: AdminReportFilters
): Promise<ReportGenerationResult> {
  const base = buildAuditLogFilterClause(tenantId, filters);
  const buckets = new Map<string, AccessStatsBucket>();
  let cursor: { createdAt: string; id: string } | null = null;
  let scanned = 0;

  while (scanned < ADMIN_REPORT_MAX_ROWS) {
    const limit = Math.min(
      REPORT_CHUNK_SIZE,
      ADMIN_REPORT_MAX_ROWS - scanned
    );
    const conditions = [...base.conditions];
    const binds = [...base.binds];
    if (cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
      binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    binds.push(limit);

    const rows = await db
      .prepare(
        `SELECT id, target_type, target_id, action, status, created_at
           FROM audit_logs
          WHERE ${conditions.join(' AND ')}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`
      )
      .bind(...binds)
      .all<AccessStatsAuditRow>();

    for (const row of rows.results) {
      scanned += 1;
      const key = `${row.target_type}\u0000${row.target_id}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          targetType: row.target_type,
          targetId: row.target_id,
          viewCount: 0,
          downloadCount: 0,
          editCount: 0,
          deniedCount: 0,
          totalCount: 0,
          firstSeenAt: row.created_at,
          lastSeenAt: row.created_at,
        };
        buckets.set(key, bucket);
      }
      bucket.totalCount += 1;
      if (row.status === 'blocked') bucket.deniedCount += 1;
      const category = classifyAuditActionForReport(row.action);
      if (category === 'view') bucket.viewCount += 1;
      else if (category === 'download') bucket.downloadCount += 1;
      else if (category === 'edit') bucket.editCount += 1;
      if (row.created_at < bucket.firstSeenAt) {
        bucket.firstSeenAt = row.created_at;
      }
      if (row.created_at > bucket.lastSeenAt) {
        bucket.lastSeenAt = row.created_at;
      }
    }

    if (rows.results.length < limit) break;
    const last = rows.results[rows.results.length - 1]!;
    cursor = { createdAt: last.created_at, id: last.id };
  }

  const accumulator = createCsvAccumulator([
    'target_type',
    'target_id',
    'view_count',
    'download_count',
    'edit_count',
    'denied_count',
    'total_count',
    'first_seen_at',
    'last_seen_at',
  ]);
  const sorted = [...buckets.values()].sort((a, b) =>
    a.targetType === b.targetType
      ? a.targetId.localeCompare(b.targetId)
      : a.targetType.localeCompare(b.targetType)
  );
  for (const bucket of sorted) {
    appendCsvRow(accumulator, [
      bucket.targetType,
      bucket.targetId,
      bucket.viewCount,
      bucket.downloadCount,
      bucket.editCount,
      bucket.deniedCount,
      bucket.totalCount,
      bucket.firstSeenAt,
      bucket.lastSeenAt,
    ]);
  }

  return { csv: toCsv(accumulator), rowCount: accumulator.rowCount };
}

interface UserInventoryRow {
  id: string;
  email: string;
  display_name: string;
  user_type: 'member' | 'guest';
  role: string;
  status: string;
  external_org: string | null;
  last_login_at: string | null;
  expires_at: string | null;
  offboarded_at: string | null;
  storage_quota_bytes: number | null;
  tenant_quota_bytes: number;
  storage_file_count: number;
  storage_used_bytes: number;
  created_at: string;
}

async function generateUsersAndGuestsCsv(
  db: D1Database,
  tenantId: string
): Promise<ReportGenerationResult> {
  const accumulator = createCsvAccumulator([
    'user_id',
    'email',
    'display_name',
    'user_type',
    'role',
    'status',
    'external_org',
    'last_login_at',
    'quota_bytes',
    'used_bytes',
    'file_count',
    'guest_expires_at',
    'offboarded_at',
    'created_at',
  ]);
  let cursorId: string | null = null;

  while (accumulator.rowCount < ADMIN_REPORT_MAX_ROWS) {
    const limit = Math.min(
      REPORT_CHUNK_SIZE,
      ADMIN_REPORT_MAX_ROWS - accumulator.rowCount
    );
    const conditions = ['u.tenant_id = ?'];
    const binds: unknown[] = [tenantId];
    if (cursorId) {
      conditions.push('u.id > ?');
      binds.push(cursorId);
    }
    binds.push(limit);

    const rows = await db
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.user_type, u.role,
                u.status, u.external_org, u.last_login_at, u.expires_at,
                u.offboarded_at, u.storage_quota_bytes,
                COALESCE(uss.file_count, 0) AS storage_file_count,
                COALESCE(uss.total_bytes, 0) AS storage_used_bytes,
                u.created_at, t.storage_quota_bytes AS tenant_quota_bytes
           FROM users u
           JOIN tenants t ON t.id = u.tenant_id
           LEFT JOIN user_storage_stats uss
             ON uss.tenant_id = u.tenant_id AND uss.user_id = u.id
          WHERE ${conditions.join(' AND ')}
          ORDER BY u.id ASC
          LIMIT ?`
      )
      .bind(...binds)
      .all<UserInventoryRow>();

    for (const row of rows.results) {
      appendCsvRow(accumulator, [
        row.id,
        row.email,
        row.display_name,
        row.user_type,
        row.role,
        row.status,
        row.external_org,
        row.last_login_at,
        row.storage_quota_bytes ?? row.tenant_quota_bytes,
        row.storage_used_bytes,
        row.storage_file_count,
        row.user_type === 'guest' ? row.expires_at : '',
        row.offboarded_at,
        row.created_at,
      ]);
    }

    if (rows.results.length < limit) break;
    cursorId = rows.results[rows.results.length - 1]!.id;
  }

  return { csv: toCsv(accumulator), rowCount: accumulator.rowCount };
}

export async function generateAdminReportCsv(
  db: D1Database,
  tenantId: string,
  reportType: AdminReportType,
  filters: AdminReportFilters,
  nowIso: string
): Promise<ReportGenerationResult> {
  switch (reportType) {
    case 'user_activity':
      return generateUserActivityCsv(db, tenantId, filters);
    case 'shared_links_inventory':
      return generateSharedLinksInventoryCsv(db, tenantId, nowIso);
    case 'access_stats':
      return generateAccessStatsCsv(db, tenantId, filters);
    case 'users_and_guests':
      return generateUsersAndGuestsCsv(db, tenantId);
  }
}

export function buildAdminReportObjectKey(
  tenantId: string,
  jobId: string
): string {
  return `reports/${tenantId}/${jobId}.csv`;
}

export function buildAdminReportFilename(
  reportType: AdminReportType,
  jobId: string
): string {
  return `files-${reportType}-${jobId.slice(0, 8)}.csv`;
}

/** Queue consumer entrypoint for one `generate_admin_report` message. */
export async function processAdminReportJob(
  message: Pick<GenerateAdminReportQueueMessage, 'jobId' | 'tenantId'>,
  env: Pick<Env, 'DB' | 'BUCKET'>
): Promise<void> {
  const job = await getAdminReportJob(env.DB, message.tenantId, message.jobId);
  if (!job) {
    throw new Error(
      `admin report job ${message.jobId} not found for tenant ${message.tenantId}`
    );
  }
  if (job.status === 'completed') return;

  const startedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE admin_report_jobs
        SET status = 'running', started_at = ?, error_message = NULL, updated_at = ?
      WHERE tenant_id = ? AND id = ?`
  )
    .bind(startedAt, startedAt, job.tenantId, job.id)
    .run();

  try {
    const result = await generateAdminReportCsv(
      env.DB,
      job.tenantId,
      job.reportType,
      job.filters,
      startedAt
    );
    const objectKey = buildAdminReportObjectKey(job.tenantId, job.id);
    const byteSize = new TextEncoder().encode(result.csv).byteLength;
    await env.BUCKET.put(objectKey, result.csv, {
      httpMetadata: { contentType: 'text/csv; charset=utf-8' },
    });

    const completedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE admin_report_jobs
            SET status = 'completed', r2_object_key = ?, row_count = ?,
                byte_size = ?, error_message = NULL, completed_at = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(
        objectKey,
        result.rowCount,
        byteSize,
        completedAt,
        completedAt,
        job.tenantId,
        job.id
      ),
      buildAuditLogStmt(env.DB, {
        tenantId: job.tenantId,
        actorId: job.createdBy,
        actorEmail: job.createdByEmail,
        actorIp: null,
        action: 'admin.report.generated',
        targetType: 'admin_report_job',
        targetId: job.id,
        status: 'allowed',
        metadata: {
          reportType: job.reportType,
          scheduleId: job.scheduleId,
          rowCount: result.rowCount,
          byteSize,
          objectKey,
        },
        nowIso: completedAt,
      }),
    ]);
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : 'Unknown report generation error';
    const failedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE admin_report_jobs
          SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    )
      .bind(messageText.slice(0, 1000), failedAt, failedAt, job.tenantId, job.id)
      .run();
    console.error('[admin-reports] generation failed:', err);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

export interface CreateAdminReportScheduleInput {
  tenantId: string;
  name: string;
  reportType: AdminReportType;
  cadence: AdminReportCadence;
  enabled?: boolean;
  filters?: AdminReportFilters;
  retentionDays?: number;
  nextRunAt?: string;
  createdBy: string;
  nowIso: string;
  id?: string;
}

export async function createAdminReportSchedule(
  db: D1Database,
  input: CreateAdminReportScheduleInput
): Promise<AdminReportScheduleRecord> {
  const id = input.id ?? crypto.randomUUID();
  const enabled = input.enabled ?? true;
  const retentionDays =
    input.retentionDays ?? ADMIN_REPORT_DEFAULT_RETENTION_DAYS;
  const nextRunAt =
    input.nextRunAt ?? computeNextAdminReportRun(input.nowIso, input.cadence);
  const filters = input.filters ?? {};

  await db
    .prepare(
      `INSERT INTO admin_report_schedules (
         id, tenant_id, name, report_type, cadence, enabled, filters_json,
         retention_days, next_run_at, last_run_at, last_job_id, created_by,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
    )
    .bind(
      id,
      input.tenantId,
      input.name,
      input.reportType,
      input.cadence,
      enabled ? 1 : 0,
      JSON.stringify(filters),
      retentionDays,
      nextRunAt,
      input.createdBy,
      input.nowIso,
      input.nowIso
    )
    .run();

  return {
    id,
    tenantId: input.tenantId,
    name: input.name,
    reportType: input.reportType,
    cadence: input.cadence,
    enabled,
    filters,
    retentionDays,
    nextRunAt,
    lastRunAt: null,
    lastJobId: null,
    createdBy: input.createdBy,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

export async function getAdminReportSchedule(
  db: D1Database,
  tenantId: string,
  scheduleId: string
): Promise<AdminReportScheduleRecord | null> {
  const row = await db
    .prepare(
      `SELECT * FROM admin_report_schedules WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, scheduleId)
    .first<AdminReportScheduleRow>();
  return row ? rowToAdminReportSchedule(row) : null;
}

export async function listAdminReportSchedules(
  db: D1Database,
  tenantId: string
): Promise<AdminReportScheduleRecord[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM admin_report_schedules
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC`
    )
    .bind(tenantId)
    .all<AdminReportScheduleRow>();
  return rows.results.map(rowToAdminReportSchedule);
}

export interface UpdateAdminReportSchedulePatch {
  name?: string;
  reportType?: AdminReportType;
  cadence?: AdminReportCadence;
  enabled?: boolean;
  filters?: AdminReportFilters;
  retentionDays?: number;
  nextRunAt?: string;
}

export async function updateAdminReportSchedule(
  db: D1Database,
  tenantId: string,
  scheduleId: string,
  patch: UpdateAdminReportSchedulePatch,
  nowIso: string
): Promise<AdminReportScheduleRecord | null> {
  const current = await getAdminReportSchedule(db, tenantId, scheduleId);
  if (!current) return null;

  const cadence = patch.cadence ?? current.cadence;
  const nextRunAt =
    patch.nextRunAt ??
    (patch.cadence
      ? computeNextAdminReportRun(nowIso, cadence)
      : current.nextRunAt);
  const name = patch.name ?? current.name;
  const reportType = patch.reportType ?? current.reportType;
  const enabled = patch.enabled ?? current.enabled;
  const filters = patch.filters ?? current.filters;
  const retentionDays = patch.retentionDays ?? current.retentionDays;

  await db
    .prepare(
      `UPDATE admin_report_schedules
          SET name = ?, report_type = ?, cadence = ?, enabled = ?,
              filters_json = ?, retention_days = ?, next_run_at = ?,
              updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(
      name,
      reportType,
      cadence,
      enabled ? 1 : 0,
      JSON.stringify(filters),
      retentionDays,
      nextRunAt,
      nowIso,
      tenantId,
      scheduleId
    )
    .run();

  return {
    ...current,
    name,
    reportType,
    cadence,
    enabled,
    filters,
    retentionDays,
    nextRunAt,
    updatedAt: nowIso,
  };
}

export async function deleteAdminReportSchedule(
  db: D1Database,
  tenantId: string,
  scheduleId: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM admin_report_schedules WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, scheduleId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Create an immediate job for a saved schedule (`/run`). */
export async function runAdminReportScheduleNow(
  env: Pick<Env, 'DB' | 'JOBS_QUEUE'>,
  schedule: AdminReportScheduleRecord,
  actor: Pick<AuthUser, 'id' | 'email'>,
  nowIso: string
): Promise<AdminReportJobRecord> {
  const { statement, job } = buildAdminReportJobInsertStatement(env.DB, {
    tenantId: schedule.tenantId,
    scheduleId: schedule.id,
    reportType: schedule.reportType,
    filters: schedule.filters,
    retentionDays: schedule.retentionDays,
    createdBy: actor.id,
    createdByEmail: actor.email,
    nowIso,
  });
  await env.DB.batch([
    statement,
    env.DB.prepare(
      `UPDATE admin_report_schedules
          SET last_run_at = ?, last_job_id = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    ).bind(nowIso, job.id, nowIso, schedule.tenantId, schedule.id),
    buildAuditLogStmt(env.DB, {
      tenantId: schedule.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: null,
      action: 'admin.report.requested',
      targetType: 'admin_report_job',
      targetId: job.id,
      status: 'allowed',
      metadata: {
        reportType: job.reportType,
        scheduleId: schedule.id,
        filters: job.filters,
        trigger: 'schedule_run_now',
      },
      nowIso,
    }),
  ]);
  await enqueueAdminReportJob(env, job);
  return job;
}

/* ------------------------------------------------------------------ */
/* Cron maintenance                                                    */
/* ------------------------------------------------------------------ */

export interface DueAdminReportScheduleResult {
  schedulesProcessed: number;
  jobsEnqueued: number;
}

/**
 * Create jobs for due schedules, advance every `next_run_at`, and enqueue the
 * consumer message. The row and schedule timestamp commit before the queue
 * send so a consumer can never observe a missing job.
 */
export async function processDueAdminReportSchedules(
  env: Pick<Env, 'DB' | 'JOBS_QUEUE'>,
  nowIso: string
): Promise<DueAdminReportScheduleResult> {
  const rows = await env.DB.prepare(
    `SELECT s.*, u.email AS created_by_email
       FROM admin_report_schedules s
       LEFT JOIN users u ON u.id = s.created_by
      WHERE s.enabled = 1 AND s.next_run_at <= ?
      ORDER BY s.next_run_at ASC
      LIMIT ?`
  )
    .bind(nowIso, ADMIN_REPORT_SCHEDULE_BATCH_LIMIT)
    .all<AdminReportScheduleRow & { created_by_email: string | null }>();

  let jobsEnqueued = 0;
  for (const row of rows.results) {
    const schedule = rowToAdminReportSchedule(row);
    const nextRunAt = advanceAdminReportNextRun(
      schedule.nextRunAt,
      schedule.cadence,
      nowIso
    );
    const { statement, job } = buildAdminReportJobInsertStatement(env.DB, {
      tenantId: schedule.tenantId,
      scheduleId: schedule.id,
      reportType: schedule.reportType,
      filters: schedule.filters,
      retentionDays: schedule.retentionDays,
      createdBy: schedule.createdBy,
      createdByEmail: row.created_by_email,
      nowIso,
    });

    await env.DB.batch([
      statement,
      env.DB.prepare(
        `UPDATE admin_report_schedules
            SET next_run_at = ?, last_run_at = ?, last_job_id = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(
        nextRunAt,
        nowIso,
        job.id,
        nowIso,
        schedule.tenantId,
        schedule.id
      ),
    ]);
    await enqueueAdminReportJob(env, job);
    jobsEnqueued += 1;
  }

  return {
    schedulesProcessed: rows.results.length,
    jobsEnqueued,
  };
}

/**
 * Delete expired report metadata and R2 objects. Objects are removed first so
 * a transient R2 failure never loses the only pointer to an orphaned export.
 */
export async function purgeExpiredAdminReportJobs(
  env: Pick<Env, 'DB' | 'BUCKET'>,
  nowIso: string
): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, tenant_id, r2_object_key
       FROM admin_report_jobs
      WHERE expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT 200`
  )
    .bind(nowIso)
    .all<{ id: string; tenant_id: string; r2_object_key: string | null }>();

  const deletableIds: string[] = [];
  for (const row of rows.results) {
    if (row.r2_object_key) {
      try {
        await env.BUCKET.delete(row.r2_object_key);
      } catch (err) {
        console.error(
          '[admin-reports] failed to delete expired report object:',
          err
        );
        continue;
      }
    }
    deletableIds.push(row.id);
  }

  if (deletableIds.length > 0) {
    await env.DB.batch(
      deletableIds.map((id) =>
        env.DB.prepare('DELETE FROM admin_report_jobs WHERE id = ?').bind(id)
      )
    );
  }

  return deletableIds.length;
}
