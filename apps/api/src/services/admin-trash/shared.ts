import type { ClassificationLabel, ResourceRole } from '../../types/api';
import { chunkArray } from '../../utils/batch';
import { FileLockedError } from '../file-lock';
import { FileUploadError } from '../file-upload-common';
import { FolderServiceError } from '../folder-closure-service';
import {
  TrashRequestError,
  type TrashItemRefInput,
  type TrashItemType,
} from '../trash-items';
import type { TrashPurgeItemResult } from '../trash-purge';
import type { TrashBulkItemResult } from '../trash-restore';
import type { AdminRestoreDelegation } from '../trash-restore-context';
import type {
  AdminTrashItemRef,
  AdminTrashPermissionSummary,
  AdminTrashPerson,
} from './types';

export const PERMISSION_QUERY_CHUNK = 30;

export const FOLDER_OWNER_ID_SQL = `COALESCE(
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

export const FILE_OWNER_ID_SQL = `COALESCE(
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
export const ADMIN_TRASH_UNION_SQL = `
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

export interface AdminTrashDbRow {
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

export interface GrantAggregateRow {
  item_id: string;
  role: ResourceRole;
  grantee_type: 'user' | 'group';
  count: number;
}

export interface SharedLinkAggregateRow {
  target_type: 'folder' | 'file';
  item_id: string;
  count: number;
}

export interface AdminTrashRefRow {
  id: string;
  name: string;
  deleted_at: string | null;
  created_by: string;
  owner_id: string | null;
  version: number | null;
  current_version_num: number | null;
  upload_state: 'pending' | 'active' | 'failed' | null;
}

export interface TenantTrashCandidate {
  item_type: TrashItemType;
  id: string;
  name: string;
  owner_id: string | null;
  owner_name: string | null;
  owner_email: string | null;
}

export function emptyPermissionSummary(): AdminTrashPermissionSummary {
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

export function summaryKey(type: TrashItemType, id: string): string {
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

export async function loadPermissionSummaries(
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

export function toPerson(row: {
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

export async function loadOwnerProfiles(
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

export function toDelegation(ref: AdminTrashItemRef): AdminRestoreDelegation {
  return {
    onBehalfOfUserId: ref.ownerId,
    ownerId: ref.ownerId,
    ownerName: ref.ownerName,
    ownerEmail: ref.ownerEmail,
  };
}

export function toRestoreFailure(
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

export function toPurgeFailure(
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

export function assertNoWritableRef(
  items: readonly TrashItemRefInput[],
  refs: ReadonlyMap<string, AdminTrashItemRef>
): void {
  for (const item of items) {
    if (!refs.has(summaryKey(item.type, item.id))) {
      throw new TrashRequestError(404, 'NOT_FOUND', 'Trash item not found');
    }
  }
}

export async function validateAdminTargetFolder(
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
