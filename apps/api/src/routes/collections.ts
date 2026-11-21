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

const ALLOWED_COLLECTION_COLORS = [
  'slate',
  'indigo',
  'emerald',
  'amber',
  'rose',
  'sky',
  'violet',
] as const;

type CollectionColor = (typeof ALLOWED_COLLECTION_COLORS)[number];

interface CollectionRow {
  id: string;
  name: string;
  color: string;
  created_at: string;
  updated_at: string;
  item_count?: number;
}

interface CollectionFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  updated_at: string;
  added_at: string;
}

interface CollectionFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  classification: ClassificationLabel;
  updated_at: string;
  added_at: string;
}

export interface CollectionEntry {
  id: string;
  name: string;
  color: CollectionColor;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionItemEntry {
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
  addedAt: string;
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

function normalizeCollectionName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 60) return null;
  return trimmed;
}

function normalizeCollectionColor(value: unknown): CollectionColor | null {
  if (value === undefined) return 'slate';
  if (
    typeof value === 'string' &&
    (ALLOWED_COLLECTION_COLORS as readonly string[]).includes(value)
  ) {
    return value as CollectionColor;
  }
  return null;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.toLowerCase().includes('unique constraint');
}

function toCollectionEntry(row: CollectionRow): CollectionEntry {
  const color = (ALLOWED_COLLECTION_COLORS as readonly string[]).includes(
    row.color
  )
    ? (row.color as CollectionColor)
    : 'slate';
  return {
    id: row.id,
    name: row.name,
    color,
    itemCount: Number(row.item_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const collectionsRoutes = new Hono<OidcHonoEnv>();

collectionsRoutes.use('*', sessionAuthMiddleware({ required: true }));

/**
 * GET /api/collections — list the authenticated user's collections with item counts.
 */
collectionsRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);

  const rows = await c.env.DB.prepare(
    `SELECT uc.id,
            uc.name,
            uc.color,
            uc.created_at,
            uc.updated_at,
            COUNT(
              CASE
                WHEN (uci.item_type = 'folder' AND f.id IS NOT NULL)
                  OR (uci.item_type = 'file' AND fl.id IS NOT NULL)
                THEN 1
              END
            ) AS item_count
       FROM user_collections uc
       LEFT JOIN user_collection_items uci
         ON uci.tenant_id = uc.tenant_id
        AND uci.user_id = uc.user_id
        AND uci.collection_id = uc.id
       LEFT JOIN folders f
         ON uci.item_type = 'folder'
        AND f.tenant_id = uci.tenant_id
        AND f.id = uci.item_id
        AND f.deleted_at IS NULL
       LEFT JOIN files fl
         ON uci.item_type = 'file'
        AND fl.tenant_id = uci.tenant_id
        AND fl.id = uci.item_id
        AND fl.deleted_at IS NULL
        AND fl.upload_state = 'active'
      WHERE uc.tenant_id = ?
        AND uc.user_id = ?
      GROUP BY uc.id, uc.name, uc.color, uc.created_at, uc.updated_at
      ORDER BY uc.created_at ASC, uc.name ASC`
  )
    .bind(user.tenantId, user.id)
    .all<CollectionRow>();

  return c.json({
    collections: rows.results.map(toCollectionEntry),
  });
});

/**
 * POST /api/collections — create a new user collection.
 */
