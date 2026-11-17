import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { buildAuditLogStmt } from '../../services/audit';
import { issueSignedStorageUrl } from '../../services/storage-url-provider';
import {
  AdminReportsError,
  buildAdminReportFilename,
  createAdminReportJob,
  createAdminReportSchedule,
  deleteAdminReportSchedule,
  getAdminReportJob,
  getAdminReportSchedule,
  isAdminReportCadence,
  isAdminReportType,
  listAdminReportJobs,
  listAdminReportSchedules,
  normalizeAdminReportFilters,
  parseAdminReportRetentionDays,
  runAdminReportScheduleNow,
  updateAdminReportSchedule,
  type AdminReportCadence,
  type AdminReportType,
} from '../../services/admin-reports';
import type { OidcHonoEnv } from '../../types/oidc';

const REPORT_DOWNLOAD_URL_TTL_SECONDS = 300;
const REPORT_NAME_MAX_LENGTH = 120;

type JsonRecord = Record<string, unknown>;

function readBody(raw: unknown): JsonRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AdminReportsError(
      'Request body must be an object',
      400,
      'INVALID_REPORT_REQUEST'
    );
  }
  return raw as JsonRecord;
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AdminReportsError(
      `${field} is required`,
      400,
      'INVALID_REPORT_REQUEST'
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new AdminReportsError(
      `${field} must be at most ${maxLength} characters`,
      400,
      'INVALID_REPORT_REQUEST'
    );
  }
  return trimmed;
}

function inlineFilterSource(body: JsonRecord): unknown {
  if (body.filters !== undefined) return body.filters;
  const source: JsonRecord = {};
  for (const key of [
    'from',
    'to',
    'actorEmail',
    'actor_email',
    'targetId',
    'target_id',
    'targetType',
    'target_type',
    'status',
    'actionPrefix',
    'action_prefix',
  ]) {
    if (key in body) source[key] = body[key];
  }
  return source;
}

function parseCreateJobBody(body: JsonRecord): {
  reportType: AdminReportType;
  filters: ReturnType<typeof normalizeAdminReportFilters>;
  retentionDays: number;
} {
  const reportType = body.reportType ?? body.report_type;
  if (!isAdminReportType(reportType)) {
    throw new AdminReportsError(
      'reportType must be user_activity, shared_links_inventory, access_stats or users_and_guests',
      400,
      'INVALID_REPORT_TYPE'
    );
  }
  return {
    reportType,
    filters: normalizeAdminReportFilters(inlineFilterSource(body)),
    retentionDays: parseAdminReportRetentionDays(
      body.retentionDays ?? body.retention_days
    ),
  };
}

function parseEnabled(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new AdminReportsError(
    'enabled must be a boolean',
    400,
    'INVALID_REPORT_SCHEDULE'
  );
}

function parseRequiredReportType(value: unknown): AdminReportType {
  if (!isAdminReportType(value)) {
    throw new AdminReportsError(
      'reportType must be user_activity, shared_links_inventory, access_stats or users_and_guests',
      400,
      'INVALID_REPORT_TYPE'
    );
  }
  return value;
}

function parseRequiredCadence(value: unknown): AdminReportCadence {
  if (!isAdminReportCadence(value)) {
    throw new AdminReportsError(
      'cadence must be weekly or monthly',
      400,
      'INVALID_REPORT_SCHEDULE'
    );
  }
  return value;
}

function parseOptionalNextRunAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new AdminReportsError(
      'nextRunAt must be an ISO timestamp',
      400,
      'INVALID_REPORT_SCHEDULE'
    );
  }
  return new Date(value).toISOString();
}

function parseCreateScheduleBody(body: JsonRecord): {
  name: string;
  reportType: AdminReportType;
  cadence: AdminReportCadence;
  enabled: boolean;
  filters: ReturnType<typeof normalizeAdminReportFilters>;
  retentionDays: number;
  nextRunAt?: string;
} {
  return {
    name: requiredString(body.name, 'name', REPORT_NAME_MAX_LENGTH),
    reportType: parseRequiredReportType(
      body.reportType ?? body.report_type
    ),
    cadence: parseRequiredCadence(body.cadence),
    enabled: parseEnabled(body.enabled) ?? true,
    filters: normalizeAdminReportFilters(inlineFilterSource(body)),
    retentionDays: parseAdminReportRetentionDays(
      body.retentionDays ?? body.retention_days
    ),
    nextRunAt: parseOptionalNextRunAt(
      body.nextRunAt ?? body.next_run_at
    ),
  };
}

