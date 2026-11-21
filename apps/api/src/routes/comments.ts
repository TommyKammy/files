import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  canAccess,
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../services/authorization';
import { createUserNotification } from '../services/notifications';
import type { OidcHonoEnv } from '../types/oidc';

type ItemType = 'file' | 'folder';

interface CommentRow {
  id: string;
  tenant_id: string;
  item_type: ItemType;
  item_id: string;
  author_id: string;
  body: string;
  mentions_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  author_display_name: string | null;
  author_email: string | null;
}

interface TenantUserRow {
  id: string;
  email: string;
  display_name: string | null;
}

interface ActivityAuditRow {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string;
  status: string;
  metadata_json: string | null;
  created_at: string;
  actor_display_name: string | null;
}

const MAX_COMMENT_LENGTH = 2000;
const DEFAULT_COMMENTS_LIMIT = 50;
const MAX_COMMENTS_LIMIT = 100;
const ACTIVITY_LIMIT = 50;

const ACTION_LABELS: Record<string, string> = {
  'comment.create': 'コメントを投稿',
  'file.upload': 'ファイルをアップロード',
  'file.upload_complete': 'ファイルをアップロード',
  'file.version_upload': '新しい版をアップロード',
  'file.download': 'ファイルをダウンロード',
  'file.preview': 'ファイルをプレビュー',
  'file.rename': 'ファイル名を変更',
  'file.move': 'ファイルを移動',
  'file.copy': 'ファイルを複製',
  'file.delete': 'ファイルをゴミ箱へ移動',
  'file.restore': 'ファイルを復元',
  'file.classification_update': '機密区分を変更',
  'file.lock': 'ファイルをロック',
  'file.unlock': 'ロックを解除',
  'folder.create': 'フォルダを作成',
  'folder.rename': 'フォルダ名を変更',
  'folder.move': 'フォルダを移動',
  'folder.copy': 'フォルダを複製',
  'folder.delete': 'フォルダをゴミ箱へ移動',
  'folder.restore': 'フォルダを復元',
  'permission.grant': 'アクセス権を付与',
  'permission.update': 'アクセス権を更新',
  'permission.revoke': 'アクセス権を削除',
  'share_link.create': '共有リンクを作成',
  'share_link.revoke': '共有リンクを無効化',
  'task.create': 'タスクを作成',
  'task.update': 'タスクを更新',
};

const SENSITIVE_KEY_PATTERN =
  /ip|ua|user_?agent|token|secret|password|hash|cipher|key|auth|cookie|session/i;

function isValidItemType(value: string): value is ItemType {
  return value === 'file' || value === 'folder';
}

function normalizeItemId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

function parseCommentBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > MAX_COMMENT_LENGTH) return null;
  return trimmed;
}

function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_COMMENTS_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_COMMENTS_LIMIT;
  return Math.min(parsed, MAX_COMMENTS_LIMIT);
}

function parseOffset(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parseMentionsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

export function extractMentionTokens(body: string): string[] {
  const tokens = new Set<string>();
  const regex =
    /(?:^|[\s(「『【\[,;])@([a-zA-Z0-9._%+-]+(?:@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})?)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    const token = match[1]?.trim().toLowerCase();
    if (token) {
      tokens.add(token);
    }
  }
  return Array.from(tokens);
}

async function resolveMentionedUserIds(
  db: D1Database,
  tenantId: string,
  body: string
): Promise<string[]> {
  const tokens = extractMentionTokens(body);
  if (tokens.length === 0) return [];

  const usersResult = await db
    .prepare(
      `SELECT id, email, display_name
         FROM users
        WHERE tenant_id = ?
          AND status = 'active'`
    )
    .bind(tenantId)
    .all<TenantUserRow>();

  const resolved = new Set<string>();
  for (const token of tokens) {
    for (const user of usersResult.results) {
      const emailLower = user.email.toLowerCase();
      const localPart = emailLower.split('@')[0] ?? '';
      const displayLower = user.display_name?.trim().toLowerCase() ?? '';
      if (
        token === emailLower ||
        token === localPart ||
        (displayLower && token === displayLower)
      ) {
        resolved.add(user.id);
      }
    }
  }
  return Array.from(resolved);
}

function sanitizeActivityMetadata(
  rawJson: string | null,
  isAdmin: boolean
): Record<string, unknown> | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isAdmin && SENSITIVE_KEY_PATTERN.test(key)) {
        continue;
      }
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        (Array.isArray(value) &&
          value.every((v) => typeof v === 'string' || typeof v === 'number'))
      ) {
        safe[key] = value;
      }
    }
    return Object.keys(safe).length > 0 ? safe : null;
  } catch {
    return null;
  }
}

