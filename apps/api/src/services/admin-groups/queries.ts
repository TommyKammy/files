import { chunkArray } from '../../utils/batch';
import {
  escapeLike,
  loadGroupRow,
  toGroupRow,
  type RawGroupMemberRow,
  type RawGroupPermissionRow,
  type RawGroupRow,
} from './shared';
import type {
  AdminGroupDetailResult,
  AdminGroupFilters,
  AdminGroupListResult,
  AdminGroupPermission,
  AdminGroupSourceFilter,
  AdminGroupSummary,
} from './types';

export function isAdminGroupSourceFilter(
  value: string
): value is AdminGroupSourceFilter {
  return value === 'all' || value === 'scim' || value === 'manual';
}

async function loadGroupSummary(
  db: D1Database,
  tenantId: string,
  scopeGroupId?: string | null
): Promise<AdminGroupSummary> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN external_idp_id IS NULL THEN 1 ELSE 0 END) AS manual_count,
              SUM(CASE WHEN external_idp_id IS NOT NULL THEN 1 ELSE 0 END) AS scim_count
         FROM groups
        WHERE tenant_id = ?${scopeGroupId ? ' AND id = ?' : ''}`
    )
    .bind(...(scopeGroupId ? [tenantId, scopeGroupId] : [tenantId]))
    .first<{ total: number; manual_count: number | null; scim_count: number | null }>();
  return {
    total: row?.total ?? 0,
    manualCount: row?.manual_count ?? 0,
    scimCount: row?.scim_count ?? 0,
  };
}

export async function listAdminGroups(
  db: D1Database,
  tenantId: string,
  filters: AdminGroupFilters
): Promise<AdminGroupListResult> {
  const conditions = ['g.tenant_id = ?'];
  const bindings: Array<string | number> = [tenantId];

  if (filters.query) {
    const pattern = `%${escapeLike(filters.query.toLowerCase())}%`;
    conditions.push(
      `(lower(g.name) LIKE ? ESCAPE '\\'
        OR lower(g.id) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(g.external_idp_id, '')) LIKE ? ESCAPE '\\')`
    );
    bindings.push(pattern, pattern, pattern);
  }
  if (filters.source === 'scim') {
    conditions.push('g.external_idp_id IS NOT NULL');
  } else if (filters.source === 'manual') {
    conditions.push('g.external_idp_id IS NULL');
  }
  if (filters.scopeGroupId) {
    conditions.push('g.id = ?');
    bindings.push(filters.scopeGroupId);
  }

  const whereSql = conditions.join(' AND ');
  const [countRow, summary, rows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM groups g WHERE ${whereSql}`)
      .bind(...bindings)
      .first<{ total: number }>(),
    loadGroupSummary(db, tenantId, filters.scopeGroupId ?? null),
    db
      .prepare(
        `SELECT g.id,
                g.name,
                g.external_idp_id,
                g.created_at,
                (
                  SELECT COUNT(*)
                    FROM group_members gm
                   WHERE gm.group_id = g.id
                ) AS member_count,
                (
                  SELECT COUNT(*)
                    FROM permissions p
                   WHERE p.tenant_id = g.tenant_id
                     AND p.grantee_type = 'group'
                     AND p.grantee_id = g.id
                ) AS permission_count
           FROM groups g
          WHERE ${whereSql}
          ORDER BY lower(g.name) ASC, g.id ASC
          LIMIT ? OFFSET ?`
      )
      .bind(...bindings, filters.limit, filters.offset)
      .all<RawGroupRow>(),
  ]);

  const total = countRow?.total ?? 0;
  const nextOffset =
    filters.offset + rows.results.length < total
      ? filters.offset + rows.results.length
      : null;

  return {
    groups: rows.results.map(toGroupRow),
    total,
    limit: filters.limit,
    offset: filters.offset,
    nextOffset,
    summary,
    aggregations: summary,
  };
}

