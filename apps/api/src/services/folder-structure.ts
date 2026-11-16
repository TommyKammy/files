import type { AuthUser } from '../types/api';

export type FolderStructureMode = 'open' | 'closed';

export const ROOT_CREATION_ADMIN_ONLY_MESSAGE =
  'Root-level creation is restricted to sys_admin in closed folder mode';

/**
 * Read the tenant folder-structure policy. Missing legacy policy rows default
 * to `open`, matching the migration default and the pre-P9-3 behavior.
 */
export async function getFolderStructureMode(
  db: D1Database,
  tenantId: string
): Promise<FolderStructureMode> {
  const row = await db
    .prepare(
      'SELECT folder_structure_mode FROM tenant_policies WHERE tenant_id = ?'
    )
    .bind(tenantId)
    .first<{ folder_structure_mode: string | null }>();
  return row?.folder_structure_mode === 'closed' ? 'closed' : 'open';
}

/**
 * Root creation / root placement is allowed in `open` mode. In `closed` mode
 * only `sys_admin` may create or place items at the workspace root.
 *
 * `sec_admin` is intentionally read/audit-only for root mutations in closed
 * mode; only the tenant system administrator bypasses the restriction.
 */
export function canCreateAtRoot(
  mode: FolderStructureMode,
  user: Pick<AuthUser, 'role'>
): boolean {
  return mode === 'open' || user.role === 'sys_admin';
}

export interface ClosedRootSummary {
  id: string;
  name: string;
  ownerMissing: boolean;
  hasSuspendedOwner: boolean;
}

export interface ClosedRootReport {
  totalRootFolders: number;
  missingOwnerCount: number;
  suspendedOwnerCount: number;
  roots: ClosedRootSummary[];
}

interface RootOwnerRow {
  root_id: string;
  root_name: string;
  active_owner_count: number;
  suspended_owner_count: number;
}

/**
 * Summary of active root folders and their direct owners, used by the policy
 * PATCH response and the administration dashboard to surface unowned or
 * suspended-owner roots immediately after switching to `closed`.
 */
export async function buildClosedRootReport(
  db: D1Database,
  tenantId: string
): Promise<ClosedRootReport> {
  const rows = await db
    .prepare(
      `SELECT f.id AS root_id,
              f.name AS root_name,
              (
                SELECT COUNT(*)
                  FROM permissions p
                  LEFT JOIN users u
                    ON p.grantee_type = 'user'
                   AND u.tenant_id = p.tenant_id
                   AND u.id = p.grantee_id
                 WHERE p.tenant_id = f.tenant_id
                   AND p.target_type = 'folder'
                   AND p.target_id = f.id
                   AND p.role = 'owner'
                   AND (
                     p.grantee_type = 'group'
                     OR (p.grantee_type = 'user' AND u.status = 'active')
                   )
              ) AS active_owner_count,
              (
                SELECT COUNT(*)
                  FROM permissions p
                  JOIN users u
                    ON p.grantee_type = 'user'
                   AND u.tenant_id = p.tenant_id
                   AND u.id = p.grantee_id
                 WHERE p.tenant_id = f.tenant_id
                   AND p.target_type = 'folder'
                   AND p.target_id = f.id
                   AND p.role = 'owner'
                   AND u.status = 'suspended'
              ) AS suspended_owner_count
         FROM folders f
        WHERE f.tenant_id = ?
          AND f.parent_id IS NULL
          AND f.deleted_at IS NULL
        ORDER BY f.name ASC, f.id ASC`
    )
    .bind(tenantId)
    .all<RootOwnerRow>();

  const roots = rows.results.map((row) => ({
    id: row.root_id,
    name: row.root_name,
    ownerMissing: Number(row.active_owner_count) === 0,
    hasSuspendedOwner: Number(row.suspended_owner_count) > 0,
  }));

  return {
    totalRootFolders: roots.length,
    missingOwnerCount: roots.filter((root) => root.ownerMissing).length,
    suspendedOwnerCount: roots.filter((root) => root.hasSuspendedOwner).length,
    roots,
  };
}
