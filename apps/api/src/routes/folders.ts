import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import { bytesToBase64Url, base64UrlToBytes } from '../services/crypto-utils';
import {
  createFolderWithClosures,
  fetchFolderBreadcrumbsRows,
  FolderServiceError,
  type FolderRow,
  getFolderBreadcrumbs,
  moveFolderSubtree,
  restoreFolderSubtree,
  softDeleteFolderSubtree,
  validateFolderName,
} from '../services/folder-closure-service';
import { buildSyncChangeStmt, parseExpectedVersionInput } from '../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../services/sync-notifier';
import type { ClassificationLabel } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { VALID_CLASSIFICATIONS } from '../utils/classification';

interface ChildrenCursor {
  phase: 'folders' | 'files';
  name?: string;
  id?: string;
}

interface ChildFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string;
  size_bytes: number;
  current_version_num: number;
  meta_version: number;
  classification: ClassificationLabel;
  ai_suggested_label: ClassificationLabel | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  updated_at: string;
}

const FOLDER_CHILD_COLS =
  'id, tenant_id, parent_id, name, depth, version, classification, is_pinned, created_by, deleted_at, created_at, updated_at';
const FILE_CHILD_COLS =
  'id, folder_id, name, extension, mime_type, size_bytes, current_version_num, meta_version, classification, ai_suggested_label, ai_confidence, ai_reason, updated_at';

function encodeCursor(cursor: ChildrenCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

function decodeCursor(raw: string | undefined): ChildrenCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw))) as ChildrenCursor;
    if (parsed.phase !== 'folders' && parsed.phase !== 'files') return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 100);
}

function handleFolderError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response },
  err: unknown
): Response {
  if (err instanceof FolderServiceError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.latest ? { latest: err.latest } : {}),
      },
      err.status
    );
  }
  throw err;
}

export const foldersRoutes = new Hono<OidcHonoEnv>();

foldersRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** GET /api/folders/roots — accessible top-level root folders for current user */
foldersRoutes.get('/roots', async (c) => {
  const user = getAuthenticatedUser(c);
  const limit = parseLimit(c.req.query('limit'));
  const rawCursor = c.req.query('cursor');
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) {
    return c.json({ error: 'Invalid pagination cursor' }, 400);
  }

  const cursorSql =
    cursor?.name !== undefined && cursor?.id !== undefined
      ? 'AND (f.name, f.id) > (?, ?)'
      : '';
  const cursorBindings =
    cursor?.name !== undefined && cursor?.id !== undefined
      ? [cursor.name, cursor.id]
      : [];

  const rows = await c.env.DB.prepare(
    `SELECT f.${FOLDER_CHILD_COLS.split(', ').join(', f.')},
            MAX(CASE p.role
              WHEN 'owner' THEN 5
              WHEN 'co_owner' THEN 4
              WHEN 'editor' THEN 3
              WHEN 'viewer' THEN 2
              WHEN 'previewer' THEN 1
              ELSE 0
            END) AS max_rank
       FROM folders f
       JOIN permissions p
         ON p.tenant_id = f.tenant_id
        AND p.target_type = 'folder'
        AND p.target_id = f.id
      WHERE f.tenant_id = ?
        AND f.parent_id IS NULL
        AND f.deleted_at IS NULL
        AND (
          (p.grantee_type = 'user' AND p.grantee_id = ?)
          OR (
            p.grantee_type = 'group'
            AND EXISTS (
              SELECT 1 FROM group_members gm
               WHERE gm.group_id = p.grantee_id AND gm.user_id = ?
            )
          )
        )
        ${cursorSql}
      GROUP BY f.id
      ORDER BY f.is_pinned DESC, f.name ASC, f.id ASC
      LIMIT ?`
  )
    .bind(user.tenantId, user.id, user.id, ...cursorBindings, limit + 1)
    .all<FolderRow & { max_rank: number }>();

  const hasMore = rows.results.length > limit;
  const pageItems = rows.results.slice(0, limit);
  const last = pageItems[pageItems.length - 1];

  return c.json({
    folders: pageItems.map(({ max_rank: _rank, ...folder }) => folder),
    nextCursor:
      hasMore && last
        ? encodeCursor({ phase: 'folders', name: last.name, id: last.id })
        : null,
  });
});

