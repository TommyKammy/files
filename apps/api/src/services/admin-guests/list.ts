import { getGuestPolicy, isGuestDomainAllowed } from '../external-guests';
import {
  loadGuestDetail,
  type GuestDetail,
  type GuestLifecycleStatus,
} from '../guest-detail';
import {
  ADMIN_GUEST_STATUS_VALUES,
  type AdminGuestAggregations,
  type AdminGuestDomainSummary,
  type AdminGuestFilters,
  type AdminGuestInviterSummary,
  type AdminGuestListResult,
  type AdminGuestRow,
  type AdminGuestSortBy,
  type AdminGuestStatusFilter,
} from './types';

interface RawGuestRow {
  id: string;
  email: string;
  display_name: string;
  external_org: string | null;
  invited_by: string | null;
  inviter_name: string | null;
  inviter_email: string | null;
  expires_at: string | null;
  last_login_at: string | null;
  status: 'active' | 'suspended';
  computed_status: GuestLifecycleStatus;
  offboarded_at: string | null;
  offboarded_by: string | null;
  created_at: string;
  domain: string;
  pending_invite_count: number;
}

const GUEST_CTE = `
WITH guest_base AS (
  SELECT u.id,
         u.email,
         u.display_name,
         u.external_org,
         u.invited_by,
         u.expires_at,
         u.last_login_at,
         u.status,
         u.offboarded_at,
         u.offboarded_by,
         u.created_at,
         inviter.display_name AS inviter_name,
         inviter.email AS inviter_email,
         substr(lower(u.email), instr(lower(u.email), '@') + 1) AS domain,
         (
           SELECT COUNT(*)
             FROM guest_invitations gi
            WHERE gi.tenant_id = u.tenant_id
              AND gi.user_id = u.id
              AND gi.status = 'pending'
              AND gi.expires_at > ?
         ) AS pending_invite_count
    FROM users u
    LEFT JOIN users inviter ON inviter.id = u.invited_by
   WHERE u.tenant_id = ? AND u.user_type = 'guest'
),
guest_status AS (
  SELECT guest_base.*,
         CASE
           WHEN offboarded_at IS NOT NULL THEN 'offboarded'
           WHEN status <> 'active' THEN 'suspended'
           WHEN expires_at IS NOT NULL AND expires_at <= ? THEN 'expired'
           WHEN pending_invite_count > 0 AND last_login_at IS NULL THEN 'pending_invite'
           ELSE 'active'
         END AS computed_status
    FROM guest_base
)
`;

const SORT_COLUMNS: Record<AdminGuestSortBy, string> = {
  createdAt: 'created_at',
  lastLoginAt: 'last_login_at',
  expiresAt: 'expires_at',
  email: 'email',
  externalOrg: 'external_org',
};

function buildWhere(filters: AdminGuestFilters): {
  sql: string;
  binds: unknown[];
} {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (filters.query) {
    // `instr()` avoids SQLite/D1's small LIKE pattern-length limit, which a
    // perfectly ordinary long e-mail address can exceed. Search remains a
    // case-insensitive substring match.
    conditions.push(
      `(instr(lower(email), lower(?)) > 0
        OR instr(lower(display_name), lower(?)) > 0
        OR instr(lower(COALESCE(external_org, '')), lower(?)) > 0
        OR instr(lower(id), lower(?)) > 0)`
    );
    binds.push(
      filters.query,
      filters.query,
      filters.query,
      filters.query
    );
  }
  if (filters.status !== 'all') {
    conditions.push('computed_status = ?');
    binds.push(filters.status);
  }
  if (filters.domain) {
    conditions.push('domain = ?');
    binds.push(filters.domain);
  }
  if (filters.invitedBy) {
    conditions.push(
      `(invited_by = ?
        OR lower(COALESCE(inviter_email, '')) = lower(?)
        OR instr(lower(COALESCE(inviter_name, '')), lower(?)) > 0)`
    );
    binds.push(filters.invitedBy, filters.invitedBy, filters.invitedBy);
  }
  if (filters.expiresBefore) {
    conditions.push('expires_at IS NOT NULL AND expires_at <= ?');
    binds.push(filters.expiresBefore);
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    binds,
  };
}

function cteBinds(tenantId: string, nowIso: string): unknown[] {
  return [nowIso, tenantId, nowIso];
}

function projectRow(
  row: RawGuestRow,
  allowlist: readonly string[]
): AdminGuestRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    externalOrg: row.external_org,
    invitedBy: row.invited_by,
    invitedByName: row.inviter_name,
    invitedByEmail: row.inviter_email,
    expiresAt: row.expires_at,
    lastLoginAt: row.last_login_at,
    accountStatus: row.status,
    status: row.computed_status,
    offboardedAt: row.offboarded_at,
    offboardedBy: row.offboarded_by,
    domain: row.domain || null,
    allowedByPolicy: isGuestDomainAllowed(row.domain || null, allowlist),
    pendingInvitationCount: row.pending_invite_count,
    createdAt: row.created_at,
  };
}

