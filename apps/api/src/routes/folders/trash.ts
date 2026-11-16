import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  parseRoleList,
  synthesizeEffectiveAccess,
} from '../../services/capabilities';
import type { ClassificationLabel } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  buildTrashCursorSql,
  buildTrashOrderBy,
  clampTrashRetentionDays,
  decodeTrashCursor,
  deriveTrashDeadlines,
  encodeTrashCursor,
  escapeLikePattern,
  parseIsoInstant,
  parseTrashLimit,
  TRASH_SORTS,
  type TrashItemType,
  type TrashSort,
} from '../../services/trash-query';

const UNKNOWN_DELETER_VALUE = 'unknown';

interface TrashDbRow {
  item_type: TrashItemType;
  id: string;
  name: string;
  parent_id: string | null;
  folder_id: string | null;
  classification: ClassificationLabel;
  version: number | null;
  is_pinned: number | null;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  current_version_num: number | null;
  meta_version: number | null;
  ai_suggested_label: ClassificationLabel | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  created_by: string;
  deleted_at: string;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_by_name: string | null;
  role_list: string | null;
}

/**
 * RBAC predicate shared by folder and file Trash candidates.
 *
 * The same SQL fragment is used with two positional bindings (user id twice):
 * direct user grants and group grants resolved through `group_members`.
 */
const TRASH_GRANTEE_MATCH_SQL = `(
  (p.grantee_type = 'user' AND p.grantee_id = ?)
  OR (
    p.grantee_type = 'group'
    AND EXISTS (
      SELECT 1 FROM group_members gm
       WHERE gm.group_id = p.grantee_id AND gm.user_id = ?
    )
  )
)`;

/**
 * Accessible top-level soft-deleted folders.
 *
 * A folder whose immediate parent was deleted by the *same batch* is excluded:
 * moving a folder to Trash soft-deletes the whole subtree with one timestamp,
 * and only the subtree root should be shown at the top level. A folder deleted
 * earlier (different `deleted_at`) is an independent Trash item and stays
 * visible so it can be restored, optionally together with its now-deleted
 * parent chain.
 */
const TRASH_FOLDER_UNION_SQL = `
  SELECT 'folder' AS item_type,
         f.id AS id,
         f.name AS name,
         f.parent_id AS parent_id,
         NULL AS folder_id,
         f.classification AS classification,
         f.version AS version,
         f.is_pinned AS is_pinned,
         NULL AS extension,
         NULL AS mime_type,
         NULL AS size_bytes,
         NULL AS current_version_num,
         NULL AS meta_version,
         NULL AS ai_suggested_label,
         NULL AS ai_confidence,
         NULL AS ai_reason,
         f.created_by AS created_by,
         f.deleted_at AS deleted_at,
         f.deleted_by AS deleted_by,
         f.created_at AS created_at,
         f.updated_at AS updated_at,
         u.display_name AS deleted_by_name,
         (
           SELECT GROUP_CONCAT(DISTINCT p.role)
             FROM folder_closures fc
             JOIN permissions p
               ON p.tenant_id = f.tenant_id
              AND p.target_type = 'folder'
              AND p.target_id = fc.ancestor_id
            WHERE fc.tenant_id = f.tenant_id
              AND fc.descendant_id = f.id
              AND ${TRASH_GRANTEE_MATCH_SQL}
         ) AS role_list
    FROM folders f
    LEFT JOIN users u
      ON u.id = f.deleted_by AND u.tenant_id = f.tenant_id
    LEFT JOIN folders pf ON pf.id = f.parent_id
   WHERE f.tenant_id = ?
     AND f.deleted_at IS NOT NULL
     AND (
       f.parent_id IS NULL
       OR pf.deleted_at IS NULL
       OR pf.deleted_at != f.deleted_at
     )`;

/**
 * Accessible top-level soft-deleted active files.
 *
 * `upload_state = 'active'` keeps pending/failed upload artifacts out of Trash.
 * Files deleted in the same batch as their parent folder belong to that
 * subtree and are hidden; files deleted independently at an earlier timestamp
 * remain visible Trash items.
 */
