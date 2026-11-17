import type { AuthUser, UserRole, UserType } from '../types/api';
import { hasAdminCapability } from './admin-delegations';
import { buildAuditLogStmt } from './audit';
import { base64UrlToBytes, bytesToBase64Url } from './crypto-utils';

/**
 * P12-2 / TOM-71 tenant-wide active session monitoring and forced sign-out.
 *
 * Reads never select `sessions.token_hash`. Every mutation updates D1 first so
 * the next `/api/sync/bootstrap` request fails closed, then writes the
 * corresponding `admin.session.*` audit row in the same batch.
 */

export const ADMIN_SESSION_MAX_LIMIT = 100;
export const ADMIN_SESSION_DEFAULT_LIMIT = 50;
export const ADMIN_SESSION_REASON_MAX = 300;

export type AdminSessionUserTypeFilter = 'all' | UserType;
export type AdminSessionUserStatus = 'active' | 'suspended';

export interface AdminSessionCursor {
  createdAt: string;
  id: string;
}

export interface AdminSessionFilters {
  userId: string | null;
  userType: AdminSessionUserTypeFilter;
  ip: string | null;
  query: string | null;
  limit: number;
  cursor: AdminSessionCursor | null;
}

export interface AdminSessionRow {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  userRole: UserRole;
  userType: UserType;
  userStatus: AdminSessionUserStatus;
  externalOrg: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface AdminSessionSummary {
  activeTotal: number;
  memberSessions: number;
  guestSessions: number;
  distinctUsers: number;
}

export interface AdminSessionListResult {
  sessions: AdminSessionRow[];
  summary: AdminSessionSummary;
  nextCursor: string | null;
  limit: number;
}

export interface AdminSessionRevokeResult {
  ok: true;
  sessionId: string;
  userId: string;
  userEmail: string;
  revokedAt: string;
  alreadyRevoked: boolean;
}

export interface AdminUserSessionsRevokeResult {
  ok: true;
  userId: string;
  userEmail: string;
  revokedCount: number;
  keepCurrentSession: boolean;
  revokedAt: string;
}

export interface AdminTenantSessionsRevokeResult {
  ok: true;
  revokedCount: number;
  keepCurrentSession: boolean;
  revokedAt: string;
}

export class AdminSessionError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminSessionError';
  }
}

interface RawAdminSessionRow {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: UserRole;
  user_type: UserType;
  status: AdminSessionUserStatus;
  external_org: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
}

interface RawSessionTargetRow {
  id: string;
  tenant_id: string;
  user_id: string;
  revoked_at: string | null;
  expires_at: string;
  email: string;
  display_name: string;
  role: UserRole;
  user_type: UserType;
}

interface RawTargetUserRow {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  user_type: UserType;
  status: AdminSessionUserStatus;
}

export function encodeAdminSessionCursor(cursor: AdminSessionCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeAdminSessionCursor(
  raw: string | undefined
): AdminSessionCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(raw))
    ) as Partial<AdminSessionCursor>;
    if (
      typeof parsed.createdAt !== 'string' ||
      !parsed.createdAt ||
      typeof parsed.id !== 'string' ||
      !parsed.id
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function isAdminSessionUserTypeFilter(
  value: string
): value is AdminSessionUserTypeFilter {
  return value === 'all' || value === 'member' || value === 'guest';
}

/**
 * `reason` is optional, but when present it must be 1–300 characters after
 * trimming. The returned value is the normalized string persisted in metadata.
 */
export function validateAdminSessionReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new AdminSessionError(
      400,
      'INVALID_SESSION_REASON',
      `reason must be 1-${ADMIN_SESSION_REASON_MAX} characters`
    );
  }
  const reason = raw.trim();
  if (reason.length === 0 || reason.length > ADMIN_SESSION_REASON_MAX) {
    throw new AdminSessionError(
      400,
      'INVALID_SESSION_REASON',
      `reason must be 1-${ADMIN_SESSION_REASON_MAX} characters`
    );
  }
  return reason;
}

export function resolveAdminSessionKeepCurrent(
  raw: unknown,
  fallback: boolean
): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') {
    throw new AdminSessionError(
      400,
      'INVALID_KEEP_CURRENT_SESSION',
      'keepCurrentSession must be a boolean'
    );
  }
  return raw;
}

