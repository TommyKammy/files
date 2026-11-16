import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import { bytesToBase64Url, base64UrlToBytes } from '../../services/crypto-utils';
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
} from '../../services/folder-closure-service';
import { buildSyncChangeStmt, parseExpectedVersionInput } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { ClassificationLabel } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import { VALID_CLASSIFICATIONS } from '../../utils/classification';
import {
  ChildFileRow,
  FILE_CHILD_COLS,
  FOLDER_CHILD_COLS,
  decodeCursor,
  encodeCursor,
  handleFolderError,
  parseLimit,
} from './shared';
export function registerFolderRootsRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/folders/roots — accessible top-level root folders for current user */
  routes.get('/roots', async (c) => {
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

}

export function registerFolderChildrenRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/folders/:id/children — Keyset-paginated folders & active files */
  routes.get('/:id/children', async (c) => {
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

}

export function registerFolderBreadcrumbRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/folders/:id/breadcrumbs — 1-query resolution using folder_closures */
  routes.get('/:id/breadcrumbs', async (c) => {
    const user = getAuthenticatedUser(c);
    try {
      const breadcrumbs = await getFolderBreadcrumbs(c.env.DB, user, c.req.param('id'));
      return c.json({ breadcrumbs });
    } catch (err) {
      return handleFolderError(c, err);
    }
  });

}

