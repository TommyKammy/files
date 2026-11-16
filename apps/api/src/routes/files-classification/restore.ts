import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import { TrashRequestError } from '../../services/trash-items';
import {
  restoreTrashFile,
  type TrashConflictPolicy,
} from '../../services/trash-restore';
import type { OidcHonoEnv } from '../../types/oidc';

function handleFileRestoreError(
  c: {
    json: (
      body: unknown,
      status: 400 | 403 | 404 | 409 | 413
    ) => Response;
  },
  err: unknown
): Response {
  if (err instanceof TrashRequestError) {
    const includeCode =
      err.code !== 'NOT_FOUND' &&
      err.code !== 'FORBIDDEN' &&
      err.code !== 'NOT_IN_TRASH';
    return c.json(
      includeCode ? { error: err.message, code: err.code } : { error: err.message },
      err.status
    );
  }
  throw err;
}

export function registerFileRestoreRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/files/:id/restore — restore soft-deleted single file & reindex FTS5 */
  routes.post('/:id/restore', async (c) => {
    const user = getAuthenticatedUser(c);
    const fileId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      newName?: unknown;
      conflictPolicy?: unknown;
    } | null;
    const conflictPolicy: TrashConflictPolicy =
      body?.conflictPolicy === 'rename' ? 'rename' : 'fail';

    try {
      const result = await restoreTrashFile(c.env.DB, user, fileId, {
        newName: body?.newName,
        conflictPolicy,
      });

      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'file.restore',
        scopeFolderIds: [result.scopeFolderId],
      });

      return c.json({ ok: true, file: result.file });
    } catch (err) {
      return handleFileRestoreError(c, err);
    }
  });
}