const TRASH_FILE_UNION_SQL = `
  SELECT 'file' AS item_type,
         fl.id AS id,
         fl.name AS name,
         NULL AS parent_id,
         fl.folder_id AS folder_id,
         fl.classification AS classification,
         NULL AS version,
         NULL AS is_pinned,
         fl.extension AS extension,
         fl.mime_type AS mime_type,
         fl.size_bytes AS size_bytes,
         fl.current_version_num AS current_version_num,
         fl.meta_version AS meta_version,
         fl.ai_suggested_label AS ai_suggested_label,
         fl.ai_confidence AS ai_confidence,
         fl.ai_reason AS ai_reason,
         fl.created_by AS created_by,
         fl.deleted_at AS deleted_at,
         fl.deleted_by AS deleted_by,
         fl.created_at AS created_at,
         fl.updated_at AS updated_at,
         u.display_name AS deleted_by_name,
         (
           SELECT GROUP_CONCAT(DISTINCT p.role)
             FROM permissions p
            WHERE p.tenant_id = fl.tenant_id
              AND (
                (p.target_type = 'file' AND p.target_id = fl.id)
                OR (
                  p.target_type = 'folder'
                  AND fl.folder_id IS NOT NULL
                  AND p.target_id IN (
                    SELECT fc.ancestor_id
                      FROM folder_closures fc
                     WHERE fc.tenant_id = fl.tenant_id
                       AND fc.descendant_id = fl.folder_id
                  )
                )
              )
              AND ${TRASH_GRANTEE_MATCH_SQL}
         ) AS role_list
    FROM files fl
    LEFT JOIN users u
      ON u.id = fl.deleted_by AND u.tenant_id = fl.tenant_id
    LEFT JOIN folders pf ON pf.id = fl.folder_id
   WHERE fl.tenant_id = ?
     AND fl.upload_state = 'active'
     AND fl.deleted_at IS NOT NULL
     AND (
       fl.folder_id IS NULL
       OR pf.deleted_at IS NULL
       OR pf.deleted_at != fl.deleted_at
     )`;

const TRASH_UNION_SQL = `${TRASH_FOLDER_UNION_SQL} UNION ALL ${TRASH_FILE_UNION_SQL}`;

/** Bindings for TRASH_UNION_SQL in prepared-statement order. */
function trashUnionBindings(user: { tenantId: string; id: string }): string[] {
  // Each union branch binds the effective-role grantee predicate first
  // (SELECT clause) and then the tenant id (WHERE clause).
  return [
    user.id,
    user.id,
    user.tenantId,
    user.id,
    user.id,
    user.tenantId,
  ];
}

function toTrashItem(
  row: TrashDbRow,
  retentionDays: number,
  nowMs: number
): Record<string, unknown> & { type: TrashItemType } {
  const { purgeAt, daysRemaining } = deriveTrashDeadlines(
    row.deleted_at,
    retentionDays,
    nowMs
  );
  const { item_type: itemType, role_list, ...rest } = row;
  const access = synthesizeEffectiveAccess(parseRoleList(role_list));

  return {
    ...rest,
    type: itemType,
    effectiveRole: access.effectiveRole,
    effective_role: access.effectiveRole,
    capabilities: access.capabilities,
    // snake_case stays for existing consumers, camelCase is the documented
    // Trash UI contract.
    deleted_at: row.deleted_at,
    deleted_by: row.deleted_by,
    deleted_by_name: row.deleted_by_name,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    deletedByName: row.deleted_by_name,
    purgeAt,
    daysRemaining,
  };
}

