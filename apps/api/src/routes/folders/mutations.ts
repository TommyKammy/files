import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../services/authorization';
import { can } from '../../services/capabilities';
import {
  createFolderWithClosures,
  type FolderRow,
  moveFolderSubtree,
  softDeleteFolderSubtree,
  validateFolderName,
} from '../../services/folder-closure-service';
import { buildSyncChangeStmt, parseExpectedVersionInput } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import { TrashRequestError } from '../../services/trash-items';
import { restoreTrashFolder } from '../../services/trash-restore';
import type { ClassificationLabel } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import { VALID_CLASSIFICATIONS } from '../../utils/classification';
import {
  FOLDER_CHILD_COLS,
  handleFolderError,
} from './shared';

export function registerFolderMutationRoutes(routes: Hono<OidcHonoEnv>) {
  /** POST /api/folders — create folder + ancestor closure rows atomically */
  routes.post('/', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      parentId?: string | null;
      classification?: ClassificationLabel;
      isPinned?: boolean;
    } | null;

    if (!body) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (body.classification !== undefined && !VALID_CLASSIFICATIONS.has(body.classification)) {
      return c.json({ error: 'Invalid classification value' }, 400);
    }

    try {
      const folder = await createFolderWithClosures(c.env.DB, user, {
        name: body.name,
        parentId: body.parentId ?? null,
        classification: body.classification,
        isPinned: Boolean(body.isPinned),
      });
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        eventKind: 'folder.create',
        scopeFolderIds: [folder.parent_id, folder.id],
      });
      return c.json({ folder }, 201);
    } catch (err) {
      return handleFolderError(c, err);
    }
  });

  /** PATCH /api/folders/:id — rename or pin/unpin folder with optimistic lock version bump */
  routes.patch('/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const folderId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      isPinned?: boolean;
      expectedVersion?: number;
    } | null;

    if (!body) {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const access = await resolveTargetAccess(c.env.DB, user, 'folder', folderId);
    if (!access || access.deletedAt !== null) {
      return c.json({ error: 'Folder not found' }, 404);
    }
    // Rename and pinning both mutate the folder itself; `folder.rename` is the
    // editor-tier capability (`uploader`-family roles can only create).
    if (!can(access.capabilities, 'folder.rename')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const existing = await c.env.DB.prepare(
      `SELECT ${FOLDER_CHILD_COLS} FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
    )
      .bind(user.tenantId, folderId)
      .first<FolderRow>();
    if (!existing) {
      return c.json({ error: 'Folder not found' }, 404);
    }

    if (body.expectedVersion !== undefined && existing.version !== body.expectedVersion) {
      return c.json({ error: 'Version conflict', code: 'VERSION_CONFLICT', latest: existing }, 409);
    }

    let nextName = existing.name;
    if (body.name !== undefined) {
      try {
        nextName = validateFolderName(body.name);
      } catch (err) {
        return handleFolderError(c, err);
      }
      if (nextName !== existing.name) {
        const dup = await c.env.DB.prepare(
          `SELECT id FROM folders
            WHERE tenant_id = ?
              AND COALESCE(parent_id, '__ROOT__') = COALESCE(?, '__ROOT__')
              AND name = ? AND deleted_at IS NULL AND id != ?`
        )
          .bind(user.tenantId, existing.parent_id, nextName, folderId)
          .first<{ id: string }>();
        if (dup) {
          return c.json({ error: 'Folder name already exists', code: 'NAME_CONFLICT' }, 409);
        }
      }
    }

    const nextPinned =
      body.isPinned !== undefined ? (body.isPinned ? 1 : 0) : existing.is_pinned;
    const nowIso = new Date().toISOString();

    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE folders
            SET name = ?, is_pinned = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(nextName, nextPinned, nowIso, user.tenantId, folderId),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'folder.update',
        targetType: 'folder',
        targetId: folderId,
        classificationSnapshot: existing.classification,
        metadata: { name: nextName, isPinned: nextPinned === 1 },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'folder',
        entityId: folderId,
        folderId: existing.parent_id,
        action: 'folder.update',
        payload: {
          name: nextName,
          isPinned: nextPinned,
          version: existing.version + 1,
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'folder.update',
      scopeFolderIds: [existing.parent_id, folderId],
    });

    return c.json({
      folder: {
        ...existing,
        name: nextName,
        is_pinned: nextPinned,
        version: existing.version + 1,
        updated_at: nowIso,
      },
    });
  });

  /** POST /api/folders/:id/move — O(1) cycle check, closure table update, strictness propagation */
  routes.post('/:id/move', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      targetParentId?: string | null;
      expectedVersion?: number;
    } | null;

    if (!body || body.targetParentId === undefined) {
      return c.json({ error: 'targetParentId (string or null) is required' }, 400);
    }

    try {
      const result = await moveFolderSubtree(
        c.env.DB,
        c.env.JOBS_QUEUE,
        user,
        c.req.param('id'),
        {
          targetParentId: body.targetParentId,
          expectedVersion: body.expectedVersion,
        }
      );
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        eventKind: 'folder.move',
        scopeFolderIds: [c.req.param('id'), body.targetParentId],
      });
      return c.json(result);
    } catch (err) {
      return handleFolderError(c, err);
    }
  });

  /** DELETE /api/folders/:id — atomic subtree soft delete & FTS5 cleanup */
  routes.delete('/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as { expectedVersion?: unknown } | null;
    const expectedVersion = parseExpectedVersionInput(c.req.query('expectedVersion'), body);
    const targetFolderId = c.req.param('id');
    try {
      const result = await softDeleteFolderSubtree(c.env.DB, user, targetFolderId, {
        expectedVersion,
      });
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        eventKind: 'folder.soft_delete',
        scopeFolderIds: [targetFolderId],
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return handleFolderError(c, err);
    }
  });

  /**
   * POST /api/folders/:id/restore — batch-timestamp subtree restore, optional
   * deleted-ancestor chain and destination move, with one atomic D1 batch.
   */
  routes.post('/:id/restore', async (c) => {
    const user = getAuthenticatedUser(c);
    const queryPolicy = c.req.query('conflictPolicy');
    const body = (await c.req.json().catch(() => ({}))) as {
      conflictPolicy?: unknown;
      targetParentId?: unknown;
      restoreParentChain?: unknown;
    } | null;
    const rawPolicy = queryPolicy ?? body?.conflictPolicy ?? 'fail';

    try {
      if (rawPolicy !== 'fail' && rawPolicy !== 'rename') {
        throw new TrashRequestError(
          400,
          'INVALID_CONFLICT_POLICY',
          "conflictPolicy must be 'fail' or 'rename'"
        );
      }

      let target: { targetParentId?: string | null } = {};
      if (body && Object.prototype.hasOwnProperty.call(body, 'targetParentId')) {
        if (body.targetParentId === null) {
          target = { targetParentId: null };
        } else if (
          typeof body.targetParentId === 'string' &&
          body.targetParentId.trim().length > 0
        ) {
          target = { targetParentId: body.targetParentId.trim() };
        } else {
          throw new TrashRequestError(
            400,
            'INVALID_TARGET_FOLDER',
            'targetParentId must be a non-empty string or null'
          );
        }
      }

      const result = await restoreTrashFolder(
        c.env.DB,
        user,
        c.req.param('id'),
        rawPolicy,
        {
          ...target,
          restoreParentChain: body?.restoreParentChain === true,
        }
      );
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        seq: result.syncSeq,
        eventKind: 'folder.restore',
        scopeFolderIds: result.scopeFolderIds,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof TrashRequestError) {
        return c.json(
          { error: err.message, code: err.code },
          err.status
        );
      }
      return handleFolderError(c, err);
    }
  });
}

