import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { parseExpectedVersionInput } from '../../services/sync-changes';
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
    const hasDetails = err.details !== undefined;
    const includeCode =
      err.code !== 'NOT_FOUND' &&
      err.code !== 'NOT_IN_TRASH' &&
      (err.code !== 'FORBIDDEN' || hasDetails);
    return c.json(
      {
        ...(includeCode
          ? { error: err.message, code: err.code }
          : { error: err.message }),
        ...(includeCode ? (err.details ?? {}) : {}),
      },
      err.status
    );
  }
  throw err;
}

function parseConflictPolicy(raw: unknown): TrashConflictPolicy {
  if (raw === undefined || raw === null) return 'fail';
  if (raw === 'fail' || raw === 'rename') return raw;
  throw new TrashRequestError(
    400,
    'INVALID_CONFLICT_POLICY',
    "conflictPolicy must be 'fail' or 'rename'"
  );
}

function parseOptionalFolderTarget(
  body: Record<string, unknown> | null,
  key: string
): { provided: boolean; value: string | null } {
  if (!body || !Object.prototype.hasOwnProperty.call(body, key)) {
    return { provided: false, value: null };
  }
  const raw = body[key];
  if (raw === null) return { provided: true, value: null };
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return { provided: true, value: raw.trim() };
  }
  throw new TrashRequestError(
    400,
    'INVALID_TARGET_FOLDER',
    `${key} must be a non-empty string or null`
  );
}

export function registerFileRestoreRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/files/:id/restore — restore a file into its original or chosen folder */
  routes.post('/:id/restore', async (c) => {
    const user = getAuthenticatedUser(c);
    const fileId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    try {
      const conflictPolicy = parseConflictPolicy(body?.conflictPolicy);
      const target = parseOptionalFolderTarget(body, 'targetFolderId');
      const expectedVersion = parseExpectedVersionInput(undefined, body);
      const restoreParentChain = body?.restoreParentChain === true;

      const result = await restoreTrashFile(c.env.DB, user, fileId, {
        newName: body?.newName,
        conflictPolicy,
        ...(target.provided ? { targetFolderId: target.value } : {}),
        restoreParentChain,
        expectedVersion,
      });

      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'file.restore',
        scopeFolderIds: result.scopeFolderIds,
      });

      return c.json({
        ok: true,
        file: result.file,
        destination: result.destination,
        restoredAncestorIds: result.restoredAncestorIds,
        affectedFolderIds: result.affectedFolderIds,
      });
    } catch (err) {
      return handleFileRestoreError(c, err);
    }
  });
}
