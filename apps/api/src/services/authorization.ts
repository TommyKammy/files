import { createMiddleware } from 'hono/factory';
import type { AuthUser, ClassificationLabel, ResourceRole, UserRole } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import {
  can,
  capabilitiesForRole,
  capabilityRoleSqlList,
  filterFileTargetRoles,
  isResourceRole,
  parseRoleList,
  ROLE_CAPABILITIES,
  synthesizeEffectiveAccess,
  type Capability,
  type EffectiveAccess,
} from './capabilities';

/**
 * Legacy linear display ranks.
 *
 * @deprecated Do not use for authorization. The eight-role model is not totally
 * ordered (`uploader` and `previewer_uploader` are orthogonal). Use
 * `can(access.capabilities, ...)` or `hasAtLeastRole()` (capability-containment
 * adapter) instead. Kept for API compatibility with older consumers.
 */
export const RESOURCE_ROLE_RANK: Record<ResourceRole, number> = {
  uploader: 0.5,
  previewer: 1,
  previewer_uploader: 1.5,
  viewer: 2,
  viewer_uploader: 2.5,
  editor: 3,
  co_owner: 4,
  owner: 5,
};

const RANK_TO_ROLE: Record<number, ResourceRole> = {
  1: 'previewer',
  2: 'viewer',
  3: 'editor',
  4: 'co_owner',
  5: 'owner',
};

/**
 * @deprecated Legacy 5-role rank decoder. Retained only for consumers that
 * still persist a linear rank; `resolveTargetAccess` now composes role sets.
 */
export function rankToResourceRole(rank: number | null | undefined): ResourceRole | null {
  if (!rank) return null;
  return RANK_TO_ROLE[rank] ?? null;
}

export interface TargetMetadata {
  exists: boolean;
  targetType: 'folder' | 'file';
  targetId: string;
  folderId: string | null;
  classification: ClassificationLabel;
  deletedAt: string | null;
  uploadState?: 'pending' | 'active' | 'failed';
  /** Non-linearly composed effective role (may be null when no grant applies). */
  effectiveRole: ResourceRole | null;
  /** Capability array matching `effectiveRole`, ready to return from APIs. */
  capabilities: Capability[];
  /** Raw granted roles that produced `effectiveRole` (user + group, direct + inherited). */
  grantedRoles: ResourceRole[];
}

/**
 * Legacy compatibility adapter for call sites that still compare a single role.
 *
 * Implemented as capability containment, never as a linear rank comparison, so
 * a role is "at least" another only when it can do everything the required role
 * can. In particular `hasAtLeastRole('viewer_uploader', 'editor')` and
 * `hasAtLeastRole('uploader', 'previewer')` are both `false`.
 *
 * New and migrated call sites should use `can(access.capabilities, ...)`.
 */
export function hasAtLeastRole(
  actual: ResourceRole | null | undefined,
  required: ResourceRole
): boolean {
  if (!actual || !isResourceRole(actual) || !isResourceRole(required)) return false;
  const actualCapabilities = ROLE_CAPABILITIES[actual];
  for (const capability of ROLE_CAPABILITIES[required]) {
    if (!actualCapabilities.has(capability)) return false;
  }
  return true;
}

export function getAuthenticatedUser(c: {
  get: (key: 'user') => AuthUser | null;
}): AuthUser {
  const user = c.get('user');
  if (!user) {
    throw new Error('Authenticated user missing from Hono context');
  }
  return user;
}

/** Restrict an endpoint to specific tenant admin roles (`sys_admin`, `sec_admin`). */
export function requireUserRoleMiddleware(allowedRoles: ReadonlyArray<UserRole>) {
  const allowed = new Set<UserRole>(allowedRoles);
  return createMiddleware<OidcHonoEnv>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    if (!allowed.has(user.role)) {
      return c.json(
        { error: 'Forbidden: insufficient administrative privilege' },
        403
      );
    }
    await next();
  });
}

export const requireSysAdmin = requireUserRoleMiddleware(['sys_admin']);
export const requireSecOrSysAdmin = requireUserRoleMiddleware(['sys_admin', 'sec_admin']);

/**
 * @deprecated Legacy 5-role SQL rank. All authorization queries now aggregate
 * `GROUP_CONCAT(DISTINCT p.role)` and compose roles in TypeScript via
 * `joinRoles` / `synthesizeEffectiveAccess`, because `MAX(rank)` loses the
 * non-linear `viewer + uploader` composition.
 */
export const ROLE_RANK_SQL = `CASE p.role
  WHEN 'owner' THEN 5
  WHEN 'co_owner' THEN 4
  WHEN 'editor' THEN 3
  WHEN 'viewer' THEN 2
  WHEN 'previewer' THEN 1
  ELSE 0
END`;

