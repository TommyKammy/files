import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  canAccess,
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import { createUserNotification } from '../services/notifications';
import type { OidcHonoEnv } from '../types/oidc';

type ItemType = 'file' | 'folder';
export type TaskStatus = 'open' | 'approved' | 'rejected' | 'completed';

const VALID_TASK_STATUSES = new Set<TaskStatus>([
  'open',
  'approved',
  'rejected',
  'completed',
]);

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_RESOLUTION_NOTE_LENGTH = 1000;

interface TaskRow {
  id: string;
  tenant_id: string;
  item_type: ItemType;
  item_id: string;
  item_name?: string | null;
  title: string;
  message: string | null;
  assignee_id: string;
  assignee_display_name: string | null;
  assignee_email: string | null;
  created_by: string;
  creator_display_name: string | null;
  creator_email: string | null;
  status: TaskStatus;
  due_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolver_display_name: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

function isValidItemType(value: string): value is ItemType {
  return value === 'file' || value === 'folder';
}

function normalizeId(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

function parseOptionalText(raw: unknown, maxLen: number): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLen) return undefined;
  return trimmed;
}

function parseOptionalDueAt(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function formatTask(row: TaskRow) {
  return {
    id: row.id,
    itemType: row.item_type,
    itemId: row.item_id,
    ...(row.item_name !== undefined ? { itemName: row.item_name ?? null } : {}),
    title: row.title,
    message: row.message,
    assigneeId: row.assignee_id,
    assigneeDisplayName:
      row.assignee_display_name ?? row.assignee_email ?? '不明なユーザー',
    assigneeEmail: row.assignee_email,
    createdBy: row.created_by,
    creatorDisplayName:
      row.creator_display_name ?? row.creator_email ?? '不明なユーザー',
    creatorEmail: row.creator_email,
    status: row.status,
    dueAt: row.due_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolverDisplayName: row.resolver_display_name ?? null,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function fetchTaskById(
  db: D1Database,
  tenantId: string,
  taskId: string
): Promise<TaskRow | null> {
  return db
    .prepare(
      `SELECT t.*,
              a.display_name AS assignee_display_name, a.email AS assignee_email,
              c.display_name AS creator_display_name, c.email AS creator_email,
              r.display_name AS resolver_display_name
         FROM item_tasks t
         LEFT JOIN users a ON a.id = t.assignee_id AND a.tenant_id = t.tenant_id
         LEFT JOIN users c ON c.id = t.created_by AND c.tenant_id = t.tenant_id
         LEFT JOIN users r ON r.id = t.resolved_by AND r.tenant_id = t.tenant_id
        WHERE t.tenant_id = ? AND t.id = ?`
    )
    .bind(tenantId, taskId)
    .first<TaskRow>();
}

export const itemTasksRoutes = new Hono<OidcHonoEnv>();
itemTasksRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** GET /api/items/:itemType/:itemId/tasks */
itemTasksRoutes.get('/:itemType/:itemId/tasks', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawType = c.req.param('itemType');
  const rawId = c.req.param('itemId');

  if (!isValidItemType(rawType)) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeId(rawId);
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const access = await resolveTargetAccess(c.env.DB, user, rawType, itemId);
  if (
    !access ||
    !access.exists ||
    access.deletedAt !== null ||
    (rawType === 'file' && access.uploadState !== 'active')
  ) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const readCap = rawType === 'file' ? 'item.preview' : 'folder.traverse';
  if (access.accessMode !== 'full' || !canAccess(access, readCap)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const rows = await c.env.DB.prepare(
    `SELECT t.*,
            a.display_name AS assignee_display_name, a.email AS assignee_email,
            c.display_name AS creator_display_name, c.email AS creator_email,
            r.display_name AS resolver_display_name
       FROM item_tasks t
       LEFT JOIN users a ON a.id = t.assignee_id AND a.tenant_id = t.tenant_id
       LEFT JOIN users c ON c.id = t.created_by AND c.tenant_id = t.tenant_id
       LEFT JOIN users r ON r.id = t.resolved_by AND r.tenant_id = t.tenant_id
      WHERE t.tenant_id = ?
        AND t.item_type = ?
        AND t.item_id = ?
      ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
               t.created_at DESC,
               t.id DESC
      LIMIT 100`
  )
    .bind(user.tenantId, rawType, itemId)
    .all<TaskRow>();

  return c.json({
    tasks: rows.results.map(formatTask),
  });
});

/** POST /api/items/:itemType/:itemId/tasks */
itemTasksRoutes.post('/:itemType/:itemId/tasks', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawType = c.req.param('itemType');
  const rawId = c.req.param('itemId');

  if (!isValidItemType(rawType)) {
    return c.json({ error: 'Invalid itemType' }, 400);
  }
  const itemId = normalizeId(rawId);
  if (!itemId) {
    return c.json({ error: 'Invalid itemId' }, 400);
  }

  const access = await resolveTargetAccess(c.env.DB, user, rawType, itemId);
  if (
    !access ||
    !access.exists ||
    access.deletedAt !== null ||
    (rawType === 'file' && access.uploadState !== 'active')
  ) {
    return c.json({ error: 'Item not found' }, 404);
  }
  const editCap = rawType === 'file' ? 'item.edit_content' : 'folder.create';
  if (
    access.accessMode !== 'full' ||
    (!canAccess(access, editCap) && !hasAtLeastRole(access.effectiveRole, 'editor'))
  ) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const payload = (await c.req.json().catch(() => null)) as {
    title?: unknown;
    message?: unknown;
    assigneeId?: unknown;
    dueAt?: unknown;
  } | null;

  const title =
    typeof payload?.title === 'string' ? payload.title.trim() : '';
  if (!title || title.length > MAX_TITLE_LENGTH) {
    return c.json(
      { error: `title must be 1..${MAX_TITLE_LENGTH} characters` },
      400
    );
  }

  const message = parseOptionalText(payload?.message, MAX_MESSAGE_LENGTH);
  if (message === undefined) {
    return c.json(
      { error: `message must be <= ${MAX_MESSAGE_LENGTH} characters` },
      400
    );
  }

  const assigneeId =
    typeof payload?.assigneeId === 'string' ? payload.assigneeId.trim() : '';
  if (!assigneeId || assigneeId.length > 128) {
    return c.json({ error: 'assigneeId is required' }, 400);
  }

  const dueAt = parseOptionalDueAt(payload?.dueAt);
  if (dueAt === undefined) {
    return c.json({ error: 'dueAt must be a valid ISO date string' }, 400);
  }

  const assignee = await c.env.DB.prepare(
    `SELECT id, email, display_name, status
       FROM users
      WHERE tenant_id = ? AND id = ?`
  )
    .bind(user.tenantId, assigneeId)
    .first<{
      id: string;
      email: string;
      display_name: string | null;
      status: string;
    }>();

  if (!assignee) {
    return c.json({ error: 'Assignee not found in tenant' }, 404);
  }
  if (assignee.status !== 'active') {
    return c.json({ error: 'Assignee is not active' }, 400);
  }

  const taskId = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO item_tasks (
         id, tenant_id, item_type, item_id, title, message, assignee_id, created_by, status, due_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
    ).bind(
      taskId,
      user.tenantId,
      rawType,
      itemId,
      title,
      message,
      assignee.id,
      user.id,
      dueAt,
      nowIso,
      nowIso
    ),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: c.req.header('CF-Connecting-IP') ?? null,
      action: 'task.create',
      targetType: rawType,
      targetId: itemId,
      classificationSnapshot: access.classification,
      metadata: {
        taskId,
        title,
        assigneeId: assignee.id,
        dueAt,
      },
      nowIso,
    }),
  ]);

  await createUserNotification(
    c.env.DB,
    {
      tenantId: user.tenantId,
      userId: assignee.id,
      type: 'task_assigned',
      title: `${user.displayName ?? user.email} さんがタスクを割り当てました`,
      body: title,
      targetType: rawType,
      targetId: itemId,
      actorId: user.id,
      nowIso,
    },
    c.env
  );

  const created = await fetchTaskById(c.env.DB, user.tenantId, taskId);
  return c.json(
    {
      task: created
        ? formatTask(created)
        : {
            id: taskId,
            itemType: rawType,
            itemId,
            title,
            message,
            assigneeId: assignee.id,
            assigneeDisplayName: assignee.display_name ?? assignee.email,
            assigneeEmail: assignee.email,
            createdBy: user.id,
            creatorDisplayName: user.displayName ?? user.email,
            creatorEmail: user.email,
            status: 'open' as const,
            dueAt,
            resolvedAt: null,
            resolvedBy: null,
            resolverDisplayName: null,
            resolutionNote: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
    },
    201
  );
});

