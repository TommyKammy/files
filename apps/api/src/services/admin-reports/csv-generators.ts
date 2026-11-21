import {
  escapeAuditLikePrefix,
  splitAuditActionPrefixes,
} from '../audit-filters';
import {
  ADMIN_REPORT_MAX_ROWS,
  REPORT_CHUNK_SIZE,
  type AdminReportFilters,
  type AdminReportType,
} from './types';

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