export const GRANTEE_MATCH_SQL = `(
  (p.grantee_type = 'user' AND p.grantee_id = ?)
  OR (
    p.grantee_type = 'group'
    AND EXISTS (
      SELECT 1 FROM group_members gm
       WHERE gm.group_id = p.grantee_id AND gm.user_id = ?
    )
  )
)`;

/** Roles that grant `item.preview`, used to keep file search/sync from leaking to uploaders. */
export const FILE_PREVIEW_ROLE_SQL = capabilityRoleSqlList('item.preview');

/**
 * Resolve effective RBAC access for a folder or file combining direct
 * permissions and ancestor folder permissions from `folder_closures` for the
 * user plus all their groups.
 *
 * All matching roles are collected (never `MAX(rank)`) and composed with the
 * non-linear `synthesizeEffectiveAccess` rule.
 */
export async function resolveTargetAccess(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId'>,
  targetType: 'folder' | 'file',
  targetId: string
): Promise<TargetMetadata | null> {
  if (targetType === 'folder') {
    const folder = await db
      .prepare(
        `SELECT f.id,
                f.classification,
                f.deleted_at,
                (
                  SELECT GROUP_CONCAT(DISTINCT p.role)
                    FROM permissions p
                   WHERE p.tenant_id = f.tenant_id
                     AND p.target_type = 'folder'
                     AND ${GRANTEE_MATCH_SQL}
                     AND p.target_id IN (
                       SELECT fc.ancestor_id
                         FROM folder_closures fc
                        WHERE fc.tenant_id = f.tenant_id
                          AND fc.descendant_id = f.id
                     )
                ) AS role_list
           FROM folders f
          WHERE f.tenant_id = ? AND f.id = ?`
      )
      .bind(user.id, user.id, user.tenantId, targetId)
      .first<{
        id: string;
        classification: ClassificationLabel;
        deleted_at: string | null;
        role_list: string | null;
      }>();

    if (!folder) return null;
    const grantedRoles = parseRoleList(folder.role_list);
    const access = synthesizeEffectiveAccess(grantedRoles);
    return {
      exists: true,
      targetType: 'folder',
      targetId: folder.id,
      folderId: folder.id,
      classification: folder.classification,
      deletedAt: folder.deleted_at,
      effectiveRole: access.effectiveRole,
      capabilities: access.capabilities,
      grantedRoles,
    };
  }

  const file = await db
    .prepare(
      `SELECT f.id,
              f.folder_id,
              f.classification,
              f.deleted_at,
              f.upload_state,
              (
                SELECT GROUP_CONCAT(DISTINCT p.role)
                  FROM permissions p
                 WHERE p.tenant_id = f.tenant_id
                   AND p.target_type = 'file'
                   AND p.target_id = f.id
                   AND ${GRANTEE_MATCH_SQL}
              ) AS direct_role_list,
              (
                SELECT GROUP_CONCAT(DISTINCT p.role)
                  FROM permissions p
                 WHERE p.tenant_id = f.tenant_id
                   AND p.target_type = 'folder'
                   AND f.folder_id IS NOT NULL
                   AND p.target_id IN (
                     SELECT fc.ancestor_id
                       FROM folder_closures fc
                      WHERE fc.tenant_id = f.tenant_id
                        AND fc.descendant_id = f.folder_id
                   )
                   AND ${GRANTEE_MATCH_SQL}
              ) AS inherited_role_list
         FROM files f
        WHERE f.tenant_id = ? AND f.id = ?`
    )
    .bind(user.id, user.id, user.id, user.id, user.tenantId, targetId)
    .first<{
      id: string;
      folder_id: string | null;
      classification: ClassificationLabel;
      deleted_at: string | null;
      upload_state: 'pending' | 'active' | 'failed';
      direct_role_list: string | null;
      inherited_role_list: string | null;
    }>();

  if (!file) return null;
  // Advanced roles are folder-only; a direct file grant must never widen access.
  const grantedRoles = [
    ...filterFileTargetRoles(parseRoleList(file.direct_role_list)),
    ...parseRoleList(file.inherited_role_list),
  ];
  const access = synthesizeEffectiveAccess(grantedRoles);
  return {
    exists: true,
    targetType: 'file',
    targetId: file.id,
    folderId: file.folder_id,
    classification: file.classification,
    deletedAt: file.deleted_at,
    uploadState: file.upload_state,
    effectiveRole: access.effectiveRole,
    capabilities: access.capabilities,
    grantedRoles: [...new Set(grantedRoles)],
  };
}

