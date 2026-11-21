import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import {
  canAccess,
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../services/authorization';
import {
  folderPathLabel,
  loadFolderBreadcrumbMap,
} from '../services/folder-breadcrumbs';
import type { ClassificationLabel } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';

type ItemType = 'file' | 'folder';

interface FavoriteFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  updated_at: string;
  favorited_at: string;
}

interface FavoriteFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  classification: ClassificationLabel;
  updated_at: string;
  favorited_at: string;
}

export interface FavoriteItemEntry {
  itemType: ItemType;
  id: string;
  name: string;
  classification: ClassificationLabel;
  folderId: string | null;
  parentId: string | null;
  updatedAt: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  effectiveRole: string | null;
  capabilities: string[];
  breadcrumbs: Array<{ id: string; name: string }>;
  pathLabel: string;
  favoritedAt: string;
}

function isValidItemType(value: unknown): value is ItemType {
  return value === 'file' || value === 'folder';
}

function normalizeItemId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

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

  const folderIds = [
    ...folderRows.results.map((row) => row.id),
    ...fileRows.results
      .map((row) => row.folder_id)
      .filter((id): id is string => Boolean(id)),
  ];
  const breadcrumbMap = await loadFolderBreadcrumbMap(
    c.env.DB,
    user.tenantId,
    folderIds
  );

  const items: FavoriteItemEntry[] = [];

  for (const row of folderRows.results) {
    const access = await resolveTargetAccess(c.env.DB, user, 'folder', row.id);
    if (!access || access.deletedAt !== null || !canAccess(access, 'folder.traverse')) {
      continue;
    }
    const breadcrumbs = breadcrumbMap.get(row.id) ?? [];
    items.push({
      itemType: 'folder',
      id: row.id,
      name: row.name,
      classification: row.classification,
      folderId: null,
      parentId: row.parent_id,
      updatedAt: row.updated_at,
      extension: null,
      mimeType: null,
      sizeBytes: null,
      effectiveRole: access.effectiveRole,
      capabilities: access.capabilities,
      breadcrumbs,
      pathLabel: folderPathLabel(breadcrumbs),
      favoritedAt: row.favorited_at,
    });
  }

  for (const row of fileRows.results) {
    const access = await resolveTargetAccess(c.env.DB, user, 'file', row.id);
    if (
      !access ||
      access.deletedAt !== null ||
      access.uploadState !== 'active' ||
      !canAccess(access, 'item.preview')
    ) {
      continue;
    }
    const breadcrumbs = row.folder_id
      ? breadcrumbMap.get(row.folder_id) ?? []
      : [];
    items.push({
      itemType: 'file',
      id: row.id,
      name: row.name,
      classification: row.classification,
      folderId: row.folder_id,
      parentId: null,
      updatedAt: row.updated_at,
      extension: row.extension,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      effectiveRole: access.effectiveRole,
      capabilities: access.capabilities,
      breadcrumbs,
      pathLabel: folderPathLabel(breadcrumbs),
      favoritedAt: row.favorited_at,
    });
  }

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
  if (!body || !isValidItemType(body.itemType)) {
    return c.json({ error: 'Invalid itemType (must be file or folder)' }, 400);
  }
  const itemId = normalizeItemId(body.itemId);
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
  const itemId = normalizeItemId(c.req.param('itemId'));

  if (!isValidItemType(itemType)) {
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
