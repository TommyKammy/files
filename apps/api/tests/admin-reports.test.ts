import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker, { app } from '../src/index';
import { handleJobsQueueBatch } from '../src/consumers/classification-consumer';
import { runDailyMaintenance } from '../src/consumers/maintenance-cron';
import { getAdminReportJob } from '../src/services/admin-reports';
import type { JobsQueueMessage } from '../src/types/classification';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-reports';
const OTHER_TENANT = 'tenant-reports-other';
const CRON_TENANT = 'tenant-reports-cron';

const SYS = 'reports-sys';
const MEMBER = 'reports-member';
const MEMBER_QUOTA = 'reports-member-quota';
const GUEST = 'reports-guest';
const OTHER_SYS = 'reports-other-sys';
const CRON_USER = 'reports-cron-user';

const TARGET_ID = 'report-target-asset';
const AUDIT_DAY_START = Date.parse('2026-11-17T00:00:00.000Z');
const AUDIT_ROW_COUNT = 450;

function dayIso(offsetSeconds: number): string {
  return new Date(AUDIT_DAY_START + offsetSeconds * 1000).toISOString();
}

function makeQueueHarness() {
  const queued: JobsQueueMessage[] = [];
  const queue = {
    send: vi.fn(async (message: JobsQueueMessage) => {
      queued.push(message);
    }),
  } as unknown as Queue;

  function buildEnv(): OidcEnv {
    return {
      ...env,
      ENVIRONMENT: 'local',
      ALLOW_DEV_AUTH: 'true',
      APP_ORIGIN: 'http://127.0.0.1:8787',
      STORAGE_MODE: 'local_proxy',
      LOCAL_PROXY_SECRET: 'test-report-proxy-secret-001',
      DEFAULT_TENANT_ID: TENANT,
      JOBS_QUEUE: queue,
    } as unknown as OidcEnv;
  }

  async function drain(maxTurns = 40): Promise<number> {
    let turns = 0;
    while (queued.length > 0) {
      turns += 1;
      if (turns > maxTurns) {
        throw new Error(`Report queue drain exceeded ${maxTurns} turns`);
      }
      const chunk = queued.splice(0, 2);
      const messages = chunk.map((body) => ({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        body,
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      }));
      await handleJobsQueueBatch(
        {
          queue: 'files-jobs',
          messages,
          metadata: {
            metrics: {
              backlogCount: 0,
              backlogBytes: 0,
              oldestMessageTimestamp: new Date(),
            },
          },
          ackAll: vi.fn(),
          retryAll: vi.fn(),
        } as unknown as MessageBatch<JobsQueueMessage>,
        buildEnv()
      );
      for (const message of messages) {
        expect(message.retry).not.toHaveBeenCalled();
        expect(message.ack).toHaveBeenCalledTimes(1);
      }
    }
    return turns;
  }

  return { queued, buildEnv, drain };
}

const harness = makeQueueHarness();

function headers(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member' = 'sys_admin',
  options: {
    tenantId?: string;
    userType?: 'member' | 'guest';
    email?: string;
  } = {}
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': options.tenantId ?? TENANT,
    'X-Dev-User-Email':
      options.email ?? `${userId}@reports.example.com`,
    'X-Dev-User-Type': options.userType ?? 'member',
    'Content-Type': 'application/json',
    Origin: 'http://127.0.0.1:8787',
  };
}

async function call(
  path: string,
  userId = SYS,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    role?: 'sys_admin' | 'sec_admin' | 'member';
    tenantId?: string;
    userType?: 'member' | 'guest';
    email?: string;
  } = {}
): Promise<Response> {
  return app.fetch(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: options.method ?? 'GET',
      headers: headers(userId, options.role ?? 'sys_admin', options),
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    harness.buildEnv()
  );
}

interface CreateJobResponse {
  job: {
    id: string;
    reportType: string;
    status: string;
    rowCount: number;
    byteSize: number;
    r2ObjectKey: string | null;
    filters: Record<string, unknown>;
  };
  jobId: string;
  downloadUrl: string;
}

