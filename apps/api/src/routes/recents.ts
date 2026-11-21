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

type RecentAction = 'view' | 'edit' | 'download' | 'upload';

const VALID_ACTIONS = new Set<RecentAction>(['view', 'edit', 'download', 'upload']);
const MAX_RECENT_STORED = 200;
const DEFAULT_RECENT_LIMIT = 50;

type RecentFolderRow = HydratableFolderRow & {
  last_action: RecentAction;
  accessed_at: string;
};

type RecentFileRow = HydratableFileRow & {
  last_action: RecentAction;
  accessed_at: string;
};

export type RecentItemEntry = HydratedWorkspaceItem & {
  lastAction: RecentAction;
  accessedAt: string;
};

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

  const items = await hydrateWorkspaceItems<
    RecentFolderRow,
    RecentFileRow,
    RecentItemEntry
  >({
    db: c.env.DB,
    user,
    folderRows: folderRows.results,
    fileRows: fileRows.results,
    projectFolder: (base, row) => ({
      ...base,
      lastAction: row.last_action,
      accessedAt: row.accessed_at,
    }),
    projectFile: (base, row) => ({
      ...base,
      lastAction: row.last_action,
      accessedAt: row.accessed_at,
    }),
  });

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

  if (!body || !isValidWorkspaceItemType(body.itemType)) {
    return c.json({ error: 'Invalid itemType (must be file or folder)' }, 400);
  }
  const itemId = normalizeWorkspaceItemId(body.itemId);
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
