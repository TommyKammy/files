import type { AuthUser, Env } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import { enqueueAdminReportJob } from './jobs';
import {
  ADMIN_REPORT_DEFAULT_RETENTION_DAYS,
  ADMIN_REPORT_SCHEDULE_BATCH_LIMIT,
  advanceAdminReportNextRun,
  buildAdminReportJobInsertStatement,
  computeNextAdminReportRun,
  rowToAdminReportSchedule,
  type AdminReportCadence,
  type AdminReportFilters,
  type AdminReportJobRecord,
  type AdminReportScheduleRecord,
  type AdminReportScheduleRow,
  type AdminReportType,
} from './types';

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
