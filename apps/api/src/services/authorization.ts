import { createMiddleware } from 'hono/factory';
import type { AuthUser, ClassificationLabel, ResourceRole, UserRole } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';

export const RESOURCE_ROLE_RANK: Record<ResourceRole, number> = {
  previewer: 1,
  viewer: 2,
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
  effectiveRole: ResourceRole | null;
}

export function hasAtLeastRole(
  actual: ResourceRole | null | undefined,
  required: ResourceRole
): boolean {
  if (!actual) return false;
  return RESOURCE_ROLE_RANK[actual] >= RESOURCE_ROLE_RANK[required];
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

/**
 * Resolve effective RBAC role for a folder or file combining direct permissions
 * and ancestor folder permissions from `folder_closures` for user + user's groups.
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
                  SELECT MAX(${ROLE_RANK_SQL})
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
                ) AS max_rank
           FROM folders f
          WHERE f.tenant_id = ? AND f.id = ?`
      )
      .bind(user.id, user.id, user.tenantId, targetId)
      .first<{
        id: string;
        classification: ClassificationLabel;
        deleted_at: string | null;
        max_rank: number | null;
      }>();

    if (!folder) return null;
    return {
      exists: true,
      targetType: 'folder',
      targetId: folder.id,
      folderId: folder.id,
      classification: folder.classification,
      deletedAt: folder.deleted_at,
      effectiveRole: folder.max_rank ? RANK_TO_ROLE[folder.max_rank] ?? null : null,
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
                SELECT MAX(${ROLE_RANK_SQL})
                  FROM permissions p
                 WHERE p.tenant_id = f.tenant_id
                   AND ${GRANTEE_MATCH_SQL}
                   AND (
                     (p.target_type = 'file' AND p.target_id = f.id)
                     OR (
                       p.target_type = 'folder'
                       AND f.folder_id IS NOT NULL
                       AND p.target_id IN (
                         SELECT fc.ancestor_id
                           FROM folder_closures fc
                          WHERE fc.tenant_id = f.tenant_id
                            AND fc.descendant_id = f.folder_id
                       )
                     )
                   )
              ) AS max_rank
         FROM files f
        WHERE f.tenant_id = ? AND f.id = ?`
    )
    .bind(user.id, user.id, user.tenantId, targetId)
    .first<{
      id: string;
      folder_id: string | null;
      classification: ClassificationLabel;
      deleted_at: string | null;
      upload_state: 'pending' | 'active' | 'failed';
      max_rank: number | null;
    }>();

  if (!file) return null;
  return {
    exists: true,
    targetType: 'file',
    targetId: file.id,
    folderId: file.folder_id,
    classification: file.classification,
    deletedAt: file.deleted_at,
    uploadState: file.upload_state,
    effectiveRole: file.max_rank ? RANK_TO_ROLE[file.max_rank] ?? null : null,
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
 * Resolve highest role across multiple candidate folders at once (used for list/search RBAC filtering).
 */
export async function resolveUserRolesForFolders(
  db: D1Database,
  tenantId: string,
  userId: string,
  folderIds: readonly string[]
): Promise<Map<string, ResourceRole>> {
  const result = new Map<string, ResourceRole>();
  const uniqueIds = [...new Set(folderIds.filter(Boolean))];
  if (uniqueIds.length === 0) return result;

  // Bounded 30-item chunks keep SQLite host parameter counts well under 100
  for (let i = 0; i < uniqueIds.length; i += 30) {
    const chunk = uniqueIds.slice(i, i + 30);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT fc.descendant_id AS folder_id,
                MAX(${ROLE_RANK_SQL}) AS max_rank
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
      .all<{ folder_id: string; max_rank: number }>();

    for (const row of rows.results) {
      const role = RANK_TO_ROLE[row.max_rank];
      if (role) result.set(row.folder_id, role);
    }
  }
  return result;
}