collectionsRoutes.post('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = await c.req
    .json<{ name?: unknown; color?: unknown }>()
    .catch(() => null);

  const name = normalizeCollectionName(body?.name);
  if (!name) {
    return c.json(
      { error: 'Collection name must be between 1 and 60 characters' },
      400
    );
  }

  const color = normalizeCollectionColor(body?.color);
  if (!color) {
    return c.json({ error: 'Invalid collection color' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM user_collections
      WHERE tenant_id = ? AND user_id = ? AND name = ?`
  )
    .bind(user.tenantId, user.id, name)
    .first<{ id: string }>();

  if (existing) {
    return c.json({ error: 'Collection name already exists' }, 409);
  }

  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO user_collections (id, tenant_id, user_id, name, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(id, user.tenantId, user.id, name, color)
      .run();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return c.json({ error: 'Collection name already exists' }, 409);
    }
    throw err;
  }

  const created = await c.env.DB.prepare(
    `SELECT id, name, color, created_at, updated_at, 0 AS item_count
       FROM user_collections
      WHERE id = ? AND tenant_id = ? AND user_id = ?`
  )
    .bind(id, user.tenantId, user.id)
    .first<CollectionRow>();

  if (!created) {
    return c.json({ error: 'Failed to load created collection' }, 500);
  }

  return c.json({ collection: toCollectionEntry(created) }, 201);
});

/**
 * PATCH /api/collections/:id — rename or recolor a user collection.
 */
collectionsRoutes.patch('/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const collectionId = normalizeItemId(c.req.param('id'));
  if (!collectionId) {
    return c.json({ error: 'Invalid collection id' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, name, color, created_at, updated_at
       FROM user_collections
      WHERE id = ? AND tenant_id = ? AND user_id = ?`
  )
    .bind(collectionId, user.tenantId, user.id)
    .first<CollectionRow>();

  if (!existing) {
    return c.json({ error: 'Collection not found' }, 404);
  }

  const body = await c.req
    .json<{ name?: unknown; color?: unknown }>()
    .catch(() => null);
  if (!body || (body.name === undefined && body.color === undefined)) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  let nextName = existing.name;
  if (body.name !== undefined) {
    const normalized = normalizeCollectionName(body.name);
    if (!normalized) {
      return c.json(
        { error: 'Collection name must be between 1 and 60 characters' },
        400
      );
    }
    nextName = normalized;
  }

  let nextColor = existing.color;
  if (body.color !== undefined) {
    const normalizedColor = normalizeCollectionColor(body.color);
    if (!normalizedColor) {
      return c.json({ error: 'Invalid collection color' }, 400);
    }
    nextColor = normalizedColor;
  }

  if (nextName !== existing.name) {
    const duplicate = await c.env.DB.prepare(
      `SELECT id FROM user_collections
        WHERE tenant_id = ? AND user_id = ? AND name = ? AND id != ?`
    )
      .bind(user.tenantId, user.id, nextName, collectionId)
      .first<{ id: string }>();
    if (duplicate) {
      return c.json({ error: 'Collection name already exists' }, 409);
    }
  }

  try {
    await c.env.DB.prepare(
      `UPDATE user_collections
          SET name = ?, color = ?, updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ? AND user_id = ?`
    )
      .bind(nextName, nextColor, collectionId, user.tenantId, user.id)
      .run();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return c.json({ error: 'Collection name already exists' }, 409);
    }
    throw err;
  }

  const updated = await c.env.DB.prepare(
    `SELECT uc.id,
            uc.name,
            uc.color,
            uc.created_at,
            uc.updated_at,
            COUNT(
              CASE
                WHEN (uci.item_type = 'folder' AND f.id IS NOT NULL)
                  OR (uci.item_type = 'file' AND fl.id IS NOT NULL)
                THEN 1
              END
            ) AS item_count
       FROM user_collections uc
       LEFT JOIN user_collection_items uci
         ON uci.tenant_id = uc.tenant_id
        AND uci.user_id = uc.user_id
        AND uci.collection_id = uc.id
       LEFT JOIN folders f
         ON uci.item_type = 'folder'
        AND f.tenant_id = uci.tenant_id
        AND f.id = uci.item_id
        AND f.deleted_at IS NULL
       LEFT JOIN files fl
         ON uci.item_type = 'file'
        AND fl.tenant_id = uci.tenant_id
        AND fl.id = uci.item_id
        AND fl.deleted_at IS NULL
        AND fl.upload_state = 'active'
      WHERE uc.id = ? AND uc.tenant_id = ? AND uc.user_id = ?
      GROUP BY uc.id, uc.name, uc.color, uc.created_at, uc.updated_at`
  )
    .bind(collectionId, user.tenantId, user.id)
    .first<CollectionRow>();

  return c.json({
    collection: toCollectionEntry(
      updated ?? {
        ...existing,
        name: nextName,
        color: nextColor,
      }
    ),
  });
});

/**
 * DELETE /api/collections/:id — delete a collection and its item memberships.
 */
collectionsRoutes.delete('/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const collectionId = normalizeItemId(c.req.param('id'));
  if (!collectionId) {
    return c.json({ error: 'Invalid collection id' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM user_collections
      WHERE id = ? AND tenant_id = ? AND user_id = ?`
  )
    .bind(collectionId, user.tenantId, user.id)
    .first<{ id: string }>();

  if (!existing) {
    return c.json({ error: 'Collection not found' }, 404);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM user_collection_items
        WHERE tenant_id = ? AND user_id = ? AND collection_id = ?`
    ).bind(user.tenantId, user.id, collectionId),
    c.env.DB.prepare(
      `DELETE FROM user_collections
        WHERE id = ? AND tenant_id = ? AND user_id = ?`
    ).bind(collectionId, user.tenantId, user.id),
  ]);

  return c.json({ ok: true, id: collectionId });
});

/**
 * GET /api/collections/:id/items — list items in a collection, strictly
 * filtered by current RBAC permissions and non-deleted/active state.
 */
