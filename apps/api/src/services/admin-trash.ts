import type {
  AuthUser,
  ClassificationLabel,
  ResourceRole,
} from '../types/api';
import type { OidcEnv } from '../types/oidc';
import { chunkArray } from '../utils/batch';
import { buildAuditLogStmt } from './audit';
import {
  FileUploadError,
} from './file-upload-common';
import { FileLockedError } from './file-lock';
import { FolderServiceError } from './folder-closure-service';
import {
  restoreTrashFile,
  restoreTrashFolder,
  type RestoreTrashFileResult,
  type RestoreTrashFolderResult,
  type TrashBulkItemResult,
} from './trash-restore';
import {
  isPrivilegedAdmin,
  type AdminRestoreDelegation,
} from './trash-restore-context';
import {
  TrashRequestError,
  type TrashItemRefInput,
  type TrashItemType,
} from './trash-items';
import {
  purgeTrashFileItem,
  purgeTrashFolderItem,
  type TrashPurgeAdminContext,
  type TrashPurgeItemResult,
} from './trash-purge';
import {
  buildTrashCursorSql,
  buildTrashOrderBy,
  decodeTrashCursor,
  deriveTrashDeadlines,
  encodeTrashCursor,
  escapeLikePattern,
  resolveTrashRetentionDays,
  type TrashSort,
} from './trash-query';

const PERMISSION_QUERY_CHUNK = 30;

const FOLDER_OWNER_ID_SQL = `COALESCE(
  (
    SELECT p.grantee_id
      FROM folder_closures fc
      JOIN permissions p
        ON p.tenant_id = fc.tenant_id
       AND p.target_type = 'folder'
       AND p.target_id = fc.ancestor_id
       AND p.grantee_type = 'user'
       AND p.role = 'owner'
     WHERE fc.tenant_id = f.tenant_id
       AND fc.descendant_id = f.id
       AND fc.depth = 0
     ORDER BY p.created_at ASC
     LIMIT 1
  ),
  f.created_by,
  (
    SELECT p.grantee_id
      FROM folder_closures fc
      JOIN permissions p
        ON p.tenant_id = fc.tenant_id
       AND p.target_type = 'folder'
       AND p.target_id = fc.ancestor_id
       AND p.grantee_type = 'user'
       AND p.role = 'owner'
     WHERE fc.tenant_id = f.tenant_id
       AND fc.descendant_id = f.id
     ORDER BY fc.depth ASC, p.created_at ASC
     LIMIT 1
  )
)`;

const FILE_OWNER_ID_SQL = `COALESCE(
  (
    SELECT p.grantee_id
      FROM permissions p
     WHERE p.tenant_id = fl.tenant_id
       AND p.target_type = 'file'
       AND p.target_id = fl.id
       AND p.grantee_type = 'user'
       AND p.role = 'owner'
     ORDER BY p.created_at ASC
     LIMIT 1
  ),
  fl.created_by,
  (
    SELECT p.grantee_id
      FROM folder_closures fc
      JOIN permissions p
        ON p.tenant_id = fc.tenant_id
       AND p.target_type = 'folder'
       AND p.target_id = fc.ancestor_id
       AND p.grantee_type = 'user'
       AND p.role = 'owner'
     WHERE fc.tenant_id = fl.tenant_id
       AND fl.folder_id IS NOT NULL
       AND fc.descendant_id = fl.folder_id
     ORDER BY fc.depth ASC, p.created_at ASC
     LIMIT 1
  )
)`;

/**
 * Tenant-wide top-level Trash projection.
 *
 * Unlike `GET /api/folders/trash` this deliberately has no RBAC predicate: the
 * admin endpoint is authorized at the route/role level and must show items the
 * administrator has no individual ACL on. Files created inside a folder that
 * was deleted in the same batch are excluded, matching the owner Trash view.
 */