function parseUpdateScheduleBody(body: JsonRecord): {
  name?: string;
  reportType?: AdminReportType;
  cadence?: AdminReportCadence;
  enabled?: boolean;
  filters?: ReturnType<typeof normalizeAdminReportFilters>;
  retentionDays?: number;
  nextRunAt?: string;
} {
  const patch: {
    name?: string;
    reportType?: AdminReportType;
    cadence?: AdminReportCadence;
    enabled?: boolean;
    filters?: ReturnType<typeof normalizeAdminReportFilters>;
    retentionDays?: number;
    nextRunAt?: string;
  } = {};

  if ('name' in body) {
    patch.name = requiredString(body.name, 'name', REPORT_NAME_MAX_LENGTH);
  }
  if ('reportType' in body || 'report_type' in body) {
    patch.reportType = parseRequiredReportType(
      body.reportType ?? body.report_type
    );
  }
  if ('cadence' in body) {
    patch.cadence = parseRequiredCadence(body.cadence);
  }
  if ('enabled' in body) {
    patch.enabled = parseEnabled(body.enabled);
  }
  if (
    'filters' in body ||
    [
      'from',
      'to',
      'actorEmail',
      'actor_email',
      'targetId',
      'target_id',
      'targetType',
      'target_type',
      'status',
      'actionPrefix',
      'action_prefix',
    ].some((key) => key in body)
  ) {
    patch.filters = normalizeAdminReportFilters(inlineFilterSource(body));
  }
  if ('retentionDays' in body || 'retention_days' in body) {
    patch.retentionDays = parseAdminReportRetentionDays(
      body.retentionDays ?? body.retention_days
    );
  }
  if ('nextRunAt' in body || 'next_run_at' in body) {
    patch.nextRunAt = parseOptionalNextRunAt(
      body.nextRunAt ?? body.next_run_at
    );
  }
  return patch;
}