function assertAdminSessionActor(actor: AuthUser): void {
  if (actor.role === 'sys_admin' || actor.role === 'sec_admin') return;
  if (
    actor.role === 'member' &&
    hasAdminCapability(actor, 'admin.users.suspend')
  ) {
    return;
  }
  throw new AdminSessionError(
    403,
    'INSUFFICIENT_ADMIN_ROLE',
    'Only sys_admin, sec_admin, or a delegated session operator can manage sessions'
  );
}

/**
 * `sec_admin` must never be able to sign out a tenant owner. The route layer
 * also enforces this, but the service keeps the invariant for direct callers.
 */
export function assertAdminCanTargetRole(
  actor: AuthUser,
  targetRole: UserRole
): void {
  if (actor.role === 'sec_admin' && targetRole === 'sys_admin') {
    throw new AdminSessionError(
      403,
      'FORBIDDEN_TARGET_ROLE',
      'sec_admin cannot revoke sessions owned by sys_admin'
    );
  }
  if (actor.role === 'member' && targetRole !== 'member') {
    throw new AdminSessionError(
      403,
      'PRIVILEGE_ESCALATION_FORBIDDEN',
      'Co-Admins cannot revoke sessions owned by privileged administrators'
    );
  }
}

/** The active-session list keyset query, exported for EXPLAIN QUERY PLAN tests. */
export function buildAdminSessionListQuery(input: {
  tenantId: string;
  nowIso: string;
  filters: AdminSessionFilters;
  /** TOM-73 Co-Admin group scope; filters sessions to group members. */
  scopeGroupId?: string | null;
}): { sql: string; binds: Array<string | number> } {
  const { filters, tenantId, nowIso } = input;
  const conditions: string[] = [
    's.tenant_id = ?',
    's.revoked_at IS NULL',
    's.expires_at > ?',
  ];
  const binds: Array<string | number> = [tenantId, nowIso];

  if (filters.userId) {
    conditions.push('s.user_id = ?');
    binds.push(filters.userId);
  }
  if (filters.userType !== 'all') {
    conditions.push('u.user_type = ?');
    binds.push(filters.userType);
  }
  if (input.scopeGroupId) {
    conditions.push(
      'EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = ? AND gm.user_id = s.user_id)'
    );
    binds.push(input.scopeGroupId);
  }
  if (filters.ip) {
    conditions.push('s.ip_address = ?');
    binds.push(filters.ip);
  }
  if (filters.query) {
    conditions.push(
      `(instr(lower(u.email), lower(?)) > 0
        OR instr(lower(u.display_name), lower(?)) > 0
        OR instr(lower(COALESCE(s.ip_address, '')), lower(?)) > 0
        OR instr(lower(s.id), lower(?)) > 0
        OR instr(lower(COALESCE(s.user_agent, '')), lower(?)) > 0)`
    );
    binds.push(
      filters.query,
      filters.query,
      filters.query,
      filters.query,
      filters.query
    );
  }
  if (filters.cursor) {
    conditions.push('(s.created_at < ? OR (s.created_at = ? AND s.id < ?))');
    binds.push(
      filters.cursor.createdAt,
      filters.cursor.createdAt,
      filters.cursor.id
    );
  }

  binds.push(filters.limit + 1);

  return {
    sql: `SELECT s.id,
                 s.user_id,
                 u.email,
                 u.display_name,
                 u.role,
                 u.user_type,
                 u.status,
                 u.external_org,
                 s.ip_address,
                 s.user_agent,
                 s.created_at,
                 s.expires_at
            FROM sessions s
            JOIN users u ON u.id = s.user_id
           WHERE ${conditions.join('\n             AND ')}
           ORDER BY s.created_at DESC, s.id DESC
           LIMIT ?`,
    binds,
  };
}

function projectSessionRow(
  row: RawAdminSessionRow,
  currentSessionId: string | null
): AdminSessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.email,
    userDisplayName: row.display_name,
    userRole: row.role,
    userType: row.user_type,
    userStatus: row.status,
    externalOrg: row.external_org,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    isCurrent: Boolean(currentSessionId) && row.id === currentSessionId,
  };
}

