import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  emptyAdminTrash,
  listAdminTrash,
  purgeAdminTrashItems,
  restoreAdminTrashItems,
  type AdminTrashFilters,
} from '../../services/admin-trash';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import { parseIsoInstant, parseTrashLimit, TRASH_SORTS, type TrashSort } from '../../services/trash-query';
import {
  parseTrashConflictPolicy,
  parseTrashItemsInput,
  TrashRequestError,
} from '../../services/trash-items';
import type { AuthUser } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';

const EMPTY_TENANT_TRASH_CONFIRMATION = 'EMPTY_TENANT_TRASH';
const MAX_DAYS_REMAINING_MAX = 3650;

function normalizedBoundaryKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function isTenantBoundaryKey(key: string): boolean {
  return normalizedBoundaryKey(key).includes('tenant');
}

function crossTenantQueryRejection(
  c: {
    req: {
      query: (name: string) => string | undefined;
      queries: () => Record<string, string[]>;
    };
    json: (body: unknown, status: 400 | 403 | 404 | 409 | 413) => Response;
  },
  user: Pick<AuthUser, 'tenantId'>
): Response | null {
  const queries = c.req.queries();
  for (const [key, values] of Object.entries(queries)) {
    if (!isTenantBoundaryKey(key)) continue;
    for (const raw of values) {
      if (raw !== '' && raw !== user.tenantId) {
        return c.json(
          {
            error: 'Cross-tenant Trash access is forbidden',
            code: 'TENANT_FORBIDDEN',
          },
          403
        );
      }
    }
  }
  return null;
}

function crossTenantBodyRejection(
  body: Record<string, unknown> | null,
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 413) => Response },
  user: Pick<AuthUser, 'tenantId'>
): Response | null {
  if (!body) return null;
  for (const [key, raw] of Object.entries(body)) {
    if (!isTenantBoundaryKey(key)) continue;
    if (typeof raw !== 'string' || raw !== user.tenantId) {
      return c.json(
        {
          error: 'Cross-tenant Trash access is forbidden',
          code: 'TENANT_FORBIDDEN',
        },
        403
      );
    }
  }
  return null;
}

function handleAdminTrashError(
  c: {
    json: (
      body: unknown,
      status: 400 | 403 | 404 | 409 | 413
    ) => Response;
  },
  err: unknown
): Response {
  if (err instanceof TrashRequestError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.details ? { details: err.details } : {}),
      },
      err.status
    );
  }
  throw err;
}

function requireSysAdmin(
  c: {
    json: (body: unknown, status: 403) => Response;
  },
  user: Pick<AuthUser, 'role'>
): Response | null {
  if (user.role !== 'sys_admin') {
    return c.json(
      {
        error:
          'Forbidden: permanent Trash deletion requires sys_admin',
        code: 'FORBIDDEN',
      },
      403
    );
  }
  return null;
}

function parseDaysRemainingMax(
  raw: string | undefined
): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: null };
  if (!/^\d+$/.test(raw.trim())) {
    return {
      ok: false,
      error: `daysRemainingMax must be an integer between 0 and ${MAX_DAYS_REMAINING_MAX}`,
    };
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0 || value > MAX_DAYS_REMAINING_MAX) {
    return {
      ok: false,
      error: `daysRemainingMax must be an integer between 0 and ${MAX_DAYS_REMAINING_MAX}`,
    };
  }
  return { ok: true, value };
}

function parseTargetFolderId(
  raw: unknown
):
  | { ok: true; provided: false }
  | { ok: true; provided: true; value: string | null }
  | { ok: false } {
  if (raw === undefined) return { ok: true, provided: false };
  if (raw === null) return { ok: true, provided: true, value: null };
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false };
  }
  return { ok: true, provided: true, value: raw.trim() };
}

