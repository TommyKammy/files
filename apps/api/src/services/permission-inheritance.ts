import type { ResourceRole } from '../types/api';

/**
 * P9-4 / TOM-54 permission inheritance policy.
 *
 * The policy is stored on `tenant_policies.permission_inheritance_mode` and only
 * changes *write* behavior. Effective access always remains the non-linear
 * capability union so that switching modes can never silently widen or narrow
 * an existing principal's access; legacy child overrides are surfaced through
 * the conflict report until an admin removes them.
 */
export type PermissionInheritanceMode = 'additive' | 'waterfall';

export interface InheritedAncestorGrant {
  ancestorFolderId: string;
  ancestorFolderName: string;
  inheritedRole: ResourceRole;
}

export interface WaterfallInheritanceConflict {
  permissionId: string;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  granteeType: 'user' | 'group';
  granteeId: string;
  granteeName: string | null;
  directRole: string;
  ancestorFolderId: string;
  ancestorFolderName: string;
  ancestorRole: string;
}

interface ConflictRow {
  permission_id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  target_name: string;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  grantee_name: string | null;
  direct_role: string;
  ancestor_folder_id: string;
  ancestor_folder_name: string;
  ancestor_role: string;
  ancestor_depth: number;
}

export function isPermissionInheritanceMode(
  value: unknown
): value is PermissionInheritanceMode {
  return value === 'additive' || value === 'waterfall';
}

/** Resolve the tenant inheritance mode; a missing policy row defaults to additive. */
export async function getPermissionInheritanceMode(
  db: D1Database,
  tenantId: string
): Promise<PermissionInheritanceMode> {
  const row = await db
    .prepare(
      'SELECT permission_inheritance_mode FROM tenant_policies WHERE tenant_id = ?'
    )
    .bind(tenantId)
    .first<{ permission_inheritance_mode: string | null }>();
  return isPermissionInheritanceMode(row?.permission_inheritance_mode)
    ? row.permission_inheritance_mode
    : 'additive';
}

function dedupeConflicts(rows: ConflictRow[]): WaterfallInheritanceConflict[] {
  const closestByPermission = new Map<string, ConflictRow>();
  for (const row of rows) {
    const existing = closestByPermission.get(row.permission_id);
    if (!existing || row.ancestor_depth < existing.ancestor_depth) {
      closestByPermission.set(row.permission_id, row);
    }
  }
  return [...closestByPermission.values()].map((row) => ({
    permissionId: row.permission_id,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    granteeName: row.grantee_name,
    directRole: row.direct_role,
    ancestorFolderId: row.ancestor_folder_id,
    ancestorFolderName: row.ancestor_folder_name,
    ancestorRole: row.ancestor_role,
  }));
}

/**
 * Detect legacy direct child grants that duplicate a grant already inherited
 * from an ancestor folder for the same `(grantee_type, grantee_id)`.
 *
 * - Folder target: the direct grant is on a strict descendant (`depth > 0`).
 * - File target: the direct file grant is inside an ancestor's subtree
 *   (`depth >= 0` includes the file's own folder).
 *
 * One row per direct permission is returned, using the closest ancestor when
 * several ancestor grants exist.
 */
