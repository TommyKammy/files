import { Hono } from 'hono';
import {
  GRANTEE_MATCH_SQL,
  getAuthenticatedUser,
  reachablePathSql,
  resolveTargetAccess,
  resolveUserAccessForFolders,
} from '../../services/authorization';
import {
  can,
  parseRoleList,
  synthesizeEffectiveAccess,
  type Capability,
} from '../../services/capabilities';
import {
  computeEffectivePermissionsCapabilities,
  resolveEffectiveInvitePoliciesForFolders,
  resolveEffectiveInvitePolicy,
} from '../../services/invite-policy';
import {
  type FolderRow,
  resolveFolderBreadcrumbs,
} from '../../services/folder-closure-service';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
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
  /** GET /api/folders/roots — accessible roots in `full` or `path` mode */
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
              GROUP_CONCAT(DISTINCT p.role) AS role_list
         FROM folders f
         LEFT JOIN permissions p
           ON p.tenant_id = f.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = f.id
          AND ${GRANTEE_MATCH_SQL}
        WHERE f.tenant_id = ?
          AND f.parent_id IS NULL
          AND f.deleted_at IS NULL
          AND (p.id IS NOT NULL OR ${reachablePathSql('f')})
          ${cursorSql}
        GROUP BY f.id
        ORDER BY f.is_pinned DESC, f.name ASC, f.id ASC
        LIMIT ?`
    )
      .bind(
        user.id,
        user.id,
        user.tenantId,
        user.id,
        user.id,
        user.id,
        user.id,
        user.id,
        user.id,
        ...cursorBindings,
        limit + 1
      )
      .all<FolderRow & { role_list: string | null }>();

    const hasMore = rows.results.length > limit;
    const pageItems = rows.results.slice(0, limit);
    const last = pageItems[pageItems.length - 1];
    const invitePolicies = await resolveEffectiveInvitePoliciesForFolders(
      c.env.DB,
      user.tenantId,
      pageItems.map((folder) => folder.id)
    );

    return c.json({
      // Non-linear composition is required here: a root folder can carry both
      // `viewer` and `uploader` grants which must surface as `viewer_uploader`.
      folders: pageItems.map(({ role_list, ...folder }) => {
        const directRoles = parseRoleList(role_list);
        if (directRoles.length === 0) {
          return {
            ...folder,
            accessMode: 'path' as const,
            effectiveRole: null,
            capabilities: ['folder.traverse'] as Capability[],
          };
        }
        const access = synthesizeEffectiveAccess(directRoles);
        const resolvedPolicy = invitePolicies.get(folder.id);
        return {
          ...folder,
          accessMode: 'full' as const,
          effectiveRole: access.effectiveRole,
          capabilities: resolvedPolicy
            ? computeEffectivePermissionsCapabilities(
                access.capabilities,
                access.effectiveRole,
                resolvedPolicy.effectivePolicy,
                user.role
              )
            : access.capabilities,
        };
      }),
      nextCursor:
        hasMore && last
          ? encodeCursor({ phase: 'folders', name: last.name, id: last.id })
          : null,
    });
  });

}

export function registerFolderChildrenRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * Attach per-child access metadata so the UI can badge intermediate folders
   * as `path-only` immediately, without an extra request per row.
   */
  async function attachChildFolderAccess(
    db: D1Database,
    user: { id: string; tenantId: string; role: 'sys_admin' | 'sec_admin' | 'member' },
    childRows: FolderRow[],
    parentAccess: { accessMode: 'full' | 'path' | null; effectiveRole: ResourceRole | null; capabilities: Capability[] }
  ) {
    if (childRows.length === 0) return [];
    const [resolved, invitePolicies] = await Promise.all([
      resolveUserAccessForFolders(
        db,
        user.tenantId,
        user.id,
        childRows.map((row) => row.id)
      ),
      resolveEffectiveInvitePoliciesForFolders(
        db,
        user.tenantId,
        childRows.map((row) => row.id)
      ),
    ]);
    return childRows.map((row) => {
      const childAccess = resolved.get(row.id);
      const effectiveRole = childAccess?.effectiveRole ?? parentAccess.effectiveRole;
      const baseCapabilities =
        childAccess?.capabilities ?? parentAccess.capabilities;
      const policy = invitePolicies.get(row.id);
      if (effectiveRole) {
        return {
          ...row,
          accessMode: 'full' as const,
          effectiveRole,
          capabilities: policy
            ? computeEffectivePermissionsCapabilities(
                baseCapabilities,
                effectiveRole,
                policy.effectivePolicy,
                user.role
              )
            : baseCapabilities,
        };
      }
      return {
        ...row,
        accessMode: 'path' as const,
        effectiveRole: null,
        capabilities: ['folder.traverse'] as Capability[],
      };
    });
  }

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
    // `folder.traverse` admits both `full` and `path` access. Every mutating or
    // listing capability remains absent from a path-only capability set.
    if (!can(access.capabilities, 'folder.traverse')) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const pathOnly = access.accessMode === 'path';
    const resolvedParentPolicy = await resolveEffectiveInvitePolicy(
      c.env.DB,
      user.tenantId,
      folderId
    );
    const responseCapabilities = computeEffectivePermissionsCapabilities(
      access.capabilities,
      access.effectiveRole,
      resolvedParentPolicy.effectivePolicy,
      user.role
    );

    const includeBreadcrumbs = c.req.query('include') === 'breadcrumbs' && !cursor;
    // Roles without `item.preview` (uploader) may navigate folders but must not
    // receive a file listing; `search` applies the same rule. Path-only
    // ancestors never list files at all.
    const canSeeFiles = !pathOnly && can(access.capabilities, 'item.preview');
    const [folder, breadcrumbResult] = await Promise.all([
      c.env.DB.prepare(
        `SELECT ${FOLDER_CHILD_COLS} FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
      )
        .bind(user.tenantId, folderId)
        .first<FolderRow>(),
      includeBreadcrumbs
        ? resolveFolderBreadcrumbs(c.env.DB, user, folderId)
        : Promise.resolve(undefined),
    ]);
    const breadcrumbsField =
      breadcrumbResult !== undefined
        ? { breadcrumbs: breadcrumbResult.breadcrumbs }
        : {};

    let folders: Array<
      FolderRow & {
        accessMode: 'full' | 'path';
        effectiveRole: ResourceRole | null;
        capabilities: Capability[];
      }
    > = [];
    const files: ChildFileRow[] = [];
    let nextCursor: string | null = null;

    if (pathOnly) {
      // Only direct children that lead to an authorized descendant are listed;
      // sibling folders and every file stay hidden.
      if (!cursor || cursor.phase === 'folders') {
        const hasKeyset = cursor?.name !== undefined && cursor?.id !== undefined;
        const folderRows = await c.env.DB.prepare(
          `SELECT ${FOLDER_CHILD_COLS}
             FROM folders c
            WHERE c.tenant_id = ?
              AND c.parent_id = ?
              AND c.deleted_at IS NULL
              AND ${reachablePathSql('c')}
              ${hasKeyset ? 'AND (c.name, c.id) > (?, ?)' : ''}
            ORDER BY c.name ASC, c.id ASC
            LIMIT ?`
        )
          .bind(
            user.tenantId,
            folderId,
            user.id,
            user.id,
            user.id,
            user.id,
            user.id,
            user.id,
            ...(hasKeyset ? [cursor!.name!, cursor!.id!] : []),
            limit + 1
          )
          .all<FolderRow>();

        const hasMoreFolders = folderRows.results.length > limit;
        folders = await attachChildFolderAccess(
          c.env.DB,
          user,
          folderRows.results.slice(0, limit),
          access
        );
        if (hasMoreFolders && folders.length > 0) {
          const last = folders[folders.length - 1];
          nextCursor = encodeCursor({
            phase: 'folders',
            name: last.name,
            id: last.id,
          });
        }
      }

      return c.json({
        folder,
        accessMode: access.accessMode,
        effectiveRole: access.effectiveRole,
        capabilities: responseCapabilities,
        folders,
        files: [],
        nextCursor,
        ...breadcrumbsField,
      });
    }

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
        folders = await attachChildFolderAccess(
          c.env.DB,
          user,
          folderRows.results.slice(0, limit),
          access
        );
        const last = folders[folders.length - 1];
        nextCursor = encodeCursor({ phase: 'folders', name: last.name, id: last.id });
        return c.json({
          folder,
          accessMode: access.accessMode,
          effectiveRole: access.effectiveRole,
          capabilities: responseCapabilities,
          folders,
          files,
          nextCursor,
          ...breadcrumbsField,
        });
      }

      folders = await attachChildFolderAccess(
        c.env.DB,
        user,
        folderRows.results,
        access
      );
      const remaining = limit - folders.length;

      if (!canSeeFiles) {
        return c.json({
          folder,
          accessMode: access.accessMode,
          effectiveRole: access.effectiveRole,
          capabilities: responseCapabilities,
          folders,
          files: [],
          nextCursor: null,
          ...breadcrumbsField,
        });
      }

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
          accessMode: access.accessMode,
          effectiveRole: access.effectiveRole,
          capabilities: responseCapabilities,
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
      files.push(...fileRows.results.slice(0, remaining));
      if (hasMoreFiles && files.length > 0) {
        const lastFile = files[files.length - 1];
        nextCursor = encodeCursor({ phase: 'files', name: lastFile.name, id: lastFile.id });
      }
    } else if (canSeeFiles) {
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
      files.push(...fileRows.results.slice(0, limit));
      if (hasMoreFiles && files.length > 0) {
        const lastFile = files[files.length - 1];
        nextCursor = encodeCursor({ phase: 'files', name: lastFile.name, id: lastFile.id });
      }
    }

    return c.json({
      folder,
      accessMode: access.accessMode,
      effectiveRole: access.effectiveRole,
      capabilities: responseCapabilities,
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
      const { breadcrumbs, access } = await resolveFolderBreadcrumbs(
        c.env.DB,
        user,
        c.req.param('id')
      );
      const resolvedPolicy = await resolveEffectiveInvitePolicy(
        c.env.DB,
        user.tenantId,
        c.req.param('id')
      );
      return c.json({
        breadcrumbs,
        accessMode: access.accessMode,
        effectiveRole: access.effectiveRole,
        capabilities: computeEffectivePermissionsCapabilities(
          access.capabilities,
          access.effectiveRole,
          resolvedPolicy.effectivePolicy,
          user.role
        ),
      });
    } catch (err) {
      return handleFolderError(c, err);
    }
  });

}