/** GET /api/folders/trash — top-level soft-deleted folders & files accessible to user */
foldersRoutes.get('/trash', async (c) => {
  const user = getAuthenticatedUser(c);
  const limit = parseLimit(c.req.query('limit'));

  const [foldersRes, filesRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT DISTINCT f.${FOLDER_CHILD_COLS.split(', ').join(', f.')}
         FROM folders f
         LEFT JOIN folders pf ON pf.id = f.parent_id
         JOIN folder_closures fc
           ON fc.tenant_id = f.tenant_id AND fc.descendant_id = f.id
         JOIN permissions p
           ON p.tenant_id = f.tenant_id AND p.target_type = 'folder' AND p.target_id = fc.ancestor_id
        WHERE f.tenant_id = ?
          AND f.deleted_at IS NOT NULL
          AND (f.parent_id IS NULL OR pf.deleted_at IS NULL)
          AND (
            (p.grantee_type = 'user' AND p.grantee_id = ?)
            OR (
              p.grantee_type = 'group'
              AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = p.grantee_id AND gm.user_id = ?)
            )
          )
        ORDER BY f.deleted_at DESC
        LIMIT ?`
    )
      .bind(user.tenantId, user.id, user.id, limit)
      .all<FolderRow>(),
    c.env.DB.prepare(
      `SELECT DISTINCT fl.${FILE_CHILD_COLS.split(', ').join(', fl.')}, fl.deleted_at
         FROM files fl
         LEFT JOIN folders pf ON pf.id = fl.folder_id
         JOIN permissions p
           ON p.tenant_id = fl.tenant_id
          AND (
            (p.target_type = 'file' AND p.target_id = fl.id)
            OR (
              p.target_type = 'folder'
              AND fl.folder_id IS NOT NULL
              AND p.target_id IN (
                SELECT fc.ancestor_id FROM folder_closures fc
                 WHERE fc.tenant_id = fl.tenant_id AND fc.descendant_id = fl.folder_id
              )
            )
          )
        WHERE fl.tenant_id = ?
          AND fl.upload_state = 'active'
          AND fl.deleted_at IS NOT NULL
          AND (fl.folder_id IS NULL OR pf.deleted_at IS NULL)
          AND (
            (p.grantee_type = 'user' AND p.grantee_id = ?)
            OR (
              p.grantee_type = 'group'
              AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = p.grantee_id AND gm.user_id = ?)
            )
          )
        ORDER BY fl.deleted_at DESC
        LIMIT ?`
    )
      .bind(user.tenantId, user.id, user.id, limit)
      .all<ChildFileRow & { deleted_at: string }>(),
  ]);

  return c.json({
    folders: foldersRes.results,
    files: filesRes.results,
  });
});

/** GET /api/folders/:id/children — Keyset-paginated folders & active files */
foldersRoutes.get('/:id/children', async (c) => {
  const user = getAuthenticatedUser(c);
  const folderId = c.req.param('id');
  const limit = parseLimit(c.req.query('limit'));
  const rawCursor = c.req.query('cursor');
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) {
    return c.json({ error: 'Invalid pagination cursor' }, 400);
  }

  const access = await resolveTargetAccess(c.env.DB, user, 'folder', folderId);
  if (!access || access.deletedAt !== null) {
    return c.json({ error: 'Folder not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'previewer')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const includeBreadcrumbs = c.req.query('include') === 'breadcrumbs' && !cursor;
  const [folder, breadcrumbs] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${FOLDER_CHILD_COLS} FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
    )
      .bind(user.tenantId, folderId)
      .first<FolderRow>(),
    includeBreadcrumbs
      ? fetchFolderBreadcrumbsRows(c.env.DB, user.tenantId, folderId)
      : Promise.resolve(undefined),
  ]);
  const breadcrumbsField = breadcrumbs !== undefined ? { breadcrumbs } : {};

  let folders: FolderRow[] = [];
  let files: ChildFileRow[] = [];
  let nextCursor: string | null = null;

  if (!cursor || cursor.phase === 'folders') {
    const hasKeyset = cursor?.name !== undefined && cursor?.id !== undefined;
    const folderRows = await c.env.DB.prepare(
      `SELECT ${FOLDER_CHILD_COLS}
         FROM folders
        WHERE tenant_id = ?
          AND parent_id = ?
          AND deleted_at IS NULL
          ${hasKeyset ? 'AND (name, id) > (?, ?)' : ''}
        ORDER BY name ASC, id ASC
        LIMIT ?`
    )
      .bind(
        user.tenantId,
        folderId,
        ...(hasKeyset ? [cursor!.name!, cursor!.id!] : []),
        limit + 1
      )
      .all<FolderRow>();

    if (folderRows.results.length > limit) {
      folders = folderRows.results.slice(0, limit);
      const last = folders[folders.length - 1];
      nextCursor = encodeCursor({ phase: 'folders', name: last.name, id: last.id });
      return c.json({
        folder,
        effectiveRole: access.effectiveRole,
        folders,
        files,
        nextCursor,
        ...breadcrumbsField,
      });
    }

    folders = folderRows.results;
    const remaining = limit - folders.length;

    if (remaining === 0) {
      const hasAnyFile = await c.env.DB.prepare(
        `SELECT 1 AS hit FROM files
          WHERE tenant_id = ? AND folder_id = ? AND deleted_at IS NULL AND upload_state = 'active'
          LIMIT 1`
      )
        .bind(user.tenantId, folderId)
        .first<{ hit: number }>();
      if (hasAnyFile) {
        nextCursor = encodeCursor({ phase: 'files' });
      }
      return c.json({
        folder,
        effectiveRole: access.effectiveRole,
        folders,
        files,
        nextCursor,
        ...breadcrumbsField,
      });
    }

    const fileRows = await c.env.DB.prepare(
      `SELECT ${FILE_CHILD_COLS}
         FROM files
        WHERE tenant_id = ?
          AND folder_id = ?
          AND deleted_at IS NULL
          AND upload_state = 'active'
        ORDER BY name ASC, id ASC
        LIMIT ?`
    )
      .bind(user.tenantId, folderId, remaining + 1)
      .all<ChildFileRow>();

    const hasMoreFiles = fileRows.results.length > remaining;
    files = fileRows.results.slice(0, remaining);
    if (hasMoreFiles && files.length > 0) {
      const lastFile = files[files.length - 1];
      nextCursor = encodeCursor({ phase: 'files', name: lastFile.name, id: lastFile.id });
    }
  } else {
    const hasKeyset = cursor.name !== undefined && cursor.id !== undefined;
    const fileRows = await c.env.DB.prepare(
      `SELECT ${FILE_CHILD_COLS}
         FROM files
        WHERE tenant_id = ?
          AND folder_id = ?
          AND deleted_at IS NULL
          AND upload_state = 'active'
          ${hasKeyset ? 'AND (name, id) > (?, ?)' : ''}
        ORDER BY name ASC, id ASC
        LIMIT ?`
    )
      .bind(
        user.tenantId,
        folderId,
        ...(hasKeyset ? [cursor.name!, cursor.id!] : []),
        limit + 1
      )
      .all<ChildFileRow>();

    const hasMoreFiles = fileRows.results.length > limit;
    files = fileRows.results.slice(0, limit);
    if (hasMoreFiles && files.length > 0) {
      const lastFile = files[files.length - 1];
      nextCursor = encodeCursor({ phase: 'files', name: lastFile.name, id: lastFile.id });
    }
  }

  return c.json({
    folder,
    effectiveRole: access.effectiveRole,
    folders,
    files,
    nextCursor,
    ...breadcrumbsField,
  });
});

/** GET /api/folders/:id/breadcrumbs — 1-query resolution using folder_closures */
foldersRoutes.get('/:id/breadcrumbs', async (c) => {
  const user = getAuthenticatedUser(c);
  try {
    const breadcrumbs = await getFolderBreadcrumbs(c.env.DB, user, c.req.param('id'));
    return c.json({ breadcrumbs });
  } catch (err) {
    return handleFolderError(c, err);
  }
});

/** POST /api/folders — create folder + ancestor closure rows atomically */
foldersRoutes.post('/', async (c) => {
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
foldersRoutes.patch('/:id', async (c) => {
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
  if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
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
foldersRoutes.post('/:id/move', async (c) => {
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
foldersRoutes.delete('/:id', async (c) => {
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

/** POST /api/folders/:id/restore — batch-timestamp subtree restore & FTS5 reindex */
foldersRoutes.post('/:id/restore', async (c) => {
  const user = getAuthenticatedUser(c);
  const queryPolicy = c.req.query('conflictPolicy');
  const body = (await c.req.json().catch(() => ({}))) as { conflictPolicy?: string };
  const rawPolicy = queryPolicy ?? body.conflictPolicy ?? 'fail';
  const conflictPolicy = rawPolicy === 'rename' ? 'rename' : 'fail';
  const targetFolderId = c.req.param('id');

  try {
    const result = await restoreFolderSubtree(
      c.env.DB,
      user,
      targetFolderId,
      conflictPolicy
    );
    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      eventKind: 'folder.restore',
      scopeFolderIds: [targetFolderId],
    });
    return c.json(result);
  } catch (err) {
    return handleFolderError(c, err);
  }
});