export const taskRoutes = new Hono<OidcHonoEnv>();
taskRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** GET /api/tasks/my?status=open|all */
taskRoutes.get('/my', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawStatus = (c.req.query('status') ?? 'open').trim().toLowerCase();
  if (rawStatus !== 'open' && rawStatus !== 'all') {
    return c.json({ error: 'status must be open or all' }, 400);
  }

  const statusFilter = rawStatus === 'open' ? "AND t.status = 'open'" : '';
  const rows = await c.env.DB.prepare(
    `SELECT t.*,
            CASE
              WHEN t.item_type = 'file' THEN f.name
              ELSE fld.name
            END AS item_name,
            a.display_name AS assignee_display_name, a.email AS assignee_email,
            c.display_name AS creator_display_name, c.email AS creator_email,
            r.display_name AS resolver_display_name
       FROM item_tasks t
       LEFT JOIN files f ON t.item_type = 'file' AND f.id = t.item_id AND f.tenant_id = t.tenant_id
       LEFT JOIN folders fld ON t.item_type = 'folder' AND fld.id = t.item_id AND fld.tenant_id = t.tenant_id
       LEFT JOIN users a ON a.id = t.assignee_id AND a.tenant_id = t.tenant_id
       LEFT JOIN users c ON c.id = t.created_by AND c.tenant_id = t.tenant_id
       LEFT JOIN users r ON r.id = t.resolved_by AND r.tenant_id = t.tenant_id
      WHERE t.tenant_id = ?
        AND t.assignee_id = ?
        ${statusFilter}
      ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
               COALESCE(t.due_at, '9999-12-31') ASC,
               t.created_at DESC
      LIMIT 100`
  )
    .bind(user.tenantId, user.id)
    .all<TaskRow>();

  const accessibleTasks: ReturnType<typeof formatTask>[] = [];
  for (const row of rows.results) {
    const access = await resolveTargetAccess(
      c.env.DB,
      user,
      row.item_type,
      row.item_id
    );
    if (
      !access ||
      !access.exists ||
      access.deletedAt !== null ||
      (row.item_type === 'file' && access.uploadState !== 'active') ||
      access.accessMode !== 'full'
    ) {
      continue;
    }
    const readCap = row.item_type === 'file' ? 'item.preview' : 'folder.traverse';
    if (!canAccess(access, readCap)) {
      continue;
    }
    accessibleTasks.push(formatTask(row));
  }

  return c.json({ tasks: accessibleTasks });
});

