import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  AdminBulkOperationError,
} from '../../services/admin-bulk';
import {
  AdminBulkIdempotencyError,
} from '../../services/admin-bulk-idempotency';
import {
  bulkGrantAdminRootFolderCoOwners,
} from '../../services/admin-bulk-permissions';
import {
  buildPermissionAuditCsv,
  listAdminPermissionAudit,
  type PermissionAuditFilters,
  type PermissionAuditGranteeStatus,
  type PermissionAuditHealth,
  type PermissionAuditSortBy,
  type PermissionAuditSortDir,
  type PermissionAuditSource,
} from '../../services/admin-permission-audit';
import {
  AdminRootFolderError,
} from '../../services/admin-root-folders';
import { isResourceRole } from '../../services/capabilities';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';

const MAX_FILTER_LIST = 20;

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

interface ParsedListResult {
  ok: boolean;
  values: string[];
}

function parseCsvFilter(
  c: {
    req: {
      query: (name: string) => string | undefined;
      queries: (name: string) => string[] | undefined;
    };
  },
  name: string
): ParsedListResult {
  const values: string[] = [];
  for (const raw of c.req.queries(name) ?? []) {
    for (const part of raw.split(',')) {
      const value = part.trim();
      if (value) values.push(value);
    }
  }
  if (values.length > MAX_FILTER_LIST) {
    return { ok: false, values: [] };
  }
  return { ok: true, values: [...new Set(values)] };
}

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

function parseDateFilter(
  value: string | undefined
): { ok: true; value: string | null } | { ok: false } {
  const trimmed = value?.trim();
  if (!trimmed) return { ok: true, value: null };
  if (Number.isNaN(Date.parse(trimmed))) return { ok: false };
  return { ok: true, value: trimmed };
}

function badRequest(c: { json: (body: unknown, status: 400) => Response }, code: string, error: string) {
  return c.json({ error, code }, 400);
}

