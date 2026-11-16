import type { AuthUser, Env } from '../types/api';
import {
  AdminBulkIdempotencyError,
  beginAdminBulkOperation,
  resolveIdempotencyKey,
  type IdempotencySession,
} from './admin-bulk-idempotency';
import { buildAuditLogStmt } from './audit';
import { executeGroupedBatches } from './d1-batch';
import {
  emailDomain,
  getGuestPolicy,
  isGuestDomainAllowed,
  isGuestEmailDomainAllowed,
  type ExternalDomainExistingGuestMode,
} from './external-guests';
import { buildGuestInvitationMailPreview } from './guest-collaboration';
import {
  loadGuestDetail,
  loadGuestInvitation,
  type GuestDetail,
  type GuestInvitationRow,
  type GuestLifecycleStatus,
} from './guest-detail';
import {
  MailDeliveryError,
  MailProviderConfigurationError,
  resolveMailProvider,
} from './mail-provider';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';
import { generateRandomToken, sha256Hex } from './crypto-utils';

/**
 * P10-3 / TOM-61 tenant-admin guest lifecycle service.
 *
 * Every mutating operation accepts an optional idempotency key and reuses the
 * TOM-57 durable idempotency table, so an HTTP retry cannot produce a second
 * audit entry or rotate a token twice.
 */

export type AdminGuestStatusFilter =
  | 'all'
  | 'active'
  | 'suspended'
  | 'expired'
  | 'pending_invite'
  | 'offboarded';
export type AdminGuestSortBy =
  | 'createdAt'
  | 'lastLoginAt'
  | 'expiresAt'
  | 'email'
  | 'externalOrg';
export type AdminGuestSortDir = 'asc' | 'desc';

export interface AdminGuestFilters {
  query: string | null;
  status: AdminGuestStatusFilter;
  domain: string | null;
  invitedBy: string | null;
  expiresBefore: string | null;
  sortBy: AdminGuestSortBy;
  sortDir: AdminGuestSortDir;
  limit: number;
  offset: number;
}

export interface AdminGuestRow {
  id: string;
  email: string;
  displayName: string;
  externalOrg: string | null;
  invitedBy: string | null;
  invitedByName: string | null;
  invitedByEmail: string | null;
  expiresAt: string | null;
  lastLoginAt: string | null;
  accountStatus: 'active' | 'suspended';
  status: GuestLifecycleStatus;
  offboardedAt: string | null;
  offboardedBy: string | null;
  domain: string | null;
  allowedByPolicy: boolean;
  pendingInvitationCount: number;
  createdAt: string;
}

export interface AdminGuestDomainSummary {
  domain: string;
  count: number;
  active: number;
  suspended: number;
  expired: number;
  allowedByPolicy: boolean;
}

export interface AdminGuestInviterSummary {
  inviterId: string;
  inviterName: string;
  inviterEmail: string | null;
  count: number;
  active: number;
  suspended: number;
  expired: number;
}

export interface AdminGuestAggregations {
  total: number;
  byStatus: Record<AdminGuestStatusFilter, number>;
  byDomain: AdminGuestDomainSummary[];
  byInviter: AdminGuestInviterSummary[];
  disallowedDomainGuestCount: number;
}

export interface AdminGuestListResult {
  guests: AdminGuestRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  sort: { by: AdminGuestSortBy; dir: AdminGuestSortDir };
  summary: AdminGuestAggregations;
  aggregations: AdminGuestAggregations;
}

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

const STATUS_VALUES: AdminGuestStatusFilter[] = [
  'all',
  'active',
  'suspended',
  'expired',
  'pending_invite',
  'offboarded',
];

const SORT_BY_VALUES: AdminGuestSortBy[] = [
  'createdAt',
  'lastLoginAt',
  'expiresAt',
  'email',
  'externalOrg',
];

export function isAdminGuestStatusFilter(
  value: unknown
): value is AdminGuestStatusFilter {
  return (
    typeof value === 'string' &&
    (STATUS_VALUES as readonly string[]).includes(value)
  );
}

