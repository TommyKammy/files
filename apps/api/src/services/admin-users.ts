import type { AuthUser, UserRole } from '../types/api';
import {
  AdminBulkIdempotencyError,
  beginAdminBulkOperation,
  resolveIdempotencyKey,
} from './admin-bulk-idempotency';
import { csvCell } from './admin-guests';
import { buildAuditLogStmt } from './audit';
import { executeGroupedBatches } from './d1-batch';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';

/**
 * P11-2 / TOM-64 tenant-admin internal member administration.
 *
 * Members are `users.user_type = 'member'`; guests have their own lifecycle
 * service and are deliberately rejected here with `NOT_INTERNAL_MEMBER`.
 * Every mutation writes an `admin.user.*` audit entry, and privilege-bearing
 * changes are protected by self-modification and last-sys_admin guards.
 */

export type AdminUserRoleFilter = 'all' | UserRole;
export type AdminUserStatusFilter = 'all' | 'active' | 'suspended';
export type AdminUserSortBy =
  | 'email'
  | 'displayName'
  | 'department'
  | 'role'
  | 'status'
  | 'createdAt'
  | 'lastLoginAt'
  | 'usedBytes';
export type AdminUserSortDir = 'asc' | 'desc';
export type AdminUserAccountStatus = Exclude<AdminUserStatusFilter, 'all'>;

export interface AdminUserFilters {
  query: string | null;
  role: AdminUserRoleFilter;
  status: AdminUserStatusFilter;
  department: string | null;
  sortBy: AdminUserSortBy;
  sortDir: AdminUserSortDir;
  limit: number;
  offset: number;
}

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  role: UserRole;
  status: AdminUserAccountStatus;
  storageQuotaBytes: number | null;
  usedBytes: number;
  fileCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminUserDepartmentSummary {
  department: string | null;
  count: number;
}

export interface AdminUserAggregations {
  total: number;
  byStatus: Record<AdminUserStatusFilter, number>;
  byRole: Record<UserRole, number>;
  departments: AdminUserDepartmentSummary[];
}

export interface AdminUserListResult {
  users: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  sort: { by: AdminUserSortBy; dir: AdminUserSortDir };
  summary: AdminUserAggregations;
  aggregations: AdminUserAggregations;
}

export interface AdminUserRootFolder {
  id: string;
  name: string;
  classification: string;
  createdAt: string;
}

export interface AdminUserGroup {
  id: string;
  name: string;
}

export interface AdminUserAuditLog {
  id: string;
  action: string;
  status: 'allowed' | 'blocked';
  actorEmail: string | null;
  actorIp: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AdminUserDetailResult {
  user: AdminUserRow & { updatedAt: string };
  rootFolders: AdminUserRootFolder[];
  groups: AdminUserGroup[];
  activeSessionCount: number;
  recentAuditLogs: AdminUserAuditLog[];
}

export interface AdminUserMutationResult {
  ok: true;
  replayed?: boolean;
  user: AdminUserRow;
  sessionsRevoked?: number;
  syncSeq: number | null;
  notice: string;
}

export type AdminUserBulkAction = 'create' | 'update' | 'unchanged' | 'error';

export interface AdminUserBulkRowResult {
  rowNumber: number;
  email: string;
  action: AdminUserBulkAction;
  displayName: string | null;
  department: string | null;
  role: UserRole | null;
  storageQuotaBytes: number | null;
  userId?: string;
  code?: string;
  error?: string;
}

export interface AdminUserBulkImportResult {
  ok: true;
  dryRun: boolean;
  replayed: boolean;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  errorCount: number;
  results: AdminUserBulkRowResult[];
  syncSeq: number | null;
  notice: string;
}

interface RawAdminUserRow {
  id: string;
  email: string;
  display_name: string;
  department: string | null;
  role: UserRole;
  status: AdminUserAccountStatus;
  storage_quota_bytes: number | null;
  used_bytes: number | null;
  file_count: number | null;
  last_login_at: string | null;
  created_at: string;
  updated_at?: string;
}

interface TargetUserRow {
  id: string;
  email: string;
  display_name: string;
  department: string | null;
  role: UserRole;
  status: AdminUserAccountStatus;
  user_type: 'member' | 'guest';
  storage_quota_bytes: number | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

const SORT_BY_VALUES: AdminUserSortBy[] = [
  'email',
  'displayName',
  'department',
  'role',
  'status',
  'createdAt',
  'lastLoginAt',
  'usedBytes',
];

const SORT_COLUMNS: Record<AdminUserSortBy, string> = {
  email: 'email',
  displayName: 'display_name',
  department: 'department',
  role: 'role',
  status: 'status',
  createdAt: 'created_at',
  lastLoginAt: 'last_login_at',
  usedBytes: 'used_bytes',
};

const ROLE_VALUES: UserRole[] = ['sys_admin', 'sec_admin', 'member'];
const STATUS_VALUES: AdminUserStatusFilter[] = ['all', 'active', 'suspended'];
const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_DEPARTMENT_LENGTH = 200;
const MAX_STORAGE_QUOTA_BYTES = 1_125_899_906_842_624; // 1 PiB
export const MAX_ADMIN_USER_BULK_ROWS = 200;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AdminUserError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminUserError';
  }
}

export { AdminBulkIdempotencyError, resolveIdempotencyKey };

export function isAdminUserRoleFilter(
  value: unknown
): value is AdminUserRoleFilter {
  return (
    typeof value === 'string' &&
    (value === 'all' || (ROLE_VALUES as readonly string[]).includes(value))
  );
}

