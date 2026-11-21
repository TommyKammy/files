import type { AuthUser, UserRole } from '../../types/api';
import type {
  AdminUserRoleFilter,
  AdminUserRow,
  AdminUserSortBy,
  AdminUserStatusFilter,
  RawAdminUserRow,
  TargetUserRow,
} from './types';

export const SORT_BY_VALUES: AdminUserSortBy[] = [
  'email',
  'displayName',
  'department',
  'role',
  'status',
  'createdAt',
  'lastLoginAt',
  'usedBytes',
];

export const SORT_COLUMNS: Record<AdminUserSortBy, string> = {
  email: 'email',
  displayName: 'display_name',
  department: 'department',
  role: 'role',
  status: 'status',
  createdAt: 'created_at',
  lastLoginAt: 'last_login_at',
  usedBytes: 'used_bytes',
};

export const ROLE_VALUES: UserRole[] = ['sys_admin', 'sec_admin', 'member'];
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

export function normalizeEmail(raw: unknown): string {
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

export function normalizeDisplayName(raw: unknown): string {
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

export function normalizeDepartment(raw: unknown): string | null {
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

export function normalizeRole(raw: unknown, fallback?: UserRole): UserRole {
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
export function normalizeStorageQuotaBytes(
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

export function projectRow(row: RawAdminUserRow): AdminUserRow {
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

export async function loadTargetUser(
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

export async function loadMemberRowStrict(
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

export function requireMemberTarget(
  target: TargetUserRow | null
): TargetUserRow {
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

export function assertActorCanManageTarget(
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
