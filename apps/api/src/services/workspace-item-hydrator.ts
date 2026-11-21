import type { AuthUser, ClassificationLabel, ResourceRole } from '../types/api';
import { chunkArray } from '../utils/batch';
import {
  FILE_PREVIEW_ROLE_SQL,
  GRANTEE_MATCH_SQL,
  resolveUserAccessForFolders,
} from './authorization';
import {
  can,
  filterFileTargetRoles,
  parseRoleList,
  synthesizeEffectiveAccess,
} from './capabilities';
import {
  folderPathLabel,
  loadFolderBreadcrumbMap,
  type FolderBreadcrumb,
} from './folder-breadcrumbs';

export type WorkspaceItemType = 'file' | 'folder';

export interface HydratableFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  updated_at: string;
}

export interface HydratableFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  classification: ClassificationLabel;
  updated_at: string;
}

export interface HydratedWorkspaceItem {
  itemType: WorkspaceItemType;
  id: string;
  name: string;
  classification: ClassificationLabel;
  folderId: string | null;
  parentId: string | null;
  updatedAt: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  effectiveRole: string | null;
  capabilities: string[];
  breadcrumbs: FolderBreadcrumb[];
  pathLabel: string;
}

const HYDRATION_CHUNK_SIZE = 30;

export function isValidWorkspaceItemType(value: unknown): value is WorkspaceItemType {
  return value === 'file' || value === 'folder';
}

export function normalizeWorkspaceItemId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return trimmed;
}

function reachableFileGrantSql(alias: string, granteeKind: 'user' | 'group'): string {
  const fromClause =
    granteeKind === 'user'
      ? `FROM permissions p
      JOIN files fl
        ON fl.id = p.target_id
     WHERE p.tenant_id = ${alias}.tenant_id
       AND p.grantee_type = 'user'
       AND p.grantee_id = ?`
      : `FROM group_members gm
     CROSS JOIN permissions p
      JOIN files fl
        ON fl.id = p.target_id
     WHERE gm.user_id = ?
       AND p.tenant_id = ${alias}.tenant_id
       AND p.grantee_type = 'group'
       AND p.grantee_id = gm.group_id`;

  return `EXISTS (
    SELECT 1
      ${fromClause}
       AND p.target_type = 'file'
       AND p.role IN (${FILE_PREVIEW_ROLE_SQL})
       AND fl.tenant_id = ${alias}.tenant_id
       AND fl.deleted_at IS NULL
       AND fl.upload_state = 'active'
       AND (
         fl.folder_id = ${alias}.id
         OR EXISTS (
           SELECT 1
             FROM folder_closures fc2
            WHERE fc2.tenant_id = ${alias}.tenant_id
              AND fc2.ancestor_id = ${alias}.id
              AND fc2.descendant_id = fl.folder_id
              AND fc2.depth > 0
         )
       )
  )`;
}

/**
 * Batch-check `accessMode: 'path'` reachability for folders that had no direct
 * or inherited folder grant in `resolveUserAccessForFolders`.
 */
async function loadPathReachableFolderIds(
  db: D1Database,
  tenantId: string,
  userId: string,
  folderIds: readonly string[]
): Promise<Set<string>> {
  const reachable = new Set<string>();
  const uniqueIds = [...new Set(folderIds.filter(Boolean))];
  if (uniqueIds.length === 0) return reachable;

  for (const chunk of chunkArray(uniqueIds, HYDRATION_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT f.id
           FROM folders f
          WHERE f.tenant_id = ?
            AND f.deleted_at IS NULL
            AND f.id IN (${placeholders})
            AND (
              EXISTS (
                SELECT 1
                  FROM folder_closures fc
                  JOIN folders d
                    ON d.tenant_id = fc.tenant_id
                   AND d.id = fc.descendant_id
                   AND d.deleted_at IS NULL
                 WHERE fc.tenant_id = f.tenant_id
                   AND fc.ancestor_id = f.id
                   AND fc.depth > 0
                   AND EXISTS (
                     SELECT 1 FROM permissions p
                      WHERE p.tenant_id = fc.tenant_id
                        AND p.target_type = 'folder'
                        AND p.target_id = d.id
                        AND ${GRANTEE_MATCH_SQL}
                   )
              )
              OR ${reachableFileGrantSql('f', 'user')}
              OR ${reachableFileGrantSql('f', 'group')}
            )`
      )
      .bind(tenantId, ...chunk, userId, userId, userId, userId)
      .all<{ id: string }>();

    for (const row of rows.results) {
      reachable.add(row.id);
    }
  }

  return reachable;
}

/**
 * Batch-load direct file permissions for a set of file IDs, filtering out
 * folder-only advanced roles to match `resolveTargetAccess`.
 */
async function loadDirectFileRolesMap(
  db: D1Database,
  tenantId: string,
  userId: string,
  fileIds: readonly string[]
): Promise<Map<string, ResourceRole[]>> {
  const map = new Map<string, ResourceRole[]>();
  const uniqueIds = [...new Set(fileIds.filter(Boolean))];
  if (uniqueIds.length === 0) return map;

  for (const chunk of chunkArray(uniqueIds, HYDRATION_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT p.target_id AS file_id,
                GROUP_CONCAT(DISTINCT p.role) AS role_list
           FROM permissions p
          WHERE p.tenant_id = ?
            AND p.target_type = 'file'
            AND p.target_id IN (${placeholders})
            AND ${GRANTEE_MATCH_SQL}
          GROUP BY p.target_id`
      )
      .bind(tenantId, ...chunk, userId, userId)
      .all<{ file_id: string; role_list: string | null }>();

    for (const row of rows.results) {
      const roles = filterFileTargetRoles(parseRoleList(row.role_list));
      if (roles.length > 0) {
        map.set(row.file_id, roles);
      }
    }
  }

  return map;
}