export async function findWaterfallInheritanceConflicts(
  db: D1Database,
  tenantId: string
): Promise<WaterfallInheritanceConflict[]> {
  const [folderRows, fileRows] = await Promise.all([
    db
      .prepare(
        `SELECT p.id AS permission_id,
                'folder' AS target_type,
                p.target_id AS target_id,
                f.name AS target_name,
                p.grantee_type,
                p.grantee_id,
                COALESCE(u.display_name, g.name) AS grantee_name,
                p.role AS direct_role,
                anc.id AS ancestor_folder_id,
                anc.name AS ancestor_folder_name,
                anc_p.role AS ancestor_role,
                fc.depth AS ancestor_depth
           FROM permissions p
           JOIN folders f
             ON f.tenant_id = p.tenant_id
            AND f.id = p.target_id
            AND f.deleted_at IS NULL
           JOIN folder_closures fc
             ON fc.tenant_id = p.tenant_id
            AND fc.descendant_id = p.target_id
            AND fc.depth > 0
           JOIN folders anc
             ON anc.tenant_id = p.tenant_id
            AND anc.id = fc.ancestor_id
            AND anc.deleted_at IS NULL
           JOIN permissions anc_p
             ON anc_p.tenant_id = p.tenant_id
            AND anc_p.target_type = 'folder'
            AND anc_p.target_id = fc.ancestor_id
            AND anc_p.grantee_type = p.grantee_type
            AND anc_p.grantee_id = p.grantee_id
           LEFT JOIN users u
             ON p.grantee_type = 'user'
            AND u.tenant_id = p.tenant_id
            AND u.id = p.grantee_id
           LEFT JOIN groups g
             ON p.grantee_type = 'group'
            AND g.tenant_id = p.tenant_id
            AND g.id = p.grantee_id
          WHERE p.tenant_id = ?
            AND p.target_type = 'folder'
          ORDER BY p.id ASC, fc.depth ASC`
      )
      .bind(tenantId)
      .all<ConflictRow>(),
    db
      .prepare(
        `SELECT p.id AS permission_id,
                'file' AS target_type,
                p.target_id AS target_id,
                fl.name AS target_name,
                p.grantee_type,
                p.grantee_id,
                COALESCE(u.display_name, g.name) AS grantee_name,
                p.role AS direct_role,
                anc.id AS ancestor_folder_id,
                anc.name AS ancestor_folder_name,
                anc_p.role AS ancestor_role,
                fc.depth AS ancestor_depth
           FROM permissions p
           JOIN files fl
             ON fl.tenant_id = p.tenant_id
            AND fl.id = p.target_id
            AND fl.deleted_at IS NULL
            AND fl.upload_state = 'active'
           JOIN folder_closures fc
             ON fc.tenant_id = p.tenant_id
            AND fc.descendant_id = fl.folder_id
           JOIN folders anc
             ON anc.tenant_id = p.tenant_id
            AND anc.id = fc.ancestor_id
            AND anc.deleted_at IS NULL
           JOIN permissions anc_p
             ON anc_p.tenant_id = p.tenant_id
            AND anc_p.target_type = 'folder'
            AND anc_p.target_id = fc.ancestor_id
            AND anc_p.grantee_type = p.grantee_type
            AND anc_p.grantee_id = p.grantee_id
           LEFT JOIN users u
             ON p.grantee_type = 'user'
            AND u.tenant_id = p.tenant_id
            AND u.id = p.grantee_id
           LEFT JOIN groups g
             ON p.grantee_type = 'group'
            AND g.tenant_id = p.tenant_id
            AND g.id = p.grantee_id
          WHERE p.tenant_id = ?
            AND p.target_type = 'file'
          ORDER BY p.id ASC, fc.depth ASC`
      )
      .bind(tenantId)
      .all<ConflictRow>(),
  ]);

  return dedupeConflicts([...folderRows.results, ...fileRows.results]);
}

/**
 * Find the closest ancestor folder grant held by `(granteeType, granteeId)` for
 * a target. In `waterfall` mode this locks any re-grant / override on the child.
 *
 * Files inherit from their own folder (`depth = 0`) and every ancestor; folders
 * only inherit from strict ancestors (`depth > 0`).
 */
export async function findInheritedAncestorGrant(
  db: D1Database,
  tenantId: string,
  targetType: 'folder' | 'file',
  targetId: string,
  granteeType: 'user' | 'group',
  granteeId: string
): Promise<InheritedAncestorGrant | null> {
  const granteeSql =
    granteeType === 'user'
      ? "anc_p.grantee_type = 'user' AND anc_p.grantee_id = ?"
      : "anc_p.grantee_type = 'group' AND anc_p.grantee_id = ?";

  const query =
    targetType === 'folder'
      ? `SELECT anc.id AS ancestor_folder_id,
                anc.name AS ancestor_folder_name,
                anc_p.role AS inherited_role
           FROM folder_closures fc
           JOIN folders anc
             ON anc.tenant_id = fc.tenant_id
            AND anc.id = fc.ancestor_id
            AND anc.deleted_at IS NULL
           JOIN permissions anc_p
             ON anc_p.tenant_id = fc.tenant_id
            AND anc_p.target_type = 'folder'
            AND anc_p.target_id = fc.ancestor_id
          WHERE fc.tenant_id = ?
            AND fc.descendant_id = ?
            AND fc.depth > 0
            AND ${granteeSql}
          ORDER BY fc.depth ASC
          LIMIT 1`
      : `SELECT anc.id AS ancestor_folder_id,
                anc.name AS ancestor_folder_name,
                anc_p.role AS inherited_role
           FROM files fl
           JOIN folder_closures fc
             ON fc.tenant_id = fl.tenant_id
            AND fc.descendant_id = fl.folder_id
           JOIN folders anc
             ON anc.tenant_id = fc.tenant_id
            AND anc.id = fc.ancestor_id
            AND anc.deleted_at IS NULL
           JOIN permissions anc_p
             ON anc_p.tenant_id = fc.tenant_id
            AND anc_p.target_type = 'folder'
            AND anc_p.target_id = fc.ancestor_id
          WHERE fl.tenant_id = ?
            AND fl.id = ?
            AND ${granteeSql}
          ORDER BY fc.depth ASC
          LIMIT 1`;

  const row = await db
    .prepare(query)
    .bind(tenantId, targetId, granteeId)
    .first<{
      ancestor_folder_id: string;
      ancestor_folder_name: string;
      inherited_role: ResourceRole;
    }>();

  if (!row) return null;
  return {
    ancestorFolderId: row.ancestor_folder_id,
    ancestorFolderName: row.ancestor_folder_name,
    inheritedRole: row.inherited_role,
  };
}