async function createAndCompleteJob(
  reportType: string,
  filters: Record<string, unknown> = {},
  options: Parameters<typeof call>[2] & { userId?: string } = {}
): Promise<CreateJobResponse> {
  const { userId, ...callOptions } = options;
  const res = await call(
    '/api/admin/reports/jobs',
    userId ?? SYS,
    {
      ...callOptions,
      method: 'POST',
      body: { reportType, filters },
    }
  );
  expect(res.status, `POST job ${reportType}`).toBe(202);
  const body = (await res.json()) as CreateJobResponse;
  expect(body.jobId).toBeTruthy();
  await harness.drain();
  const job = await getAdminReportJob(
    env.DB,
    options.tenantId ?? TENANT,
    body.jobId
  );
  expect(job?.status).toBe('completed');
  return {
    ...body,
    job: {
      ...body.job,
      status: job!.status,
      rowCount: job!.rowCount,
      byteSize: job!.byteSize,
      r2ObjectKey: job!.r2ObjectKey,
    },
  };
}

async function readReportCsv(job: { r2ObjectKey: string | null }): Promise<string> {
  expect(job.r2ObjectKey).toBeTruthy();
  const object = await env.BUCKET.get(job.r2ObjectKey!);
  expect(object).not.toBeNull();
  return object!.text();
}

function csvRows(csv: string): string[] {
  return csv.split('\n');
}

