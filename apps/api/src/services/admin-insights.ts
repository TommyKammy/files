import type { ClassificationLabel } from '../types/api';

/**
 * P13-2 / TOM-67 admin insights (usage, security blocks and sharing risk).
 *
 * Every request-time aggregate is built here and exported so the
 * `EXPLAIN QUERY PLAN` regression test can prove that none of them fall back
 * to a full `files` / `audit_logs` / `shared_links` scan. The only unbounded
 * reads are O(1) or tenant-partitioned indexes such as
 * `tenant_storage_stats`, `tenant_daily_insights` and `active_file_locks`.
 */

export const ADMIN_INSIGHTS_RANGE_DAYS = [7, 30] as const;
export type AdminInsightsRangeDays = (typeof ADMIN_INSIGHTS_RANGE_DAYS)[number];

export const ADMIN_INSIGHTS_DEFAULT_DAYS: AdminInsightsRangeDays = 7;

/** Actions written by the download/preview content access paths. */
export const FILE_DOWNLOAD_AUDIT_ACTIONS = [
  'file.download',
  'file.version.download',
  'shared_link.download',
] as const;

const DAY_MS = 86_400_000;

export class AdminInsightsError extends Error {
  constructor(
    public readonly status: 400,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminInsightsError';
  }
}

export interface AdminInsightsQuery {
  name: string;
  sql: string;
  binds: Array<string | number>;
}

export interface TenantDailyInsightsResult {
  tenantId: string;
  dayUtc: string;
  activeUsersCount: number;
  activeGuestsCount: number;
  newFilesCount: number;
  downloadsCount: number;
  sharedLinksCreatedCount: number;
  blockedAuditCount: number;
  usedBytesSnapshot: number;
  totalFilesSnapshot: number;
  updatedAt: string;
}

export interface AdminInsightsBlockedAction {
  action: string;
  count: number;
}

export interface AdminInsightsTrendPoint {
  day: string;
  activeUsers: number;
  activeGuests: number;
  newFiles: number;
  downloads: number;
  sharedLinksCreated: number;
  blockedAudits: number;
  usedBytesSnapshot: number;
  totalFilesSnapshot: number;
}

export interface AdminInsightsStorageSummary {
  quotaBytes: number;
  usedBytes: number;
  remainingBytes: number;
  totalFiles: number;
  byClassification: Record<
    ClassificationLabel,
    { fileCount: number; totalBytes: number }
  >;
  d1EstimatedBytes: number | null;
  quotaWarnThresholdPct: number;
  quotaCriticalThresholdPct: number;
}

export interface AdminInsightsResponse {
  rangeDays: AdminInsightsRangeDays;
  generatedAt: string;
  storage: AdminInsightsStorageSummary;
  security: {
    blocked7dCount: number;
    blocked30dCount: number;
    blockedRecentCount: number;
    blockedByAction: AdminInsightsBlockedAction[];
    unsetSharedFilesCount: number;
    activeSharedLinksCount: number;
    publicSharedLinksCount: number;
    activeFileLocksCount: number;
    expiringGuestsCount: number;
  };
  collaboration: {
    activeMembers: number;
    suspendedMembers: number;
    activeGuests: number;
    expiringGuests72h: number;
    groupsCount: number;
    activeSessionsCount: number;
  };
  trends: AdminInsightsTrendPoint[];
}

export function isAdminInsightsRangeDays(
  value: unknown
): value is AdminInsightsRangeDays {
  return value === 7 || value === 30;
}

/**
 * Query-string parser shared by the route. Missing values keep the historical
 * seven-day default; anything else is rejected as an explicit 400 instead of
 * silently widening the scan window.
 */
export function parseAdminInsightsRangeDays(
  raw: string | null | undefined
): AdminInsightsRangeDays {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return ADMIN_INSIGHTS_DEFAULT_DAYS;
  }
  const parsed = Number(raw);
  if (!isAdminInsightsRangeDays(parsed)) {
    throw new AdminInsightsError(
      400,
      'INVALID_INSIGHTS_RANGE',
      'days must be 7 or 30'
    );
  }
  return parsed;
}

