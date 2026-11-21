import { TrashRequestError } from '../trash-items';
import {
  buildTrashCursorSql,
  buildTrashOrderBy,
  decodeTrashCursor,
  deriveTrashDeadlines,
  encodeTrashCursor,
  escapeLikePattern,
  resolveTrashRetentionDays,
} from '../trash-query';
import {
  ADMIN_TRASH_UNION_SQL,
  emptyPermissionSummary,
  loadPermissionSummaries,
  summaryKey,
  toPerson,
  type AdminTrashDbRow,
} from './shared';
import type {
  AdminTrashFilters,
  AdminTrashItem,
  AdminTrashListResult,
  AdminTrashPerson,
} from './types';

/** Tenant-wide top-level Trash list with strict keyset pagination. */
export async function listAdminTrash(
  db: D1Database,
  tenantId: string,
  filters: AdminTrashFilters,
  nowMs = Date.now()
): Promise<AdminTrashListResult> {
  const retentionDays = await resolveTrashRetentionDays(db, tenantId);

  const whereSql: string[] = [];
  const whereBinds: unknown[] = [];

  if (filters.type !== 'all') {
    whereSql.push('AND t.item_type = ?');
    whereBinds.push(filters.type);
  }
  if (filters.ownerId) {
    whereSql.push('AND t.owner_id = ?');
    whereBinds.push(filters.ownerId);
  }
  if (filters.deletedById) {
    if (filters.deletedById === 'unknown') {
      whereSql.push('AND t.deleted_by IS NULL');
    } else {
      whereSql.push('AND t.deleted_by = ?');
      whereBinds.push(filters.deletedById);
    }
  }
  if (filters.deletedFrom) {
    whereSql.push('AND t.deleted_at >= ?');
    whereBinds.push(filters.deletedFrom);
  }
  if (filters.deletedTo) {
    whereSql.push('AND t.deleted_at <= ?');
    whereBinds.push(filters.deletedTo);
  }
  if (
    filters.daysRemainingMax !== null &&
    filters.daysRemainingMax !== undefined
  ) {
    // ceil((deleted_at + retention - now) / day) <= max
    //   <=> deleted_at <= now + (max - retention) * day
    const cutoffMs = nowMs + (filters.daysRemainingMax - retentionDays) * 86_400_000;
    whereSql.push('AND t.deleted_at <= ?');
    whereBinds.push(new Date(cutoffMs).toISOString());
  }
  const trimmedQuery = (filters.query ?? '').trim();
  if (trimmedQuery) {
    whereSql.push("AND t.name LIKE ? ESCAPE '\\'");
    whereBinds.push(`%${escapeLikePattern(trimmedQuery)}%`);
  }
  if (filters.scopeRootFolderId) {
    whereSql.push(
      `AND (
         (t.item_type = 'folder' AND EXISTS (
           SELECT 1 FROM folder_closures fc
            WHERE fc.tenant_id = ?
              AND fc.ancestor_id = ?
              AND fc.descendant_id = t.id
         ))
         OR
         (t.item_type = 'file' AND EXISTS (
           SELECT 1 FROM files fl
             JOIN folder_closures fc
               ON fc.tenant_id = fl.tenant_id
              AND fc.descendant_id = fl.folder_id
            WHERE fl.tenant_id = ?
              AND fl.id = t.id
              AND fc.ancestor_id = ?
         ))
       )`
    );
    whereBinds.push(
      tenantId,
      filters.scopeRootFolderId,
      tenantId,
      filters.scopeRootFolderId
    );
  }

  const cursor = filters.cursor
    ? decodeTrashCursor(filters.cursor, filters.sort)
    : null;
  if (filters.cursor && !cursor) {
    throw new TrashRequestError(
      400,
      'INVALID_CURSOR',
      'Invalid pagination cursor'
    );
  }
  if (cursor) {
    const cursorSql = buildTrashCursorSql(filters.sort, cursor);
    whereSql.push(cursorSql.sql);
    whereBinds.push(...cursorSql.binds);
  }

  const pageSql = `
    SELECT t.*,
           pf.name AS parent_name,
           ou.display_name AS owner_name,
           ou.email AS owner_email,
           du.display_name AS deleted_by_name,
           du.email AS deleted_by_email
      FROM (${ADMIN_TRASH_UNION_SQL}) t
      LEFT JOIN folders pf
        ON pf.tenant_id = ? AND pf.id = t.parent_ref_id
      LEFT JOIN users ou
        ON ou.tenant_id = ? AND ou.id = t.owner_id
      LEFT JOIN users du
        ON du.tenant_id = ? AND du.id = t.deleted_by
     WHERE 1 = 1
       ${whereSql.join('\n       ')}
     ORDER BY ${buildTrashOrderBy(filters.sort)}
     LIMIT ?`;

  const [pageRows, ownerRows, deleterRows, unknownDeleterRows] = await Promise.all([
    db
      .prepare(pageSql)
      .bind(
        tenantId,
        tenantId,
        tenantId,
        tenantId,
        tenantId,
        ...whereBinds,
        filters.limit + 1
      )
      .all<AdminTrashDbRow>(),
    db
      .prepare(
        `SELECT DISTINCT t.owner_id AS id, u.display_name AS name, u.email AS email
           FROM (${ADMIN_TRASH_UNION_SQL}) t
           LEFT JOIN users u
             ON u.tenant_id = ? AND u.id = t.owner_id
          WHERE t.owner_id IS NOT NULL
          ORDER BY name ASC, id ASC`
      )
      .bind(tenantId, tenantId, tenantId)
      .all<{ id: string | null; name: string | null; email: string | null }>(),
    db
      .prepare(
        `SELECT DISTINCT t.deleted_by AS id, u.display_name AS name, u.email AS email
           FROM (${ADMIN_TRASH_UNION_SQL}) t
           LEFT JOIN users u
             ON u.tenant_id = ? AND u.id = t.deleted_by
          WHERE t.deleted_by IS NOT NULL
          ORDER BY name ASC, id ASC`
      )
      .bind(tenantId, tenantId, tenantId)
      .all<{ id: string | null; name: string | null; email: string | null }>(),
    db
      .prepare(
        `SELECT 1 AS hit
           FROM (${ADMIN_TRASH_UNION_SQL}) t
          WHERE t.deleted_by IS NULL
          LIMIT 1`
      )
      .bind(tenantId, tenantId)
      .all<{ hit: number }>(),
  ]);

  const hasMore = pageRows.results.length > filters.limit;
  const page = hasMore
    ? pageRows.results.slice(0, filters.limit)
    : pageRows.results;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeTrashCursor({
          v: 1,
          sort: filters.sort,
          deletedAt: last.deleted_at,
          name: last.name,
          itemType: last.item_type,
          id: last.id,
        })
      : null;

  const permissionSummaries = await loadPermissionSummaries(
    db,
    tenantId,
    page.map((row) => ({ type: row.item_type, id: row.id }))
  );

  const items: AdminTrashItem[] = page.map((row) => {
    const deadlines = deriveTrashDeadlines(
      row.deleted_at,
      retentionDays,
      nowMs
    );
    return {
      type: row.item_type,
      id: row.id,
      name: row.name,
      classification: row.classification,
      sizeBytes: row.size_bytes,
      currentVersionNum:
        row.current_version_num ?? row.version ?? 1,
      parentFolder: row.parent_ref_id
        ? {
            id: row.parent_ref_id,
            name: row.parent_name ?? '不明',
          }
        : null,
      owner: toPerson({
        id: row.owner_id,
        name: row.owner_name,
        email: row.owner_email,
      }),
      deletedBy: toPerson({
        id: row.deleted_by,
        name: row.deleted_by_name,
        email: row.deleted_by_email,
      }),
      deletedAt: row.deleted_at,
      purgeAt: deadlines.purgeAt,
      daysRemaining: deadlines.daysRemaining,
      permissionSummary:
        permissionSummaries.get(summaryKey(row.item_type, row.id)) ??
        emptyPermissionSummary(),
    };
  });

  return {
    items,
    owners: ownerRows.results
      .map((row) => toPerson(row))
      .filter((row): row is AdminTrashPerson => row !== null),
    deleters: deleterRows.results
      .map((row) => toPerson(row))
      .filter((row): row is AdminTrashPerson => row !== null),
    hasUnknownDeleter: unknownDeleterRows.results.length > 0,
    nextCursor,
    hasMore,
    trashRetentionDays: retentionDays,
    limit: filters.limit,
    sort: filters.sort,
  };
}