export function registerAdminPermissionRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/permissions — tenant-wide permission audit (sec_admin/sys_admin). */
  routes.get('/permissions', async (c) => {
    const user = getAuthenticatedUser(c);

    const targetTypeRaw = c.req.query('targetType')?.trim() || 'all';
    if (!['all', 'folder', 'file'].includes(targetTypeRaw)) {
      return badRequest(
        c,
        'INVALID_TARGET_TYPE',
        'targetType must be all, folder, or file'
      );
    }
    const targetType = targetTypeRaw as 'all' | 'folder' | 'file';

    const sourceRaw = c.req.query('source')?.trim() || 'all';
    if (!['all', 'direct', 'inherited'].includes(sourceRaw)) {
      return badRequest(
        c,
        'INVALID_SOURCE_FILTER',
        'source must be all, direct, or inherited'
      );
    }
    const source = sourceRaw as PermissionAuditSource;

    const granteeTypeRaw = c.req.query('granteeType')?.trim() || null;
    if (
      granteeTypeRaw !== null &&
      granteeTypeRaw !== 'user' &&
      granteeTypeRaw !== 'group'
    ) {
      return badRequest(
        c,
        'INVALID_GRANTEE_TYPE',
        'granteeType must be user or group'
      );
    }

    const granteeStatusRaw = c.req.query('granteeStatus')?.trim() || null;
    if (
      granteeStatusRaw !== null &&
      !['active', 'suspended', 'deleted'].includes(granteeStatusRaw)
    ) {
      return badRequest(
        c,
        'INVALID_GRANTEE_STATUS',
        'granteeStatus must be active, suspended, or deleted'
      );
    }

    const healthRaw = c.req.query('health')?.trim() || 'all';
    if (!['all', 'owner_missing', 'inactive_owner'].includes(healthRaw)) {
      return badRequest(
        c,
        'INVALID_HEALTH_FILTER',
        'health must be all, owner_missing, or inactive_owner'
      );
    }

    const sortByRaw = c.req.query('sortBy')?.trim() || 'createdAt';
    if (
      !['createdAt', 'role', 'targetName', 'granteeName'].includes(sortByRaw)
    ) {
      return badRequest(
        c,
        'INVALID_SORT',
        'sortBy must be createdAt, role, targetName, or granteeName'
      );
    }

    const sortDirRaw = c.req.query('sortDir')?.trim() || 'desc';
    if (!['asc', 'desc'].includes(sortDirRaw)) {
      return badRequest(
        c,
        'INVALID_SORT_DIRECTION',
        'sortDir must be asc or desc'
      );
    }

    const formatRaw = c.req.query('format')?.trim() || 'json';
    if (formatRaw !== 'json' && formatRaw !== 'csv') {
      return badRequest(c, 'INVALID_FORMAT', 'format must be json or csv');
    }

    const fromResult = parseDateFilter(c.req.query('from'));
    const toResult = parseDateFilter(c.req.query('to'));
    if (!fromResult.ok || !toResult.ok) {
      return badRequest(
        c,
        'INVALID_DATE_RANGE',
        'from and to must be valid ISO timestamps'
      );
    }
    if (
      fromResult.value &&
      toResult.value &&
      Date.parse(fromResult.value) > Date.parse(toResult.value)
    ) {
      return badRequest(
        c,
        'INVALID_DATE_RANGE',
        'from must be earlier than or equal to to'
      );
    }

    const roleValues = parseCsvFilter(c, 'role');
    if (!roleValues.ok) {
      return badRequest(
        c,
        'INVALID_ROLE_FILTER',
        `At most ${MAX_FILTER_LIST} role filters are allowed`
      );
    }
    const roles: ResourceRole[] = [];
    for (const role of roleValues.values) {
      if (!isResourceRole(role)) {
        return badRequest(
          c,
          'INVALID_ROLE_FILTER',
          `Unknown resource role: ${role}`
        );
      }
      roles.push(role);
    }

    const filters: PermissionAuditFilters = {
      targetType,
      targetId: c.req.query('targetId')?.trim() || null,
      rootFolderId: c.req.query('rootFolderId')?.trim() || null,
      includeInherited: isTruthyFlag(c.req.query('includeInherited')),
      grantee: c.req.query('grantee')?.trim() || null,
      granteeType: granteeTypeRaw as 'user' | 'group' | null,
      roles,
      source,
      inheritedFromId: c.req.query('inheritedFromId')?.trim() || null,
      grantedBy: c.req.query('grantedBy')?.trim() || null,
      from: fromResult.value,
      to: toResult.value,
      granteeStatus: granteeStatusRaw as PermissionAuditGranteeStatus | null,
      health: healthRaw as PermissionAuditHealth,
      sortBy: sortByRaw as PermissionAuditSortBy,
      sortDir: sortDirRaw as PermissionAuditSortDir,
      limit: parseLimit(c.req.query('limit'), 50, 200),
      offset: parseOffset(c.req.query('offset')),
    };

    const result = await listAdminPermissionAudit(
      c.env.DB,
      user.tenantId,
      filters
    );

    if (formatRaw === 'csv') {
      return c.body(buildPermissionAuditCsv(result.entries), 200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="admin-permissions.csv"',
      });
    }

    if (isTruthyFlag(c.req.query('download'))) {
      return c.body(JSON.stringify(result), 200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition':
          'attachment; filename="admin-permissions.json"',
      });
    }
    return c.json(result);
  });

  /** POST /api/admin/permissions/bulk-co-owner — sys_admin bulk grant. */
  routes.post('/permissions/bulk-co-owner', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        { error: 'sys_admin role required', code: 'SYS_ADMIN_REQUIRED' },
        403
      );
    }
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!body) {
      return c.json({ error: 'JSON body required' }, 400);
    }

    try {
      const result = await bulkGrantAdminRootFolderCoOwners(
        { DB: c.env.DB },
        user,
        {
          folderIds: body.folderIds,
          userIds: body.userIds,
          groupIds: body.groupIds,
          dryRun: body.dryRun,
          idempotencyKey: body.idempotencyKey,
          headerIdempotencyKey: c.req.header('Idempotency-Key'),
        }
      );
      const scopeFolderIds = result.results
        .filter((item) => item.status === 'succeeded')
        .map((item) => item.folderId);
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'admin.permission.bulk_grant',
        scopeFolderIds,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof AdminBulkIdempotencyError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      if (err instanceof AdminRootFolderError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      if (err instanceof AdminBulkOperationError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }
  });
}
