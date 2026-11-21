import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import {
  canAccess,
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../services/authorization';
import {
  hydrateWorkspaceItems,
  isValidWorkspaceItemType,
  normalizeWorkspaceItemId,
  type HydratableFileRow,
  type HydratableFolderRow,
  type HydratedWorkspaceItem,
} from '../services/workspace-item-hydrator';
import type { OidcHonoEnv } from '../types/oidc';

type FavoriteFolderRow = HydratableFolderRow & {
  favorited_at: string;
};

type FavoriteFileRow = HydratableFileRow & {
  favorited_at: string;
};

export type FavoriteItemEntry = HydratedWorkspaceItem & {
  favoritedAt: string;
};

export const favoritesRoutes = new Hono<OidcHonoEnv>();

favoritesRoutes.use('*', sessionAuthMiddleware({ required: true }));

/**
 * GET /api/favorites — returns the authenticated user's favorited files and
 * folders, strictly filtered by current RBAC permissions so revoked or deleted
 * items are never exposed.
 */
favoritesRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);

  const [folderRows, fileRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT f.id,
              f.parent_id,
              f.name,
              f.classification,
              f.updated_at,
              uf.created_at AS favorited_at
         FROM user_favorites uf
         JOIN folders f
           ON f.tenant_id = uf.tenant_id
          AND f.id = uf.item_id
          AND f.deleted_at IS NULL
        WHERE uf.tenant_id = ?
          AND uf.user_id = ?
          AND uf.item_type = 'folder'`
    )
      .bind(user.tenantId, user.id)
      .all<FavoriteFolderRow>(),
    c.env.DB.prepare(
      `SELECT fl.id,
              fl.folder_id,
              fl.name,
              fl.extension,
              fl.mime_type,
              fl.size_bytes,
              fl.classification,
              fl.updated_at,
              uf.created_at AS favorited_at
         FROM user_favorites uf
         JOIN files fl
           ON fl.tenant_id = uf.tenant_id
          AND fl.id = uf.item_id
          AND fl.deleted_at IS NULL
          AND fl.upload_state = 'active'
        WHERE uf.tenant_id = ?
          AND uf.user_id = ?
          AND uf.item_type = 'file'`
    )
      .bind(user.tenantId, user.id)
      .all<FavoriteFileRow>(),
  ]);

  const items = await hydrateWorkspaceItems<
    FavoriteFolderRow,
    FavoriteFileRow,
    FavoriteItemEntry
  >({
    db: c.env.DB,
    user,
    folderRows: folderRows.results,
    fileRows: fileRows.results,
    projectFolder: (base, row) => ({ ...base, favoritedAt: row.favorited_at }),
    projectFile: (base, row) => ({ ...base, favoritedAt: row.favorited_at }),
  });

  items.sort((a, b) => {
    const byFav = b.favoritedAt.localeCompare(a.favoritedAt);
    return byFav !== 0 ? byFav : a.id.localeCompare(b.id);
  });

  return c.json({ items });
});

/**
 * POST /api/favorites — add a file or folder to the user's favorites
 * (idempotent upsert after verifying existence and RBAC access).
 */
favoritesRoutes.post('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = await c.req.json<{ itemType?: unknown; itemId?: unknown }>().catch(() => null);
  if (!body || !isValidWorkspaceItemType(body.itemType)) {
    return c.json({ error: 'Invalid itemType (must be file or folder)' }, 400);
  }
  const itemId = normalizeWorkspaceItemId(body.itemId);
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const access = await resolveTargetAccess(c.env.DB, user, body.itemType, itemId);
  if (
    !access ||
    access.deletedAt !== null ||
    (body.itemType === 'file' && access.uploadState !== 'active')
  ) {
    return c.json({ error: 'Item not found' }, 404);
  }

  const requiredCap = body.itemType === 'folder' ? 'folder.traverse' : 'item.preview';
  if (!canAccess(access, requiredCap)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    `INSERT INTO user_favorites (tenant_id, user_id, item_type, item_id, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (tenant_id, user_id, item_type, item_id) DO NOTHING`
  )
    .bind(user.tenantId, user.id, body.itemType, itemId)
    .run();

  return c.json({ ok: true, itemType: body.itemType, itemId });
});

/**
 * DELETE /api/favorites/:itemType/:itemId — remove a favorite (idempotent).
 */
favoritesRoutes.delete('/:itemType/:itemId', async (c) => {
  const user = getAuthenticatedUser(c);
  const itemType = c.req.param('itemType');
  const itemId = normalizeWorkspaceItemId(c.req.param('itemId'));

  if (!isValidWorkspaceItemType(itemType)) {
    return c.json({ error: 'Invalid itemType (must be file or folder)' }, 400);
  }
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  await c.env.DB.prepare(
    `DELETE FROM user_favorites
      WHERE tenant_id = ?
        AND user_id = ?
        AND item_type = ?
        AND item_id = ?`
  )
    .bind(user.tenantId, user.id, itemType, itemId)
    .run();

  return c.json({ ok: true, itemType, itemId });
});
