import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { getAuthenticatedUser } from '../services/authorization';
import {
  getUserNotificationPreferences,
  updateUserNotificationPreferences,
  type NotificationPreferences,
  type UserNotificationType,
} from '../services/notifications';
import type { OidcHonoEnv } from '../types/oidc';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

interface NotificationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  type: UserNotificationType;
  title: string;
  body: string | null;
  target_type: string | null;
  target_id: string | null;
  actor_id: string | null;
  actor_display_name: string | null;
  actor_email: string | null;
  read_at: string | null;
  created_at: string;
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function formatNotification(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    targetType: row.target_type,
    targetId: row.target_id,
    actorId: row.actor_id,
    actorDisplayName:
      row.actor_display_name ?? row.actor_email ?? (row.actor_id ? 'ユーザー' : 'システム'),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export const notificationRoutes = new Hono<OidcHonoEnv>();
notificationRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** GET /api/notifications?limit=30&unreadOnly=true|false */
notificationRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const limit = parseLimit(c.req.query('limit'));
  const unreadOnly = c.req.query('unreadOnly') === 'true';

  const unreadFilter = unreadOnly ? 'AND n.read_at IS NULL' : '';
  const rows = await c.env.DB.prepare(
    `SELECT n.*,
            u.display_name AS actor_display_name,
            u.email AS actor_email
       FROM user_notifications n
       LEFT JOIN users u ON u.id = n.actor_id AND u.tenant_id = n.tenant_id
      WHERE n.tenant_id = ?
        AND n.user_id = ?
        ${unreadFilter}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ?`
  )
    .bind(user.tenantId, user.id, limit)
    .all<NotificationRow>();

  return c.json({
    notifications: rows.results.map(formatNotification),
    limit,
    unreadOnly,
  });
});

/** GET /api/notifications/unread-count */
notificationRoutes.get('/unread-count', async (c) => {
  const user = getAuthenticatedUser(c);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM user_notifications
      WHERE tenant_id = ?
        AND user_id = ?
        AND read_at IS NULL`
  )
    .bind(user.tenantId, user.id)
    .first<{ count: number }>();

  return c.json({ count: Number(row?.count ?? 0) });
});

/** POST /api/notifications/read-all */
notificationRoutes.post('/read-all', async (c) => {
  const user = getAuthenticatedUser(c);
  const nowIso = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE user_notifications
        SET read_at = ?
      WHERE tenant_id = ?
        AND user_id = ?
        AND read_at IS NULL`
  )
    .bind(nowIso, user.tenantId, user.id)
    .run();

  return c.json({
    ok: true,
    updatedCount: result.meta?.changes ?? 0,
  });
});

/** GET /api/notifications/preferences */
notificationRoutes.get('/preferences', async (c) => {
  const user = getAuthenticatedUser(c);
  const preferences = await getUserNotificationPreferences(
    c.env.DB,
    user.tenantId,
    user.id
  );
  return c.json({ preferences });
});

/** PATCH /api/notifications/preferences */
notificationRoutes.patch('/preferences', async (c) => {
  const user = getAuthenticatedUser(c);

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }

  const body = rawBody as Record<string, unknown>;
  const patch: Partial<NotificationPreferences> = {};
  const allowedKeys: Array<keyof NotificationPreferences> = [
    'emailOnMention',
    'emailOnTaskAssigned',
    'emailOnTaskResolved',
    'emailOnShareGranted',
  ];

  for (const key of allowedKeys) {
    if (key in body && body[key] !== undefined) {
      if (typeof body[key] !== 'boolean') {
        return c.json({ error: `Field '${key}' must be a boolean` }, 400);
      }
      patch[key] = body[key];
    }
  }

  const preferences = await updateUserNotificationPreferences(
    c.env.DB,
    user.tenantId,
    user.id,
    patch
  );

  return c.json({ preferences });
});

/** POST /api/notifications/:id/read */
notificationRoutes.post('/:id/read', async (c) => {
  const user = getAuthenticatedUser(c);
  const notificationId = c.req.param('id').trim();
  if (!notificationId || notificationId.length > 128) {
    return c.json({ error: 'Invalid notification id' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, read_at
       FROM user_notifications
      WHERE tenant_id = ? AND id = ? AND user_id = ?`
  )
    .bind(user.tenantId, notificationId, user.id)
    .first<{ id: string; read_at: string | null }>();

  if (!existing) {
    return c.json({ error: 'Notification not found' }, 404);
  }

  const readAt = existing.read_at ?? new Date().toISOString();
  if (!existing.read_at) {
    await c.env.DB.prepare(
      `UPDATE user_notifications
          SET read_at = ?
        WHERE tenant_id = ? AND id = ? AND user_id = ?`
    )
      .bind(readAt, user.tenantId, notificationId, user.id)
      .run();
  }

  return c.json({ ok: true, id: notificationId, readAt });
});