export function isAdminUserStatusFilter(
  value: unknown
): value is AdminUserStatusFilter {
  return (
    typeof value === 'string' &&
    (STATUS_VALUES as readonly string[]).includes(value)
  );
}

export function isAdminUserSortBy(value: unknown): value is AdminUserSortBy {
  return (
    typeof value === 'string' &&
    (SORT_BY_VALUES as readonly string[]).includes(value)
  );
}

function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AdminUserError(400, 'INVALID_EMAIL', 'email must be a string');
  }
  const email = raw.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > MAX_EMAIL_LENGTH ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new AdminUserError(400, 'INVALID_EMAIL', 'email is not valid');
  }
  return email;
}

function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AdminUserError(
      400,
      'INVALID_DISPLAY_NAME',
      'displayName must be a string'
    );
  }
  const displayName = raw.trim();
  if (
    displayName.length === 0 ||
    displayName.length > MAX_DISPLAY_NAME_LENGTH
  ) {
    throw new AdminUserError(
      400,
      'INVALID_DISPLAY_NAME',
      `displayName must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`
    );
  }
  return displayName;
}

function normalizeDepartment(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new AdminUserError(
      400,
      'INVALID_DEPARTMENT',
      'department must be a string or null'
    );
  }
  const department = raw.trim();
  if (department.length > MAX_DEPARTMENT_LENGTH) {
    throw new AdminUserError(
      400,
      'INVALID_DEPARTMENT',
      `department must be at most ${MAX_DEPARTMENT_LENGTH} characters`
    );
  }
  return department.length > 0 ? department : null;
}

function normalizeRole(raw: unknown, fallback?: UserRole): UserRole {
  if (raw === undefined) {
    if (fallback) return fallback;
    throw new AdminUserError(400, 'INVALID_ROLE', 'role is required');
  }
  if (typeof raw !== 'string' || !ROLE_VALUES.includes(raw as UserRole)) {
    throw new AdminUserError(
      400,
      'INVALID_ROLE',
      'role must be sys_admin, sec_admin, or member'
    );
  }
  return raw as UserRole;
}

/**
 * `undefined` = not supplied (keep current / default), `null` = no personal
 * quota. Numeric strings are accepted for CSV import rows.
 */
function normalizeStorageQuotaBytes(
  raw: unknown,
  options: { allowUndefined: boolean }
): number | null | undefined {
  if (raw === undefined) {
    if (options.allowUndefined) return undefined;
    return null;
  }
  if (raw === null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.toLowerCase() === 'null') return null;
    const parsed = Number(trimmed);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed <= 0 ||
      parsed > MAX_STORAGE_QUOTA_BYTES
    ) {
      throw new AdminUserError(
        400,
        'INVALID_STORAGE_QUOTA',
        `storageQuotaBytes must be a positive integer no larger than ${MAX_STORAGE_QUOTA_BYTES}`
      );
    }
    return parsed;
  }
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw <= 0 ||
    raw > MAX_STORAGE_QUOTA_BYTES
  ) {
    throw new AdminUserError(
      400,
      'INVALID_STORAGE_QUOTA',
      `storageQuotaBytes must be a positive integer no larger than ${MAX_STORAGE_QUOTA_BYTES}`
    );
  }
  return raw;
}

function projectRow(row: RawAdminUserRow): AdminUserRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    department: row.department,
    role: row.role,
    status: row.status,
    storageQuotaBytes: row.storage_quota_bytes,
    usedBytes: row.used_bytes ?? 0,
    fileCount: row.file_count ?? 0,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function buildWhere(filters: AdminUserFilters): {
  sql: string;
  binds: unknown[];
} {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (filters.query) {
    conditions.push(
      `(instr(lower(u.email), lower(?)) > 0
        OR instr(lower(u.display_name), lower(?)) > 0
        OR instr(lower(COALESCE(u.department, '')), lower(?)) > 0
        OR instr(lower(u.id), lower(?)) > 0)`
    );
    binds.push(filters.query, filters.query, filters.query, filters.query);
  }
  if (filters.role !== 'all') {
    conditions.push('u.role = ?');
    binds.push(filters.role);
  }
  if (filters.status !== 'all') {
    conditions.push('u.status = ?');
    binds.push(filters.status);
  }
  if (filters.department) {
    conditions.push('u.department = ?');
    binds.push(filters.department);
  }

  return {
    sql: conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '',
    binds,
  };
}