/**
 * Batch-hydrate workspace folder and file rows with RBAC filtering, effective
 * roles/capabilities, breadcrumbs, and path labels in O(1) D1 queries.
 */
export async function hydrateWorkspaceItems<
  TFolder extends HydratableFolderRow,
  TFile extends HydratableFileRow,
  TItem extends HydratedWorkspaceItem = HydratedWorkspaceItem,
>(options: {
  db: D1Database;
  user: Pick<AuthUser, 'id' | 'tenantId'>;
  folderRows: readonly TFolder[];
  fileRows: readonly TFile[];
  projectFolder: (base: HydratedWorkspaceItem, row: TFolder) => TItem;
  projectFile: (base: HydratedWorkspaceItem, row: TFile) => TItem;
}): Promise<TItem[]> {
  const { db, user, folderRows, fileRows, projectFolder, projectFile } = options;
  if (folderRows.length === 0 && fileRows.length === 0) {
    return [];
  }

  const allFolderIds = [
    ...folderRows.map((row) => row.id),
    ...fileRows
      .map((row) => row.folder_id)
      .filter((id): id is string => Boolean(id)),
  ];
  const fileIds = fileRows.map((row) => row.id);

  const [breadcrumbMap, folderAccessMap, directFileRolesMap] = await Promise.all([
    loadFolderBreadcrumbMap(db, user.tenantId, allFolderIds),
    resolveUserAccessForFolders(db, user.tenantId, user.id, allFolderIds),
    loadDirectFileRolesMap(db, user.tenantId, user.id, fileIds),
  ]);

  const missingFolderIds = folderRows
    .map((row) => row.id)
    .filter((id) => !folderAccessMap.has(id));
  const pathReachableIds = await loadPathReachableFolderIds(
    db,
    user.tenantId,
    user.id,
    missingFolderIds
  );

  const items: TItem[] = [];

  for (const row of folderRows) {
    const folderAccess = folderAccessMap.get(row.id);
    let effectiveRole: string | null;
    let capabilities: string[];

    if (folderAccess) {
      if (!can(folderAccess.capabilities, 'folder.traverse')) {
        continue;
      }
      effectiveRole = folderAccess.effectiveRole;
      capabilities = folderAccess.capabilities;
    } else if (pathReachableIds.has(row.id)) {
      effectiveRole = null;
      capabilities = ['folder.traverse'];
    } else {
      continue;
    }

    const breadcrumbs = breadcrumbMap.get(row.id) ?? [];
    items.push(
      projectFolder(
        {
          itemType: 'folder',
          id: row.id,
          name: row.name,
          classification: row.classification,
          folderId: null,
          parentId: row.parent_id,
          updatedAt: row.updated_at,
          extension: null,
          mimeType: null,
          sizeBytes: null,
          effectiveRole,
          capabilities,
          breadcrumbs,
          pathLabel: folderPathLabel(breadcrumbs),
        },
        row
      )
    );
  }

  for (const row of fileRows) {
    const folderAccess = row.folder_id
      ? folderAccessMap.get(row.folder_id)
      : undefined;
    const directRoles = directFileRolesMap.get(row.id) ?? [];
    const access = synthesizeEffectiveAccess([
      ...(folderAccess?.effectiveRole ? [folderAccess.effectiveRole] : []),
      ...directRoles,
    ]);

    if (!can(access.capabilities, 'item.preview')) {
      continue;
    }

    const breadcrumbs = row.folder_id
      ? breadcrumbMap.get(row.folder_id) ?? []
      : [];
    items.push(
      projectFile(
        {
          itemType: 'file',
          id: row.id,
          name: row.name,
          classification: row.classification,
          folderId: row.folder_id,
          parentId: null,
          updatedAt: row.updated_at,
          extension: row.extension,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          effectiveRole: access.effectiveRole,
          capabilities: access.capabilities,
          breadcrumbs,
          pathLabel: folderPathLabel(breadcrumbs),
        },
        row
      )
    );
  }

  return items;
}