function formatComment(row: CommentRow) {
  return {
    id: row.id,
    itemType: row.item_type,
    itemId: row.item_id,
    authorId: row.author_id,
    authorDisplayName: row.author_display_name ?? row.author_email ?? '不明なユーザー',
    authorEmail: row.author_email,
    body: row.body,
    mentions: parseMentionsJson(row.mentions_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function authorizeItemTarget(
  db: D1Database,
  user: ReturnType<typeof getAuthenticatedUser>,
  itemType: ItemType,
  itemId: string
): Promise<
  | { ok: true; classification: string }
  | { ok: false; status: 403 | 404; error: string }
> {
  const access = await resolveTargetAccess(db, user, itemType, itemId);
  if (
    !access ||
    !access.exists ||
    access.deletedAt !== null ||
    (itemType === 'file' && access.uploadState !== 'active')
  ) {
    return { ok: false, status: 404, error: 'Item not found' };
  }
  if (access.accessMode !== 'full') {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  const requiredCap = itemType === 'file' ? 'item.preview' : 'folder.traverse';
  if (!canAccess(access, requiredCap)) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  return { ok: true, classification: access.classification };
}

export const itemCommentsRoutes = new Hono<OidcHonoEnv>();
itemCommentsRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** GET /api/items/:itemType/:itemId/comments */
itemCommentsRoutes.get('/:itemType/:itemId/comments', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawType = c.req.param('itemType');
  const rawId = c.req.param('itemId');

  if (!isValidItemType(rawType)) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeItemId(rawId);
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const authz = await authorizeItemTarget(c.env.DB, user, rawType, itemId);
  if (!authz.ok) {
    return c.json({ error: authz.error }, authz.status);
  }

  const limit = parseLimit(c.req.query('limit'));
  const offset = parseOffset(c.req.query('offset'));

  const [rows, countRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT c.id, c.tenant_id, c.item_type, c.item_id, c.author_id,
              c.body, c.mentions_json, c.created_at, c.updated_at, c.deleted_at,
              u.display_name AS author_display_name, u.email AS author_email
         FROM item_comments c
         LEFT JOIN users u ON u.id = c.author_id AND u.tenant_id = c.tenant_id
        WHERE c.tenant_id = ?
          AND c.item_type = ?
          AND c.item_id = ?
          AND c.deleted_at IS NULL
        ORDER BY c.created_at ASC, c.id ASC
        LIMIT ? OFFSET ?`
    )
      .bind(user.tenantId, rawType, itemId, limit, offset)
      .all<CommentRow>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total
         FROM item_comments
        WHERE tenant_id = ?
          AND item_type = ?
          AND item_id = ?
          AND deleted_at IS NULL`
    )
      .bind(user.tenantId, rawType, itemId)
      .first<{ total: number }>(),
  ]);

  return c.json({
    comments: rows.results.map(formatComment),
    total: Number(countRow?.total ?? 0),
    limit,
    offset,
  });
});

/** POST /api/items/:itemType/:itemId/comments */
itemCommentsRoutes.post('/:itemType/:itemId/comments', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawType = c.req.param('itemType');
  const rawId = c.req.param('itemId');

  if (!isValidItemType(rawType)) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeItemId(rawId);
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const authz = await authorizeItemTarget(c.env.DB, user, rawType, itemId);
  if (!authz.ok) {
    return c.json({ error: authz.error }, authz.status);
  }

  const payload = (await c.req.json().catch(() => null)) as {
    body?: unknown;
  } | null;
  const body = parseCommentBody(payload?.body);
  if (!body) {
    return c.json(
      { error: `body must be 1..${MAX_COMMENT_LENGTH} characters` },
      400
    );
  }

  const mentionedUserIds = await resolveMentionedUserIds(
    c.env.DB,
    user.tenantId,
    body
  );
  const commentId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const mentionsJson = JSON.stringify(mentionedUserIds);

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO item_comments (
         id, tenant_id, item_type, item_id, author_id, body, mentions_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      commentId,
      user.tenantId,
      rawType,
      itemId,
      user.id,
      body,
      mentionsJson,
      nowIso,
      nowIso
    ),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: c.req.header('CF-Connecting-IP') ?? null,
      action: 'comment.create',
      targetType: rawType,
      targetId: itemId,
      classificationSnapshot: authz.classification,
      metadata: {
        commentId,
        mentionedUserIds,
      },
      nowIso,
    }),
  ]);

  if (mentionedUserIds.length > 0) {
    const actorLabel = user.displayName ?? user.email;
    await Promise.all(
      mentionedUserIds.map((mentionedUserId) =>
        createUserNotification(c.env.DB, {
          tenantId: user.tenantId,
          userId: mentionedUserId,
          type: 'mention',
          title: `${actorLabel} さんがあなたをメンションしました`,
          body: body.slice(0, 140),
          targetType: rawType,
          targetId: itemId,
          actorId: user.id,
          nowIso,
        })
      )
    );
  }

  return c.json(
    {
      comment: {
        id: commentId,
        itemType: rawType,
        itemId,
        authorId: user.id,
        authorDisplayName: user.displayName ?? user.email,
        authorEmail: user.email,
        body,
        mentions: mentionedUserIds,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      mentionedUserIds,
    },
    201
  );
});