const ADMIN_TRASH_UNION_SQL = `
  SELECT 'folder' AS item_type,
         f.id AS id,
         f.name AS name,
         f.parent_id AS parent_ref_id,
         f.classification AS classification,
         NULL AS size_bytes,
         NULL AS current_version_num,
         f.version AS version,
         f.created_by AS created_by,
         f.deleted_at AS deleted_at,
         f.deleted_by AS deleted_by,
         f.created_at AS created_at,
         f.updated_at AS updated_at,
         (${FOLDER_OWNER_ID_SQL}) AS owner_id,
         pf.deleted_at AS parent_deleted_at
    FROM folders f
    LEFT JOIN folders pf ON pf.id = f.parent_id
   WHERE f.tenant_id = ?
     AND f.deleted_at IS NOT NULL
     AND (
       f.parent_id IS NULL
       OR pf.deleted_at IS NULL
       OR pf.deleted_at != f.deleted_at
     )
  UNION ALL
  SELECT 'file' AS item_type,
         fl.id AS id,
         fl.name AS name,
         fl.folder_id AS parent_ref_id,
         fl.classification AS classification,
         fl.size_bytes AS size_bytes,
         fl.current_version_num AS current_version_num,
         NULL AS version,
         fl.created_by AS created_by,
         fl.deleted_at AS deleted_at,
         fl.deleted_by AS deleted_by,
         fl.created_at AS created_at,
         fl.updated_at AS updated_at,
         (${FILE_OWNER_ID_SQL}) AS owner_id,
         pf.deleted_at AS parent_deleted_at
    FROM files fl
    LEFT JOIN folders pf ON pf.id = fl.folder_id
   WHERE fl.tenant_id = ?
     AND fl.upload_state = 'active'
     AND fl.deleted_at IS NOT NULL
     AND (
       fl.folder_id IS NULL
       OR pf.deleted_at IS NULL
       OR pf.deleted_at != fl.deleted_at
     )`;

export interface AdminTrashFilters {
  query?: string;
  type: 'all' | 'file' | 'folder';
  ownerId?: string | null;
  deletedById?: string | null;
  deletedFrom?: string | null;
  deletedTo?: string | null;
  daysRemainingMax?: number | null;
  sort: TrashSort;
  limit: number;
  cursor?: string | null;
}

export interface AdminTrashPerson {
  id: string;
  name: string;
  email: string | null;
}

export interface AdminTrashPermissionSummary {
  /** Effective ACL rows (direct + inherited from ancestor folders). */
  total: number;
  direct: number;
  inherited: number;
  userCount: number;
  groupCount: number;
  roles: Record<ResourceRole, number>;
  /** Active (not revoked) shared links targeting the item itself. */
  sharedLinkCount: number;
}

export interface AdminTrashItem {
  type: TrashItemType;
  id: string;
  name: string;
  classification: ClassificationLabel;
  sizeBytes: number | null;
  currentVersionNum: number;
  parentFolder: { id: string; name: string } | null;
  owner: AdminTrashPerson | null;
  deletedBy: AdminTrashPerson | null;
  deletedAt: string;
  purgeAt: string;
  daysRemaining: number;
  permissionSummary: AdminTrashPermissionSummary;
}

export interface AdminTrashListResult {
  items: AdminTrashItem[];
  owners: AdminTrashPerson[];
  deleters: AdminTrashPerson[];
  hasUnknownDeleter: boolean;
  nextCursor: string | null;
  hasMore: boolean;
  trashRetentionDays: number;
  limit: number;
  sort: TrashSort;
}

interface AdminTrashDbRow {
  item_type: TrashItemType;
  id: string;
  name: string;
  parent_ref_id: string | null;
  classification: ClassificationLabel;
  size_bytes: number | null;
  current_version_num: number | null;
  version: number | null;
  created_by: string;
  deleted_at: string;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
  owner_id: string | null;
  parent_name: string | null;
  owner_name: string | null;
  owner_email: string | null;
  deleted_by_name: string | null;
  deleted_by_email: string | null;
}

interface GrantAggregateRow {
  item_id: string;
  role: ResourceRole;
  grantee_type: 'user' | 'group';
  count: number;
}