const EMPTY_STATUS_COUNTS = (): Record<AdminGuestStatusFilter, number> => ({
  all: 0,
  active: 0,
  suspended: 0,
  expired: 0,
  pending_invite: 0,
  offboarded: 0,
});

export async function listAdminGuests(
  db: D1Database,
  tenantId: string,
  filters: AdminGuestFilters,
  nowIso = new Date().toISOString()
): Promise<AdminGuestListResult> {
  const policy = await getGuestPolicy(db, tenantId);
  const where = buildWhere(filters);
  const orderColumn = SORT_COLUMNS[filters.sortBy];
  const orderDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

  const [rows, totalRow, statusRes, domainRes, inviterRes] = await Promise.all([
    db
      .prepare(
        `${GUEST_CTE}
         SELECT guest_status.*
           FROM guest_status
           ${where.sql}
          ORDER BY ${orderColumn} IS NULL, ${orderColumn} ${orderDir}, id ASC
          LIMIT ? OFFSET ?`
      )
      .bind(
        ...cteBinds(tenantId, nowIso),
        ...where.binds,
        filters.limit,
        filters.offset
      )
      .all<RawGuestRow>(),
    db
      .prepare(
        `${GUEST_CTE}
         SELECT COUNT(*) AS total FROM guest_status ${where.sql}`
      )
      .bind(...cteBinds(tenantId, nowIso), ...where.binds)
      .first<{ total: number }>(),
    db
      .prepare(
        `${GUEST_CTE}
         SELECT computed_status AS status, COUNT(*) AS count
           FROM guest_status ${where.sql}
          GROUP BY computed_status`
      )
      .bind(...cteBinds(tenantId, nowIso), ...where.binds)
      .all<{ status: AdminGuestStatusFilter; count: number }>(),
    db
      .prepare(
        `${GUEST_CTE}
         SELECT domain,
                COUNT(*) AS count,
                SUM(CASE WHEN computed_status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN computed_status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
                SUM(CASE WHEN computed_status = 'expired' THEN 1 ELSE 0 END) AS expired
           FROM guest_status ${where.sql}
          GROUP BY domain
          ORDER BY count DESC, domain ASC`
      )
      .bind(...cteBinds(tenantId, nowIso), ...where.binds)
      .all<{
        domain: string;
        count: number;
        active: number | null;
        suspended: number | null;
        expired: number | null;
      }>(),
    db
      .prepare(
        `${GUEST_CTE}
         SELECT COALESCE(invited_by, 'unknown') AS inviter_id,
                COALESCE(inviter_name, invited_by, '不明な招待者') AS inviter_name,
                inviter_email,
                COUNT(*) AS count,
                SUM(CASE WHEN computed_status = 'active' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN computed_status = 'suspended' THEN 1 ELSE 0 END) AS suspended,
                SUM(CASE WHEN computed_status = 'expired' THEN 1 ELSE 0 END) AS expired
           FROM guest_status ${where.sql}
          GROUP BY invited_by, inviter_name, inviter_email
          ORDER BY count DESC, inviter_name ASC`
      )
      .bind(...cteBinds(tenantId, nowIso), ...where.binds)
      .all<{
        inviter_id: string;
        inviter_name: string;
        inviter_email: string | null;
        count: number;
        active: number | null;
        suspended: number | null;
        expired: number | null;
      }>(),
  ]);

  const guests = rows.results.map((row) =>
    projectRow(row, policy.externalDomainAllowlist)
  );
  const total = totalRow?.total ?? 0;
  const byStatus = EMPTY_STATUS_COUNTS();
  for (const row of statusRes.results) {
    if (ADMIN_GUEST_STATUS_VALUES.includes(row.status)) {
      byStatus[row.status] = row.count;
    }
  }
  byStatus.all = total;

  const byDomain: AdminGuestDomainSummary[] = domainRes.results.map((row) => ({
    domain: row.domain,
    count: row.count,
    active: row.active ?? 0,
    suspended: row.suspended ?? 0,
    expired: row.expired ?? 0,
    allowedByPolicy: isGuestDomainAllowed(
      row.domain,
      policy.externalDomainAllowlist
    ),
  }));

  const byInviter: AdminGuestInviterSummary[] = inviterRes.results.map(
    (row) => ({
      inviterId: row.inviter_id,
      inviterName: row.inviter_name,
      inviterEmail: row.inviter_email,
      count: row.count,
      active: row.active ?? 0,
      suspended: row.suspended ?? 0,
      expired: row.expired ?? 0,
    })
  );

  const aggregations: AdminGuestAggregations = {
    total,
    byStatus,
    byDomain,
    byInviter,
    disallowedDomainGuestCount: byDomain
      .filter((row) => !row.allowedByPolicy)
      .reduce((sum, row) => sum + row.count, 0),
  };

  return {
    guests,
    total,
    limit: filters.limit,
    offset: filters.offset,
    nextOffset:
      filters.offset + guests.length < total
        ? filters.offset + guests.length
        : null,
    sort: { by: filters.sortBy, dir: filters.sortDir },
    summary: aggregations,
    aggregations,
  };
}