export async function listAdminSessions(input: {
  db: D1Database;
  tenantId: string;
  actorSessionId: string | null;
  filters: AdminSessionFilters;
  nowIso?: string;
  /** TOM-73 Co-Admin group scope. */
  scopeGroupId?: string | null;
}): Promise<AdminSessionListResult> {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const query = buildAdminSessionListQuery({
    tenantId: input.tenantId,
    nowIso,
    filters: input.filters,
    scopeGroupId: input.scopeGroupId ?? null,
  });

  const [rows, summaryRow] = await Promise.all([
    input.db
      .prepare(query.sql)
      .bind(...query.binds)
      .all<RawAdminSessionRow>(),
    input.db
      .prepare(
        `SELECT COUNT(*) AS active_total,
                SUM(CASE WHEN u.user_type = 'member' THEN 1 ELSE 0 END) AS member_sessions,
                SUM(CASE WHEN u.user_type = 'guest' THEN 1 ELSE 0 END) AS guest_sessions,
                COUNT(DISTINCT s.user_id) AS distinct_users
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.tenant_id = ?
            AND s.revoked_at IS NULL
            AND s.expires_at > ?`
      )
      .bind(input.tenantId, nowIso)
      .first<{
        active_total: number | null;
        member_sessions: number | null;
        guest_sessions: number | null;
        distinct_users: number | null;
      }>(),
  ]);

  const pageRows = rows.results.slice(0, input.filters.limit);
  const lastRow = pageRows[pageRows.length - 1];
  const hasMore = rows.results.length > input.filters.limit;

  return {
    sessions: pageRows.map((row) =>
      projectSessionRow(row, input.actorSessionId)
    ),
    summary: {
      activeTotal: summaryRow?.active_total ?? 0,
      memberSessions: summaryRow?.member_sessions ?? 0,
      guestSessions: summaryRow?.guest_sessions ?? 0,
      distinctUsers: summaryRow?.distinct_users ?? 0,
    },
    nextCursor:
      hasMore && lastRow
        ? encodeAdminSessionCursor({
            createdAt: lastRow.created_at,
            id: lastRow.id,
          })
        : null,
    limit: input.filters.limit,
  };
}

async function loadSessionTarget(
  db: D1Database,
  tenantId: string,
  sessionId: string
): Promise<RawSessionTargetRow | null> {
  return db
    .prepare(
      `SELECT s.id, s.tenant_id, s.user_id, s.revoked_at, s.expires_at,
              u.email, u.display_name, u.role, u.user_type
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.tenant_id = ? AND s.id = ?
        LIMIT 1`
    )
    .bind(tenantId, sessionId)
    .first<RawSessionTargetRow>();
}

export async function revokeAdminSession(input: {
  db: D1Database;
  tenantId: string;
  sessionId: string;
  actor: AuthUser;
  reason?: unknown;
  nowIso?: string;
}): Promise<AdminSessionRevokeResult> {
  assertAdminSessionActor(input.actor);
  const reason = validateAdminSessionReason(input.reason);
  const target = await loadSessionTarget(
    input.db,
    input.tenantId,
    input.sessionId
  );
  if (!target) {
    throw new AdminSessionError(
      404,
      'SESSION_NOT_FOUND',
      'Session not found'
    );
  }
  assertAdminCanTargetRole(input.actor, target.role);

  if (target.revoked_at) {
    return {
      ok: true,
      sessionId: target.id,
      userId: target.user_id,
      userEmail: target.email,
      revokedAt: target.revoked_at,
      alreadyRevoked: true,
    };
  }

  const nowIso = input.nowIso ?? new Date().toISOString();
  await input.db.batch([
    input.db
      .prepare(
        `UPDATE sessions
            SET revoked_at = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`
      )
      .bind(nowIso, input.tenantId, target.id),
    buildAuditLogStmt(input.db, {
      tenantId: input.tenantId,
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      actorIp: input.actor.ipAddress,
      action: 'admin.session.revoke',
      targetType: 'session',
      targetId: target.id,
      metadata: {
        sessionId: target.id,
        userId: target.user_id,
        email: target.email,
        ...(reason ? { reason } : {}),
      },
      nowIso,
    }),
  ]);

  return {
    ok: true,
    sessionId: target.id,
    userId: target.user_id,
    userEmail: target.email,
    revokedAt: nowIso,
    alreadyRevoked: false,
  };
}