export async function listAdminUsers(
  db: D1Database,
  tenantId: string,
  filters: AdminUserFilters
): Promise<AdminUserListResult> {
  const where = buildWhere(filters);
  const orderColumn = SORT_COLUMNS[filters.sortBy];
  const orderDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

  const [rows, totalRow, statusRes, roleRes, departmentRes] = await Promise.all([
    db
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.department, u.role, u.status,
                u.storage_quota_bytes, u.last_login_at, u.created_at,
                COALESCE(s.total_bytes, 0) AS used_bytes,
                COALESCE(s.file_count, 0) AS file_count
           FROM users u
           LEFT JOIN user_storage_stats s
             ON s.tenant_id = u.tenant_id AND s.user_id = u.id
          WHERE u.tenant_id = ? AND u.user_type = 'member'${where.sql}
          ORDER BY ${orderColumn} IS NULL, ${orderColumn} ${orderDir}, u.id ASC
          LIMIT ? OFFSET ?`
      )
      .bind(tenantId, ...where.binds, filters.limit, filters.offset)
      .all<RawAdminUserRow>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM users u
          WHERE u.tenant_id = ? AND u.user_type = 'member'${where.sql}`
      )
      .bind(tenantId, ...where.binds)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT u.status AS status, COUNT(*) AS count
           FROM users u
          WHERE u.tenant_id = ? AND u.user_type = 'member'
          GROUP BY u.status`
      )
      .bind(tenantId)
      .all<{ status: AdminUserAccountStatus; count: number }>(),
    db
      .prepare(
        `SELECT u.role AS role, COUNT(*) AS count
           FROM users u
          WHERE u.tenant_id = ? AND u.user_type = 'member'
          GROUP BY u.role`
      )
      .bind(tenantId)
      .all<{ role: UserRole; count: number }>(),
    db
      .prepare(
        `SELECT u.department AS department, COUNT(*) AS count
           FROM users u
          WHERE u.tenant_id = ? AND u.user_type = 'member'
          GROUP BY u.department
          ORDER BY count DESC, department ASC`
      )
      .bind(tenantId)
      .all<{ department: string | null; count: number }>(),
  ]);

  const users = rows.results.map(projectRow);
  const total = totalRow?.total ?? 0;
  const byStatus: Record<AdminUserStatusFilter, number> = {
    all: 0,
    active: 0,
    suspended: 0,
  };
  for (const row of statusRes.results) {
    if (row.status === 'active' || row.status === 'suspended') {
      byStatus[row.status] = row.count;
      byStatus.all += row.count;
    }
  }
  const byRole: Record<UserRole, number> = {
    sys_admin: 0,
    sec_admin: 0,
    member: 0,
  };
  for (const row of roleRes.results) {
    if (ROLE_VALUES.includes(row.role)) byRole[row.role] = row.count;
  }

  const summary: AdminUserAggregations = {
    total: byStatus.all,
    byStatus,
    byRole,
    departments: departmentRes.results.map((row) => ({
      department: row.department,
      count: row.count,
    })),
  };

  return {
    users,
    total,
    limit: filters.limit,
    offset: filters.offset,
    nextOffset:
      filters.offset + users.length < total
        ? filters.offset + users.length
        : null,
    sort: { by: filters.sortBy, dir: filters.sortDir },
    summary,
    aggregations: summary,
  };
}

export function buildAdminUserCsv(users: readonly AdminUserRow[]): string {
  const header = [
    'id',
    'email',
    'display_name',
    'department',
    'role',
    'status',
    'storage_quota_bytes',
    'used_bytes',
    'file_count',
    'last_login_at',
    'created_at',
  ].join(',');
  const lines = users.map((user) =>
    [
      user.id,
      user.email,
      user.displayName,
      user.department,
      user.role,
      user.status,
      user.storageQuotaBytes,
      user.usedBytes,
      user.fileCount,
      user.lastLoginAt,
      user.createdAt,
    ]
      .map(csvCell)
      .join(',')
  );
  return [header, ...lines].join('\n');
}

async function loadTargetUser(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<TargetUserRow | null> {
  return db
    .prepare(
      `SELECT id, email, display_name, department, role, status, user_type,
              storage_quota_bytes, last_login_at, created_at, updated_at
         FROM users
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, userId)
    .first<TargetUserRow>();
}

async function loadMemberRowStrict(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<AdminUserRow> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.department, u.role, u.status,
              u.storage_quota_bytes, u.last_login_at, u.created_at,
              COALESCE(s.total_bytes, 0) AS used_bytes,
              COALESCE(s.file_count, 0) AS file_count
         FROM users u
         LEFT JOIN user_storage_stats s
           ON s.tenant_id = u.tenant_id AND s.user_id = u.id
        WHERE u.tenant_id = ? AND u.id = ? AND u.user_type = 'member'`
    )
    .bind(tenantId, userId)
    .first<RawAdminUserRow>();
  if (!row) {
    throw new AdminUserError(
      404,
      'MEMBER_NOT_FOUND',
      'Internal member not found'
    );
  }
  return projectRow(row);
}

function requireMemberTarget(target: TargetUserRow | null): TargetUserRow {
  if (!target) {
    throw new AdminUserError(
      404,
      'MEMBER_NOT_FOUND',
      'Internal member not found'
    );
  }
  if (target.user_type !== 'member') {
    throw new AdminUserError(
      404,
      'NOT_INTERNAL_MEMBER',
      'Guest accounts are managed by the guest lifecycle console'
    );
  }
  return target;
}

export async function loadAdminUserDetail(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<AdminUserDetailResult | null> {
  const target = await loadTargetUser(db, tenantId, userId);
  if (!target) return null;
  requireMemberTarget(target);

  const [row, rootFolders, groups, sessionRow, auditRows] = await Promise.all([
    db
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.department, u.role, u.status,
                u.storage_quota_bytes, u.last_login_at, u.created_at, u.updated_at,
                COALESCE(s.total_bytes, 0) AS used_bytes,
                COALESCE(s.file_count, 0) AS file_count
           FROM users u
           LEFT JOIN user_storage_stats s
             ON s.tenant_id = u.tenant_id AND s.user_id = u.id
          WHERE u.tenant_id = ? AND u.id = ? AND u.user_type = 'member'`
      )
      .bind(tenantId, userId)
      .first<RawAdminUserRow>(),
    db
      .prepare(
        `SELECT DISTINCT f.id, f.name, f.classification, f.created_at
           FROM folders f
           JOIN permissions p
             ON p.tenant_id = f.tenant_id
            AND p.target_type = 'folder'
            AND p.target_id = f.id
            AND p.grantee_type = 'user'
            AND p.grantee_id = ?
            AND p.role = 'owner'
          WHERE f.tenant_id = ?
            AND f.parent_id IS NULL
            AND f.deleted_at IS NULL
          ORDER BY f.name ASC`
      )
      .bind(userId, tenantId)
      .all<{
        id: string;
        name: string;
        classification: string;
        created_at: string;
      }>(),
    db
      .prepare(
        `SELECT g.id, g.name
           FROM groups g
           JOIN group_members gm ON gm.group_id = g.id
          WHERE g.tenant_id = ? AND gm.user_id = ?
          ORDER BY g.name ASC`
      )
      .bind(tenantId, userId)
      .all<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM sessions
          WHERE tenant_id = ? AND user_id = ?
            AND revoked_at IS NULL AND expires_at > ?`
      )
      .bind(tenantId, userId, new Date().toISOString())
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT id, action, status, actor_email, actor_ip, target_type,
                target_id, metadata_json, created_at
           FROM audit_logs
          WHERE tenant_id = ?
            AND action LIKE 'admin.user.%'
            AND (target_id = ? OR json_extract(metadata_json, '$.userId') = ?)
          ORDER BY created_at DESC, id DESC
          LIMIT 20`
      )
      .bind(tenantId, userId, userId)
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
      }>(),
  ]);

  if (!row) return null;

  return {
    user: {
      ...projectRow(row),
      updatedAt: row.updated_at ?? target.updated_at,
    },
    rootFolders: rootFolders.results.map((folder) => ({
      id: folder.id,
      name: folder.name,
      classification: folder.classification,
      createdAt: folder.created_at,
    })),
    groups: groups.results.map((group) => ({
      id: group.id,
      name: group.name,
    })),
    activeSessionCount: sessionRow?.count ?? 0,
    recentAuditLogs: auditRows.results.map((log) => ({
      id: log.id,
      action: log.action,
      status: log.status,
      actorEmail: log.actor_email,
      actorIp: log.actor_ip,
      targetType: log.target_type,
      targetId: log.target_id,
      metadata: log.metadata_json
        ? (JSON.parse(log.metadata_json) as Record<string, unknown>)
        : null,
      createdAt: log.created_at,
    })),
  };
}