function handleAdminReportsError(
  c: { json: (body: unknown, status: 400 | 404 | 409) => Response },
  err: unknown
): Response {
  if (err instanceof AdminReportsError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

export function registerAdminReportRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/reports/jobs — tenant-scoped generation history. */
  routes.get('/reports/jobs', async (c) => {
    const user = getAuthenticatedUser(c);
    const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 100)
      : 50;
    const jobs = await listAdminReportJobs(c.env.DB, user.tenantId, limit);
    return c.json({
      jobs: jobs.map((job) => ({
        ...job,
        downloadUrl: `/api/admin/reports/jobs/${job.id}/download`,
      })),
    });
  });

  /** POST /api/admin/reports/jobs — enqueue an asynchronous CSV export. */
  routes.post('/reports/jobs', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const body = readBody(await c.req.json().catch(() => null));
      const input = parseCreateJobBody(body);
      const nowIso = new Date().toISOString();
      const job = await createAdminReportJob(c.env, {
        tenantId: user.tenantId,
        reportType: input.reportType,
        filters: input.filters,
        retentionDays: input.retentionDays,
        createdBy: user.id,
        createdByEmail: user.email,
        nowIso,
      });
      return c.json(
        {
          job,
          jobId: job.id,
          downloadUrl: `/api/admin/reports/jobs/${job.id}/download`,
        },
        202
      );
    } catch (err) {
      return handleAdminReportsError(c, err);
    }
  });

  /**
   * GET /api/admin/reports/jobs/:id/download
   *
   * Direct requests stream the CSV with `no-store`; `?mode=url` returns a
   * short-lived signed URL (HMAC local proxy or R2 presigned).
   */
  routes.get('/reports/jobs/:id/download', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const job = await getAdminReportJob(
        c.env.DB,
        user.tenantId,
        c.req.param('id')
      );
      if (!job) {
        throw new AdminReportsError(
          'Report job not found',
          404,
          'REPORT_NOT_FOUND'
        );
      }
      if (job.status !== 'completed' || !job.r2ObjectKey) {
        throw new AdminReportsError(
          'Report is not ready for download',
          409,
          'REPORT_NOT_READY'
        );
      }

      const filename = buildAdminReportFilename(job.reportType, job.id);
      const nowIso = new Date().toISOString();

      if (c.req.query('mode') === 'url') {
        const signed = await issueSignedStorageUrl(c.env, {
          method: 'GET',
          objectKey: job.r2ObjectKey,
          tenantId: user.tenantId,
          expiresInSeconds: REPORT_DOWNLOAD_URL_TTL_SECONDS,
          disposition: 'attachment',
          filename,
          contentType: 'text/csv; charset=utf-8',
        });
        await buildAuditLogStmt(c.env.DB, {
          tenantId: user.tenantId,
          actorId: user.id,
          actorEmail: user.email,
          actorIp: user.ipAddress,
          action: 'admin.report.downloaded',
          targetType: 'admin_report_job',
          targetId: job.id,
          status: 'allowed',
          metadata: {
            reportType: job.reportType,
            mode: 'signed_url',
            expiresAt: signed.expiresAt,
          },
          nowIso,
        }).run();
        return c.json({
          url: signed.url,
          method: signed.method,
          expiresAt: signed.expiresAt,
          expiresInSeconds: REPORT_DOWNLOAD_URL_TTL_SECONDS,
          filename,
          reportType: job.reportType,
          rowCount: job.rowCount,
          byteSize: job.byteSize,
        });
      }

      const object = await c.env.BUCKET.get(job.r2ObjectKey);
      if (!object) {
        throw new AdminReportsError(
          'Report object not found',
          404,
          'REPORT_NOT_FOUND'
        );
      }

      await buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'admin.report.downloaded',
        targetType: 'admin_report_job',
        targetId: job.id,
        status: 'allowed',
        metadata: {
          reportType: job.reportType,
          mode: 'direct',
          rowCount: job.rowCount,
          byteSize: job.byteSize,
        },
        nowIso,
      }).run();

      return new Response(object.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': String(object.size),
        },
      });
    } catch (err) {
      return handleAdminReportsError(c, err);
    }
  });

  /** GET /api/admin/reports/schedules — recurring export definitions. */
  routes.get('/reports/schedules', async (c) => {
    const user = getAuthenticatedUser(c);
    const schedules = await listAdminReportSchedules(
      c.env.DB,
      user.tenantId
    );
    return c.json({ schedules });
  });

  /** POST /api/admin/reports/schedules — weekly/monthly report definition. */
  routes.post('/reports/schedules', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const body = readBody(await c.req.json().catch(() => null));
      const input = parseCreateScheduleBody(body);
      const nowIso = new Date().toISOString();
      const schedule = await createAdminReportSchedule(c.env.DB, {
        tenantId: user.tenantId,
        name: input.name,
        reportType: input.reportType,
        cadence: input.cadence,
        enabled: input.enabled,
        filters: input.filters,
        retentionDays: input.retentionDays,
        nextRunAt: input.nextRunAt,
        createdBy: user.id,
        nowIso,
      });
      return c.json({ schedule }, 201);
    } catch (err) {
      return handleAdminReportsError(c, err);
    }
  });

  /** PATCH /api/admin/reports/schedules/:id — toggle or update a schedule. */
  routes.patch('/reports/schedules/:id', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const body = readBody(await c.req.json().catch(() => null));
      const patch = parseUpdateScheduleBody(body);
      const schedule = await updateAdminReportSchedule(
        c.env.DB,
        user.tenantId,
        c.req.param('id'),
        patch,
        new Date().toISOString()
      );
      if (!schedule) {
        throw new AdminReportsError(
          'Report schedule not found',
          404,
          'REPORT_SCHEDULE_NOT_FOUND'
        );
      }
      return c.json({ schedule });
    } catch (err) {
      return handleAdminReportsError(c, err);
    }
  });

  /** POST /api/admin/reports/schedules/:id/run — immediate test generation. */
  routes.post('/reports/schedules/:id/run', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const schedule = await getAdminReportSchedule(
        c.env.DB,
        user.tenantId,
        c.req.param('id')
      );
      if (!schedule) {
        throw new AdminReportsError(
          'Report schedule not found',
          404,
          'REPORT_SCHEDULE_NOT_FOUND'
        );
      }
      const job = await runAdminReportScheduleNow(
        c.env,
        schedule,
        user,
        new Date().toISOString()
      );
      return c.json(
        {
          job,
          jobId: job.id,
          downloadUrl: `/api/admin/reports/jobs/${job.id}/download`,
        },
        202
      );
    } catch (err) {
      return handleAdminReportsError(c, err);
    }
  });

  /** DELETE /api/admin/reports/schedules/:id */
  routes.delete('/reports/schedules/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const deleted = await deleteAdminReportSchedule(
      c.env.DB,
      user.tenantId,
      c.req.param('id')
    );
    if (!deleted) {
      return c.json(
        {
          error: 'Report schedule not found',
          code: 'REPORT_SCHEDULE_NOT_FOUND',
        },
        404
      );
    }
    return c.json({ ok: true, id: c.req.param('id') });
  });
}
