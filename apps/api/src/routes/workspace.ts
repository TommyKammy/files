import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { getAuthenticatedUser } from '../services/authorization';
import { emitTenantSyncSignal } from '../services/sync-notifier';
import {
  WorkspaceOpError,
  batchMoveWorkspaceItems,
  copyWorkspaceItems,
  duplicateWorkspaceItems,
  getWorkspaceJobStatus,
  type WorkspaceConflictPolicy,
} from '../services/workspace-operations';
import type { OidcHonoEnv } from '../types/oidc';
import { workspaceZipRoutes } from './workspace-zip';

function handleWorkspaceError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 413) => Response },
  err: unknown
): Response {
  if (err instanceof WorkspaceOpError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.latest !== undefined ? { latest: err.latest } : {}),
      },
      err.status
    );
  }
  throw err;
}

export const workspaceRoutes = new Hono<OidcHonoEnv>();

workspaceRoutes.use('*', sessionAuthMiddleware({ required: true }));
workspaceRoutes.route('/', workspaceZipRoutes);

/** POST /api/workspace/batch-move — batch move folders and files atomically with RBAC & closure checks */
workspaceRoutes.post('/batch-move', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    items?: unknown;
    targetParentId?: unknown;
    conflictPolicy?: unknown;
  } | null;

  if (!body || body.targetParentId === undefined) {
    return c.json({ error: 'items and targetParentId (string or null) are required' }, 400);
  }
  if (
    body.targetParentId !== null &&
    (typeof body.targetParentId !== 'string' || body.targetParentId.trim().length === 0)
  ) {
    return c.json({ error: 'targetParentId must be a non-empty string or null' }, 400);
  }

  const targetParentId =
    body.targetParentId === null ? null : body.targetParentId.trim();
  const conflictPolicy: WorkspaceConflictPolicy =
    body.conflictPolicy === 'rename' ? 'rename' : 'fail';

  try {
    const result = await batchMoveWorkspaceItems(c.env.DB, c.env.JOBS_QUEUE, user, {
      items: body.items,
      targetParentId,
      conflictPolicy,
    });

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: result.syncSeq,
      eventKind: 'workspace.batch_move',
      scopeFolderIds: result.scopeFolderIds,
    });

    return c.json({
      ok: true,
      movedFolders: result.movedFolders,
      movedFiles: result.movedFiles,
      skippedIds: result.skippedIds,
      classificationJobQueued: result.classificationJobQueued,
    });
  } catch (err) {
    return handleWorkspaceError(c, err);
  }
});

/** POST /api/workspace/copy — CoW logical copy of files/subtrees with viewer+ DLP enforcement */
workspaceRoutes.post('/copy', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    items?: unknown;
    targetParentId?: unknown;
    conflictPolicy?: unknown;
  } | null;

  if (!body || body.targetParentId === undefined) {
    return c.json({ error: 'items and targetParentId (string or null) are required' }, 400);
  }
  if (
    body.targetParentId !== null &&
    (typeof body.targetParentId !== 'string' || body.targetParentId.trim().length === 0)
  ) {
    return c.json({ error: 'targetParentId must be a non-empty string or null' }, 400);
  }

  const targetParentId =
    body.targetParentId === null ? null : body.targetParentId.trim();
  const conflictPolicy: WorkspaceConflictPolicy =
    body.conflictPolicy === 'fail' ? 'fail' : 'rename';

  try {
    const result = await copyWorkspaceItems(c.env.DB, c.env.JOBS_QUEUE, user, {
      items: body.items,
      targetParentId,
      conflictPolicy,
    });

    if (!result.queued) {
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'workspace.copy',
        scopeFolderIds: result.scopeFolderIds,
      });
    }

    return c.json(
      {
        ok: true,
        queued: result.queued,
        ...(result.jobId ? { jobId: result.jobId } : {}),
        totalItems: result.totalItems,
        copiedFolders: result.copiedFolders,
        copiedFiles: result.copiedFiles,
      },
      result.queued ? 202 : 201
    );
  } catch (err) {
    return handleWorkspaceError(c, err);
  }
});

/** POST /api/workspace/duplicate — in-place duplicate into each item's current parent folder */
workspaceRoutes.post('/duplicate', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    items?: unknown;
  } | null;

  if (!body) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    const result = await duplicateWorkspaceItems(c.env.DB, c.env.JOBS_QUEUE, user, body.items);

    if (!result.queued) {
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'workspace.copy',
        scopeFolderIds: result.scopeFolderIds,
      });
    }

    return c.json(
      {
        ok: true,
        queued: result.queued,
        ...(result.jobId ? { jobId: result.jobId } : {}),
        ...(result.jobIds.length > 0 ? { jobIds: result.jobIds } : {}),
        totalItems: result.totalItems,
        copiedFolders: result.copiedFolders,
        copiedFiles: result.copiedFiles,
      },
      result.queued ? 202 : 201
    );
  } catch (err) {
    return handleWorkspaceError(c, err);
  }
});

/** GET /api/workspace/jobs/:id — inspect background copy job progress */
workspaceRoutes.get('/jobs/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const job = await getWorkspaceJobStatus(c.env.DB, user.tenantId, c.req.param('id'));
  if (!job) {
    return c.json({ error: 'Workspace job not found' }, 404);
  }
  return c.json({ job });
});
