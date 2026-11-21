import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { getAuthenticatedUser } from '../services/authorization';
import {
  normalizeTargetId,
  parseItemTargetType,
  verifyItemTargetAccess,
  type ItemTargetType,
} from '../services/item-target-access';
import type { OidcHonoEnv } from '../types/oidc';

export type TagItemType = ItemTargetType;

interface ItemTagRow {
  tag: string;
  created_by: string;
  created_at: string;
}

const MAX_TAG_LENGTH = 40;
const MAX_TAGS_PER_ITEM = 20;
const MAX_TENANT_TAGS_LIMIT = 100;

function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 1 || trimmed.length > MAX_TAG_LENGTH) return null;
  return trimmed;
}

function escapeSqlLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export const tagsRoutes = new Hono<OidcHonoEnv>();

tagsRoutes.use('/tags', sessionAuthMiddleware({ required: true }));
tagsRoutes.use(
  '/items/:itemType/:itemId/tags',
  sessionAuthMiddleware({ required: true })
);
tagsRoutes.use(
  '/items/:itemType/:itemId/tags/*',
  sessionAuthMiddleware({ required: true })
);

/** GET /api/tags — distinct tags in tenant (limit 100) */
tagsRoutes.get('/tags', async (c) => {
  const user = getAuthenticatedUser(c);
  const q = (c.req.query('q') ?? '').trim().toLowerCase();

  const sql = q
    ? `SELECT DISTINCT tag
         FROM item_tags
        WHERE tenant_id = ?
          AND tag LIKE ? ESCAPE '\\'
        ORDER BY tag ASC
        LIMIT ?`
    : `SELECT DISTINCT tag
         FROM item_tags
        WHERE tenant_id = ?
        ORDER BY tag ASC
        LIMIT ?`;

  const bindings = q
    ? [user.tenantId, `%${escapeSqlLike(q)}%`, MAX_TENANT_TAGS_LIMIT]
    : [user.tenantId, MAX_TENANT_TAGS_LIMIT];

  const rows = await c.env.DB.prepare(sql)
    .bind(...bindings)
    .all<{ tag: string }>();

  return c.json({
    tags: rows.results.map((r) => r.tag),
  });
});

/** GET /api/items/:itemType/:itemId/tags */
tagsRoutes.get('/items/:itemType/:itemId/tags', async (c) => {
  const user = getAuthenticatedUser(c);
  const itemType = parseItemTargetType(c.req.param('itemType'));
  if (!itemType) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeTargetId(c.req.param('itemId'));
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const authz = await verifyItemTargetAccess(
    c.env.DB,
    user,
    itemType,
    itemId,
    'read'
  );
  if (!authz.ok) {
    return c.json({ error: authz.error }, authz.status);
  }

  const rows = await c.env.DB.prepare(
    `SELECT tag, created_by, created_at
       FROM item_tags
      WHERE tenant_id = ?
        AND item_type = ?
        AND item_id = ?
      ORDER BY created_at ASC, tag ASC`
  )
    .bind(user.tenantId, itemType, itemId)
    .all<ItemTagRow>();

  return c.json({
    itemType,
    itemId,
    tags: rows.results.map((r) => ({
      tag: r.tag,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
  });
});

/** POST /api/items/:itemType/:itemId/tags */
tagsRoutes.post('/items/:itemType/:itemId/tags', async (c) => {
  const user = getAuthenticatedUser(c);
  const itemType = parseItemTargetType(c.req.param('itemType'));
  if (!itemType) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeTargetId(c.req.param('itemId'));
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const authz = await verifyItemTargetAccess(
    c.env.DB,
    user,
    itemType,
    itemId,
    'write'
  );
  if (!authz.ok) {
    return c.json({ error: authz.error }, authz.status);
  }

  const body = (await c.req.json().catch(() => null)) as {
    tag?: unknown;
  } | null;
  const tag = normalizeTag(body?.tag);
  if (!tag) {
    return c.json(
      { error: `tag must be a non-empty string up to ${MAX_TAG_LENGTH} characters` },
      400
    );
  }

  const existing = await c.env.DB.prepare(
    `SELECT tag, created_by, created_at
       FROM item_tags
      WHERE tenant_id = ?
        AND item_type = ?
        AND item_id = ?
        AND tag = ?`
  )
    .bind(user.tenantId, itemType, itemId, tag)
    .first<ItemTagRow>();

  if (existing) {
    return c.json(
      {
        ok: true,
        tag: {
          tag: existing.tag,
          createdBy: existing.created_by,
          createdAt: existing.created_at,
        },
      },
      200
    );
  }

  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt
       FROM item_tags
      WHERE tenant_id = ?
        AND item_type = ?
        AND item_id = ?`
  )
    .bind(user.tenantId, itemType, itemId)
    .first<{ cnt: number }>();

  if ((countRow?.cnt ?? 0) >= MAX_TAGS_PER_ITEM) {
    return c.json(
      { error: `Maximum of ${MAX_TAGS_PER_ITEM} tags per item exceeded` },
      400
    );
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO item_tags (tenant_id, item_type, item_id, tag, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(user.tenantId, itemType, itemId, tag, user.id, now)
    .run();

  return c.json(
    {
      ok: true,
      tag: {
        tag,
        createdBy: user.id,
        createdAt: now,
      },
    },
    201
  );
});

/** DELETE /api/items/:itemType/:itemId/tags/:tag */
tagsRoutes.delete('/items/:itemType/:itemId/tags/:tag', async (c) => {
  const user = getAuthenticatedUser(c);
  const itemType = parseItemTargetType(c.req.param('itemType'));
  if (!itemType) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeTargetId(c.req.param('itemId'));
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const rawTag = c.req.param('tag');
  let decodedTag = rawTag;
  try {
    decodedTag = decodeURIComponent(rawTag);
  } catch {
    return c.json({ error: 'Invalid tag encoding' }, 400);
  }
  const tag = normalizeTag(decodedTag);
  if (!tag) {
    return c.json({ error: 'Invalid tag' }, 400);
  }

  const authz = await verifyItemTargetAccess(
    c.env.DB,
    user,
    itemType,
    itemId,
    'write'
  );
  if (!authz.ok) {
    return c.json({ error: authz.error }, authz.status);
  }

  await c.env.DB.prepare(
    `DELETE FROM item_tags
      WHERE tenant_id = ?
        AND item_type = ?
        AND item_id = ?
        AND tag = ?`
  )
    .bind(user.tenantId, itemType, itemId, tag)
    .run();

  return c.json({ ok: true, tag });
});
