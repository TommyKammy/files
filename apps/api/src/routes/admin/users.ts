import { Hono, type Context } from 'hono';
import {
  AdminBulkIdempotencyError,
  AdminUserError,
  MAX_ADMIN_USER_BULK_ROWS,
  buildAdminUserCsv,
  bulkImportAdminUsers,
  createAdminUser,
  isAdminUserRoleFilter,
  isAdminUserSortBy,
  isAdminUserStatusFilter,
  listAdminUsers,
  loadAdminUserDetail,
  resolveIdempotencyKey,
  resumeAdminUser,
  suspendAdminUser,
  updateAdminUser,
  type AdminUserFilters,
} from '../../services/admin-users';
import { getAuthenticatedUser } from '../../services/authorization';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';

const MAX_QUERY_LENGTH = 320;

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function parseOffset(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function adminUserErrorResponse(
  c: Context<OidcHonoEnv>,
  err: unknown
): Response {
  if (err instanceof AdminUserError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof AdminBulkIdempotencyError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

function hasReplayed(response: { replayed?: boolean }): boolean {
  return response.replayed === true;
}

export function registerAdminUserRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/users — internal member list, summaries and CSV export. */
  routes.get('/users', async (c) => {
    const user = getAuthenticatedUser(c);

    const roleRaw = c.req.query('role')?.trim() || 'all';
    if (!isAdminUserRoleFilter(roleRaw)) {
      return c.json(
        {
          error: 'role must be all, sys_admin, sec_admin, or member',
          code: 'INVALID_MEMBER_ROLE_FILTER',
        },
        400
      );
    }

    const statusRaw = c.req.query('status')?.trim() || 'all';
    if (!isAdminUserStatusFilter(statusRaw)) {
      return c.json(
        {
          error: 'status must be all, active, or suspended',
          code: 'INVALID_MEMBER_STATUS_FILTER',
        },
        400
      );
    }

    const sortByRaw = c.req.query('sortBy')?.trim() || 'createdAt';
    if (!isAdminUserSortBy(sortByRaw)) {
      return c.json(
        {
          error:
            'sortBy must be email, displayName, department, role, status, createdAt, lastLoginAt, or usedBytes',
          code: 'INVALID_MEMBER_SORT',
        },
        400
      );
    }

    const sortDirRaw = c.req.query('sortDir')?.trim() || 'desc';
    if (sortDirRaw !== 'asc' && sortDirRaw !== 'desc') {
      return c.json(
        {
          error: 'sortDir must be asc or desc',
          code: 'INVALID_MEMBER_SORT_DIRECTION',
        },
        400
      );
    }

    const formatRaw = c.req.query('format')?.trim() || 'json';
    if (formatRaw !== 'json' && formatRaw !== 'csv') {
      return c.json(
        { error: 'format must be json or csv', code: 'INVALID_FORMAT' },
        400
      );
    }

    const queryRaw = c.req.query('query')?.trim() || null;
    const departmentRaw = c.req.query('department')?.trim() || null;
    for (const value of [queryRaw, departmentRaw]) {
      if (value && value.length > MAX_QUERY_LENGTH) {
        return c.json(
          {
            error: `Member filters must be at most ${MAX_QUERY_LENGTH} characters`,
            code: 'INVALID_MEMBER_FILTER',
          },
          400
        );
      }
    }

    const filters: AdminUserFilters = {
      query: queryRaw,
      role: roleRaw,
      status: statusRaw,
      department: departmentRaw,
      sortBy: sortByRaw,
      sortDir: sortDirRaw,
      limit: parseLimit(c.req.query('limit'), 50, 200),
      offset: parseOffset(c.req.query('offset')),
    };

    const result = await listAdminUsers(c.env.DB, user.tenantId, filters);

    if (formatRaw === 'csv') {
      return c.body(buildAdminUserCsv(result.users), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="admin-users.csv"',
      });
    }
    return c.json(result);
  });

  /** GET /api/admin/users/:id — member detail with storage, ACL and sessions. */
  routes.get('/users/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const memberId = c.req.param('id');
    try {
      const detail = await loadAdminUserDetail(
        c.env.DB,
        user.tenantId,
        memberId
      );
      if (!detail) {
        return c.json(
          { error: 'Internal member not found', code: 'MEMBER_NOT_FOUND' },
          404
        );
      }
      return c.json(detail);
    } catch (err) {
      return adminUserErrorResponse(c, err);
    }
  });

  /** POST /api/admin/users — individual member registration (sys_admin). */
  routes.post('/users', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can register internal members',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!body) {
      return c.json(
        { error: 'JSON body required', code: 'INVALID_BODY' },
        400
      );
    }
    try {
      const result = await createAdminUser({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        email: body.email,
        displayName: body.displayName ?? body.display_name,
        department: body.department,
        role: body.role,
        storageQuotaBytes:
          body.storageQuotaBytes ?? body.storage_quota_bytes,
      });
      return c.json(result, 201);
    } catch (err) {
      return adminUserErrorResponse(c, err);
    }
  });

  /** PATCH /api/admin/users/:id — profile, role and quota update (sys_admin). */
  routes.patch('/users/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can change roles or personal quotas',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!body) {
      return c.json(
        { error: 'JSON body required', code: 'INVALID_BODY' },
        400
      );
    }
    try {
      const result = await updateAdminUser({
        db: c.env.DB,
        tenantId: user.tenantId,
        userId: c.req.param('id'),
        actor: user,
        displayName: body.displayName ?? body.display_name,
        department: body.department,
        role: body.role,
        storageQuotaBytes:
          body.storageQuotaBytes !== undefined
            ? body.storageQuotaBytes
            : body.storage_quota_bytes,
      });
      return c.json(result);
    } catch (err) {
      return adminUserErrorResponse(c, err);
    }
  });

  /** POST /api/admin/users/:id/suspend — sys_admin & sec_admin. */
  routes.post('/users/:id/suspend', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    try {
      const result = await suspendAdminUser({
        db: c.env.DB,
        tenantId: user.tenantId,
        userId: c.req.param('id'),
        actor: user,
        idempotencyKey: resolveIdempotencyKey(
          body?.idempotencyKey,
          c.req.header('Idempotency-Key')
        ),
      });
      if (!hasReplayed(result)) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: result.syncSeq,
          eventKind: 'user.suspended',
          targetUserId: c.req.param('id'),
          revoked: true,
        });
      }
      return c.json(result);
    } catch (err) {
      return adminUserErrorResponse(c, err);
    }
  });

  /** POST /api/admin/users/:id/resume — sys_admin & sec_admin. */
  routes.post('/users/:id/resume', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    try {
      const result = await resumeAdminUser({
        db: c.env.DB,
        tenantId: user.tenantId,
        userId: c.req.param('id'),
        actor: user,
        idempotencyKey: resolveIdempotencyKey(
          body?.idempotencyKey,
          c.req.header('Idempotency-Key')
        ),
      });
      if (!hasReplayed(result)) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: result.syncSeq,
          eventKind: 'admin.user.resume',
          targetUserId: c.req.param('id'),
        });
      }
      return c.json(result);
    } catch (err) {
      return adminUserErrorResponse(c, err);
    }
  });

  /**
   * POST /api/admin/users/bulk-import — CSV/row bulk upsert (sys_admin).
   * `dryRun` previews never consume the idempotency key.
   */
  routes.post('/users/bulk-import', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can bulk import internal members',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!body) {
      return c.json(
        { error: 'JSON body required', code: 'INVALID_BODY' },
        400
      );
    }
    if (
      body.csv !== undefined &&
      typeof body.csv !== 'string' &&
      !Array.isArray(body.rows)
    ) {
      return c.json(
        {
          error: `csv must be UTF-8 text or rows must contain at most ${MAX_ADMIN_USER_BULK_ROWS} entries`,
          code: 'INVALID_BULK_IMPORT',
        },
        400
      );
    }
    try {
      const result = await bulkImportAdminUsers({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        csv: body.csv,
        rows: body.rows,
        dryRun: body.dryRun,
        idempotencyKey: resolveIdempotencyKey(
          body.idempotencyKey,
          c.req.header('Idempotency-Key')
        ),
      });
      if (!result.dryRun && !result.replayed) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: result.syncSeq,
          eventKind: 'admin.user.bulk_import',
        });
      }
      return c.json(result);
    } catch (err) {
      return adminUserErrorResponse(c, err);
    }
  });
}