export function isAdminGuestSortBy(value: unknown): value is AdminGuestSortBy {
  return (
    typeof value === 'string' &&
    (SORT_BY_VALUES as readonly string[]).includes(value)
  );
}

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

  const guests = rows.results.map((row) => projectRow(row, policy.externalDomainAllowlist));
  const total = totalRow?.total ?? 0;
  const byStatus = EMPTY_STATUS_COUNTS();
  for (const row of statusRes.results) {
    if (STATUS_VALUES.includes(row.status)) byStatus[row.status] = row.count;
  }
  byStatus.all = total;

  const byDomain: AdminGuestDomainSummary[] = domainRes.results.map((row) => ({
    domain: row.domain,
    count: row.count,
    active: row.active ?? 0,
    suspended: row.suspended ?? 0,
    expired: row.expired ?? 0,
    allowedByPolicy: isGuestDomainAllowed(row.domain, policy.externalDomainAllowlist),
  }));

  const byInviter: AdminGuestInviterSummary[] = inviterRes.results.map((row) => ({
    inviterId: row.inviter_id,
    inviterName: row.inviter_name,
    inviterEmail: row.inviter_email,
    count: row.count,
    active: row.active ?? 0,
    suspended: row.suspended ?? 0,
    expired: row.expired ?? 0,
  }));

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

export class AdminGuestError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 410 | 502 | 503,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminGuestError';
  }
}

interface GuestAccountRow {
  id: string;
  email: string;
  display_name: string;
  external_org: string | null;
  status: 'active' | 'suspended';
  expires_at: string | null;
  offboarded_at: string | null;
  invited_by: string | null;
}