/** PATCH /api/tasks/:taskId */
taskRoutes.patch('/:taskId', async (c) => {
  const user = getAuthenticatedUser(c);
  const taskId = normalizeId(c.req.param('taskId'));
  if (!taskId) {
    return c.json({ error: 'Invalid taskId' }, 400);
  }

  const existing = await fetchTaskById(c.env.DB, user.tenantId, taskId);
  if (!existing) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const isPrivilegedAdmin =
    user.role === 'sys_admin' || user.role === 'sec_admin';
  if (
    existing.assignee_id !== user.id &&
    existing.created_by !== user.id &&
    !isPrivilegedAdmin
  ) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const payload = (await c.req.json().catch(() => null)) as {
    status?: unknown;
    resolutionNote?: unknown;
  } | null;

  const nextStatus =
    typeof payload?.status === 'string'
      ? (payload.status.trim() as TaskStatus)
      : null;
  if (!nextStatus || !VALID_TASK_STATUSES.has(nextStatus)) {
    return c.json(
      { error: 'status must be one of open, approved, rejected, completed' },
      400
    );
  }

  const resolutionNote = parseOptionalText(
    payload?.resolutionNote,
    MAX_RESOLUTION_NOTE_LENGTH
  );
  if (resolutionNote === undefined) {
    return c.json(
      {
        error: `resolutionNote must be <= ${MAX_RESOLUTION_NOTE_LENGTH} characters`,
      },
      400
    );
  }

  const nowIso = new Date().toISOString();
  const isResolved = nextStatus !== 'open';
  const resolvedAt = isResolved ? nowIso : null;
  const resolvedBy = isResolved ? user.id : null;
  const nextResolutionNote = isResolved ? resolutionNote : null;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE item_tasks
          SET status = ?,
              resolved_at = ?,
              resolved_by = ?,
              resolution_note = ?,
              updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    ).bind(
      nextStatus,
      resolvedAt,
      resolvedBy,
      nextResolutionNote,
      nowIso,
      user.tenantId,
      taskId
    ),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: c.req.header('CF-Connecting-IP') ?? null,
      action: 'task.update',
      targetType: existing.item_type,
      targetId: existing.item_id,
      metadata: {
        taskId,
        previousStatus: existing.status,
        status: nextStatus,
        resolutionNote: nextResolutionNote,
      },
      nowIso,
    }),
  ]);

  if (isResolved) {
    const statusLabel =
      nextStatus === 'approved'
        ? '承認'
        : nextStatus === 'rejected'
          ? '差し戻し'
          : '完了';
    await createUserNotification(
      c.env.DB,
      {
        tenantId: user.tenantId,
        userId: existing.created_by,
        type: 'task_resolved',
        title: `${user.displayName ?? user.email} さんがタスクを「${statusLabel}」にしました`,
        body: existing.title,
        targetType: existing.item_type,
        targetId: existing.item_id,
        actorId: user.id,
        nowIso,
      },
      c.env
    );
  }

  const updated = await fetchTaskById(c.env.DB, user.tenantId, taskId);
  return c.json({
    task: updated ? formatTask(updated) : null,
  });
});
