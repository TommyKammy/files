import type { Env } from '../../types/api';
import type { GenerateAdminReportQueueMessage } from '../../types/classification';
import { buildAuditLogStmt } from '../audit';
import { generateAdminReportCsv } from './csv-generators';
import {
  buildAdminReportJobInsertStatement,
  rowToAdminReportJob,
  type AdminReportJobRecord,
  type AdminReportJobRow,
  type AdminReportType,
  type BuildAdminReportJobInput,
} from './types';

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