async function loadTargetUser(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<RawTargetUserRow | null> {
  return db
    .prepare(
      `SELECT id, email, display_name, role, user_type, status
         FROM users
        WHERE tenant_id = ? AND id = ?
        LIMIT 1`
    )
    .bind(tenantId, userId)
    .first<RawTargetUserRow>();
}

export async function revokeAdminUserSessions(input: {
  db: D1Database;
  tenantId: string;
  userId: string;
  actor: AuthUser;
  reason?: unknown;
  keepCurrentSession?: unknown;
  nowIso?: string;
}): Promise<AdminUserSessionsRevokeResult> {
  assertAdminSessionActor(input.actor);
  const reason = validateAdminSessionReason(input.reason);
  const target = await loadTargetUser(
    input.db,
    input.tenantId,
    input.userId
  );
  if (!target) {
    throw new AdminSessionError(404, 'USER_NOT_FOUND', 'User not found');
  }
  assertAdminCanTargetRole(input.actor, target.role);

  const keepCurrentSession = resolveAdminSessionKeepCurrent(
    input.keepCurrentSession,
    target.id === input.actor.id
  );
  const excludeSessionId =
    keepCurrentSession && input.actor.sessionId
      ? input.actor.sessionId
      : null;

  const nowIso = input.nowIso ?? new Date().toISOString();
  const updateStatement = input.db
    .prepare(
      `UPDATE sessions
          SET revoked_at = ?
        WHERE tenant_id = ? AND user_id = ?
          AND revoked_at IS NULL
          AND expires_at > ?
          ${excludeSessionId ? 'AND id <> ?' : ''}`
    )
    .bind(
      nowIso,
      input.tenantId,
      target.id,
      nowIso,
      ...(excludeSessionId ? [excludeSessionId] : [])
    );

  const results = await input.db.batch([
    updateStatement,
    buildAuditLogStmt(input.db, {
      tenantId: input.tenantId,
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      actorIp: input.actor.ipAddress,
      action: 'admin.session.revoke_user',
      targetType: 'user',
      targetId: target.id,
      metadata: {
        userId: target.id,
        email: target.email,
        keepCurrentSession,
        ...(reason ? { reason } : {}),
      },
      nowIso,
    }),
  ]);

  return {
    ok: true,
    userId: target.id,
    userEmail: target.email,
    revokedCount: results[0]?.meta.changes ?? 0,
    keepCurrentSession,
    revokedAt: nowIso,
  };
}

export async function revokeTenantAdminSessions(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  reason?: unknown;
  keepCurrentSession?: unknown;
  nowIso?: string;
}): Promise<AdminTenantSessionsRevokeResult> {
  if (input.actor.role !== 'sys_admin') {
    throw new AdminSessionError(
      403,
      'INSUFFICIENT_ADMIN_ROLE',
      'Only sys_admin can revoke every tenant session'
    );
  }
  const reason = validateAdminSessionReason(input.reason);
  const keepCurrentSession = resolveAdminSessionKeepCurrent(
    input.keepCurrentSession,
    true
  );
  const excludeSessionId =
    keepCurrentSession && input.actor.sessionId
      ? input.actor.sessionId
      : null;

  const nowIso = input.nowIso ?? new Date().toISOString();
  const updateStatement = input.db
    .prepare(
      `UPDATE sessions
          SET revoked_at = ?
        WHERE tenant_id = ?
          AND revoked_at IS NULL
          AND expires_at > ?
          ${excludeSessionId ? 'AND id <> ?' : ''}`
    )
    .bind(
      nowIso,
      input.tenantId,
      nowIso,
      ...(excludeSessionId ? [excludeSessionId] : [])
    );

  const results = await input.db.batch([
    updateStatement,
    buildAuditLogStmt(input.db, {
      tenantId: input.tenantId,
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      actorIp: input.actor.ipAddress,
      action: 'admin.session.revoke_all',
      targetType: 'tenant',
      targetId: input.tenantId,
      metadata: {
        keepCurrentSession,
        ...(reason ? { reason } : {}),
      },
      nowIso,
    }),
  ]);

  return {
    ok: true,
    revokedCount: results[0]?.meta.changes ?? 0,
    keepCurrentSession,
    revokedAt: nowIso,
  };
}
