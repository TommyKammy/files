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
type RecentAction = 'view' | 'edit' | 'download' | 'upload';

const VALID_ACTIONS = new Set<RecentAction>(['view', 'edit', 'download', 'upload']);
const MAX_RECENT_STORED = 200;
const DEFAULT_RECENT_LIMIT = 50;

interface RecentFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  updated_at: string;
  last_action: RecentAction;
  accessed_at: string;
}

interface RecentFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  classification: ClassificationLabel;
  updated_at: string;
  last_action: RecentAction;
  accessed_at: string;
}

export interface RecentItemEntry {
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
  lastAction: RecentAction;
  accessedAt: string;
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

function parseAction(value: unknown): RecentAction | null {
  if (value === undefined) return 'view';
  if (typeof value !== 'string') return null;
  return VALID_ACTIONS.has(value as RecentAction) ? (value as RecentAction) : null;
}

export const recentsRoutes = new Hono<OidcHonoEnv>();

recentsRoutes.use('*', sessionAuthMiddleware({ required: true }));

/**
 * GET /api/recents?limit=50 — returns the authenticated user's recently
 * accessed files and folders ordered by accessed_at DESC, strictly filtered
 * by current RBAC permissions so revoked or deleted items are never exposed.
 */
recentsRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawLimit = Number.parseInt(
    c.req.query('limit') ?? String(DEFAULT_RECENT_LIMIT),
    10
  );
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_RECENT_STORED)
    : DEFAULT_RECENT_LIMIT;

  const [folderRows, fileRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT f.id,
              f.parent_id,
              f.name,
              f.classification,
              f.updated_at,
              uri.last_action,
              uri.accessed_at
         FROM user_recent_items uri
         JOIN folders f
           ON f.tenant_id = uri.tenant_id
          AND f.id = uri.item_id
          AND f.deleted_at IS NULL
        WHERE uri.tenant_id = ?
          AND uri.user_id = ?
          AND uri.item_type = 'folder'
        ORDER BY uri.accessed_at DESC`
    )
      .bind(user.tenantId, user.id)
      .all<RecentFolderRow>(),
    c.env.DB.prepare(
      `SELECT fl.id,
              fl.folder_id,
              fl.name,
              fl.extension,
              fl.mime_type,
              fl.size_bytes,
              fl.classification,
              fl.updated_at,
              uri.last_action,
              uri.accessed_at
         FROM user_recent_items uri
         JOIN files fl
           ON fl.tenant_id = uri.tenant_id
          AND fl.id = uri.item_id
          AND fl.deleted_at IS NULL
          AND fl.upload_state = 'active'
        WHERE uri.tenant_id = ?
          AND uri.user_id = ?
          AND uri.item_type = 'file'
        ORDER BY uri.accessed_at DESC`
    )
      .bind(user.tenantId, user.id)
      .all<RecentFileRow>(),
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

  const items: RecentItemEntry[] = [];

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
      lastAction: row.last_action,
      accessedAt: row.accessed_at,
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
      lastAction: row.last_action,
      accessedAt: row.accessed_at,
    });
  }

  items.sort((a, b) => {
    const byAccessed = b.accessedAt.localeCompare(a.accessedAt);
    return byAccessed !== 0 ? byAccessed : a.id.localeCompare(b.id);
  });

  return c.json({ items: items.slice(0, limit) });
});

/**
 * POST /api/recents/touch — record or refresh a user's access to a file or
 * folder after verifying RBAC access, pruning entries beyond the top 200.
 */
recentsRoutes.post('/touch', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = await c.req
    .json<{ itemType?: unknown; itemId?: unknown; action?: unknown }>()
    .catch(() => null);

  if (!body || !isValidItemType(body.itemType)) {
    return c.json({ error: 'Invalid itemType (must be file or folder)' }, 400);
  }
  const itemId = normalizeItemId(body.itemId);
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }
  const action = parseAction(body.action);
  if (!action) {
    return c.json({ error: 'Invalid action' }, 400);
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

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO user_recent_items (tenant_id, user_id, item_type, item_id, last_action, accessed_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (tenant_id, user_id, item_type, item_id)
       DO UPDATE SET last_action = excluded.last_action,
                     accessed_at = datetime('now')`
    ).bind(user.tenantId, user.id, body.itemType, itemId, action),
    c.env.DB.prepare(
      `DELETE FROM user_recent_items
        WHERE tenant_id = ?
          AND user_id = ?
          AND rowid NOT IN (
            SELECT rowid
              FROM user_recent_items
             WHERE tenant_id = ?
               AND user_id = ?
             ORDER BY accessed_at DESC, rowid DESC
             LIMIT ?
          )`
    ).bind(user.tenantId, user.id, user.tenantId, user.id, MAX_RECENT_STORED),
  ]);

  return c.json({ ok: true, itemType: body.itemType, itemId, action });
});