/** `YYYY-MM-DD` for the UTC day that contains `date`. */
export function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addUtcDays(dayUtc: string, delta: number): string {
  const base = Date.parse(`${dayUtc}T00:00:00.000Z`);
  if (!Number.isFinite(base)) {
    throw new AdminInsightsError(
      400,
      'INVALID_INSIGHTS_DAY',
      'dayUtc must be YYYY-MM-DD'
    );
  }
  return new Date(base + delta * DAY_MS).toISOString().slice(0, 10);
}

function dayBounds(dayUtc: string): { startIso: string; endIso: string } {
  const normalized = new Date(`${dayUtc}T00:00:00.000Z`);
  if (!Number.isFinite(normalized.getTime())) {
    throw new AdminInsightsError(
      400,
      'INVALID_INSIGHTS_DAY',
      'dayUtc must be YYYY-MM-DD'
    );
  }
  const day = normalized.toISOString().slice(0, 10);
  return {
    startIso: `${day}T00:00:00.000Z`,
    endIso: `${addUtcDays(day, 1)}T00:00:00.000Z`,
  };
}

function bindQuery(
  name: string,
  sql: string,
  binds: Array<string | number>
): AdminInsightsQuery {
  return { name, sql, binds };
}

/**
 * The five bounded scans used by both the daily Cron upsert and today's
 * partial trend point. `files` uses `idx_files_active_created`, `audit_logs`
 * uses `idx_audit_logs_tenant_time`, and `shared_links` uses
 * `idx_shared_links_tenant_created` (all range predicates on day bounds).
 */
export function buildTenantDailyAggregationQueries(input: {
  tenantId: string;
  dayUtc: string;
}): AdminInsightsQuery[] {
  const { tenantId } = input;
  const { startIso, endIso } = dayBounds(input.dayUtc);
  const downloadActions = FILE_DOWNLOAD_AUDIT_ACTIONS.map(
    (action) => `'${action}'`
  ).join(', ');

  return [
    bindQuery(
      'storageSnapshot',
      `SELECT COALESCE(SUM(file_count), 0) AS total_files,
              COALESCE(SUM(total_bytes), 0) AS used_bytes
         FROM tenant_storage_stats
        WHERE tenant_id = ?`,
      [tenantId]
    ),
    bindQuery(
      'newFiles',
      `SELECT COUNT(*) AS count
         FROM files
        WHERE tenant_id = ?
          AND created_at >= ?
          AND created_at < ?
          AND deleted_at IS NULL
          AND upload_state = 'active'`,
      [tenantId, startIso, endIso]
    ),
    bindQuery(
      'auditMetrics',
      `SELECT COALESCE(SUM(CASE
                WHEN action IN (${downloadActions})
                THEN 1 ELSE 0 END), 0) AS downloads,
              COALESCE(SUM(CASE
                WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked
         FROM audit_logs
        WHERE tenant_id = ?
          AND created_at >= ?
          AND created_at < ?`,
      [tenantId, startIso, endIso]
    ),
    bindQuery(
      'sharedLinksCreated',
      `SELECT COUNT(*) AS count
         FROM shared_links
        WHERE tenant_id = ?
          AND created_at >= ?
          AND created_at < ?`,
      [tenantId, startIso, endIso]
    ),
    bindQuery(
      'activeUsers',
      `SELECT COUNT(DISTINCT CASE
                WHEN users.user_type = 'member' THEN audit_logs.actor_id
              END) AS active_users,
              COUNT(DISTINCT CASE
                WHEN users.user_type = 'guest' THEN audit_logs.actor_id
              END) AS active_guests
         FROM audit_logs
         LEFT JOIN users ON users.id = audit_logs.actor_id
        WHERE audit_logs.tenant_id = ?
          AND audit_logs.created_at >= ?
          AND audit_logs.created_at < ?
          AND audit_logs.actor_id IS NOT NULL`,
      [tenantId, startIso, endIso]
    ),
  ];
}

/**
 * Every SQL statement executed by `GET /api/admin/insights`.
 *
 * Keep the statements free of dynamic identifiers so the EXPLAIN test can
 * bind and inspect the exact production SQL.
 */
