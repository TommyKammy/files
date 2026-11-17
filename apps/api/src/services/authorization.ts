import { createMiddleware } from 'hono/factory';
import type { AuthUser, ClassificationLabel, ResourceRole, UserRole } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import {
  hasAdminCapability,
  hasAnyAdminCapability,
  type AdminCapability,
} from './admin-delegations';
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
  /**
   * How the caller reaches the target:
   * - `full`: at least one grant applies (direct or inherited).
   * - `path`: no grant on this folder itself, but an accessible descendant
   *   exists. Only `folder.traverse` is exposed so intermediate ancestors leak
   *   no sibling names, files, or delta metadata.
   * - `null`: no access at all.
   */
  accessMode: 'full' | 'path' | null;
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
 * Router gate for the governance console (P13-1 / TOM-73).
 *
 * `sys_admin` / `sec_admin` keep their legacy access. Internal `member`s pass
 * only when an active `admin_delegations` row resolved at least one fine
 * grained capability. Every endpoint still adds `requireAdminCapability(...)`
 * so a Co-Admin cannot reach a sibling capability surface.
 */
export const requireAdminConsoleAccess = createMiddleware<OidcHonoEnv>(
  async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    if (user.userType === 'guest') {
      return c.json(
        {
          error: 'Forbidden: guest accounts cannot access internal features',
          code: 'GUEST_FORBIDDEN',
        },
        403
      );
    }
    if (!hasAnyAdminCapability(user)) {
      return c.json(
        {
          error: 'Forbidden: administrative capability required',
          code: 'ADMIN_CAPABILITY_REQUIRED',
        },
        403
      );
    }
    await next();
  }
);

export function requireAdminCapability(capability: AdminCapability) {
  return createMiddleware<OidcHonoEnv>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    if (user.userType === 'guest') {
      return c.json(
        {
          error: 'Forbidden: guest accounts cannot access internal features',
          code: 'GUEST_FORBIDDEN',
        },
        403
      );
    }
    // sys_admin / sec_admin keep the pre-TOM-73 router behavior: capability
    // narrowing only applies to delegated members. The route handlers still
    // enforce every legacy sys_admin-only constraint for sec_admin.
    if (user.role === 'sys_admin' || user.role === 'sec_admin') {
      await next();
      return;
    }
    if (!hasAdminCapability(user, capability)) {
      // `admin.users.manage` is the gate in front of role changes, member
      // registration, offboarding, SCIM and other sys_admin-only operations.
      // Returning the escalation code keeps the Co-Admin contract explicit
      // even though the handler also rejects the request.
      const code =
        user.role === 'member' && capability === 'admin.users.manage'
          ? 'PRIVILEGE_ESCALATION_FORBIDDEN'
          : 'ADMIN_CAPABILITY_REQUIRED';
      return c.json(
        {
          error: `Forbidden: ${capability} capability required`,
          code,
          capability,
        },
        403
      );
    }
    await next();
  });
}

/**
 * Capability gate that only applies to the listed HTTP methods. Keeps
 * read/mutate pairs on the same Hono path (e.g. GET /policies vs PATCH
 * /policies) on their narrowest capability without duplicating routers.
 */
export function requireAdminCapabilityForMethods(
  capability: AdminCapability,
  methods: ReadonlyArray<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>
) {
  const allowedMethods = new Set(methods);
  const guard = requireAdminCapability(capability);
  return createMiddleware<OidcHonoEnv>(async (c, next) => {
    if (!allowedMethods.has(c.req.method as 'GET')) {
      await next();
      return;
    }
    return guard(c, next);
  });
}

/** Any of the given capabilities grants access; used by mixed-content tabs. */
export function requireAnyAdminCapability(
  capabilities: readonly AdminCapability[]
) {
  return createMiddleware<OidcHonoEnv>(async (c, next) => {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    if (user.userType === 'guest') {
      return c.json(
        {
          error: 'Forbidden: guest accounts cannot access internal features',
          code: 'GUEST_FORBIDDEN',
        },
        403
      );
    }
    if (user.role === 'sys_admin' || user.role === 'sec_admin') {
      await next();
      return;
    }
    if (!capabilities.some((capability) => hasAdminCapability(user, capability))) {
      return c.json(
        {
          error: 'Forbidden: administrative capability required',
          code: 'ADMIN_CAPABILITY_REQUIRED',
          capabilities,
        },
        403
      );
    }
    await next();
  });
}