export async function createAdminUser(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  email: unknown;
  displayName: unknown;
  department?: unknown;
  role?: unknown;
  storageQuotaBytes?: unknown;
}): Promise<AdminUserMutationResult> {
  const { db, tenantId, actor } = input;
  const email = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(input.displayName);
  const department = normalizeDepartment(input.department);
  const role = normalizeRole(input.role, 'member');
  const storageQuotaBytes =
    normalizeStorageQuotaBytes(input.storageQuotaBytes, {
      allowUndefined: true,
    }) ?? null;

  const duplicate = await db
    .prepare(
      `SELECT id, user_type FROM users
        WHERE tenant_id = ? AND lower(email) = lower(?) LIMIT 1`
    )
    .bind(tenantId, email)
    .first<{ id: string; user_type: 'member' | 'guest' }>();
  if (duplicate) {
    throw new AdminUserError(
      409,
      'EMAIL_ALREADY_EXISTS',
      'A member or guest account already uses this email address'
    );
  }

  const userId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO users (
             id, tenant_id, email, display_name, department, role, status,
             user_type, storage_quota_bytes, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'member', ?, ?, ?)`
        )
        .bind(
          userId,
          tenantId,
          email,
          displayName,
          department,
          role,
          storageQuotaBytes,
          nowIso,
          nowIso
        ),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.create',
        targetType: 'user',
        targetId: userId,
        metadata: {
          userId,
          email,
          displayName,
          department,
          role,
          storageQuotaBytes,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: userId,
        targetUserId: userId,
        action: 'admin.user.create',
        payload: { email, displayName, department, role, status: 'active' },
        nowIso,
      }),
    ]);
  } catch (err) {
    if (((err as Error).message ?? '').includes('UNIQUE constraint failed')) {
      throw new AdminUserError(
        409,
        'EMAIL_ALREADY_EXISTS',
        'A member or guest account already uses this email address'
      );
    }
    throw err;
  }

  return {
    ok: true,
    user: await loadMemberRowStrict(db, tenantId, userId),
    syncSeq: extractLastSyncSeq(results),
    notice: `${email} を社内メンバーとして登録しました。`,
  };
}

export async function updateAdminUser(input: {
  db: D1Database;
  tenantId: string;
  userId: string;
  actor: AuthUser;
  displayName?: unknown;
  department?: unknown;
  role?: unknown;
  storageQuotaBytes?: unknown;
}): Promise<AdminUserMutationResult> {
  const { db, tenantId, userId, actor } = input;
  const target = requireMemberTarget(
    await loadTargetUser(db, tenantId, userId)
  );

  const nextDisplayName =
    input.displayName === undefined
      ? target.display_name
      : normalizeDisplayName(input.displayName);
  const nextDepartment =
    input.department === undefined
      ? target.department
      : normalizeDepartment(input.department);
  const nextRole = normalizeRole(input.role, target.role);
  const quotaInput = normalizeStorageQuotaBytes(input.storageQuotaBytes, {
    allowUndefined: true,
  });
  const nextQuota =
    quotaInput === undefined ? target.storage_quota_bytes : quotaInput;

  const roleChanged = nextRole !== target.role;
  const displayNameChanged = nextDisplayName !== target.display_name;
  const departmentChanged = nextDepartment !== target.department;
  const quotaChanged = nextQuota !== target.storage_quota_bytes;

  if (
    !roleChanged &&
    !displayNameChanged &&
    !departmentChanged &&
    !quotaChanged
  ) {
    return {
      ok: true,
      user: await loadMemberRowStrict(db, tenantId, userId),
      syncSeq: null,
      notice: '変更はありません。',
    };
  }

  if (roleChanged) {
    if (target.id === actor.id) {
      throw new AdminUserError(
        409,
        'CANNOT_SELF_MODIFY_PRIVILEGE',
        'You cannot change your own administrative role'
      );
    }
    if (
      target.role === 'sys_admin' &&
      target.status === 'active' &&
      nextRole !== 'sys_admin'
    ) {
      const otherAdmins = await db
        .prepare(
          `SELECT COUNT(*) AS count FROM users
            WHERE tenant_id = ? AND user_type = 'member'
              AND role = 'sys_admin' AND status = 'active' AND id <> ?`
        )
        .bind(tenantId, target.id)
        .first<{ count: number }>();
      if ((otherAdmins?.count ?? 0) === 0) {
        throw new AdminUserError(
          409,
          'LAST_SYS_ADMIN_REQUIRED',
          'At least one active sys_admin must remain'
        );
      }
    }
  }

  const nowIso = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users
            SET display_name = ?, department = ?, role = ?,
                storage_quota_bytes = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
      )
      .bind(
        nextDisplayName,
        nextDepartment,
        nextRole,
        nextQuota,
        nowIso,
        tenantId,
        target.id
      ),
    buildAuditLogStmt(db, {
      tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: actor.ipAddress,
      action: 'admin.user.update',
      targetType: 'user',
      targetId: target.id,
      metadata: {
        userId: target.id,
        email: target.email,
        previous: {
          displayName: target.display_name,
          department: target.department,
          role: target.role,
          storageQuotaBytes: target.storage_quota_bytes,
        },
        next: {
          displayName: nextDisplayName,
          department: nextDepartment,
          role: nextRole,
          storageQuotaBytes: nextQuota,
        },
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId,
      entityType: 'user',
      entityId: target.id,
      targetUserId: target.id,
      action: 'admin.user.update',
      payload: {
        email: target.email,
        displayName: nextDisplayName,
        department: nextDepartment,
        role: nextRole,
        storageQuotaBytes: nextQuota,
      },
      nowIso,
    }),
  ]);

  return {
    ok: true,
    user: await loadMemberRowStrict(db, tenantId, target.id),
    syncSeq: extractLastSyncSeq(results),
    notice: `${target.email} のメンバー情報を更新しました。`,
  };
}

function assertActorCanManageTarget(
  actor: AuthUser,
  target: TargetUserRow
): void {
  if (actor.role === 'sec_admin' && target.role !== 'member') {
    throw new AdminUserError(
      403,
      'SYS_ADMIN_REQUIRED',
      'Only sys_admin can manage sys_admin or sec_admin accounts'
    );
  }
}

export async function suspendAdminUser(input: {
  db: D1Database;
  tenantId: string;
  userId: string;
  actor: AuthUser;
  idempotencyKey?: string | null;
}): Promise<AdminUserMutationResult> {
  const { db, tenantId, userId, actor } = input;
  const target = requireMemberTarget(
    await loadTargetUser(db, tenantId, userId)
  );

  if (target.id === actor.id) {
    throw new AdminUserError(
      409,
      'CANNOT_SELF_MODIFY_PRIVILEGE',
      'You cannot suspend your own account'
    );
  }
  assertActorCanManageTarget(actor, target);

  const session = await beginAdminBulkOperation<AdminUserMutationResult>({
    db,
    tenantId,
    operation: 'admin.user.suspend',
    idempotencyKey: input.idempotencyKey ?? null,
    payload: { userId },
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    if (
      target.role === 'sys_admin' &&
      target.status === 'active'
    ) {
      const otherAdmins = await db
        .prepare(
          `SELECT COUNT(*) AS count FROM users
            WHERE tenant_id = ? AND user_type = 'member'
              AND role = 'sys_admin' AND status = 'active' AND id <> ?`
        )
        .bind(tenantId, target.id)
        .first<{ count: number }>();
      if ((otherAdmins?.count ?? 0) === 0) {
        throw new AdminUserError(
          409,
          'LAST_SYS_ADMIN_REQUIRED',
          'At least one active sys_admin must remain'
        );
      }
    }

    const nowIso = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = 'suspended', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
        )
        .bind(nowIso, tenantId, target.id),
      db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, tenantId, target.id),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.suspend',
        targetType: 'user',
        targetId: target.id,
        metadata: {
          userId: target.id,
          email: target.email,
          role: target.role,
          previousStatus: target.status,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: target.id,
        targetUserId: target.id,
        action: 'user.suspended',
        payload: {
          email: target.email,
          status: 'suspended',
          reason: 'admin_suspend',
        },
        nowIso,
      }),
    ]);

    const sessionsRevoked = results[1]?.meta.changes ?? 0;
    const response: AdminUserMutationResult = {
      ok: true,
      user: await loadMemberRowStrict(db, tenantId, target.id),
      sessionsRevoked,
      syncSeq: extractLastSyncSeq(results),
      notice: `メンバーを停止し、有効セッション ${sessionsRevoked} 件を失効させました。`,
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

/**
 * `sessionsRevoked` in the audit row cannot include the final count because the
 * `UPDATE sessions` result is only available after the batch runs. The
 * authoritative count is returned in the API response and sync event.
 */

export async function resumeAdminUser(input: {
  db: D1Database;
  tenantId: string;
  userId: string;
  actor: AuthUser;
  idempotencyKey?: string | null;
}): Promise<AdminUserMutationResult> {
  const { db, tenantId, userId, actor } = input;
  const target = requireMemberTarget(
    await loadTargetUser(db, tenantId, userId)
  );
  assertActorCanManageTarget(actor, target);

  const session = await beginAdminBulkOperation<AdminUserMutationResult>({
    db,
    tenantId,
    operation: 'admin.user.resume',
    idempotencyKey: input.idempotencyKey ?? null,
    payload: { userId },
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const results = await db.batch([
      db
        .prepare(
          `UPDATE users
              SET status = 'active', updated_at = ?
            WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
        )
        .bind(nowIso, tenantId, target.id),
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.resume',
        targetType: 'user',
        targetId: target.id,
        metadata: {
          userId: target.id,
          email: target.email,
          role: target.role,
          previousStatus: target.status,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: target.id,
        targetUserId: target.id,
        action: 'admin.user.resume',
        payload: { email: target.email, status: 'active' },
        nowIso,
      }),
    ]);

    const response: AdminUserMutationResult = {
      ok: true,
      user: await loadMemberRowStrict(db, tenantId, target.id),
      syncSeq: extractLastSyncSeq(results),
      notice: 'メンバーアカウントを再開しました。',
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* CSV / bulk import                                                   */
/* ------------------------------------------------------------------ */

export interface ParsedAdminUserCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

function parseCsvMatrix(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else if (char === '\r') {
      // `\r\n` is handled by the following `\n`.
    } else {
      cell += char;
    }
  }

  if (inQuotes) {
    throw new AdminUserError(
      400,
      'INVALID_CSV',
      'CSV contains an unterminated quoted field'
    );
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((record) => record.some((value) => value.trim() !== ''));
}

function normalizeCsvHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]/g, '');
}

