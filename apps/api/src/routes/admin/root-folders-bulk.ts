import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { AdminBulkOperationError } from '../../services/admin-bulk';
import { AdminBulkIdempotencyError } from '../../services/admin-bulk-idempotency';
import {
  bulkArchiveAdminRootFolders,
  bulkRestoreAdminRootFolders,
} from '../../services/admin-bulk-root-folders';
import { bulkTransferAdminRootFolderOwner } from '../../services/admin-bulk-permissions';
import { AdminRootFolderError } from '../../services/admin-root-folders';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';
import type { AdminBulkResponse } from '../../services/admin-bulk';

function handleBulkError(
  c: {
    json: (
      body: unknown,
      status: 400 | 403 | 404 | 409
    ) => Response;
  },
  err: unknown
): Response {
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

async function readBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  return (await c.req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
}

async function emitBulkSignal(
  c: Parameters<typeof emitTenantSyncSignal>[0],
  tenantId: string,
  eventKind: string,
  result: AdminBulkResponse
): Promise<void> {
  await emitTenantSyncSignal(c, {
    tenantId,
    seq: result.syncSeq,
    eventKind,
    scopeFolderIds: result.results
      .filter((item) => item.status === 'succeeded')
      .map((item) => item.folderId),
  });
}

export function registerAdminRootFolderBulkRoutes(routes: Hono<OidcHonoEnv>) {
  routes.post('/root-folders/bulk-transfer-owner', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        { error: 'sys_admin role required', code: 'SYS_ADMIN_REQUIRED' },
        403
      );
    }
    const body = await readBody(c);
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    try {
      const result = await bulkTransferAdminRootFolderOwner(
        { DB: c.env.DB },
        user,
        {
          folderIds: body.folderIds,
          newOwnerUserId: body.newOwnerUserId,
          demotePreviousOwnersTo: body.demotePreviousOwnersTo,
          dryRun: body.dryRun,
          idempotencyKey: body.idempotencyKey,
          headerIdempotencyKey: c.req.header('Idempotency-Key'),
        }
      );
      await emitBulkSignal(
        c,
        user.tenantId,
        'admin.root_folder.bulk_transfer',
        result
      );
      return c.json(result);
    } catch (err) {
      return handleBulkError(c, err);
    }
  });

  routes.post('/root-folders/bulk-archive', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        { error: 'sys_admin role required', code: 'SYS_ADMIN_REQUIRED' },
        403
      );
    }
    const body = await readBody(c);
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    try {
      const result = await bulkArchiveAdminRootFolders(
        { DB: c.env.DB, FILE_LOCK_HUB: c.env.FILE_LOCK_HUB },
        user,
        {
          folderIds: body.folderIds,
          dryRun: body.dryRun,
          idempotencyKey: body.idempotencyKey,
          headerIdempotencyKey: c.req.header('Idempotency-Key'),
        }
      );
      await emitBulkSignal(
        c,
        user.tenantId,
        'admin.root_folder.bulk_archive',
        result
      );
      return c.json(result);
    } catch (err) {
      return handleBulkError(c, err);
    }
  });

  routes.post('/root-folders/bulk-restore', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        { error: 'sys_admin role required', code: 'SYS_ADMIN_REQUIRED' },
        403
      );
    }
    const body = await readBody(c);
    if (!body) return c.json({ error: 'JSON body required' }, 400);
    try {
      const result = await bulkRestoreAdminRootFolders(
        { DB: c.env.DB, FILE_LOCK_HUB: c.env.FILE_LOCK_HUB },
        user,
        {
          folderIds: body.folderIds,
          dryRun: body.dryRun,
          idempotencyKey: body.idempotencyKey,
          headerIdempotencyKey: c.req.header('Idempotency-Key'),
        }
      );
      await emitBulkSignal(
        c,
        user.tenantId,
        'admin.root_folder.bulk_restore',
        result
      );
      return c.json(result);
    } catch (err) {
      return handleBulkError(c, err);
    }
  });
}
