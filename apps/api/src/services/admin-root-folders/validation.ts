import { chunkArray } from '../../utils/batch';
import {
  AdminRootFolderError,
  ROOT_PERMISSION_CHUNK,
  type AdminRootFolderCandidate,
  type RootFolderRow,
} from './types';

export function normalizeIdArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AdminRootFolderError(
      400,
      'INVALID_GRANTEE_LIST',
      `${field} must be an array of ids`
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new AdminRootFolderError(
        400,
        'INVALID_GRANTEE',
        `${field} must contain non-empty ids`
      );
    }
    const id = raw.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export async function assertActiveUser(
  db: D1Database,
  tenantId: string,
  userId: string,
  code = 'INVALID_OWNER'
): Promise<void> {
  const row = await db
    .prepare('SELECT id, status FROM users WHERE tenant_id = ? AND id = ?')
    .bind(tenantId, userId)
    .first<{ id: string; status: 'active' | 'suspended' }>();
  if (!row) {
    throw new AdminRootFolderError(400, code, 'User not found in tenant');
  }
  if (row.status !== 'active') {
    throw new AdminRootFolderError(400, 'SUSPENDED_USER_BLOCKED', 'User is suspended');
  }
}

export async function assertTenantGroups(
  db: D1Database,
  tenantId: string,
  groupIds: readonly string[]
): Promise<void> {
  if (groupIds.length === 0) return;
  for (const chunk of chunkArray([...groupIds], ROOT_PERMISSION_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id FROM groups WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<{ id: string }>();
    if (rows.results.length !== chunk.length) {
      throw new AdminRootFolderError(
        400,
        'INVALID_GROUP',
        'Group not found in tenant'
      );
    }
  }
}

export async function loadRootFolderRow(
  db: D1Database,
  tenantId: string,
  folderId: string,
  options: { allowDeleted?: boolean } = {}
): Promise<RootFolderRow> {
  const row = await db
    .prepare(
      `SELECT f.id, f.parent_id, f.name, f.classification, f.is_pinned, f.version,
              f.created_by, f.deleted_at, f.deleted_by, f.created_at, f.updated_at,
              u.display_name AS created_by_name,
              u.email AS created_by_email
         FROM folders f
         LEFT JOIN users u
           ON u.tenant_id = f.tenant_id AND u.id = f.created_by
        WHERE f.tenant_id = ? AND f.id = ?`
    )
    .bind(tenantId, folderId)
    .first<RootFolderRow>();
  if (!row) {
    throw new AdminRootFolderError(404, 'NOT_FOUND', 'Root folder not found');
  }
  if (row.parent_id !== null) {
    throw new AdminRootFolderError(
      400,
      'NOT_ROOT_FOLDER',
      'Target folder is not a workspace root folder'
    );
  }
  if (row.deleted_at !== null && !options.allowDeleted) {
    throw new AdminRootFolderError(404, 'NOT_FOUND', 'Root folder not found');
  }
  return row;
}

/**
 * Load root-folder candidates without throwing for missing/non-root/archived
 * ids. Bulk operations need per-item results, so a cross-tenant or unknown id
 * simply never appears in the returned map.
 */
export async function loadAdminRootFolderCandidates(
  db: D1Database,
  tenantId: string,
  folderIds: readonly string[]
): Promise<Map<string, AdminRootFolderCandidate>> {
  const result = new Map<string, AdminRootFolderCandidate>();
  for (const chunk of chunkArray([...new Set(folderIds)], ROOT_PERMISSION_CHUNK)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, parent_id, name, classification, deleted_at
           FROM folders
          WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<AdminRootFolderCandidate>();
    for (const row of rows.results) result.set(row.id, row);
  }
  return result;
}