async function loadGuestAccount(
  db: D1Database,
  tenantId: string,
  guestId: string
): Promise<GuestAccountRow> {
  const guest = await db
    .prepare(
      `SELECT id, email, display_name, external_org, status, expires_at,
              offboarded_at, invited_by
         FROM users
        WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
    )
    .bind(tenantId, guestId)
    .first<GuestAccountRow>();
  if (!guest) {
    throw new AdminGuestError(
      404,
      'GUEST_NOT_FOUND',
      'Guest account not found'
    );
  }
  return guest;
}

function operationPayload(guestId: string, body?: unknown): unknown {
  return { guestId, body: body ?? null };
}

async function beginGuestOperation<T>(
  db: D1Database,
  tenantId: string,
  operation: string,
  guestId: string,
  idempotencyKey: string | null,
  body?: unknown
): Promise<IdempotencySession<T>> {
  return beginAdminBulkOperation<T>({
    db,
    tenantId,
    operation,
    idempotencyKey,
    payload: operationPayload(guestId, body),
  });
}

export { AdminBulkIdempotencyError, resolveIdempotencyKey };

export async function suspendAdminGuest(input: {
  db: D1Database;
  tenantId: string;
  guestId: string;
  actor: AuthUser;
  idempotencyKey?: string | null;
}): Promise<Record<string, unknown>> {
  const { db, tenantId, guestId, actor } = input;
  const guest = await loadGuestAccount(db, tenantId, guestId);
  const session = await beginGuestOperation<Record<string, unknown>>(
    db,
    tenantId,
    'admin.guest.suspend',
    guestId,
    input.idempotencyKey ?? null
  );
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    if (guest.offboarded_at) {
      throw new AdminGuestError(
        409,
        'GUEST_OFFBOARDED',
        'Guest account has been offboarded'
      );
    }

    const nowIso = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = 'suspended', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
        )
        .bind(nowIso, tenantId, guestId),
      db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, tenantId, guestId),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.guest.suspend',
        targetType: 'user',
        targetId: guestId,
        metadata: {
          email: guest.email,
          externalOrg: guest.external_org,
          previousStatus: guest.status,
          previousExpiresAt: guest.expires_at,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: guestId,
        targetUserId: guestId,
        action: 'admin.guest.suspend',
        payload: { email: guest.email, status: 'suspended' },
        nowIso,
      }),
    ]);

    const response = {
      ok: true,
      guest: { id: guestId, status: 'suspended', offboardedAt: null },
      sessionsRevoked: results[1]?.meta.changes ?? 0,
      syncSeq: extractLastSyncSeq(results),
      notice: 'ゲストを停止し、すべての有効セッションを失効させました。',
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export async function resumeAdminGuest(input: {
  db: D1Database;
  tenantId: string;
  guestId: string;
  actor: AuthUser;
  expiresAt?: unknown;
  extendDays?: unknown;
  idempotencyKey?: string | null;
}): Promise<Record<string, unknown>> {
  const { db, tenantId, guestId, actor } = input;
  const guest = await loadGuestAccount(db, tenantId, guestId);
  const session = await beginGuestOperation<Record<string, unknown>>(
    db,
    tenantId,
    'admin.guest.resume',
    guestId,
    input.idempotencyKey ?? null,
    { expiresAt: input.expiresAt, extendDays: input.extendDays }
  );
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    if (guest.offboarded_at) {
      throw new AdminGuestError(
        409,
        'GUEST_OFFBOARDED',
        'Offboarded guest accounts cannot be resumed'
      );
    }

    let nextExpiresAt = guest.expires_at;
    if (input.expiresAt !== undefined) {
      if (
        typeof input.expiresAt !== 'string' ||
        Number.isNaN(Date.parse(input.expiresAt))
      ) {
        throw new AdminGuestError(
          400,
          'INVALID_GUEST_EXPIRY',
          'expiresAt must be a valid ISO 8601 timestamp'
        );
      }
      nextExpiresAt = new Date(input.expiresAt).toISOString();
      if (nextExpiresAt <= nowIso) {
        throw new AdminGuestError(
          400,
          'INVALID_GUEST_EXPIRY',
          'expiresAt must be in the future'
        );
      }
    } else if (input.extendDays !== undefined) {
      if (
        typeof input.extendDays !== 'number' ||
        !Number.isInteger(input.extendDays) ||
        input.extendDays < 1 ||
        input.extendDays > 3650
      ) {
        throw new AdminGuestError(
          400,
          'INVALID_GUEST_EXPIRY',
          'extendDays must be an integer between 1 and 3650'
        );
      }
      const baseMs = Math.max(
        Date.now(),
        guest.expires_at ? Date.parse(guest.expires_at) : 0
      );
      nextExpiresAt = new Date(
        baseMs + input.extendDays * 86_400_000
      ).toISOString();
    }

    if (
      guest.expires_at &&
      guest.expires_at <= nowIso &&
      nextExpiresAt === guest.expires_at
    ) {
      throw new AdminGuestError(
        409,
        'GUEST_ACCOUNT_EXPIRED',
        'Guest account has expired; provide expiresAt or extendDays to resume'
      );
    }

    const policy = await getGuestPolicy(db, tenantId);
    if (
      policy.externalDomainExistingGuestMode === 'suspend_existing' &&
      !isGuestEmailDomainAllowed(
        guest.email,
        policy.externalDomainAllowlist
      )
    ) {
      throw new AdminGuestError(
        409,
        'GUEST_DOMAIN_NOT_ALLOWED',
        'The guest domain is not on the external domain allowlist'
      );
    }

    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = 'active',
                  expires_at = ?,
                  expiring_notified_at = NULL,
                  updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'
              AND offboarded_at IS NULL`
        )
        .bind(nextExpiresAt, nowIso, tenantId, guestId),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.guest.resume',
        targetType: 'user',
        targetId: guestId,
        metadata: {
          email: guest.email,
          externalOrg: guest.external_org,
          previousStatus: guest.status,
          previousExpiresAt: guest.expires_at,
          expiresAt: nextExpiresAt,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: guestId,
        targetUserId: guestId,
        action: 'admin.guest.resume',
        payload: { email: guest.email, status: 'active', expiresAt: nextExpiresAt },
        nowIso,
      }),
    ]);

    const response = {
      ok: true,
      guest: {
        id: guestId,
        status: 'active',
        offboardedAt: null,
        expiresAt: nextExpiresAt,
      },
      syncSeq: extractLastSyncSeq(results),
      notice: 'ゲストアカウントを再開しました。',
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export async function resendAdminGuestInvite(input: {
  db: D1Database;
  tenantId: string;
  guestId: string;
  actor: AuthUser;
  invitationId?: string | null;
  acceptOrigin: string;
  mailEnv: Pick<
    Env,
    'DB' | 'ENVIRONMENT' | 'MAIL_WEBHOOK_URL' | 'MAIL_API_KEY' | 'MAIL_FROM'
  >;
  idempotencyKey?: string | null;
}): Promise<Record<string, unknown>> {
  const { db, tenantId, guestId, actor } = input;
  const guest = await loadGuestAccount(db, tenantId, guestId);
  const session = await beginGuestOperation<Record<string, unknown>>(
    db,
    tenantId,
    'admin.guest.resend_invite',
    guestId,
    input.idempotencyKey ?? null,
    { invitationId: input.invitationId ?? null }
  );
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    if (guest.offboarded_at) {
      throw new AdminGuestError(
        409,
        'GUEST_OFFBOARDED',
        'Offboarded guest accounts cannot receive invitations'
      );
    }

    let invitation = input.invitationId
      ? await loadGuestInvitation(db, tenantId, input.invitationId)
      : null;
    if (input.invitationId && (!invitation || invitation.user_id !== guestId)) {
      throw new AdminGuestError(
        404,
        'INVITATION_NOT_FOUND',
        'Guest invitation not found for this guest'
      );
    }
    if (!invitation) {
      invitation = await db
        .prepare(
          `SELECT gi.*,
                  COALESCE(f.name, fl.name) AS target_name,
                  inviter.display_name AS invited_by_name
             FROM guest_invitations gi
             LEFT JOIN folders f
               ON gi.target_type = 'folder'
              AND f.tenant_id = gi.tenant_id
              AND f.id = gi.target_id
             LEFT JOIN files fl
               ON gi.target_type = 'file'
              AND fl.tenant_id = gi.tenant_id
              AND fl.id = gi.target_id
             LEFT JOIN users inviter ON inviter.id = gi.invited_by
            WHERE gi.tenant_id = ? AND gi.user_id = ? AND gi.status = 'pending'
            ORDER BY gi.created_at DESC
            LIMIT 1`
        )
        .bind(tenantId, guestId)
        .first<GuestInvitationRow>();
    }
    if (!invitation) {
      throw new AdminGuestError(
        409,
        'NO_PENDING_INVITATION',
        'The guest has no pending invitation to resend'
      );
    }
    if (invitation.status !== 'pending') {
      throw new AdminGuestError(
        409,
        'INVITATION_NOT_PENDING',
        `Guest invitation is ${invitation.status} and cannot be resent`
      );
    }
    if (invitation.expires_at <= nowIso) {
      await db
        .prepare(
          `UPDATE guest_invitations SET status = 'expired', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = 'pending'`
        )
        .bind(nowIso, tenantId, invitation.id)
        .run();
      throw new AdminGuestError(
        410,
        'INVITATION_EXPIRED',
        'Guest invitation has expired'
      );
    }

    const policy = await getGuestPolicy(db, tenantId);
    if (!policy.allowExternalCollaborators) {
      throw new AdminGuestError(
        403,
        'EXTERNAL_COLLABORATORS_DISABLED',
        'External collaborators are disabled for this tenant'
      );
    }
    if (
      !isGuestEmailDomainAllowed(guest.email, policy.externalDomainAllowlist)
    ) {
      throw new AdminGuestError(
        403,
        'EXTERNAL_DOMAIN_NOT_ALLOWED',
        'This external email domain is not on the guest domain allowlist'
      );
    }
    if (
      guest.status !== 'active' ||
      (guest.expires_at && guest.expires_at <= nowIso)
    ) {
      throw new AdminGuestError(
        403,
        'GUEST_ACCOUNT_INACTIVE',
        'Guest account is no longer active'
      );
    }

    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const resendCount = invitation.resend_count + 1;
    const results = await db.batch([
      db
        .prepare(
          `UPDATE guest_invitations
              SET token_hash = ?, resend_count = resend_count + 1,
                  last_sent_at = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ? AND status = 'pending'`
        )
        .bind(tokenHash, nowIso, nowIso, tenantId, invitation.id),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.guest.resend_invite',
        targetType: 'guest_invitation',
        targetId: invitation.id,
        metadata: {
          email: invitation.email,
          guestUserId: guestId,
          externalOrg: invitation.external_org,
          resendCount,
          targetType: invitation.target_type,
          targetId: invitation.target_id,
          role: invitation.role,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: guestId,
        targetUserId: guestId,
        action: 'admin.guest.resend_invite',
        payload: { invitationId: invitation.id, resendCount },
        nowIso,
      }),
    ]);

    const acceptUrl = `${input.acceptOrigin}/guest/accept?token=${encodeURIComponent(rawToken)}`;
    const provider = resolveMailProvider(input.mailEnv);
    try {
      await provider.send({
        tenantId,
        kind: 'guest_invitation',
        to: invitation.email,
        subject: '【Files】外部ゲストコラボレーターの招待',
        text: [
          `${invitation.display_name} 様`,
          '',
          'Files のワークスペースへ外部ゲストコラボレーターとして招待されました。',
          `共有対象: ${invitation.target_name ?? invitation.target_type}`,
          invitation.external_org ? `外部組織: ${invitation.external_org}` : null,
          `招待の有効期限: ${new Date(invitation.expires_at).toISOString()}`,
          '',
          '以下の URL から招待を承諾し、メールに届く 6 桁の認証コードでサインインしてください。',
          acceptUrl,
          '',
          'このメールに心当たりがない場合は破棄してください。',
        ]
          .filter((line): line is string => line !== null)
          .join('\n'),
        token: rawToken,
        acceptUrl,
      });
    } catch (err) {
      if (err instanceof MailProviderConfigurationError) {
        throw new AdminGuestError(
          503,
          'MAIL_PROVIDER_NOT_CONFIGURED',
          'Mail provider is not configured for guest invitations'
        );
      }
      if (err instanceof MailDeliveryError) {
        throw new AdminGuestError(
          502,
          'MAIL_DELIVERY_FAILED',
          'Failed to deliver the guest invitation'
        );
      }
      throw err;
    }

    const response = {
      ok: true,
      guestId,
      invitationId: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expires_at,
      resendCount,
      syncSeq: extractLastSyncSeq(results),
      mailPreview: buildGuestInvitationMailPreview({
        displayName: invitation.display_name,
        externalOrg: invitation.external_org,
        targetType: invitation.target_type,
        targetName: invitation.target_name,
        role: invitation.role,
        expiresAt: invitation.expires_at,
        invitedByName: invitation.invited_by_name ?? null,
      }),
      notice: `招待メールを再送しました（再送回数 ${resendCount} 回）。`,
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export async function offboardAdminGuest(input: {
  db: D1Database;
  tenantId: string;
  guestId: string;
  actor: AuthUser;
  idempotencyKey?: string | null;
}): Promise<Record<string, unknown>> {
  const { db, tenantId, guestId, actor } = input;
  const guest = await loadGuestAccount(db, tenantId, guestId);
  const session = await beginGuestOperation<Record<string, unknown>>(
    db,
    tenantId,
    'admin.guest.offboard',
    guestId,
    input.idempotencyKey ?? null
  );
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const counts = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions
             WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL) AS sessions,
           (SELECT COUNT(*) FROM guest_invitations
             WHERE tenant_id = ? AND user_id = ? AND status <> 'revoked') AS invitations,
           (SELECT COUNT(*) FROM guest_otp_challenges
             WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL) AS otps,
           (SELECT COUNT(*) FROM permissions
             WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?) AS permissions`
      )
      .bind(
        tenantId,
        guestId,
        tenantId,
        guestId,
        tenantId,
        guestId,
        tenantId,
        guestId
      )
      .first<{
        sessions: number;
        invitations: number;
        otps: number;
        permissions: number;
      }>();

    const results = await db.batch([
      db
        .prepare(
          `UPDATE sessions SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, tenantId, guestId),
      db
        .prepare(
          `UPDATE guest_invitations
              SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
            WHERE tenant_id = ? AND user_id = ? AND status <> 'revoked'`
        )
        .bind(nowIso, actor.id, nowIso, tenantId, guestId),
      db
        .prepare(
          `UPDATE guest_otp_challenges
              SET consumed_at = ?
            WHERE tenant_id = ? AND user_id = ? AND consumed_at IS NULL`
        )
        .bind(nowIso, tenantId, guestId),
      db
        .prepare(
          `DELETE FROM permissions
            WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?`
        )
        .bind(tenantId, guestId),
      db
        .prepare(
          `UPDATE users
              SET status = 'suspended',
                  offboarded_at = ?,
                  offboarded_by = ?,
                  updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
        )
        .bind(nowIso, actor.id, nowIso, tenantId, guestId),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.guest.offboard',
        targetType: 'user',
        targetId: guestId,
        metadata: {
          email: guest.email,
          externalOrg: guest.external_org,
          invitedBy: guest.invited_by,
          sessionsRevoked: counts?.sessions ?? 0,
          invitationsRevoked: counts?.invitations ?? 0,
          otpChallengesConsumed: counts?.otps ?? 0,
          permissionsDeleted: counts?.permissions ?? 0,
          offboardedAt: nowIso,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: guestId,
        targetUserId: guestId,
        action: 'admin.guest.offboard',
        payload: {
          email: guest.email,
          status: 'suspended',
          offboardedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    const response = {
      ok: true,
      guest: {
        id: guestId,
        status: 'suspended',
        offboardedAt: nowIso,
      },
      sessionsRevoked: results[0]?.meta.changes ?? counts?.sessions ?? 0,
      invitationsRevoked: results[1]?.meta.changes ?? counts?.invitations ?? 0,
      otpChallengesConsumed: results[2]?.meta.changes ?? counts?.otps ?? 0,
      permissionsDeleted: results[3]?.meta.changes ?? counts?.permissions ?? 0,
      syncSeq: extractLastSyncSeq(results),
      notice:
        'ゲストを完全にオフボーディングしました。セッション・招待・OTP・権限はすべて無効化されています。',
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export interface ExternalDomainPolicyResult {
  mode: ExternalDomainExistingGuestMode;
  affectedGuestCount: number;
  suspendedGuestIds: string[];
  syncSeq: number | null;
}

/**
 * Apply `externalDomainExistingGuestMode` to guests that are already active.
 *
 * `reject_new_only` only reports the candidates (new invitations and OTP
 * reauthentication are already rejected by the existing allowlist checks).
 * `suspend_existing` suspends every candidate and revokes their sessions.
 */
export async function applyExternalDomainGuestPolicy(input: {
  db: D1Database;
  tenantId: string;
  allowlist: readonly string[];
  mode: ExternalDomainExistingGuestMode;
  actor: AuthUser;
  nowIso?: string;
}): Promise<ExternalDomainPolicyResult> {
  const { db, tenantId, allowlist, mode, actor } = input;
  const nowIso = input.nowIso ?? new Date().toISOString();

  const rows = await db
    .prepare(
      `SELECT id, email
         FROM users
        WHERE tenant_id = ?
          AND user_type = 'guest'
          AND status = 'active'
          AND offboarded_at IS NULL`
    )
    .bind(tenantId)
    .all<{ id: string; email: string }>();

  const candidates = rows.results.filter((row) => {
    const domain = emailDomain(row.email);
    return !domain || !isGuestDomainAllowed(domain, allowlist);
  });

  if (mode === 'reject_new_only' || candidates.length === 0) {
    return {
      mode,
      affectedGuestCount: candidates.length,
      suspendedGuestIds: [],
      syncSeq: null,
    };
  }

  const groups = candidates.map((guest) => [
    db
      .prepare(
        `UPDATE users
            SET status = 'suspended', updated_at = ?
          WHERE tenant_id = ? AND id = ? AND user_type = 'guest'`
      )
      .bind(nowIso, tenantId, guest.id),
    db
      .prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .bind(nowIso, tenantId, guest.id),
    buildAuditLogStmt(db, {
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: actor.ipAddress,
      action: 'admin.guest.suspend',
      targetType: 'user',
      targetId: guest.id,
      metadata: {
        email: guest.email,
        domain: emailDomain(guest.email),
        reason: 'domain_removed_from_allowlist',
        mode,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId,
      entityType: 'user',
      entityId: guest.id,
      targetUserId: guest.id,
      action: 'admin.guest.suspend',
      payload: {
        email: guest.email,
        status: 'suspended',
        reason: 'domain_removed_from_allowlist',
      },
      nowIso,
    }),
  ]);

  const results = await executeGroupedBatches(db, groups);
  return {
    mode,
    affectedGuestCount: candidates.length,
    suspendedGuestIds: candidates.map((guest) => guest.id),
    syncSeq: extractLastSyncSeq(results),
  };
}