describe('Admin reports (P13-3 / TOM-68)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tenants (id, name, slug, storage_quota_bytes) VALUES
           (?, 'Reports Corp', 'reports-corp', 100000),
           (?, 'Reports Other', 'reports-other', 50000),
           (?, 'Reports Cron', 'reports-cron', 25000)`
      ).bind(TENANT, OTHER_TENANT, CRON_TENANT),
      env.DB.prepare(
        `INSERT INTO tenant_policies (tenant_id) VALUES (?), (?), (?)`
      ).bind(TENANT, OTHER_TENANT, CRON_TENANT),
      env.DB.prepare(
        `INSERT INTO users (
           id, tenant_id, email, display_name, role, status, user_type,
           external_org, expires_at, last_login_at, storage_quota_bytes
         ) VALUES
           (?, ?, 'sys@reports.example.com', 'Reports Sys', 'sys_admin', 'active', 'member', NULL, NULL, '2026-11-16T10:00:00.000Z', NULL),
           (?, ?, 'member@reports.example.com', 'Reports Member', 'member', 'active', 'member', NULL, NULL, '2026-11-15T10:00:00.000Z', NULL),
           (?, ?, 'quota@reports.example.com', 'Reports Quota', 'member', 'suspended', 'member', NULL, NULL, NULL, 4096),
           (?, ?, 'guest@partner.example', 'Reports Guest', 'member', 'active', 'guest', 'Partner Inc', '2027-01-31T00:00:00.000Z', '2026-11-14T10:00:00.000Z', 1024),
           (?, ?, 'other-sys@reports.example.com', 'Other Sys', 'sys_admin', 'active', 'member', NULL, NULL, NULL, NULL),
           (?, ?, 'cron@reports.example.com', 'Cron User', 'sys_admin', 'active', 'member', NULL, NULL, NULL, NULL)`
      ).bind(
        SYS,
        TENANT,
        MEMBER,
        TENANT,
        MEMBER_QUOTA,
        TENANT,
        GUEST,
        TENANT,
        OTHER_SYS,
        OTHER_TENANT,
        CRON_USER,
        CRON_TENANT
      ),
      env.DB.prepare(
        `INSERT INTO user_storage_stats (
           tenant_id, user_id, file_count, total_bytes
         ) VALUES (?, ?, 3, 2048), (?, ?, 1, 512)`
      ).bind(TENANT, MEMBER, TENANT, GUEST),
      env.DB.prepare(
        `INSERT INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification,
           created_by, created_at, updated_at
         ) VALUES (
           'report-folder-target', ?, NULL, 'Reports Folder', 0, 1, 'internal',
           ?, '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z'
         )`
      ).bind(TENANT, SYS),
      env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, mime_type, size_bytes,
           upload_state, classification, created_by, updated_by,
           created_at, updated_at
         ) VALUES (
           ?, ?, NULL, 'quarterly.pdf', 'application/pdf', 4096,
           'active', 'internal', ?, ?, '2026-11-10T00:00:00.000Z',
           '2026-11-10T00:00:00.000Z'
         )`
      ).bind(TARGET_ID, TENANT, SYS, SYS),
      env.DB.prepare(
        `INSERT INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, permission_level, require_watermark, expires_at,
           max_downloads, download_count, created_by, revoked_at, created_at
         ) VALUES
           ('report-link-active', ?, 'report-hash-active', 'file', ?, 'company_only', 1, 'download', 0, '2027-01-01T00:00:00.000Z', 100, 4, ?, NULL, '2026-11-12T00:00:00.000Z'),
           ('report-link-expired', ?, 'report-hash-expired', 'folder', 'report-folder-target', 'public', 0, 'view', 1, '2026-11-16T00:00:00.000Z', NULL, 1, ?, NULL, '2026-11-11T00:00:00.000Z'),
           ('report-link-revoked', ?, 'report-hash-revoked', 'file', ?, 'collaborators_only', 1, 'edit', 0, NULL, 10, 9, ?, '2026-11-16T12:00:00.000Z', '2026-11-10T00:00:00.000Z')`
      ).bind(
        TENANT,
        TARGET_ID,
        SYS,
        TENANT,
        SYS,
        TENANT,
        TARGET_ID,
        SYS
      ),
    ]);

    // 450 audit rows exercise the 200-row keyset chunks (3 chunks).
    const actions = [
      'file.preview',
      'file.download',
      'file.update',
      'file.content_access_denied',
    ] as const;
    for (let start = 0; start < AUDIT_ROW_COUNT; start += 50) {
      const statements: D1PreparedStatement[] = [];
      for (let i = start; i < Math.min(start + 50, AUDIT_ROW_COUNT); i += 1) {
        const action = actions[i % actions.length]!;
        statements.push(
          env.DB.prepare(
            `INSERT INTO audit_logs (
               id, tenant_id, actor_id, actor_email, actor_ip, action,
               target_type, target_id, status, metadata_json, created_at
             ) VALUES (?, ?, ?, ?, '127.0.0.1', ?, 'file', ?, ?, ?, ?)`
          ).bind(
            `report-audit-${i}`,
            TENANT,
            i % 2 === 0 ? SYS : MEMBER,
            i % 2 === 0
              ? 'sys@reports.example.com'
              : 'member@reports.example.com',
            action,
            TARGET_ID,
            action === 'file.content_access_denied' ? 'blocked' : 'allowed',
            JSON.stringify({ index: i }),
            dayIso(i)
          )
        );
      }
      await env.DB.batch(statements);
    }
  });

  it('generates a 450-row user_activity report in 200-row chunks and stores it in R2', async () => {
    const created = await createAndCompleteJob('user_activity', {
      from: '2026-11-17',
      to: '2026-11-17',
      // Keep the report's own `admin.report.requested` audit row out of the
      // fixture count while still exercising the full file.* action set.
      actionPrefix: 'file.',
    });

    expect(created.job.rowCount).toBe(AUDIT_ROW_COUNT);
    expect(created.job.r2ObjectKey).toBe(
      `reports/${TENANT}/${created.jobId}.csv`
    );

    const csv = await readReportCsv(created.job);
    const rows = csvRows(csv);
    expect(rows).toHaveLength(AUDIT_ROW_COUNT + 1);
    expect(rows[0]).toBe(
      'id,created_at,action,status,actor_id,actor_email,actor_ip,target_type,target_id,classification_snapshot,metadata_json'
    );
    expect(rows.filter((row) => row.includes(TARGET_ID))).toHaveLength(
      AUDIT_ROW_COUNT
    );
    expect(rows[1]).toContain('report-audit-449');
    expect(rows[AUDIT_ROW_COUNT]).toContain('report-audit-0');
    expect(created.job.byteSize).toBe(new TextEncoder().encode(csv).byteLength);

    // The stored `to` boundary is the end of the requested calendar day.
    expect(created.job.filters.to).toBe('2026-11-17T23:59:59.999Z');
    expect(created.job.filters.from).toBe('2026-11-17T00:00:00.000Z');

    const generatedAudit = await env.DB.prepare(
      `SELECT action, target_id, status FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.report.generated' AND target_id = ?`
    )
      .bind(TENANT, created.jobId)
      .first<{ action: string; target_id: string; status: string }>();
    expect(generatedAudit).toEqual({
      action: 'admin.report.generated',
      target_id: created.jobId,
      status: 'allowed',
    });
  });

  it('supports exact actor/action-prefix/status filters without leaking other tenants', async () => {
    const filtered = await createAndCompleteJob('user_activity', {
      from: '2026-11-17',
      to: '2026-11-17',
      actorEmail: 'member@reports.example.com',
      actionPrefix: 'file.',
      status: 'blocked',
    });
    // Blocked rows are every index where `i % 4 === 3` (odd indexes), all
    // produced by the member actor in the fixture.
    expect(filtered.job.rowCount).toBe(112);

    const otherJob = await call('/api/admin/reports/jobs', OTHER_SYS, {
      method: 'POST',
      tenantId: OTHER_TENANT,
      body: { reportType: 'users_and_guests' },
    });
    expect(otherJob.status).toBe(202);
    const otherBody = (await otherJob.json()) as CreateJobResponse;
    await harness.drain();

    const fromOtherTenant = await call(
      `/api/admin/reports/jobs/${otherBody.jobId}/download`
    );
    expect(fromOtherTenant.status).toBe(404);

    const list = await call('/api/admin/reports/jobs');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { jobs: Array<{ id: string }> };
    expect(listBody.jobs.some((job) => job.id === otherBody.jobId)).toBe(false);
  });

  it('exports shared-link inventory with expiration and revocation state', async () => {
    const created = await createAndCompleteJob('shared_links_inventory');
    expect(created.job.rowCount).toBe(3);

    const csv = await readReportCsv(created.job);
    const rows = csvRows(csv);
    expect(rows[0]).toBe(
      'link_id,created_at,target_type,target_id,target_name,access_scope,permission_level,can_download,require_watermark,expires_at,max_downloads,download_count,creator_id,creator_email,revoked_at,status'
    );
    expect(rows.find((row) => row.includes('report-link-active'))).toContain(
      '"quarterly.pdf"'
    );
    expect(rows.find((row) => row.includes('report-link-active'))).toContain(
      '"active"'
    );
    expect(rows.find((row) => row.includes('report-link-expired'))).toContain(
      '"Reports Folder"'
    );
    expect(rows.find((row) => row.includes('report-link-expired'))).toContain(
      '"expired"'
    );
    expect(rows.find((row) => row.includes('report-link-revoked'))).toContain(
      '"revoked"'
    );
  });

  it('aggregates per-resource access statistics from chunked audit scans', async () => {
    const created = await createAndCompleteJob('access_stats', {
      from: '2026-11-17',
      to: '2026-11-17',
      targetId: TARGET_ID,
    });
    expect(created.job.rowCount).toBe(1);

    const csv = await readReportCsv(created.job);
    const rows = csvRows(csv);
    expect(rows[0]).toBe(
      'target_type,target_id,view_count,download_count,edit_count,denied_count,total_count,first_seen_at,last_seen_at'
    );
    expect(rows[1]).toBe(
      `"file","${TARGET_ID}","113","113","112","112","450","2026-11-17T00:00:00.000Z","2026-11-17T00:07:29.000Z"`
    );
  });

  it('exports members and guests with roles, quotas, usage and guest expiry', async () => {
    const created = await createAndCompleteJob('users_and_guests');
    expect(created.job.rowCount).toBe(4);

    const csv = await readReportCsv(created.job);
    const rows = csvRows(csv);
    expect(rows[0]).toBe(
      'user_id,email,display_name,user_type,role,status,external_org,last_login_at,quota_bytes,used_bytes,file_count,guest_expires_at,offboarded_at,created_at'
    );
    const guestRow = rows.find((row) => row.includes('guest@partner.example'));
    expect(guestRow).toContain('"Partner Inc"');
    expect(guestRow).toContain('"1024"');
    expect(guestRow).toContain('"2027-01-31T00:00:00.000Z"');
    const quotaRow = rows.find((row) => row.includes('quota@reports.example.com'));
    expect(quotaRow).toContain('"4096"');
    const memberRow = rows.find((row) =>
      row.includes('member@reports.example.com')
    );
    expect(memberRow).toContain('"2048"');
    expect(memberRow).toContain('"3"');
  });

  it('serves direct and signed downloads with audit, 409 and tenant isolation', async () => {
    const created = await createAndCompleteJob('users_and_guests');

    const direct = await call(
      `/api/admin/reports/jobs/${created.jobId}/download`
    );
    expect(direct.status).toBe(200);
    expect(direct.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(direct.headers.get('Cache-Control')).toBe('no-store');
    expect(direct.headers.get('Content-Disposition')).toContain(
      'attachment; filename='
    );
    const directCsv = await direct.text();
    expect(directCsv.split('\n')[0]).toContain('user_id,email');

    const downloadedAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.report.downloaded' AND target_id = ?`
    )
      .bind(TENANT, created.jobId)
      .first<{ count: number }>();
    expect(downloadedAudit?.count).toBe(1);

    const signedRes = await call(
      `/api/admin/reports/jobs/${created.jobId}/download?mode=url`
    );
    expect(signedRes.status).toBe(200);
    const signed = (await signedRes.json()) as {
      url: string;
      expiresAt: string;
      expiresInSeconds: number;
      filename: string;
    };
    expect(signed.url).toContain('/api/storage/proxy');
    expect(signed.url).toContain('sig=');
    expect(signed.expiresInSeconds).toBe(300);
    expect(signed.filename).toMatch(/\.csv$/);

    const signedDownload = await app.fetch(
      new Request(`http://127.0.0.1:8787${signed.url}`),
      harness.buildEnv()
    );
    expect(signedDownload.status).toBe(200);
    expect(await signedDownload.text()).toContain('user_id,email');

    const notReadyRes = await call('/api/admin/reports/jobs', SYS, {
      method: 'POST',
      body: { reportType: 'access_stats' },
    });
    expect(notReadyRes.status).toBe(202);
    const notReady = (await notReadyRes.json()) as CreateJobResponse;
    const notReadyDownload = await call(
      `/api/admin/reports/jobs/${notReady.jobId}/download`
    );
    expect(notReadyDownload.status).toBe(409);
    expect(await notReadyDownload.json()).toEqual({
      error: 'Report is not ready for download',
      code: 'REPORT_NOT_READY',
    });

    const memberList = await call('/api/admin/reports/jobs', MEMBER, {
      role: 'member',
    });
    expect(memberList.status).toBe(403);
    const memberDownload = await call(
      `/api/admin/reports/jobs/${created.jobId}/download`,
      MEMBER,
      { role: 'member' }
    );
    expect(memberDownload.status).toBe(403);
  });

  it('creates, toggles, runs and deletes recurring report schedules', async () => {
    const createRes = await call('/api/admin/reports/schedules', SYS, {
      method: 'POST',
      body: {
        name: 'Weekly users export',
        reportType: 'users_and_guests',
        cadence: 'weekly',
        retentionDays: 14,
        filters: { status: 'allowed' },
      },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      schedule: {
        id: string;
        enabled: boolean;
        nextRunAt: string;
        retentionDays: number;
        filters: Record<string, unknown>;
      };
    };
    expect(created.schedule.enabled).toBe(true);
    expect(created.schedule.retentionDays).toBe(14);
    expect(created.schedule.filters).toEqual({ status: 'allowed' });
    expect(Date.parse(created.schedule.nextRunAt)).toBeGreaterThan(Date.now());

    const toggleRes = await call(
      `/api/admin/reports/schedules/${created.schedule.id}`,
      SYS,
      { method: 'PATCH', body: { enabled: false } }
    );
    expect(toggleRes.status).toBe(200);
    const toggled = (await toggleRes.json()) as {
      schedule: { enabled: boolean };
    };
    expect(toggled.schedule.enabled).toBe(false);

    const runRes = await call(
      `/api/admin/reports/schedules/${created.schedule.id}/run`,
      SYS,
      { method: 'POST', body: {} }
    );
    expect(runRes.status).toBe(202);
    const runBody = (await runRes.json()) as CreateJobResponse;
    expect(runBody.jobId).toBeTruthy();
    await harness.drain();
    const runJob = await getAdminReportJob(env.DB, TENANT, runBody.jobId);
    expect(runJob?.status).toBe('completed');
    expect(runJob?.scheduleId).toBe(created.schedule.id);

    const listRes = await call('/api/admin/reports/schedules');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      schedules: Array<{ id: string; lastJobId: string | null }>;
    };
    expect(
      listBody.schedules.find((schedule) => schedule.id === created.schedule.id)
        ?.lastJobId
    ).toBe(runBody.jobId);

    const deleteRes = await call(
      `/api/admin/reports/schedules/${created.schedule.id}`,
      SYS,
      { method: 'DELETE' }
    );
    expect(deleteRes.status).toBe(200);
    const afterDelete = await call('/api/admin/reports/schedules');
    const afterDeleteBody = (await afterDelete.json()) as {
      schedules: Array<{ id: string }>;
    };
    expect(
      afterDeleteBody.schedules.some(
        (schedule) => schedule.id === created.schedule.id
      )
    ).toBe(false);

    const missing = await call(
      `/api/admin/reports/schedules/${created.schedule.id}`,
      SYS,
      { method: 'PATCH', body: { enabled: true } }
    );
    expect(missing.status).toBe(404);
  });

  it('Cron enqueues due schedules and purges expired R2 report objects', async () => {
    const cronNowIso = '2026-11-17T03:00:00.000Z';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO admin_report_schedules (
           id, tenant_id, name, report_type, cadence, enabled, filters_json,
           retention_days, next_run_at, created_by, created_at, updated_at
         ) VALUES (
           'report-cron-schedule', ?, 'Cron access stats', 'access_stats',
           'weekly', 1, '{}', 7, '2026-11-10T00:00:00.000Z', ?,
           '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'
         )`
      ).bind(CRON_TENANT, CRON_USER),
      env.DB.prepare(
        `INSERT INTO admin_report_jobs (
           id, tenant_id, report_type, status, filters_json, r2_object_key,
           row_count, byte_size, created_by, created_by_email, expires_at,
           created_at, updated_at
         ) VALUES (
           'report-cron-expired', ?, 'users_and_guests', 'completed', '{}',
           ?, 2, 10, ?, 'cron@reports.example.com',
           '2026-11-16T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
           '2026-11-01T00:00:00.000Z'
         )`
      ).bind(
        CRON_TENANT,
        `reports/${CRON_TENANT}/report-cron-expired.csv`,
        CRON_USER
      ),
    ]);
    await env.BUCKET.put(
      `reports/${CRON_TENANT}/report-cron-expired.csv`,
      'expired-report'
    );

    const summary = await runDailyMaintenance(
      harness.buildEnv(),
      new Date(cronNowIso)
    );
    expect(summary.adminReportSchedulesProcessed).toBeGreaterThanOrEqual(1);
    expect(summary.adminReportJobsEnqueued).toBeGreaterThanOrEqual(1);
    expect(summary.adminReportJobsPurged).toBeGreaterThanOrEqual(1);

    const schedule = await env.DB.prepare(
      `SELECT next_run_at, last_run_at, last_job_id
         FROM admin_report_schedules WHERE id = 'report-cron-schedule'`
    ).first<{
      next_run_at: string;
      last_run_at: string | null;
      last_job_id: string | null;
    }>();
    expect(schedule?.last_run_at).toBe(cronNowIso);
    expect(Date.parse(schedule!.next_run_at)).toBeGreaterThan(
      Date.parse(cronNowIso)
    );
    expect(schedule?.last_job_id).toBeTruthy();

    const cronJob = await getAdminReportJob(
      env.DB,
      CRON_TENANT,
      schedule!.last_job_id!
    );
    expect(cronJob).toMatchObject({
      status: 'queued',
      reportType: 'access_stats',
      scheduleId: 'report-cron-schedule',
    });
    expect(
      harness.queued.some(
        (message) =>
          message.type === 'generate_admin_report' &&
          message.jobId === schedule!.last_job_id
      )
    ).toBe(true);

    expect(
      await env.BUCKET.get(`reports/${CRON_TENANT}/report-cron-expired.csv`)
    ).toBeNull();
    const expiredRow = await env.DB.prepare(
      "SELECT id FROM admin_report_jobs WHERE id = 'report-cron-expired'"
    ).first<{ id: string }>();
    expect(expiredRow).toBeNull();

    // The Worker scheduled entrypoint still works with the new summary fields.
    const ctx = createExecutionContext();
    await expect(
      worker.scheduled?.(
        {
          cron: '0 3 * * *',
          scheduledTime: Date.parse(cronNowIso),
          noRetry: () => {},
        },
        harness.buildEnv(),
        ctx
      )
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});