async function loadGroupPermissions(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<AdminGroupPermission[]> {
  const rows = await db
    .prepare(
      `SELECT p.id,
              p.target_type,
              p.target_id,
              p.role,
              p.granted_by,
              u.display_name AS granted_by_name,
              p.created_at
         FROM permissions p
         LEFT JOIN users u ON u.id = p.granted_by
        WHERE p.tenant_id = ?
          AND p.grantee_type = 'group'
          AND p.grantee_id = ?
        ORDER BY p.target_type ASC, p.created_at ASC, p.id ASC`
    )
    .bind(tenantId, groupId)
    .all<RawGroupPermissionRow>();

  const folderIds = new Set<string>();
  const fileIds = new Set<string>();
  for (const row of rows.results) {
    if (row.target_type === 'folder') folderIds.add(row.target_id);
    else fileIds.add(row.target_id);
  }

  const fileRows: Array<{
    id: string;
    name: string;
    folder_id: string | null;
    deleted_at: string | null;
  }> = [];
  for (const chunk of chunkArray([...fileIds])) {
    const chunkRows = await db
      .prepare(
        `SELECT id, name, folder_id, deleted_at
           FROM files
          WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`
      )
      .bind(tenantId, ...chunk)
      .all<{
        id: string;
        name: string;
        folder_id: string | null;
        deleted_at: string | null;
      }>();
    fileRows.push(...chunkRows.results);
  }

  const files = new Map(fileRows.map((row) => [row.id, row]));
  for (const row of fileRows) {
    if (row.folder_id) folderIds.add(row.folder_id);
  }

  const folderRows: Array<{
    id: string;
    name: string;
    deleted_at: string | null;
  }> = [];
  for (const chunk of chunkArray([...folderIds])) {
    const chunkRows = await db
      .prepare(
        `SELECT id, name, deleted_at
           FROM folders
          WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`
      )
      .bind(tenantId, ...chunk)
      .all<{ id: string; name: string; deleted_at: string | null }>();
    folderRows.push(...chunkRows.results);
  }

  const folders = new Map(folderRows.map((row) => [row.id, row]));

  const closureRows: Array<{ folder_id: string; depth: number; name: string }> =
    [];
  for (const chunk of chunkArray([...folderIds])) {
    const chunkRows = await db
      .prepare(
        `SELECT fc.descendant_id AS folder_id, fc.depth, f.name
           FROM folder_closures fc
           JOIN folders f
             ON f.id = fc.ancestor_id
            AND f.tenant_id = fc.tenant_id
          WHERE fc.tenant_id = ?
            AND fc.descendant_id IN (${chunk.map(() => '?').join(', ')})
          ORDER BY fc.descendant_id ASC, fc.depth DESC`
      )
      .bind(tenantId, ...chunk)
      .all<{ folder_id: string; depth: number; name: string }>();
    closureRows.push(...chunkRows.results);
  }

  const pathParts = new Map<string, string[]>();
  for (const row of closureRows) {
    const parts = pathParts.get(row.folder_id) ?? [];
    parts.push(row.name);
    pathParts.set(row.folder_id, parts);
  }

  const folderPath = (folderId: string | null): string => {
    if (!folderId) return 'ルート';
    const parts = pathParts.get(folderId);
    if (parts && parts.length > 0) return parts.join(' / ');
    return folders.get(folderId)?.name ?? '不明なフォルダ';
  };

  return rows.results.map((row) => {
    if (row.target_type === 'file') {
      const file = files.get(row.target_id);
      const deletedSuffix = file?.deleted_at ? '（削除済み）' : '';
      return {
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        targetName: `${file?.name ?? row.target_id}${deletedSuffix}`,
        targetPath: folderPath(file?.folder_id ?? null),
        role: row.role,
        grantedBy: row.granted_by,
        grantedByName: row.granted_by_name,
        createdAt: row.created_at,
      };
    }
    const folder = folders.get(row.target_id);
    const deletedSuffix = folder?.deleted_at ? '（削除済み）' : '';
    return {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      targetName: `${folder?.name ?? row.target_id}${deletedSuffix}`,
      targetPath: `${folderPath(row.target_id)}${deletedSuffix}`,
      role: row.role,
      grantedBy: row.granted_by,
      grantedByName: row.granted_by_name,
      createdAt: row.created_at,
    };
  });
}

export async function loadAdminGroupDetail(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<AdminGroupDetailResult | null> {
  const group = await loadGroupRow(db, tenantId, groupId);
  if (!group) return null;

  const [memberRows, permissions] = await Promise.all([
    db
      .prepare(
        `SELECT u.id,
                u.email,
                u.display_name,
                u.department,
                u.role,
                u.status,
                gm.created_at AS added_at
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = ? AND u.tenant_id = ?
          ORDER BY lower(u.email) ASC, u.id ASC`
      )
      .bind(groupId, tenantId)
      .all<RawGroupMemberRow>(),
    loadGroupPermissions(db, tenantId, groupId),
  ]);

  return {
    group: toGroupRow(group),
    members: memberRows.results.map((member) => ({
      id: member.id,
      email: member.email,
      displayName: member.display_name,
      department: member.department,
      role: member.role,
      status: member.status,
      addedAt: member.added_at,
    })),
    permissions,
    scimManaged: group.external_idp_id !== null,
  };
}

/** Stable alias for callers that follow the admin-user service naming. */
export const getAdminGroupDetail = loadAdminGroupDetail;