export function registerFolderTrashRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/folders/trash
   *
   * Mixed folder/file Trash listing with strict keyset pagination.
   *
   * Query parameters:
   * - limit=1..200 (default 50, out-of-range values are clamped)
   * - cursor=<base64url keyset cursor from a previous response>
   * - query=<LIKE name substring, %, _ and \ are escaped>
   * - type=all|file|folder (default all)
   * - deletedBy=<user id>|unknown (unknown selects legacy NULL rows)
   * - deletedFrom/deletedTo=<ISO-8601 instant, inclusive>
   * - sort=deletedAt_desc|deletedAt_asc|name_asc|name_desc
   *
   * Response:
   * - `items` is the authoritative mixed folder/file order; `folders` and
   *   `files` are compatibility projections of the same page.
   * - Each item preserves every snake_case DB column (`deleted_at`,
   *   `deleted_by`, `deleted_by_name`, ...) and adds the documented camelCase
   *   aliases `deletedAt`, `deletedBy`, `deletedByName`, plus `purgeAt` and
   *   `daysRemaining` derived from the current `trash_retention_days`.
   * - `deleters` only contains users whose Trash rows are visible to the
   *   caller; legacy NULL rows are signalled by `hasUnknownDeleter`.
   */
  routes.get('/trash', async (c) => {
    const user = getAuthenticatedUser(c);
    const limit = parseTrashLimit(c.req.query('limit'));

    const rawSort = c.req.query('sort') ?? 'deletedAt_desc';
    if (!TRASH_SORTS.has(rawSort as TrashSort)) {
      return c.json(
        {
          error:
            'sort must be one of deletedAt_desc, deletedAt_asc, name_asc, name_desc',
        },
        400
      );
    }
    const sort = rawSort as TrashSort;

    const rawType = c.req.query('type');
    if (
      rawType !== undefined &&
      rawType !== 'all' &&
      rawType !== 'file' &&
      rawType !== 'folder'
    ) {
      return c.json({ error: 'type must be one of all, file, folder' }, 400);
    }
    const typeFilter = rawType ?? 'all';

    const rawDeletedFrom = c.req.query('deletedFrom');
    const rawDeletedTo = c.req.query('deletedTo');
    let deletedFrom: string | null = null;
    let deletedTo: string | null = null;
    if (rawDeletedFrom !== undefined && rawDeletedFrom !== '') {
      const parsed = parseIsoInstant(rawDeletedFrom);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      deletedFrom = parsed.value;
    }
    if (rawDeletedTo !== undefined && rawDeletedTo !== '') {
      const parsed = parseIsoInstant(rawDeletedTo);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      deletedTo = parsed.value;
    }
    if (deletedFrom && deletedTo && deletedFrom > deletedTo) {
      return c.json(
        { error: 'deletedFrom must be earlier than or equal to deletedTo' },
        400
      );
    }

    const rawDeletedBy = c.req.query('deletedBy')?.trim();
    let deletedByFilter: { kind: 'unknown' } | { kind: 'user'; id: string } | null =
      null;
    if (rawDeletedBy) {
      deletedByFilter =
        rawDeletedBy === UNKNOWN_DELETER_VALUE
          ? { kind: 'unknown' }
          : { kind: 'user', id: rawDeletedBy };
    }

    const rawCursor = c.req.query('cursor');
    const cursor = rawCursor ? decodeTrashCursor(rawCursor, sort) : null;
    if (rawCursor && !cursor) {
      return c.json({ error: 'Invalid pagination cursor' }, 400);
    }

    const whereSql: string[] = [];
    const whereBinds: unknown[] = [];

    if (typeFilter !== 'all') {
      whereSql.push('AND t.item_type = ?');
      whereBinds.push(typeFilter);
    }
    if (deletedByFilter) {
      if (deletedByFilter.kind === 'unknown') {
        whereSql.push('AND t.deleted_by IS NULL');
      } else {
        whereSql.push('AND t.deleted_by = ?');
        whereBinds.push(deletedByFilter.id);
      }
    }
    if (deletedFrom) {
      whereSql.push('AND t.deleted_at >= ?');
      whereBinds.push(deletedFrom);
    }
    if (deletedTo) {
      whereSql.push('AND t.deleted_at <= ?');
      whereBinds.push(deletedTo);
    }
    const trimmedQuery = (c.req.query('query') ?? '').trim();
    if (trimmedQuery) {
      whereSql.push("AND t.name LIKE ? ESCAPE '\\'");
      whereBinds.push(`%${escapeLikePattern(trimmedQuery)}%`);
    }
    if (cursor) {
      const cursorSql = buildTrashCursorSql(sort, cursor);
      whereSql.push(cursorSql.sql);
      whereBinds.push(...cursorSql.binds);
    }

    const rbacBindings = trashUnionBindings(user);
    const pageSql = `
      SELECT *
        FROM (${TRASH_UNION_SQL}) t
       WHERE 1 = 1
         AND t.role_list IS NOT NULL AND t.role_list != ''
         ${whereSql.join('\n         ')}
       ORDER BY ${buildTrashOrderBy(sort)}
       LIMIT ?`;

    const [policy, pageRows, deleterRows] = await Promise.all([
      c.env.DB.prepare(
        'SELECT trash_retention_days FROM tenant_policies WHERE tenant_id = ?'
      )
        .bind(user.tenantId)
        .first<{ trash_retention_days: number }>(),
      c.env.DB.prepare(pageSql)
        .bind(...rbacBindings, ...whereBinds, limit + 1)
        .all<TrashDbRow>(),
      c.env.DB.prepare(
        `SELECT DISTINCT t.deleted_by AS id, t.deleted_by_name AS name
           FROM (${TRASH_UNION_SQL}) t
          WHERE t.role_list IS NOT NULL AND t.role_list != ''
          ORDER BY t.deleted_by_name ASC, t.deleted_by ASC`
      )
        .bind(...rbacBindings)
        .all<{ id: string | null; name: string | null }>(),
    ]);

    const retentionDays = clampTrashRetentionDays(
      policy?.trash_retention_days
    );
    const nowMs = Date.now();
    const hasMore = pageRows.results.length > limit;
    const pageRowsPage = pageRows.results.slice(0, limit);
    const lastRow = pageRowsPage[pageRowsPage.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeTrashCursor({
            v: 1,
            sort,
            deletedAt: lastRow.deleted_at,
            name: lastRow.name,
            itemType: lastRow.item_type,
            id: lastRow.id,
          })
        : null;

    const items = pageRowsPage.map((row) =>
      toTrashItem(row, retentionDays, nowMs)
    );

    return c.json({
      type: 'trash',
      limit,
      sort,
      folders: items.filter((item) => item.type === 'folder'),
      files: items.filter((item) => item.type === 'file'),
      items,
      nextCursor,
      hasMore,
      trashRetentionDays: retentionDays,
      deleters: deleterRows.results
        .filter(
          (row): row is { id: string; name: string | null } => row.id !== null
        )
        .map((row) => ({ id: row.id, name: row.name ?? '不明' })),
      hasUnknownDeleter: deleterRows.results.some((row) => row.id === null),
    });
  });
}