/** GET /api/items/:itemType/:itemId/activity */
itemCommentsRoutes.get('/:itemType/:itemId/activity', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawType = c.req.param('itemType');
  const rawId = c.req.param('itemId');

  if (!isValidItemType(rawType)) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeItemId(rawId);
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const authz = await authorizeItemTarget(c.env.DB, user, rawType, itemId);
  if (!authz.ok) {
    return c.json({ error: authz.error }, authz.status);
  }

  const isAdmin = user.role === 'sys_admin' || user.role === 'sec_admin';
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.actor_id, a.actor_email, a.action, a.target_type, a.target_id,
            a.status, a.metadata_json, a.created_at,
            u.display_name AS actor_display_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id AND u.tenant_id = a.tenant_id
      WHERE a.tenant_id = ?
        AND a.target_type = ?
        AND a.target_id = ?
      ORDER BY a.created_at DESC
      LIMIT ?`
  )
    .bind(user.tenantId, rawType, itemId, ACTIVITY_LIMIT)
    .all<ActivityAuditRow>();

  return c.json({
    activities: rows.results.map((row) => ({
      id: row.id,
      actorDisplayName:
        row.actor_display_name ?? row.actor_email ?? 'システム',
      action: row.action,
      actionLabel: ACTION_LABELS[row.action] ?? row.action,
      status: row.status,
      createdAt: row.created_at,
      metadata: sanitizeActivityMetadata(row.metadata_json, isAdmin),
    })),
  });
});

export const commentRoutes = new Hono<OidcHonoEnv>();
commentRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** PATCH /api/comments/:commentId */
commentRoutes.patch('/:commentId', async (c) => {
  const user = getAuthenticatedUser(c);
  const commentId = normalizeItemId(c.req.param('commentId'));
  if (!commentId) {
    return c.json({ error: 'Invalid commentId' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT c.id, c.tenant_id, c.item_type, c.item_id, c.author_id,
            c.body, c.mentions_json, c.created_at, c.updated_at, c.deleted_at,
            u.display_name AS author_display_name, u.email AS author_email
       FROM item_comments c
       LEFT JOIN users u ON u.id = c.author_id AND u.tenant_id = c.tenant_id
      WHERE c.id = ?
        AND c.tenant_id = ?
        AND c.deleted_at IS NULL`
  )
    .bind(commentId, user.tenantId)
    .first<CommentRow>();

  if (!existing) {
    return c.json({ error: 'Comment not found' }, 404);
  }

  const isAdmin = user.role === 'sys_admin' || user.role === 'sec_admin';
  if (existing.author_id !== user.id && !isAdmin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const payload = (await c.req.json().catch(() => null)) as {
    body?: unknown;
  } | null;
  const body = parseCommentBody(payload?.body);
  if (!body) {
    return c.json(
      { error: `body must be 1..${MAX_COMMENT_LENGTH} characters` },
      400
    );
  }

  const mentionedUserIds = await resolveMentionedUserIds(
    c.env.DB,
    user.tenantId,
    body
  );
  const nowIso = new Date().toISOString();
  const mentionsJson = JSON.stringify(mentionedUserIds);

  await c.env.DB.prepare(
    `UPDATE item_comments
        SET body = ?, mentions_json = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  )
    .bind(body, mentionsJson, nowIso, commentId, user.tenantId)
    .run();

  return c.json({
    comment: {
      ...formatComment(existing),
      body,
      mentions: mentionedUserIds,
      updatedAt: nowIso,
    },
    mentionedUserIds,
  });
});

/** DELETE /api/comments/:commentId */
commentRoutes.delete('/:commentId', async (c) => {
  const user = getAuthenticatedUser(c);
  const commentId = normalizeItemId(c.req.param('commentId'));
  if (!commentId) {
    return c.json({ error: 'Invalid commentId' }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, author_id
       FROM item_comments
      WHERE id = ?
        AND tenant_id = ?
        AND deleted_at IS NULL`
  )
    .bind(commentId, user.tenantId)
    .first<{ id: string; author_id: string }>();

  if (!existing) {
    return c.json({ error: 'Comment not found' }, 404);
  }

  const isAdmin = user.role === 'sys_admin' || user.role === 'sec_admin';
  if (existing.author_id !== user.id && !isAdmin) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    `UPDATE item_comments
        SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
  )
    .bind(commentId, user.tenantId)
    .run();

  return c.json({ ok: true, id: commentId });
});