const CSV_HEADER_MAP: Record<string, string> = {
  email: 'email',
  displayname: 'displayName',
  name: 'displayName',
  department: 'department',
  dept: 'department',
  role: 'role',
  storagequotabytes: 'storageQuotaBytes',
  storagequota: 'storageQuotaBytes',
  quotabytes: 'storageQuotaBytes',
  quota: 'storageQuotaBytes',
};

export function parseAdminUserCsv(text: string): ParsedAdminUserCsv {
  const cleaned = text.replace(/^\uFEFF/, '');
  const matrix = parseCsvMatrix(cleaned);
  if (matrix.length === 0) {
    throw new AdminUserError(
      400,
      'BULK_IMPORT_EMPTY',
      'CSV must contain a header and at least one data row'
    );
  }

  const rawHeaders = matrix[0] ?? [];
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const rawHeader of rawHeaders) {
    const normalized = normalizeCsvHeader(rawHeader);
    if (!normalized) continue;
    const mapped = CSV_HEADER_MAP[normalized];
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    headers.push(mapped);
  }
  if (!seen.has('email')) {
    throw new AdminUserError(
      400,
      'INVALID_CSV_HEADER',
      'CSV header must include an email column'
    );
  }

  const rows = matrix.slice(1).map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (record[index] ?? '').trim();
    });
    return row;
  });

  return { headers, rows };
}