/**
 * Count total effective `owner` principal assignments (direct + inherited from ancestors)
 * on a target so the last remaining owner cannot be demoted or deleted.
 */
export async function countEffectiveOwners(
  db: D1Database,
  tenantId: string,
  targetType: 'folder' | 'file',
  targetId: string,
  folderIdForFile: string | null
): Promise<number> {
  if (targetType === 'folder') {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS cnt
           FROM permissions p
          WHERE p.tenant_id = ?
            AND p.target_type = 'folder'
            AND p.role = 'owner'
            AND p.target_id IN (
              SELECT fc.ancestor_id
                FROM folder_closures fc
               WHERE fc.tenant_id = ? AND fc.descendant_id = ?
            )`
      )
      .bind(tenantId, tenantId, targetId)
      .first<{ cnt: number }>();
    return row?.cnt ?? 0;
  }

  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
         FROM permissions p
        WHERE p.tenant_id = ?
          AND p.role = 'owner'
          AND (
            (p.target_type = 'file' AND p.target_id = ?)
            OR (
              p.target_type = 'folder'
              AND ? IS NOT NULL
              AND p.target_id IN (
                SELECT fc.ancestor_id
                  FROM folder_closures fc
                 WHERE fc.tenant_id = ? AND fc.descendant_id = ?
              )
            )
          )`
    )
    .bind(
      tenantId,
      targetId,
      folderIdForFile,
      tenantId,
      folderIdForFile ?? ''
    )
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/**
 * Resolve composed access across multiple candidate folders at once (used for
 * list/search/sync RBAC filtering and capability projection).
 */
export async function resolveUserAccessForFolders(
  db: D1Database,
  tenantId: string,
  userId: string,
  folderIds: readonly string[]
): Promise<Map<string, EffectiveAccess>> {
  const result = new Map<string, EffectiveAccess>();
  const uniqueIds = [...new Set(folderIds.filter(Boolean))];
  if (uniqueIds.length === 0) return result;

  // Bounded 30-item chunks keep SQLite host parameter counts well under 100
  for (let i = 0; i < uniqueIds.length; i += 30) {
    const chunk = uniqueIds.slice(i, i + 30);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT fc.descendant_id AS folder_id,
                GROUP_CONCAT(DISTINCT p.role) AS role_list
           FROM folder_closures fc
           JOIN permissions p
             ON p.tenant_id = fc.tenant_id
            AND p.target_type = 'folder'
            AND p.target_id = fc.ancestor_id
          WHERE fc.tenant_id = ?
            AND fc.descendant_id IN (${placeholders})
            AND ${GRANTEE_MATCH_SQL}
          GROUP BY fc.descendant_id`
      )
      .bind(tenantId, ...chunk, userId, userId)
      .all<{ folder_id: string; role_list: string | null }>();

    for (const row of rows.results) {
      const access = synthesizeEffectiveAccess(parseRoleList(row.role_list));
      if (access.effectiveRole) result.set(row.folder_id, access);
    }
  }
  return result;
}

/**
 * Backwards-compatible projection of `resolveUserAccessForFolders` that only
 * returns the composed role.
 *
 * @deprecated Prefer `resolveUserAccessForFolders` so callers can use
 * `capabilities` instead of comparing roles.
 */
export async function resolveUserRolesForFolders(
  db: D1Database,
  tenantId: string,
  userId: string,
  folderIds: readonly string[]
): Promise<Map<string, ResourceRole>> {
  const access = await resolveUserAccessForFolders(db, tenantId, userId, folderIds);
  const result = new Map<string, ResourceRole>();
  for (const [folderId, entry] of access) {
    if (entry.effectiveRole) result.set(folderId, entry.effectiveRole);
  }
  return result;
}

/** Convenience for endpoints that only have a `TargetMetadata` value. */
export function canAccess(access: TargetMetadata | null, capability: Capability): boolean {
  return can(access?.capabilities, capability);
}

/**
 * Tenant policy gate for the folder-only advanced roles
 * (`uploader`, `viewer_uploader`, `previewer_uploader`).
 *
 * Defaults to disabled (`0`) when the policy row is missing so an unseeded
 * tenant can never grant advanced roles implicitly.
 */
export async function areAdvancedRolesEnabled(
  db: D1Database,
  tenantId: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT advanced_roles_enabled FROM tenant_policies WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ advanced_roles_enabled: number | null }>();
  return row?.advanced_roles_enabled === 1;
}

/** Expose the canonical capability array for a role (legacy call sites). */
export function capabilitiesOfRole(role: ResourceRole | null | undefined): Capability[] {
  if (!role || !isResourceRole(role)) return [];
  return capabilitiesForRole(role);
}
