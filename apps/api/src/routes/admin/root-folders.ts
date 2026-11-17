import { Hono } from 'hono';
import { getAdminScope } from '../../services/admin-delegations';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  AdminRootFolderError,
  archiveAdminRootFolder,
  createAdminRootFolder,
  grantAdminRootFolderCoOwners,
  listAdminRootFolders,
  restoreAdminRootFolder,
  transferAdminRootFolderOwner,
} from '../../services/admin-root-folders';
import { FileLockedError } from '../../services/file-lock';
import { FolderServiceError } from '../../services/folder-closure-service';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { AuthUser } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';

interface ErrorResponseContext {
  json: (
    body: unknown,
    status: 400 | 403 | 404 | 409 | 413
  ) => Response;
}

function handleRootFolderError(c: ErrorResponseContext, err: unknown): Response {
  if (err instanceof FileLockedError) {
    return c.json(
      { error: 'File is locked', code: err.code, lock: err.lock },
      409
    );
  }
  if (err instanceof AdminRootFolderError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof FolderServiceError) {
    return c.json(
      { error: err.message, code: err.code, ...(err.details ?? {}) },
      err.status
    );
  }
  throw err;
}

function requireSysAdmin(c: ErrorResponseContext, user: AuthUser): Response | null {
  if (user.role !== 'sys_admin') {
    return c.json(
      { error: 'sys_admin role required', code: 'SYS_ADMIN_REQUIRED' },
      403
    );
  }
  return null;
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function isFalsyFlag(value: string | undefined): boolean {
  return value === '0' || value === 'false';
}

function parseStatusFilter(
  c: { req: { query: (name: string) => string | undefined } }
): 'active' | 'archived' | 'all' | null {
  const status = c.req.query('status');
  if (status !== undefined) {
    if (status === 'active' || status === 'archived' || status === 'all') {
      return status;
    }
    return null;
  }
  const includeArchived = c.req.query('includeArchived');
  if (includeArchived !== undefined && !isTruthyFlag(includeArchived)) {
    return 'active';
  }
  return 'all';
}

export function registerAdminRootFolderRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/root-folders — tenant root inventory with owner metrics */
  routes.get('/root-folders', async (c) => {
    const user = getAuthenticatedUser(c);
    const status = parseStatusFilter(c);
    if (status === null) {
      return c.json(
        {
          error: 'status must be one of active, archived, all',
          code: 'INVALID_STATUS_FILTER',
        },
        400
      );
    }
    const rawIncludeMetrics = c.req.query('includeMetrics');
    const result = await listAdminRootFolders(c.env.DB, user.tenantId, {
      status,
      search: c.req.query('search'),
      ownerMissingOnly: isTruthyFlag(c.req.query('ownerMissingOnly')),
      includeMetrics: rawIncludeMetrics === undefined ? true : !isFalsyFlag(rawIncludeMetrics),
    });
    const scopeRootFolderId = getAdminScope(user)?.rootFolderId ?? null;
    if (scopeRootFolderId) {
      return c.json({
        ...result,
        roots: result.roots.filter((root) => root.id === scopeRootFolderId),
      });
    }
    return c.json(result);
  });

  /** POST /api/admin/root-folders — create a root folder with owner/co-owners */
  routes.post('/root-folders', async (c) => {
    const user = getAuthenticatedUser(c);
    const denied = requireSysAdmin(c, user);
    if (denied) return denied;

    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!body) {
      return c.json({ error: 'JSON body required' }, 400);
    }

    try {
      const result = await createAdminRootFolder(c.env.DB, user, {
        name: body.name,
        classification: body.classification,
        isPinned: body.isPinned,
        ownerUserId: body.ownerUserId,
        coOwnerUserIds: body.coOwnerUserIds,
        coOwnerGroupIds: body.coOwnerGroupIds,
      });
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'folder.create',
        scopeFolderIds: [null, result.root.id],
      });
      return c.json({ root: result.root }, 201);
    } catch (err) {
      return handleRootFolderError(c, err);
    }
  });

  /** POST /api/admin/root-folders/:id/transfer-owner — sys_admin ownership transfer */
  routes.post('/root-folders/:id/transfer-owner', async (c) => {
    const user = getAuthenticatedUser(c);
    const denied = requireSysAdmin(c, user);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!body) {
      return c.json({ error: 'JSON body required' }, 400);
    }
    try {
      const result = await transferAdminRootFolderOwner(
        c.env.DB,
        user,
        c.req.param('id'),
        {
          newOwnerUserId: body.newOwnerUserId,
          demotePreviousOwnersTo: body.demotePreviousOwnersTo,
        }
      );
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'admin.root_folder.owner_transfer',
        scopeFolderIds: [result.root.id],
      });
      return c.json({ root: result.root });
    } catch (err) {
      return handleRootFolderError(c, err);
    }
  });

  /** POST /api/admin/root-folders/:id/co-owners — bulk co-owner grants */
  routes.post('/root-folders/:id/co-owners', async (c) => {
    const user = getAuthenticatedUser(c);
    const denied = requireSysAdmin(c, user);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!body) {
      return c.json({ error: 'JSON body required' }, 400);
    }
    try {
      const result = await grantAdminRootFolderCoOwners(
        c.env.DB,
        user,
        c.req.param('id'),
        { userIds: body.userIds, groupIds: body.groupIds }
      );
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'permission.grant',
        scopeFolderIds: [result.root.id],
      });
      return c.json({ root: result.root });
    } catch (err) {
      return handleRootFolderError(c, err);
    }
  });

  /** POST /api/admin/root-folders/:id/archive — soft-delete the root subtree */
  routes.post('/root-folders/:id/archive', async (c) => {
    const user = getAuthenticatedUser(c);
    const denied = requireSysAdmin(c, user);
    if (denied) return denied;
    try {
      const result = await archiveAdminRootFolder(c.env, user, c.req.param('id'));
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'folder.soft_delete',
        scopeFolderIds: [c.req.param('id')],
      });
      return c.json({ ok: true, deletedAt: result.deletedAt });
    } catch (err) {
      return handleRootFolderError(c, err);
    }
  });

  /** POST /api/admin/root-folders/:id/restore — restore an archived root subtree */
  routes.post('/root-folders/:id/restore', async (c) => {
    const user = getAuthenticatedUser(c);
    const denied = requireSysAdmin(c, user);
    if (denied) return denied;
    try {
      const result = await restoreAdminRootFolder(
        c.env.DB,
        user,
        c.req.param('id')
      );
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'folder.restore',
        scopeFolderIds: [result.root.id],
      });
      return c.json({ ok: true, root: result.root });
    } catch (err) {
      return handleRootFolderError(c, err);
    }
  });
}
