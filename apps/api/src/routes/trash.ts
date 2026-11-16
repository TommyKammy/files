import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { getAuthenticatedUser } from '../services/authorization';
import { emitTenantSyncSignal } from '../services/sync-notifier';
import {
  parseTrashConflictPolicy,
  parseTrashItemsInput,
  TrashRequestError,
} from '../services/trash-items';
import {
  emptyTrash,
  purgeTrashItems,
} from '../services/trash-purge';
import { restoreTrashItems } from '../services/trash-restore';
import type { OidcHonoEnv } from '../types/oidc';

const EMPTY_TRASH_CONFIRMATION = 'EMPTY_TRASH';

function handleTrashError(
  c: {
    json: (
      body: unknown,
      status: 400 | 403 | 404 | 409 | 413
    ) => Response;
  },
  err: unknown
): Response {
  if (err instanceof TrashRequestError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

export const trashRoutes = new Hono<OidcHonoEnv>();

trashRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** POST /api/trash/restore — per-item partial-success restore of up to 100 items. */
trashRoutes.post('/restore', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    items?: unknown;
    conflictPolicy?: unknown;
  } | null;

  try {
    const items = parseTrashItemsInput(body?.items);
    const conflictPolicy = parseTrashConflictPolicy(body?.conflictPolicy);
    const result = await restoreTrashItems(
      c.env.DB,
      user,
      items,
      conflictPolicy
    );

    if (result.succeededCount > 0) {
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'trash.restore',
        scopeFolderIds: result.scopeFolderIds,
      });
    }

    return c.json({
      ok: true,
      results: result.results,
      succeededCount: result.succeededCount,
      failedCount: result.failedCount,
    });
  } catch (err) {
    return handleTrashError(c, err);
  }
});

/** DELETE /api/trash/items — per-item permanent deletion of up to 100 items. */
trashRoutes.delete('/items', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    items?: unknown;
  } | null;

  try {
    const items = parseTrashItemsInput(body?.items);
    const result = await purgeTrashItems(c.env, user, items);

    if (result.succeededCount > 0) {
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'trash.purge',
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
    return handleTrashError(c, err);
  }
});

/**
 * POST /api/trash/empty — permanently delete every top-level Trash item the
 * caller can fully delete. The confirmation string is mandatory and validated
 * before any destructive work starts.
 */
trashRoutes.post('/empty', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    confirm?: unknown;
  } | null;

  if (body?.confirm === undefined) {
    return c.json(
      {
        error: 'confirm: "EMPTY_TRASH" is required',
        code: 'CONFIRMATION_REQUIRED',
      },
      400
    );
  }
  if (body.confirm !== EMPTY_TRASH_CONFIRMATION) {
    return c.json(
      {
        error: 'Invalid confirmation value',
        code: 'INVALID_CONFIRMATION',
      },
      400
    );
  }

  const result = await emptyTrash(c.env, user);

  if (result.deletedCount > 0) {
    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: result.syncSeq,
      eventKind: 'trash.empty',
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
});