/**
 * Block external guest accounts from internal/member-only surfaces
 * (`/api/admin/*`, `/api/audit-logs`, file-request management, ...).
 * Authentication must already have run.
 */
export const requireMemberUser = createMiddleware<OidcHonoEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  if (user.userType === 'guest') {
    return c.json(
      {
        error: 'Forbidden: guest accounts cannot access internal features',
        code: 'GUEST_FORBIDDEN',
      },
      403
    );
  }
  await next();
});

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
 * Drive shared-file reachability from the grantee side (`idx_permissions_grantee`
 * / `idx_group_members_user`) -> `files` PK -> `folder_closures` PK instead of
 * scanning all tenant `files` rows per candidate folder. Binds one user id.
 */
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
 * Shared predicate matching a strict descendant folder with any grant or an
 * active file inside `alias`'s subtree with an `item.preview` grant. Binds four
 * user ids (descendant folder user/group + user file + group file).
 */
function reachableDescendantSql(alias: string): string {
  return `EXISTS (
    SELECT 1
      FROM folder_closures fc
      JOIN folders d
        ON d.tenant_id = fc.tenant_id
       AND d.id = fc.descendant_id
       AND d.deleted_at IS NULL
     WHERE fc.tenant_id = ${alias}.tenant_id
       AND fc.ancestor_id = ${alias}.id
       AND fc.depth > 0
       AND EXISTS (
         SELECT 1 FROM permissions p
          WHERE p.tenant_id = fc.tenant_id
            AND p.target_type = 'folder'
            AND p.target_id = d.id
            AND ${GRANTEE_MATCH_SQL}
       )
  )
  OR ${reachableFileGrantSql(alias, 'user')}
  OR ${reachableFileGrantSql(alias, 'group')}`;
}

/**
 * SQL predicate for `accessMode: 'path'`: the folder aliased `alias` is itself
 * directly granted, or contains an accessible descendant folder / directly
 * shared active file. Binds six user ids (self, descendant folder, user/group file).
 */
export function reachablePathSql(alias: string): string {
  return `(
  EXISTS (
    SELECT 1 FROM permissions p
     WHERE p.tenant_id = ${alias}.tenant_id
       AND p.target_type = 'folder'
       AND p.target_id = ${alias}.id
       AND ${GRANTEE_MATCH_SQL}
  )
  OR ${reachableDescendantSql(alias)}
)`;
}

/**
 * True when the user can reach at least one item below `folderId`:
 * - a strict descendant folder carrying any direct/group folder grant, or
 * - an active file in the folder/subtree carrying a direct file grant with
 *   `item.preview` (directly shared files are reachable only through preview).
 *
 * Used to derive `accessMode: 'path'` for intermediate ancestors without
 * granting `folder.list`.
 */
async function folderHasReachableDescendant(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId'>,
  folderId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `WITH target(tenant_id, id) AS (VALUES (?, ?))
       SELECT 1 AS hit
         FROM target t
        WHERE ${reachableDescendantSql('t')}
        LIMIT 1`
    )
    .bind(user.tenantId, folderId, user.id, user.id, user.id, user.id)
    .first<{ hit: number }>();
  return Boolean(row);
}

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
    if (grantedRoles.length > 0) {
      return {
        exists: true,
        targetType: 'folder',
        targetId: folder.id,
        folderId: folder.id,
        classification: folder.classification,
        deletedAt: folder.deleted_at,
        accessMode: 'full',
        effectiveRole: access.effectiveRole,
        capabilities: access.capabilities,
        grantedRoles,
      };
    }

    // Path-only traversal: no grant on this folder, but an accessible folder or
    // directly shared active file exists below it. Expose `folder.traverse` only.
    const pathReachable =
      folder.deleted_at === null &&
      (await folderHasReachableDescendant(db, user, folder.id));
    return {
      exists: true,
      targetType: 'folder',
      targetId: folder.id,
      folderId: folder.id,
      classification: folder.classification,
      deletedAt: folder.deleted_at,
      accessMode: pathReachable ? 'path' : null,
      effectiveRole: null,
      capabilities: pathReachable ? ['folder.traverse'] : [],
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
    accessMode: access.effectiveRole ? 'full' : null,
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