interface BulkInputRow {
  rowNumber: number;
  emailRaw: unknown;
  displayNameRaw: unknown;
  departmentRaw: unknown;
  roleRaw: unknown;
  storageQuotaRaw: unknown;
}

function normalizeBulkInputRows(input: {
  csv?: unknown;
  rows?: unknown;
}): BulkInputRow[] {
  const hasCsv = typeof input.csv === 'string' && input.csv.trim().length > 0;
  const hasRows = Array.isArray(input.rows);

  if (hasCsv && hasRows) {
    throw new AdminUserError(
      400,
      'INVALID_BULK_IMPORT',
      'Provide either csv or rows, not both'
    );
  }
  if (!hasCsv && !hasRows) {
    throw new AdminUserError(
      400,
      'INVALID_BULK_IMPORT',
      'csv text or a rows array is required'
    );
  }

  let rows: BulkInputRow[];
  if (hasCsv) {
    const parsed = parseAdminUserCsv(input.csv as string);
    rows = parsed.rows.map((row, index) => ({
      rowNumber: index + 2,
      emailRaw: row.email,
      displayNameRaw: row.displayName,
      departmentRaw: row.department,
      roleRaw: row.role,
      storageQuotaRaw: row.storageQuotaBytes,
    }));
  } else {
    rows = (input.rows as unknown[]).map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {
          rowNumber: index + 1,
          emailRaw: undefined,
          displayNameRaw: undefined,
          departmentRaw: undefined,
          roleRaw: undefined,
          storageQuotaRaw: undefined,
        };
      }
      const record = raw as Record<string, unknown>;
      return {
        rowNumber: index + 1,
        emailRaw: record.email,
        displayNameRaw: record.displayName ?? record.display_name,
        departmentRaw: record.department,
        roleRaw: record.role,
        storageQuotaRaw:
          record.storageQuotaBytes ?? record.storage_quota_bytes,
      };
    });
  }

  if (rows.length === 0) {
    throw new AdminUserError(
      400,
      'BULK_IMPORT_EMPTY',
      'Bulk import requires at least one data row'
    );
  }
  if (rows.length > MAX_ADMIN_USER_BULK_ROWS) {
    throw new AdminUserError(
      400,
      'BULK_IMPORT_TOO_LARGE',
      `At most ${MAX_ADMIN_USER_BULK_ROWS} members can be imported at once`
    );
  }
  return rows;
}