export function buildAdminInsightsQueries(input: {
  tenantId: string;
  rangeDays: AdminInsightsRangeDays;
  now: Date;
}): AdminInsightsQuery[] {
  const { tenantId, rangeDays, now } = input;
  const nowIso = now.toISOString();
  const todayDay = toUtcDay(now);
  const historyStartDay = addUtcDays(todayDay, -(rangeDays - 1));
  const sevenDayStartIso = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const thirtyDayStartIso = new Date(
    now.getTime() - 30 * DAY_MS
  ).toISOString();
  const rangeStartIso =
    rangeDays === 7 ? sevenDayStartIso : thirtyDayStartIso;
  const expiringCutoffIso = new Date(
    now.getTime() + 72 * 3_600_000
  ).toISOString();
  const todayQueries = buildTenantDailyAggregationQueries({
    tenantId,
    dayUtc: todayDay,
  });

  return [
    bindQuery(
      'storageStats',
      `SELECT classification, file_count, total_bytes
         FROM tenant_storage_stats
        WHERE tenant_id = ?`,
      [tenantId]
    ),
    bindQuery(
      'tenantQuota',
      `SELECT t.storage_quota_bytes,
              p.quota_warn_threshold_pct,
              p.quota_critical_threshold_pct
         FROM tenants t
         LEFT JOIN tenant_policies p ON p.tenant_id = t.id
        WHERE t.id = ?`,
      [tenantId]
    ),
    bindQuery(
      'blockedCounts',
      `SELECT COALESCE(SUM(CASE
                WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS blocked_7d,
              COUNT(*) AS blocked_30d
         FROM audit_logs
        WHERE tenant_id = ?
          AND status = 'blocked'
          AND created_at >= ?
          AND created_at < ?`,
      [sevenDayStartIso, tenantId, thirtyDayStartIso, nowIso]
    ),
    bindQuery(
      'blockedByAction',
      `SELECT action, COUNT(*) AS count
         FROM audit_logs
        WHERE tenant_id = ?
          AND status = 'blocked'
          AND created_at >= ?
          AND created_at < ?
        GROUP BY action
        ORDER BY count DESC, action ASC`,
      [tenantId, rangeStartIso, nowIso]
    ),
    bindQuery(
      'unsetSharedFiles',
      `SELECT COUNT(DISTINCT shared_links.target_id) AS count
         FROM shared_links
         JOIN files ON files.id = shared_links.target_id
        WHERE shared_links.tenant_id = ?
          AND shared_links.revoked_at IS NULL
          AND shared_links.target_type = 'file'
          AND (shared_links.expires_at IS NULL OR shared_links.expires_at > ?)
          AND files.classification = 'unset'
          AND files.deleted_at IS NULL
          AND files.upload_state = 'active'`,
      [tenantId, nowIso]
    ),
    bindQuery(
      'activeSharedLinks',
      `SELECT COUNT(*) AS active_count,
              COALESCE(SUM(CASE
                WHEN access_scope = 'public' THEN 1 ELSE 0 END), 0) AS public_count
         FROM shared_links
        WHERE tenant_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`,
      [tenantId, nowIso]
    ),
    bindQuery(
      'activeFileLocks',
      `SELECT COUNT(*) AS count
         FROM active_file_locks
        WHERE tenant_id = ?
          AND expires_at > ?`,
      [tenantId, nowIso]
    ),
    bindQuery(
      'userCounts',
      `SELECT COALESCE(SUM(CASE
                WHEN user_type = 'member' AND status = 'active'
                THEN 1 ELSE 0 END), 0) AS active_members,
              COALESCE(SUM(CASE
                WHEN user_type = 'member' AND status = 'suspended'
                THEN 1 ELSE 0 END), 0) AS suspended_members,
              COALESCE(SUM(CASE
                WHEN user_type = 'guest' AND status = 'active'
                 AND offboarded_at IS NULL
                 AND (expires_at IS NULL OR expires_at > ?)
                THEN 1 ELSE 0 END), 0) AS active_guests,
              COALESCE(SUM(CASE
                WHEN user_type = 'guest' AND status = 'active'
                 AND offboarded_at IS NULL
                 AND expires_at > ?
                 AND expires_at <= ?
                THEN 1 ELSE 0 END), 0) AS expiring_guests
         FROM users
        WHERE tenant_id = ?`,
      [nowIso, nowIso, expiringCutoffIso, tenantId]
    ),
    bindQuery(
      'groupsCount',
      `SELECT COUNT(*) AS count
         FROM groups
        WHERE tenant_id = ?`,
      [tenantId]
    ),
    bindQuery(
      'activeSessions',
      `SELECT COUNT(*) AS count
         FROM sessions
        WHERE tenant_id = ?
          AND revoked_at IS NULL
          AND expires_at > ?`,
      [tenantId, nowIso]
    ),
    bindQuery(
      'dailyTrends',
      `SELECT day_utc,
              active_users_count,
              active_guests_count,
              new_files_count,
              downloads_count,
              shared_links_created_count,
              blocked_audit_count,
              used_bytes_snapshot,
              total_files_snapshot
         FROM tenant_daily_insights
        WHERE tenant_id = ?
          AND day_utc >= ?
          AND day_utc <= ?
        ORDER BY day_utc ASC`,
      [tenantId, historyStartDay, todayDay]
    ),
    ...todayQueries.map((query) => ({
      ...query,
      name: `today.${query.name}`,
    })),
  ];
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface RawTrendRow {
  day_utc: string;
  active_users_count: number;
  active_guests_count: number;
  new_files_count: number;
  downloads_count: number;
  shared_links_created_count: number;
  blocked_audit_count: number;
  used_bytes_snapshot: number;
  total_files_snapshot: number;
}

interface RawStorageStatRow {
  classification: string;
  file_count: number;
  total_bytes: number;
}

export async function aggregateTenantDailyInsights(
  db: D1Database,
  tenantId: string,
  dayUtc: string,
  now: Date = new Date()
): Promise<TenantDailyInsightsResult> {
  const nowIso = now.toISOString();
  const queries = buildTenantDailyAggregationQueries({ tenantId, dayUtc });
  const batch = await db.batch(
    queries.map((query) => db.prepare(query.sql).bind(...query.binds))
  );
  const rows = new Map<string, Record<string, unknown>[]>();
  for (let index = 0; index < queries.length; index += 1) {
    rows.set(
      queries[index]!.name,
      (batch[index]?.results ?? []) as Record<string, unknown>[]
    );
  }

  const storage = rows.get('storageSnapshot')?.[0] ?? {};
  const result: TenantDailyInsightsResult = {
    tenantId,
    dayUtc,
    activeUsersCount: asNumber(rows.get('activeUsers')?.[0]?.active_users),
    activeGuestsCount: asNumber(rows.get('activeUsers')?.[0]?.active_guests),
    newFilesCount: asNumber(rows.get('newFiles')?.[0]?.count),
    downloadsCount: asNumber(rows.get('auditMetrics')?.[0]?.downloads),
    sharedLinksCreatedCount: asNumber(
      rows.get('sharedLinksCreated')?.[0]?.count
    ),
    blockedAuditCount: asNumber(rows.get('auditMetrics')?.[0]?.blocked),
    usedBytesSnapshot: asNumber(storage.used_bytes),
    totalFilesSnapshot: asNumber(storage.total_files),
    updatedAt: nowIso,
  };

  await db
    .prepare(
      `INSERT INTO tenant_daily_insights (
         tenant_id, day_utc, active_users_count, active_guests_count,
         new_files_count, downloads_count, shared_links_created_count,
         blocked_audit_count, used_bytes_snapshot, total_files_snapshot,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, day_utc) DO UPDATE SET
         active_users_count = excluded.active_users_count,
         active_guests_count = excluded.active_guests_count,
         new_files_count = excluded.new_files_count,
         downloads_count = excluded.downloads_count,
         shared_links_created_count = excluded.shared_links_created_count,
         blocked_audit_count = excluded.blocked_audit_count,
         used_bytes_snapshot = excluded.used_bytes_snapshot,
         total_files_snapshot = excluded.total_files_snapshot,
         updated_at = excluded.updated_at`
    )
    .bind(
      result.tenantId,
      result.dayUtc,
      result.activeUsersCount,
      result.activeGuestsCount,
      result.newFilesCount,
      result.downloadsCount,
      result.sharedLinksCreatedCount,
      result.blockedAuditCount,
      result.usedBytesSnapshot,
      result.totalFilesSnapshot,
      result.updatedAt
    )
    .run();

  return result;
}

/**
 * Daily Cron entrypoint: refresh yesterday and today for every tenant.
 *
 * Yesterday is refreshed again because late-arriving audit rows (for example
 * a WOPI finalization near midnight) are still queryable the next morning.
 * The UPSERT makes repeated runs idempotent.
 */
export async function runDailyInsightsAggregation(
  db: D1Database,
  now: Date = new Date()
): Promise<{ tenantsProcessed: number; daysAggregated: number }> {
  const todayDay = toUtcDay(now);
  const yesterdayDay = addUtcDays(todayDay, -1);
  const tenants = await db
    .prepare('SELECT id FROM tenants ORDER BY id')
    .all<{ id: string }>();

  let daysAggregated = 0;
  for (const tenant of tenants.results) {
    await aggregateTenantDailyInsights(db, tenant.id, yesterdayDay, now);
    daysAggregated += 1;
    await aggregateTenantDailyInsights(db, tenant.id, todayDay, now);
    daysAggregated += 1;
  }

  return {
    tenantsProcessed: tenants.results.length,
    daysAggregated,
  };
}

function emptyStorageSummary(): AdminInsightsStorageSummary {
  return {
    quotaBytes: 0,
    usedBytes: 0,
    remainingBytes: 0,
    totalFiles: 0,
    byClassification: {
      confidential: { fileCount: 0, totalBytes: 0 },
      internal: { fileCount: 0, totalBytes: 0 },
      public: { fileCount: 0, totalBytes: 0 },
      unset: { fileCount: 0, totalBytes: 0 },
    },
    d1EstimatedBytes: null,
    quotaWarnThresholdPct: 80,
    quotaCriticalThresholdPct: 90,
  };
}

export async function getAdminInsights(
  db: D1Database,
  tenantId: string,
  rangeDays: AdminInsightsRangeDays,
  now: Date = new Date()
): Promise<AdminInsightsResponse> {
  if (!isAdminInsightsRangeDays(rangeDays)) {
    throw new AdminInsightsError(
      400,
      'INVALID_INSIGHTS_RANGE',
      'days must be 7 or 30'
    );
  }

  const nowIso = now.toISOString();
  const todayDay = toUtcDay(now);
  const historyStartDay = addUtcDays(todayDay, -(rangeDays - 1));
  const queries = buildAdminInsightsQueries({ tenantId, rangeDays, now });
  const batch = await db.batch(
    queries.map((query) => db.prepare(query.sql).bind(...query.binds))
  );
  const rows = new Map<string, Record<string, unknown>[]>();
  for (let index = 0; index < queries.length; index += 1) {
    rows.set(
      queries[index]!.name,
      (batch[index]?.results ?? []) as Record<string, unknown>[]
    );
  }

  const storage = emptyStorageSummary();
  for (const row of (rows.get('storageStats') ?? []) as unknown as RawStorageStatRow[]) {
    if (row.classification in storage.byClassification) {
      storage.byClassification[row.classification as ClassificationLabel] = {
        fileCount: asNumber(row.file_count),
        totalBytes: asNumber(row.total_bytes),
      };
    }
    storage.totalFiles += asNumber(row.file_count);
    storage.usedBytes += asNumber(row.total_bytes);
  }
  const quotaRow = rows.get('tenantQuota')?.[0];
  storage.quotaBytes = asNumber(quotaRow?.storage_quota_bytes);
  storage.quotaWarnThresholdPct =
    asNumber(quotaRow?.quota_warn_threshold_pct) || 80;
  storage.quotaCriticalThresholdPct =
    asNumber(quotaRow?.quota_critical_threshold_pct) || 90;
  storage.remainingBytes = Math.max(
    0,
    storage.quotaBytes - storage.usedBytes
  );

  try {
    const dbSize = await db
      .prepare(
        'SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS db_bytes'
      )
      .first<{ db_bytes: number }>();
    if (
      typeof dbSize?.db_bytes === 'number' &&
      Number.isFinite(dbSize.db_bytes)
    ) {
      storage.d1EstimatedBytes = dbSize.db_bytes;
    }
  } catch {
    storage.d1EstimatedBytes = null;
  }

  const blockedCounts = rows.get('blockedCounts')?.[0] ?? {};
  const blocked7dCount = asNumber(blockedCounts.blocked_7d);
  const blocked30dCount = asNumber(blockedCounts.blocked_30d);
  const blockedByAction: AdminInsightsBlockedAction[] = (
    rows.get('blockedByAction') ?? []
  ).map((row) => ({
    action: typeof row.action === 'string' ? row.action : 'unknown',
    count: asNumber(row.count),
  }));
  const activeSharedLinks = rows.get('activeSharedLinks')?.[0] ?? {};
  const activeFileLocksCount = asNumber(
    rows.get('activeFileLocks')?.[0]?.count
  );
  const userCounts = rows.get('userCounts')?.[0] ?? {};

  const trendRows = new Map<string, RawTrendRow>();
  for (const row of (rows.get('dailyTrends') ??
    []) as unknown as RawTrendRow[]) {
    trendRows.set(row.day_utc, row);
  }

  const todayNewFiles = asNumber(rows.get('today.newFiles')?.[0]?.count);
  const todayAuditMetrics = rows.get('today.auditMetrics')?.[0] ?? {};
  const todaySharedLinks = asNumber(
    rows.get('today.sharedLinksCreated')?.[0]?.count
  );
  const todayActiveUsers = rows.get('today.activeUsers')?.[0] ?? {};

  const trends: AdminInsightsTrendPoint[] = [];
  let lastUsedBytes = 0;
  let lastTotalFiles = 0;
  for (let offset = 0; offset < rangeDays; offset += 1) {
    const day = addUtcDays(historyStartDay, offset);
    const stored = trendRows.get(day);
    if (stored) {
      lastUsedBytes = asNumber(stored.used_bytes_snapshot);
      lastTotalFiles = asNumber(stored.total_files_snapshot);
    }

    if (day === todayDay) {
      trends.push({
        day,
        activeUsers: asNumber(todayActiveUsers.active_users),
        activeGuests: asNumber(todayActiveUsers.active_guests),
        newFiles: todayNewFiles,
        downloads: asNumber(todayAuditMetrics.downloads),
        sharedLinksCreated: todaySharedLinks,
        blockedAudits: asNumber(todayAuditMetrics.blocked),
        usedBytesSnapshot: storage.usedBytes,
        totalFilesSnapshot: storage.totalFiles,
      });
      continue;
    }

    trends.push({
      day,
      activeUsers: asNumber(stored?.active_users_count),
      activeGuests: asNumber(stored?.active_guests_count),
      newFiles: asNumber(stored?.new_files_count),
      downloads: asNumber(stored?.downloads_count),
      sharedLinksCreated: asNumber(stored?.shared_links_created_count),
      blockedAudits: asNumber(stored?.blocked_audit_count),
      usedBytesSnapshot: lastUsedBytes,
      totalFilesSnapshot: lastTotalFiles,
    });
  }

  return {
    rangeDays,
    generatedAt: nowIso,
    storage,
    security: {
      blocked7dCount,
      blocked30dCount,
      blockedRecentCount:
        rangeDays === 7 ? blocked7dCount : blocked30dCount,
      blockedByAction,
      unsetSharedFilesCount: asNumber(
        rows.get('unsetSharedFiles')?.[0]?.count
      ),
      activeSharedLinksCount: asNumber(activeSharedLinks.active_count),
      publicSharedLinksCount: asNumber(activeSharedLinks.public_count),
      activeFileLocksCount,
      expiringGuestsCount: asNumber(userCounts.expiring_guests),
    },
    collaboration: {
      activeMembers: asNumber(userCounts.active_members),
      suspendedMembers: asNumber(userCounts.suspended_members),
      activeGuests: asNumber(userCounts.active_guests),
      expiringGuests72h: asNumber(userCounts.expiring_guests),
      groupsCount: asNumber(rows.get('groupsCount')?.[0]?.count),
      activeSessionsCount: asNumber(rows.get('activeSessions')?.[0]?.count),
    },
    trends,
  };
}