export function registerAdminTrashRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/admin/trash — tenant-wide Trash metadata for sec_admin/sys_admin.
   * Only names, sizes, classifications and ACL summaries are returned; R2 keys
   * and file contents never leave the storage layer.
   */
  routes.get('/trash', async (c) => {
    const user = getAuthenticatedUser(c);
    const rejection = crossTenantQueryRejection(c, user);
    if (rejection) return rejection;

    const rawSort = c.req.query('sort') ?? 'deletedAt_desc';
    if (!TRASH_SORTS.has(rawSort as TrashSort)) {
      return c.json(
        {
          error:
            'sort must be one of deletedAt_desc, deletedAt_asc, name_asc, name_desc',
        },
        400
      );
    }

    const rawType = c.req.query('type') ?? 'all';
    if (rawType !== 'all' && rawType !== 'file' && rawType !== 'folder') {
      return c.json({ error: 'type must be one of all, file, folder' }, 400);
    }

    const rawDeletedFrom = c.req.query('deletedFrom');
    const rawDeletedTo = c.req.query('deletedTo');
    let deletedFrom: string | null = null;
    let deletedTo: string | null = null;
    if (rawDeletedFrom !== undefined && rawDeletedFrom !== '') {
      const parsed = parseIsoInstant(rawDeletedFrom);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      deletedFrom = parsed.value;
    }
    if (rawDeletedTo !== undefined && rawDeletedTo !== '') {
      const parsed = parseIsoInstant(rawDeletedTo);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      deletedTo = parsed.value;
    }
    if (deletedFrom && deletedTo && deletedFrom > deletedTo) {
      return c.json(
        { error: 'deletedFrom must be earlier than or equal to deletedTo' },
        400
      );
    }

    const daysRemainingMax = parseDaysRemainingMax(
      c.req.query('daysRemainingMax')
    );
    if (!daysRemainingMax.ok) {
      return c.json({ error: daysRemainingMax.error }, 400);
    }

    const filters: AdminTrashFilters = {
      query: c.req.query('query'),
      type: rawType,
      ownerId: c.req.query('ownerId')?.trim() || null,
      deletedById: c.req.query('deletedById')?.trim() || null,
      deletedFrom,
      deletedTo,
      daysRemainingMax: daysRemainingMax.value,
      sort: rawSort as TrashSort,
      limit: parseTrashLimit(c.req.query('limit')),
      cursor: c.req.query('cursor') ?? null,
    };

    try {
      const result = await listAdminTrash(c.env.DB, user.tenantId, filters);
      return c.json({ type: 'admin_trash', ...result });
    } catch (err) {
      return handleAdminTrashError(c, err);
    }
  });

  /** POST /api/admin/trash/restore — delegated restore for sec_admin/sys_admin. */
  routes.post('/trash/restore', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const tenantRejection = crossTenantBodyRejection(body, c, user);
    if (tenantRejection) return tenantRejection;

    try {
      const items = parseTrashItemsInput(body?.items);
      const conflictPolicy = parseTrashConflictPolicy(body?.conflictPolicy);

      const restoreParentChainRaw = body?.restoreParentChain;
      if (
        restoreParentChainRaw !== undefined &&
        typeof restoreParentChainRaw !== 'boolean'
      ) {
        return c.json(
          {
            error: 'restoreParentChain must be a boolean',
            code: 'INVALID_RESTORE_PARENT_CHAIN',
          },
          400
        );
      }

      const target = parseTargetFolderId(body?.targetFolderId);
      if (!target.ok) {
        return c.json(
          {
            error: 'targetFolderId must be a non-empty string or null',
            code: 'INVALID_TARGET_FOLDER',
          },
          400
        );
      }

      const result = await restoreAdminTrashItems(c.env.DB, user, items, {
        conflictPolicy,
        restoreParentChain: restoreParentChainRaw === true,
        ...(target.provided ? { targetFolderId: target.value } : {}),
      });

      if (result.succeededCount > 0) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: result.syncSeq,
          eventKind: 'admin.trash.restore',
          scopeFolderIds: result.scopeFolderIds,
        });
      }

      return c.json({
        ok: true,
        results: result.results,
        succeededCount: result.succeededCount,
        failedCount: result.failedCount,
        syncSeq: result.syncSeq,
      });
    } catch (err) {
      return handleAdminTrashError(c, err);
    }
  });

  /** POST /api/admin/trash/empty — sys_admin tenant-wide purge. */
  routes.post('/trash/empty', async (c) => {
    const user = getAuthenticatedUser(c);
    const forbidden = requireSysAdmin(c, user);
    if (forbidden) return forbidden;

    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const tenantRejection = crossTenantBodyRejection(body, c, user);
    if (tenantRejection) return tenantRejection;

    if (body?.confirm === undefined) {
      return c.json(
        {
          error: `confirm: "${EMPTY_TENANT_TRASH_CONFIRMATION}" is required`,
          code: 'CONFIRMATION_REQUIRED',
        },
        400
      );
    }
    if (body.confirm !== EMPTY_TENANT_TRASH_CONFIRMATION) {
      return c.json(
        {
          error: 'Invalid confirmation value',
          code: 'INVALID_CONFIRMATION',
        },
        400
      );
    }

    try {
      const result = await emptyAdminTrash(c.env, user);
      if (result.deletedCount > 0) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: result.syncSeq,
          eventKind: 'admin.trash.empty',
          scopeFolderIds: result.scopeFolderIds,
        });
      }
      return c.json({
        ok: true,
        deletedCount: result.deletedCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount,
        results: result.results,
      });
    } catch (err) {
      return handleAdminTrashError(c, err);
    }
  });

  /** DELETE /api/admin/trash/items — sys_admin selected tenant-wide purge. */
  routes.delete('/trash/items', async (c) => {
    const user = getAuthenticatedUser(c);
    const forbidden = requireSysAdmin(c, user);
    if (forbidden) return forbidden;

    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const tenantRejection = crossTenantBodyRejection(body, c, user);
    if (tenantRejection) return tenantRejection;

    try {
      const items = parseTrashItemsInput(body?.items);
      const result = await purgeAdminTrashItems(c.env, user, items);
      if (result.succeededCount > 0) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          seq: result.syncSeq,
          eventKind: 'admin.trash.purge',
          scopeFolderIds: result.scopeFolderIds,
        });
      }
      return c.json({
        ok: true,
        results: result.results,
        succeededCount: result.succeededCount,
        failedCount: result.failedCount,
        skippedCount: result.skippedCount,
      });
    } catch (err) {
      return handleAdminTrashError(c, err);
    }
  });
}