collectionsRoutes.get('/:id/items', async (c) => {
  const user = getAuthenticatedUser(c);
  const collectionId = normalizeItemId(c.req.param('id'));
  if (!collectionId) {
    return c.json({ error: 'Invalid collection id' }, 400);
  }

  const collectionRow = await c.env.DB.prepare(
    `SELECT id, name, color, created_at, updated_at
       FROM user_collections
      WHERE id = ? AND tenant_id = ? AND user_id = ?`
  )
    .bind(collectionId, user.tenantId, user.id)
    .first<CollectionRow>();

  if (!collectionRow) {
    return c.json({ error: 'Collection not found' }, 404);
  }

  const [folderRows, fileRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT f.id,
              f.parent_id,
              f.name,
              f.classification,
              f.updated_at,
              uci.added_at
         FROM user_collection_items uci
         JOIN folders f
           ON f.tenant_id = uci.tenant_id
          AND f.id = uci.item_id
          AND f.deleted_at IS NULL
        WHERE uci.tenant_id = ?
          AND uci.user_id = ?
          AND uci.collection_id = ?
          AND uci.item_type = 'folder'`
    )
      .bind(user.tenantId, user.id, collectionId)
      .all<CollectionFolderRow>(),
    c.env.DB.prepare(
      `SELECT fl.id,
              fl.folder_id,
              fl.name,
              fl.extension,
              fl.mime_type,
              fl.size_bytes,
              fl.classification,
              fl.updated_at,
              uci.added_at
         FROM user_collection_items uci
         JOIN files fl
           ON fl.tenant_id = uci.tenant_id
          AND fl.id = uci.item_id
          AND fl.deleted_at IS NULL
          AND fl.upload_state = 'active'
        WHERE uci.tenant_id = ?
          AND uci.user_id = ?
          AND uci.collection_id = ?
          AND uci.item_type = 'file'`
    )
      .bind(user.tenantId, user.id, collectionId)
      .all<CollectionFileRow>(),
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

  const items: CollectionItemEntry[] = [];

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
      addedAt: row.added_at,
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
      addedAt: row.added_at,
    });
  }

  items.sort((a, b) => {
    const byAdded = b.addedAt.localeCompare(a.addedAt);
    return byAdded !== 0 ? byAdded : a.id.localeCompare(b.id);
  });

  return c.json({
    collection: {
      ...toCollectionEntry(collectionRow),
      itemCount: items.length,
    },
    items,
  });
});

/**
 * POST /api/collections/:id/items — add a file or folder to a collection
 * (idempotent upsert after verifying collection ownership and RBAC access).
 */
collectionsRoutes.post('/:id/items', async (c) => {
  const user = getAuthenticatedUser(c);
  const collectionId = normalizeItemId(c.req.param('id'));
  if (!collectionId) {
    return c.json({ error: 'Invalid collection id' }, 400);
  }

  const collection = await c.env.DB.prepare(
    `SELECT id FROM user_collections
      WHERE id = ? AND tenant_id = ? AND user_id = ?`
  )
    .bind(collectionId, user.tenantId, user.id)
    .first<{ id: string }>();

  if (!collection) {
    return c.json({ error: 'Collection not found' }, 404);
  }

  const body = await c.req
    .json<{ itemType?: unknown; itemId?: unknown }>()
    .catch(() => null);
  if (!body || !isValidItemType(body.itemType)) {
    return c.json({ error: 'Invalid itemType (must be file or folder)' }, 400);
  }
  const itemId = normalizeItemId(body.itemId);
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const access = await resolveTargetAccess(
    c.env.DB,
    user,
    body.itemType,
    itemId
  );
  if (
    !access ||
    access.deletedAt !== null ||
    (body.itemType === 'file' && access.uploadState !== 'active')
  ) {
    return c.json({ error: 'Item not found' }, 404);
  }

  const requiredCap =
    body.itemType === 'folder' ? 'folder.traverse' : 'item.preview';
  if (!canAccess(access, requiredCap)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    `INSERT INTO user_collection_items (tenant_id, user_id, collection_id, item_type, item_id, added_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (tenant_id, user_id, collection_id, item_type, item_id) DO NOTHING`
  )
    .bind(user.tenantId, user.id, collectionId, body.itemType, itemId)
    .run();

  return c.json({
    ok: true,
    collectionId,
    itemType: body.itemType,
    itemId,
  });
});

/**
 * DELETE /api/collections/:id/items/:itemType/:itemId — remove an item from a collection (idempotent).
 */
collectionsRoutes.delete('/:id/items/:itemType/:itemId', async (c) => {
  const user = getAuthenticatedUser(c);
  const collectionId = normalizeItemId(c.req.param('id'));
  const itemType = c.req.param('itemType');
  const itemId = normalizeItemId(c.req.param('itemId'));

  if (!collectionId) {
    return c.json({ error: 'Invalid collection id' }, 400);
  }
  if (!isValidItemType(itemType)) {
    return c.json({ error: 'Invalid itemType (must be file or folder)' }, 400);
  }
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const collection = await c.env.DB.prepare(
    `SELECT id FROM user_collections
      WHERE id = ? AND tenant_id = ? AND user_id = ?`
  )
    .bind(collectionId, user.tenantId, user.id)
    .first<{ id: string }>();

  if (!collection) {
    return c.json({ error: 'Collection not found' }, 404);
  }

  await c.env.DB.prepare(
    `DELETE FROM user_collection_items
      WHERE tenant_id = ?
        AND user_id = ?
        AND collection_id = ?
        AND item_type = ?
        AND item_id = ?`
  )
    .bind(user.tenantId, user.id, collectionId, itemType, itemId)
    .run();

  return c.json({
    ok: true,
    collectionId,
    itemType,
    itemId,
  });
});
