import type { UserRole } from '../../types/api';
import { csvCell } from '../admin-guests';
import { projectRow, ROLE_VALUES, SORT_COLUMNS } from './shared';
import type {
  AdminUserAccountStatus,
  AdminUserAggregations,
  AdminUserFilters,
  AdminUserListResult,
  AdminUserRow,
  AdminUserStatusFilter,
  RawAdminUserRow,
} from './types';

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
  if (filters.scopeGroupId) {
    conditions.push(
      'EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = ? AND gm.user_id = u.id)'
    );
    binds.push(filters.scopeGroupId);
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

  const [rows, totalRow, statusRes, roleRes, departmentRes, activeSysAdminRow] =
    await Promise.all([
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
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM users
            WHERE tenant_id = ? AND user_type = 'member'
              AND role = 'sys_admin' AND status = 'active'`
        )
        .bind(tenantId)
        .first<{ count: number }>(),
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
    activeSysAdminCount: activeSysAdminRow?.count ?? 0,
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