interface PlannedBulkRow {
  rowNumber: number;
  email: string;
  displayName: string | null;
  department: string | null;
  role: UserRole | null;
  storageQuotaBytes: number | null;
  action: AdminUserBulkAction;
  userId: string;
  existing: TargetUserRow | null;
  code?: string;
  error?: string;
}

async function loadExistingUsersByEmail(
  db: D1Database,
  tenantId: string,
  emails: readonly string[]
): Promise<Map<string, TargetUserRow>> {
  const map = new Map<string, TargetUserRow>();
  const chunkSize = 40;
  for (let index = 0; index < emails.length; index += chunkSize) {
    const chunk = emails.slice(index, index + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT id, email, display_name, department, role, status, user_type,
                storage_quota_bytes, last_login_at, created_at, updated_at
           FROM users
          WHERE tenant_id = ? AND lower(email) IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<TargetUserRow>();
    for (const row of res.results) {
      map.set(row.email.toLowerCase(), row);
    }
  }
  return map;
}

function toRowResult(row: PlannedBulkRow): AdminUserBulkRowResult {
  return {
    rowNumber: row.rowNumber,
    email: row.email,
    action: row.action,
    displayName: row.displayName,
    department: row.department,
    role: row.role,
    storageQuotaBytes: row.storageQuotaBytes,
    ...(row.action !== 'error' ? { userId: row.userId } : {}),
    ...(row.code ? { code: row.code } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function summarizeBulkRows(rows: readonly PlannedBulkRow[]) {
  return {
    createdCount: rows.filter((row) => row.action === 'create').length,
    updatedCount: rows.filter((row) => row.action === 'update').length,
    unchangedCount: rows.filter((row) => row.action === 'unchanged').length,
    errorCount: rows.filter((row) => row.action === 'error').length,
  };
}

export async function bulkImportAdminUsers(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  csv?: unknown;
  rows?: unknown;
  dryRun?: unknown;
  idempotencyKey?: string | null;
}): Promise<AdminUserBulkImportResult> {
  const { db, tenantId, actor } = input;
  const dryRun = input.dryRun === true;
  const inputRows = normalizeBulkInputRows({
    csv: input.csv,
    rows: input.rows,
  });

  const planned: PlannedBulkRow[] = [];
  let validEmails: string[] = [];

  for (const inputRow of inputRows) {
    let email: string;
    try {
      email = normalizeEmail(inputRow.emailRaw);
    } catch (err) {
      const e = err as AdminUserError;
      planned.push({
        rowNumber: inputRow.rowNumber,
        email:
          typeof inputRow.emailRaw === 'string'
            ? inputRow.emailRaw.trim().toLowerCase()
            : '',
        displayName: null,
        department: null,
        role: null,
        storageQuotaBytes: null,
        action: 'error',
        userId: '',
        existing: null,
        code: e.code,
        error: e.message,
      });
      continue;
    }
    planned.push({
      rowNumber: inputRow.rowNumber,
      email,
      displayName: null,
      department: null,
      role: null,
      storageQuotaBytes: null,
      action: 'unchanged',
      userId: crypto.randomUUID(),
      existing: null,
    });
    validEmails.push(email);
  }

  const existingByEmail = await loadExistingUsersByEmail(
    db,
    tenantId,
    [...new Set(validEmails)]
  );

  const seenEmails = new Set<string>();
  for (let index = 0; index < planned.length; index += 1) {
    const row = planned[index]!;
    if (row.action === 'error') continue;
    const inputRow = inputRows[index]!;

    if (seenEmails.has(row.email)) {
      row.action = 'error';
      row.code = 'DUPLICATE_EMAIL_IN_IMPORT';
      row.error = 'The same email appears more than once in this import';
      continue;
    }

    const existing = existingByEmail.get(row.email) ?? null;
    row.existing = existing;

    try {
      const displayName =
        inputRow.displayNameRaw === undefined ||
        (typeof inputRow.displayNameRaw === 'string' &&
          inputRow.displayNameRaw.trim() === '')
          ? undefined
          : normalizeDisplayName(inputRow.displayNameRaw);
      const department =
        inputRow.departmentRaw === undefined
          ? undefined
          : normalizeDepartment(inputRow.departmentRaw);
      const role =
        inputRow.roleRaw === undefined ||
        (typeof inputRow.roleRaw === 'string' &&
          inputRow.roleRaw.trim() === '')
          ? undefined
          : normalizeRole(inputRow.roleRaw);
      const storageQuotaBytes = normalizeStorageQuotaBytes(
        inputRow.storageQuotaRaw,
        { allowUndefined: true }
      );

      if (existing) {
        if (existing.user_type !== 'member') {
          row.action = 'error';
          row.code = 'NOT_INTERNAL_MEMBER';
          row.error = 'Guest accounts cannot be managed from this console';
          row.userId = '';
          continue;
        }
        const nextDisplayName = displayName ?? existing.display_name;
        const nextDepartment =
          department === undefined ? existing.department : department;
        const nextRole = role ?? existing.role;
        const nextQuota =
          storageQuotaBytes === undefined
            ? existing.storage_quota_bytes
            : storageQuotaBytes;

        if (existing.id === actor.id && nextRole !== existing.role) {
          row.action = 'error';
          row.code = 'CANNOT_SELF_MODIFY_PRIVILEGE';
          row.error = 'You cannot change your own administrative role';
          row.userId = '';
          continue;
        }

        row.displayName = nextDisplayName;
        row.department = nextDepartment;
        row.role = nextRole;
        row.storageQuotaBytes = nextQuota;
        row.userId = existing.id;
        row.action =
          nextDisplayName !== existing.display_name ||
          nextDepartment !== existing.department ||
          nextRole !== existing.role ||
          nextQuota !== existing.storage_quota_bytes
            ? 'update'
            : 'unchanged';
        seenEmails.add(row.email);
        continue;
      }

      if (!displayName) {
        row.action = 'error';
        row.code = 'DISPLAY_NAME_REQUIRED';
        row.error = 'displayName is required for a new member';
        row.userId = '';
        continue;
      }
      row.displayName = displayName;
      row.department = department ?? null;
      row.role = role ?? 'member';
      row.storageQuotaBytes = storageQuotaBytes ?? null;
      row.action = 'create';
      seenEmails.add(row.email);
    } catch (err) {
      const e = err as AdminUserError;
      row.action = 'error';
      row.code = e.code;
      row.error = e.message;
      row.userId = '';
    }
  }

  // Preserve at least one active sys_admin across the whole request.
  const activeSysAdmins = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM users
        WHERE tenant_id = ? AND user_type = 'member'
          AND role = 'sys_admin' AND status = 'active'`
    )
    .bind(tenantId)
    .first<{ count: number }>();
  const createdSysAdmins = planned.filter(
    (row) => row.action === 'create' && row.role === 'sys_admin'
  ).length;
  const promotedSysAdmins = planned.filter(
    (row) =>
      row.action === 'update' &&
      row.existing?.role !== 'sys_admin' &&
      row.role === 'sys_admin'
  ).length;
  const demotions = planned.filter(
    (row) =>
      row.action === 'update' &&
      row.existing?.role === 'sys_admin' &&
      row.existing.status === 'active' &&
      row.role !== 'sys_admin'
  );
  if (
    (activeSysAdmins?.count ?? 0) +
      createdSysAdmins +
      promotedSysAdmins -
      demotions.length <
    1
  ) {
    for (const row of demotions) {
      row.action = 'error';
      row.code = 'LAST_SYS_ADMIN_REQUIRED';
      row.error = 'At least one active sys_admin must remain';
      row.userId = '';
    }
  }

  const counts = summarizeBulkRows(planned);
  const payload = {
    csv: typeof input.csv === 'string' ? input.csv : null,
    rows: Array.isArray(input.rows) ? input.rows : null,
    dryRun: false,
  };

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      replayed: false,
      totalRows: planned.length,
      ...counts,
      results: planned.map(toRowResult),
      syncSeq: null,
      notice: `プレビュー: 作成 ${counts.createdCount} 件 / 更新 ${counts.updatedCount} 件 / 変更なし ${counts.unchangedCount} 件 / エラー ${counts.errorCount} 件。`,
    };
  }

  const session = await beginAdminBulkOperation<AdminUserBulkImportResult>({
    db,
    tenantId,
    operation: 'admin.user.bulk_import',
    idempotencyKey: input.idempotencyKey ?? null,
    payload,
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const groups: D1PreparedStatement[][] = [];
    for (const row of planned) {
      if (row.action === 'create') {
        groups.push([
          db
            .prepare(
              `INSERT INTO users (
                 id, tenant_id, email, display_name, department, role, status,
                 user_type, storage_quota_bytes, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, 'active', 'member', ?, ?, ?)`
            )
            .bind(
              row.userId,
              tenantId,
              row.email,
              row.displayName,
              row.department,
              row.role,
              row.storageQuotaBytes,
              nowIso,
              nowIso
            ),
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'user',
            entityId: row.userId,
            targetUserId: row.userId,
            action: 'admin.user.create',
            payload: {
              email: row.email,
              displayName: row.displayName,
              department: row.department,
              role: row.role,
              status: 'active',
              source: 'bulk_import',
            },
            nowIso,
          }),
        ]);
      } else if (row.action === 'update' && row.existing) {
        groups.push([
          db
            .prepare(
              `UPDATE users
                  SET display_name = ?, department = ?, role = ?,
                      storage_quota_bytes = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
            )
            .bind(
              row.displayName,
              row.department,
              row.role,
              row.storageQuotaBytes,
              nowIso,
              tenantId,
              row.existing.id
            ),
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'user',
            entityId: row.existing.id,
            targetUserId: row.existing.id,
            action: 'admin.user.update',
            payload: {
              email: row.email,
              displayName: row.displayName,
              department: row.department,
              role: row.role,
              storageQuotaBytes: row.storageQuotaBytes,
              source: 'bulk_import',
            },
            nowIso,
          }),
        ]);
      }
    }

    groups.push([
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.bulk_import',
        targetType: 'user',
        targetId: 'bulk-import',
        metadata: {
          totalRows: planned.length,
          ...counts,
          createdEmails: planned
            .filter((row) => row.action === 'create')
            .map((row) => row.email),
          updatedEmails: planned
            .filter((row) => row.action === 'update')
            .map((row) => row.email),
        },
        nowIso,
      }),
    ]);

    const results = await executeGroupedBatches(db, groups);
    const response: AdminUserBulkImportResult = {
      ok: true,
      dryRun: false,
      replayed: false,
      totalRows: planned.length,
      ...counts,
      results: planned.map(toRowResult),
      syncSeq: extractLastSyncSeq(results),
      notice: `メンバーを一括登録しました（作成 ${counts.createdCount} 件 / 更新 ${counts.updatedCount} 件 / 変更なし ${counts.unchangedCount} 件 / エラー ${counts.errorCount} 件）。`,
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}