interface SharedLinkAggregateRow {
  target_type: 'folder' | 'file';
  item_id: string;
  count: number;
}

interface AdminTrashRefRow {
  id: string;
  name: string;
  deleted_at: string | null;
  created_by: string;
  owner_id: string | null;
  version: number | null;
  current_version_num: number | null;
  upload_state: 'pending' | 'active' | 'failed' | null;
}

export interface AdminTrashItemRef {
  type: TrashItemType;
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string | null;
  deletedAt: string | null;
  sourceVersion: number | null;
}

export interface AdminTrashRestoreOptions {
  targetFolderId?: string | null;
  conflictPolicy: 'fail' | 'rename';
  restoreParentChain: boolean;
}

export interface AdminTrashRestoreResult {
  results: TrashBulkItemResult[];
  succeededCount: number;
  failedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

export interface AdminTrashEmptyResult {
  results: TrashPurgeItemResult[];
  deletedCount: number;
  failedCount: number;
  skippedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

export interface AdminTrashPurgeResult {
  results: TrashPurgeItemResult[];
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

function emptyPermissionSummary(): AdminTrashPermissionSummary {
  return {
    total: 0,
    direct: 0,
    inherited: 0,
    userCount: 0,
    groupCount: 0,
    roles: {
      owner: 0,
      co_owner: 0,
      editor: 0,
      viewer_uploader: 0,
      previewer_uploader: 0,
      viewer: 0,
      previewer: 0,
      uploader: 0,
    },
    sharedLinkCount: 0,
  };
}

function addGrant(
  summary: AdminTrashPermissionSummary,
  row: GrantAggregateRow,
  scope: 'direct' | 'inherited'
): void {
  const count = Number(row.count) || 0;
  summary.total += count;
  summary[scope] += count;
  summary.roles[row.role] = (summary.roles[row.role] ?? 0) + count;
  if (row.grantee_type === 'user') summary.userCount += count;
  else summary.groupCount += count;
}

function summaryKey(type: TrashItemType, id: string): string {
  return `${type}:${id}`;
}

async function loadGrantRows(
  db: D1Database,
  sql: string,
  binds: unknown[]
): Promise<GrantAggregateRow[]> {
  const rows = await db
    .prepare(sql)
    .bind(...binds)
    .all<GrantAggregateRow>();
  return rows.results;
}

async function loadPermissionSummaries(
  db: D1Database,
  tenantId: string,
  pageItems: ReadonlyArray<{ type: TrashItemType; id: string }>
): Promise<Map<string, AdminTrashPermissionSummary>> {
  const summaries = new Map<string, AdminTrashPermissionSummary>();
  for (const item of pageItems) {
    summaries.set(summaryKey(item.type, item.id), emptyPermissionSummary());
  }

  const folderIds = pageItems
    .filter((item) => item.type === 'folder')
    .map((item) => item.id);
  const fileIds = pageItems
    .filter((item) => item.type === 'file')
    .map((item) => item.id);

  for (const chunk of chunkArray(folderIds, PERMISSION_QUERY_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const direct = await loadGrantRows(
      db,
      `SELECT target_id AS item_id, role, grantee_type, COUNT(*) AS count
         FROM permissions
        WHERE tenant_id = ?
          AND target_type = 'folder'
          AND target_id IN (${placeholders})
        GROUP BY target_id, role, grantee_type`,
      [tenantId, ...chunk]
    );
    const inherited = await loadGrantRows(
      db,
      `SELECT fc.descendant_id AS item_id, p.role, p.grantee_type, COUNT(*) AS count
         FROM folder_closures fc
         JOIN permissions p
           ON p.tenant_id = fc.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = fc.ancestor_id
        WHERE fc.tenant_id = ?
          AND fc.depth > 0
          AND fc.descendant_id IN (${placeholders})
        GROUP BY fc.descendant_id, p.role, p.grantee_type`,
      [tenantId, ...chunk]
    );
    for (const row of direct) {
      const summary = summaries.get(summaryKey('folder', row.item_id));
      if (summary) addGrant(summary, row, 'direct');
    }
    for (const row of inherited) {
      const summary = summaries.get(summaryKey('folder', row.item_id));
      if (summary) addGrant(summary, row, 'inherited');
    }
  }

  for (const chunk of chunkArray(fileIds, PERMISSION_QUERY_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const direct = await loadGrantRows(
      db,
      `SELECT target_id AS item_id, role, grantee_type, COUNT(*) AS count
         FROM permissions
        WHERE tenant_id = ?
          AND target_type = 'file'
          AND target_id IN (${placeholders})
        GROUP BY target_id, role, grantee_type`,
      [tenantId, ...chunk]
    );
    const inherited = await loadGrantRows(
      db,
      `SELECT fl.id AS item_id, p.role, p.grantee_type, COUNT(*) AS count
         FROM files fl
         JOIN folder_closures fc
           ON fc.tenant_id = fl.tenant_id
          AND fc.descendant_id = fl.folder_id
         JOIN permissions p
           ON p.tenant_id = fl.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = fc.ancestor_id
        WHERE fl.tenant_id = ?
          AND fl.id IN (${placeholders})
        GROUP BY fl.id, p.role, p.grantee_type`,
      [tenantId, ...chunk]
    );
    for (const row of direct) {
      const summary = summaries.get(summaryKey('file', row.item_id));
      if (summary) addGrant(summary, row, 'direct');
    }
    for (const row of inherited) {
      const summary = summaries.get(summaryKey('file', row.item_id));
      if (summary) addGrant(summary, row, 'inherited');
    }
  }

  const allIds = [...new Set([...folderIds, ...fileIds])];
  for (const chunk of chunkArray(allIds, PERMISSION_QUERY_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT target_type, target_id AS item_id, COUNT(*) AS count
           FROM shared_links
          WHERE tenant_id = ?
            AND revoked_at IS NULL
            AND target_id IN (${placeholders})
          GROUP BY target_type, target_id`
      )
      .bind(tenantId, ...chunk)
      .all<SharedLinkAggregateRow>();
    for (const row of rows.results) {
      const summary = summaries.get(summaryKey(row.target_type, row.item_id));
      if (summary) {
        summary.sharedLinkCount += Number(row.count) || 0;
      }
    }
  }

  return summaries;
}

function toPerson(row: {
  id: string | null;
  name: string | null;
  email: string | null;
}): AdminTrashPerson | null {
  if (!row.id) return null;
  return {
    id: row.id,
    name: row.name ?? '不明',
    email: row.email,
  };
}

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

async function loadOwnerProfiles(
  db: D1Database,
  tenantId: string,
  ownerIds: readonly string[]
): Promise<Map<string, { name: string; email: string | null }>> {
  const profiles = new Map<string, { name: string; email: string | null }>();
  const uniqueIds = [...new Set(ownerIds.filter(Boolean))];
  for (const chunk of chunkArray(uniqueIds, PERMISSION_QUERY_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, display_name, email
           FROM users
          WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<{ id: string; display_name: string; email: string | null }>();
    for (const row of rows.results) {
      profiles.set(row.id, { name: row.display_name, email: row.email });
    }
  }
  return profiles;
}

/**
 * Load exactly the requested tenant-scoped Trash rows and their owners. Used
 * before any write so a cross-tenant or unknown id can reject the whole request.
 */
export async function loadAdminTrashItemRefs(
  db: D1Database,
  tenantId: string,
  items: readonly TrashItemRefInput[]
): Promise<Map<string, AdminTrashItemRef>> {
  const folderIds = items
    .filter((item) => item.type === 'folder')
    .map((item) => item.id);
  const fileIds = items
    .filter((item) => item.type === 'file')
    .map((item) => item.id);
  const rows: Array<{ type: TrashItemType; row: AdminTrashRefRow }> = [];

  for (const chunk of chunkArray(folderIds, PERMISSION_QUERY_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT f.id, f.name, f.deleted_at, f.created_by, f.version,
                NULL AS current_version_num, NULL AS upload_state,
                (${FOLDER_OWNER_ID_SQL}) AS owner_id
           FROM folders f
          WHERE f.tenant_id = ? AND f.id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<AdminTrashRefRow>();
    for (const row of res.results) rows.push({ type: 'folder', row });
  }

  for (const chunk of chunkArray(fileIds, PERMISSION_QUERY_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT fl.id, fl.name, fl.deleted_at, fl.created_by,
                fl.current_version_num, fl.upload_state,
                NULL AS version,
                (${FILE_OWNER_ID_SQL}) AS owner_id
           FROM files fl
          WHERE fl.tenant_id = ? AND fl.id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<AdminTrashRefRow>();
    for (const row of res.results) rows.push({ type: 'file', row });
  }

  const profiles = await loadOwnerProfiles(
    db,
    tenantId,
    rows
      .map(({ row }) => row.owner_id ?? row.created_by)
      .filter((id): id is string => Boolean(id))
  );

  const refs = new Map<string, AdminTrashItemRef>();
  for (const { type, row } of rows) {
    const ownerId = row.owner_id ?? row.created_by;
    const profile = profiles.get(ownerId);
    refs.set(summaryKey(type, row.id), {
      type,
      id: row.id,
      name: row.name,
      ownerId,
      ownerName: profile?.name ?? '不明',
      ownerEmail: profile?.email ?? null,
      deletedAt: row.deleted_at,
      sourceVersion:
        type === 'file' ? row.current_version_num : row.version,
    });
  }
  return refs;
}

function toDelegation(ref: AdminTrashItemRef): AdminRestoreDelegation {
  return {
    onBehalfOfUserId: ref.ownerId,
    ownerId: ref.ownerId,
    ownerName: ref.ownerName,
    ownerEmail: ref.ownerEmail,
  };
}

function toRestoreFailure(
  item: TrashItemRefInput,
  err: unknown
): TrashBulkItemResult {
  if (
    err instanceof TrashRequestError ||
    err instanceof FolderServiceError ||
    err instanceof FileUploadError
  ) {
    return {
      type: item.type,
      id: item.id,
      ok: false,
      status: 'failed',
      code: err.code,
      error: err.message,
    };
  }
  console.error('[admin-trash] unexpected restore failure:', err);
  return {
    type: item.type,
    id: item.id,
    ok: false,
    status: 'failed',
    code: 'INTERNAL_ERROR',
    error: 'Failed to restore item',
  };
}

function toPurgeFailure(
  item: TrashItemRefInput,
  err: unknown
): TrashPurgeItemResult {
  if (err instanceof FileLockedError) {
    return {
      type: item.type,
      id: item.id,
      ok: false,
      status: 'skipped',
      code: err.code,
      error: err.message,
    };
  }
  if (err instanceof TrashRequestError) {
    return {
      type: item.type,
      id: item.id,
      ok: false,
      status: 'failed',
      code: err.code,
      error: err.message,
    };
  }
  console.error('[admin-trash] unexpected purge failure:', err);
  return {
    type: item.type,
    id: item.id,
    ok: false,
    status: 'failed',
    code: 'INTERNAL_ERROR',
    error: 'Failed to purge item',
  };
}

function assertNoWritableRef(
  items: readonly TrashItemRefInput[],
  refs: ReadonlyMap<string, AdminTrashItemRef>
): void {
  for (const item of items) {
    if (!refs.has(summaryKey(item.type, item.id))) {
      throw new TrashRequestError(404, 'NOT_FOUND', 'Trash item not found');
    }
  }
}

async function validateAdminTargetFolder(
  db: D1Database,
  tenantId: string,
  targetFolderId: string | null | undefined
): Promise<void> {
  if (targetFolderId === undefined || targetFolderId === null) return;
  const row = await db
    .prepare('SELECT id FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(tenantId, targetFolderId)
    .first<{ id: string }>();
  if (!row) {
    throw new TrashRequestError(
      404,
      'TARGET_NOT_FOUND',
      'Destination folder not found'
    );
  }
}

/**
 * Restore up to 100 Trash items as a tenant administrator. Every id is validated
 * against the session tenant first; one cross-tenant or unknown id rejects the
 * entire request before a single row is written. Per-item planning failures are
 * then reported independently.
 */
export async function restoreAdminTrashItems(
  db: D1Database,
  user: AuthUser,
  items: readonly TrashItemRefInput[],
  options: AdminTrashRestoreOptions
): Promise<AdminTrashRestoreResult> {
  if (!isPrivilegedAdmin(user)) {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }
  await validateAdminTargetFolder(db, user.tenantId, options.targetFolderId);

  const refs = await loadAdminTrashItemRefs(db, user.tenantId, items);
  assertNoWritableRef(items, refs);

  const results: TrashBulkItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;
  const hasTarget = options.targetFolderId !== undefined;

  for (const item of items) {
    const ref = refs.get(summaryKey(item.type, item.id))!;
    try {
      if (item.type === 'file') {
        const result: RestoreTrashFileResult = await restoreTrashFile(
          db,
          user,
          item.id,
          {
            conflictPolicy: options.conflictPolicy,
            restoreParentChain: options.restoreParentChain,
            ...(hasTarget ? { targetFolderId: options.targetFolderId } : {}),
            adminDelegation: toDelegation(ref),
          }
        );
        result.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
        if (result.syncSeq !== null) {
          lastSeq = Math.max(lastSeq ?? 0, result.syncSeq);
        }
        results.push({
          type: 'file',
          id: item.id,
          ok: true,
          status: 'succeeded',
          name: result.file.name,
          file: result.file,
        });
      } else {
        const result: RestoreTrashFolderResult = await restoreTrashFolder(
          db,
          user,
          item.id,
          options.conflictPolicy,
          {
            restoreParentChain: options.restoreParentChain,
            ...(hasTarget ? { targetParentId: options.targetFolderId } : {}),
            adminDelegation: toDelegation(ref),
          }
        );
        result.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
        if (result.syncSeq !== null) {
          lastSeq = Math.max(lastSeq ?? 0, result.syncSeq);
        }
        results.push({
          type: 'folder',
          id: item.id,
          ok: true,
          status: 'succeeded',
          name: result.folder.name,
          folder: result.folder,
        });
      }
    } catch (err) {
      results.push(toRestoreFailure(item, err));
    }
  }

  const succeededCount = results.filter((result) => result.ok).length;
  return {
    results,
    succeededCount,
    failedCount: results.length - succeededCount,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}

/** Permanently delete selected tenant Trash items as sys_admin. */
export async function purgeAdminTrashItems(
  env: Pick<OidcEnv, 'DB' | 'BUCKET' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  items: readonly TrashItemRefInput[],
  nowIso = new Date().toISOString()
): Promise<AdminTrashPurgeResult> {
  if (user.role !== 'sys_admin') {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  const refs = await loadAdminTrashItemRefs(env.DB, user.tenantId, items);
  assertNoWritableRef(items, refs);

  const results: TrashPurgeItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;

  for (const item of items) {
    const ref = refs.get(summaryKey(item.type, item.id))!;
    const adminContext: TrashPurgeAdminContext = {
      adminBypass: true,
      owner: {
        id: ref.ownerId,
        name: ref.ownerName,
        email: ref.ownerEmail,
      },
    };
    try {
      const outcome =
        item.type === 'file'
          ? await purgeTrashFileItem(
              env,
              user,
              item.id,
              nowIso,
              adminContext
            )
          : await purgeTrashFolderItem(
              env,
              user,
              item.id,
              nowIso,
              adminContext
            );
      results.push({ ...outcome.result, name: outcome.result.name ?? ref.name });
      outcome.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
      if (outcome.syncSeq !== null) {
        lastSeq = Math.max(lastSeq ?? 0, outcome.syncSeq);
      }
    } catch (err) {
      const failure = toPurgeFailure(item, err);
      results.push({ ...failure, name: failure.name ?? ref.name });
    }
  }

  const succeededCount = results.filter((result) => result.ok).length;
  return {
    results,
    succeededCount,
    failedCount: results.length - succeededCount,
    skippedCount: results.filter((result) => result.status === 'skipped').length,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}

interface TenantTrashCandidate {
  item_type: TrashItemType;
  id: string;
  name: string;
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
}

/**
 * Permanently delete every top-level item in the tenant Trash. Unlike
 * `emptyTrash()` this intentionally ignores individual ACLs; the route and this
 * service both require sys_admin. Locked files are skipped, never forced.
 */
export async function emptyAdminTrash(
  env: Pick<OidcEnv, 'DB' | 'BUCKET' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  nowIso = new Date().toISOString()
): Promise<AdminTrashEmptyResult> {
  if (user.role !== 'sys_admin') {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  const candidates = await env.DB.prepare(
    `SELECT t.item_type, t.id, t.name, t.owner_id,
            u.display_name AS owner_name, u.email AS owner_email
       FROM (${ADMIN_TRASH_UNION_SQL}) t
       LEFT JOIN users u
         ON u.tenant_id = ? AND u.id = t.owner_id
      WHERE t.parent_deleted_at IS NULL
      ORDER BY t.deleted_at ASC, t.item_type ASC, t.id ASC`
  )
    .bind(user.tenantId, user.tenantId, user.tenantId)
    .all<TenantTrashCandidate>();

  const results: TrashPurgeItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;

  for (const candidate of candidates.results) {
    const item: TrashItemRefInput = {
      type: candidate.item_type,
      id: candidate.id,
    };
    const adminContext: TrashPurgeAdminContext = {
      adminBypass: true,
      owner: {
        id: candidate.owner_id ?? user.id,
        name: candidate.owner_name ?? '不明',
        email: candidate.owner_email ?? null,
      },
    };
    try {
      const outcome =
        candidate.item_type === 'file'
          ? await purgeTrashFileItem(
              env,
              user,
              candidate.id,
              nowIso,
              adminContext
            )
          : await purgeTrashFolderItem(
              env,
              user,
              candidate.id,
              nowIso,
              adminContext
            );
      results.push({ ...outcome.result, name: outcome.result.name ?? candidate.name });
      outcome.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
      if (outcome.syncSeq !== null) {
        lastSeq = Math.max(lastSeq ?? 0, outcome.syncSeq);
      }
    } catch (err) {
      const failure = toPurgeFailure(item, err);
      results.push({ ...failure, name: failure.name ?? candidate.name });
    }
  }

  const deletedCount = results.filter((result) => result.ok).length;
  const skippedCount = results.filter(
    (result) => result.status === 'skipped'
  ).length;
  const failedCount = results.length - deletedCount - skippedCount;

  await buildAuditLogStmt(env.DB, {
    tenantId: user.tenantId,
    actorId: user.id,
    actorEmail: user.email,
    actorIp: user.ipAddress,
    action: 'admin.trash.empty',
    targetType: 'tenant',
    targetId: user.tenantId,
    classificationSnapshot: null,
    metadata: {
      targetName: 'テナント全体のゴミ箱',
      deletedCount,
      failedCount,
      skippedCount,
      failedItems: results
        .filter((result) => result.status === 'failed')
        .map((result) => ({
          type: result.type,
          id: result.id,
          name: result.name ?? null,
          code: result.code ?? null,
          error: result.error ?? null,
        })),
      skippedItems: results
        .filter((result) => result.status === 'skipped')
        .map((result) => ({
          type: result.type,
          id: result.id,
          name: result.name ?? null,
          code: result.code ?? null,
          error: result.error ?? null,
        })),
    },
    nowIso,
  }).run();

  return {
    results,
    deletedCount,
    failedCount,
    skippedCount,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}