/**
 * Spreadsheet formula injection defence. Excel/Sheets execute cells that start
 * with these characters even when they were produced by a server export.
 */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function buildAdminGuestCsv(guests: readonly AdminGuestRow[]): string {
  const header = [
    'id',
    'email',
    'display_name',
    'external_org',
    'domain',
    'allowed_by_policy',
    'status',
    'invited_by',
    'invited_by_email',
    'expires_at',
    'last_login_at',
    'offboarded_at',
    'created_at',
  ].join(',');
  const lines = guests.map((guest) =>
    [
      guest.id,
      guest.email,
      guest.displayName,
      guest.externalOrg,
      guest.domain,
      guest.allowedByPolicy ? 'yes' : 'no',
      guest.status,
      guest.invitedByName ?? guest.invitedBy,
      guest.invitedByEmail,
      guest.expiresAt,
      guest.lastLoginAt,
      guest.offboardedAt,
      guest.createdAt,
    ]
      .map(csvCell)
      .join(',')
  );
  return [header, ...lines].join('\n');
}

export async function loadAdminGuestDetail(
  db: D1Database,
  tenantId: string,
  guestId: string,
  nowIso = new Date().toISOString()
): Promise<
  | (GuestDetail & {
      permissions: {
        direct: GuestDetail['effectivePermissions'];
        inherited: GuestDetail['effectivePermissions'];
        directCount: number;
        inheritedCount: number;
      };
      recentAuditLogs: Array<{
        id: string;
        action: string;
        status: 'allowed' | 'blocked';
        actorEmail: string | null;
        actorIp: string | null;
        targetType: string | null;
        targetId: string | null;
        metadata: Record<string, unknown> | null;
        createdAt: string;
      }>;
    })
  | null
> {
  const detail = await loadGuestDetail(db, tenantId, guestId, { nowIso });
  if (!detail) return null;

  const auditRows = await db
    .prepare(
      `SELECT id, action, status, actor_email, actor_ip, target_type,
              target_id, metadata_json, created_at
         FROM audit_logs
        WHERE tenant_id = ?
          AND (
            target_id = ?
            OR json_extract(metadata_json, '$.guestUserId') = ?
            OR json_extract(metadata_json, '$.userId') = ?
          )
        ORDER BY created_at DESC, id DESC
        LIMIT 25`
    )
    .bind(tenantId, guestId, guestId, guestId)
    .all<{
      id: string;
      action: string;
      status: 'allowed' | 'blocked';
      actor_email: string | null;
      actor_ip: string | null;
      target_type: string | null;
      target_id: string | null;
      metadata_json: string | null;
      created_at: string;
    }>();

  const direct = detail.effectivePermissions.filter(
    (permission) => !permission.inherited
  );
  const inherited = detail.effectivePermissions.filter(
    (permission) => permission.inherited
  );

  return {
    ...detail,
    permissions: {
      direct,
      inherited,
      directCount: direct.length,
      inheritedCount: inherited.length,
    },
    recentAuditLogs: auditRows.results.map((row) => ({
      id: row.id,
      action: row.action,
      status: row.status,
      actorEmail: row.actor_email,
      actorIp: row.actor_ip,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata_json
        ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
        : null,
      createdAt: row.created_at,
    })),
  };
}

export function buildAdminGuestPermissionCsv(
  detail: GuestDetail
): string {
  const header = [
    'record_type',
    'item_type',
    'id',
    'name',
    'classification',
    'dlp_protected',
    'path_label',
    'role',
    'inherited',
    'inherited_from',
    'synthesized_role',
    'capabilities',
  ].join(',');
  const lines: string[] = [];
  for (const item of detail.sharedItems) {
    lines.push(
      [
        'shared_item',
        item.itemType,
        item.id,
        item.name,
        item.classification,
        item.dlpProtected ? 'yes' : 'no',
        item.pathLabel,
        item.effectiveRole,
        'no',
        '',
        item.synthesizedRole,
        item.capabilities.join('|'),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  for (const permission of detail.effectivePermissions) {
    lines.push(
      [
        'permission',
        permission.targetType,
        permission.targetId,
        permission.targetName,
        '',
        '',
        '',
        permission.role,
        permission.inherited ? 'yes' : 'no',
        permission.inheritedFromName,
        permission.synthesizedRole,
        permission.capabilities.join('|'),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return [header, ...lines].join('\n');
}
