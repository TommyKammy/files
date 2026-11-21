import type { AuthUser, UserRole } from '../../types/api';
import { AdminDelegationError } from './types';

/* ------------------------------------------------------------------ */
/* Scope checks and privilege-escalation guards                        */
/* ------------------------------------------------------------------ */

export async function isFolderInAdminScope(
  db: D1Database,
  tenantId: string,
  scopeRootFolderId: string | null,
  folderId: string | null
): Promise<boolean> {
  if (!scopeRootFolderId) return true;
  if (!folderId) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS hit
         FROM folder_closures
        WHERE tenant_id = ? AND ancestor_id = ? AND descendant_id = ?
        LIMIT 1`
    )
    .bind(tenantId, scopeRootFolderId, folderId)
    .first<{ hit: number }>();
  return Boolean(row);
}

export async function resolveAdminContentFolderId(
  db: D1Database,
  tenantId: string,
  targetType: 'file' | 'folder',
  targetId: string
): Promise<string | null> {
  if (targetType === 'folder') {
    const row = await db
      .prepare('SELECT id FROM folders WHERE tenant_id = ? AND id = ?')
      .bind(tenantId, targetId)
      .first<{ id: string }>();
    return row?.id ?? null;
  }
  const row = await db
    .prepare('SELECT folder_id FROM files WHERE tenant_id = ? AND id = ?')
    .bind(tenantId, targetId)
    .first<{ folder_id: string | null }>();
  return row?.folder_id ?? null;
}

export async function assertAdminFolderInScope(
  db: D1Database,
  tenantId: string,
  scopeRootFolderId: string | null,
  folderId: string | null
): Promise<void> {
  if (await isFolderInAdminScope(db, tenantId, scopeRootFolderId, folderId)) {
    return;
  }
  throw new AdminDelegationError(
    403,
    'OUT_OF_DELEGATION_SCOPE',
    'This item is outside the delegated root-folder scope'
  );
}

export async function assertAdminContentTargetInScope(
  db: D1Database,
  tenantId: string,
  scopeRootFolderId: string | null,
  targetType: 'file' | 'folder',
  targetId: string
): Promise<void> {
  const folderId = await resolveAdminContentFolderId(
    db,
    tenantId,
    targetType,
    targetId
  );
  if (folderId === null && targetType === 'file') {
    await assertAdminFolderInScope(db, tenantId, scopeRootFolderId, null);
    return;
  }
  await assertAdminFolderInScope(
    db,
    tenantId,
    scopeRootFolderId,
    targetType === 'folder' ? targetId : folderId
  );
}

export async function assertAdminSharedLinkTargetInScope(
  db: D1Database,
  tenantId: string,
  scopeRootFolderId: string | null,
  targetType: 'file' | 'folder',
  targetId: string
): Promise<void> {
  await assertAdminContentTargetInScope(
    db,
    tenantId,
    scopeRootFolderId,
    targetType,
    targetId
  );
}

export async function isUserInAdminScopeGroup(
  db: D1Database,
  tenantId: string,
  scopeGroupId: string | null,
  userId: string
): Promise<boolean> {
  if (!scopeGroupId) return true;
  const row = await db
    .prepare(
      `SELECT 1 AS hit
         FROM group_members gm
         JOIN groups g
           ON g.id = gm.group_id AND g.tenant_id = ?
        WHERE gm.group_id = ? AND gm.user_id = ?
        LIMIT 1`
    )
    .bind(tenantId, scopeGroupId, userId)
    .first<{ hit: number }>();
  return Boolean(row);
}

export async function assertAdminUserInScopeGroup(
  db: D1Database,
  tenantId: string,
  scopeGroupId: string | null,
  userId: string
): Promise<void> {
  if (await isUserInAdminScopeGroup(db, tenantId, scopeGroupId, userId)) {
    return;
  }
  throw new AdminDelegationError(
    403,
    'OUT_OF_DELEGATION_SCOPE',
    'This member is outside the delegated group scope'
  );
}

export async function assertAdminGroupInScope(
  scopeGroupId: string | null,
  groupId: string
): Promise<void> {
  if (!scopeGroupId || scopeGroupId === groupId) return;
  throw new AdminDelegationError(
    403,
    'OUT_OF_DELEGATION_SCOPE',
    'This group is outside the delegated group scope'
  );
}

/**
 * Verify a batch of Trash references before restore/purge. Folder references
 * use the closure table so the delegated root itself and every descendant are
 * accepted while siblings are rejected.
 */
export async function assertAdminTrashItemsInScope(
  db: D1Database,
  tenantId: string,
  scopeRootFolderId: string | null,
  items: ReadonlyArray<{ type: 'file' | 'folder'; id: string }>,
  targetFolderId: string | null = null
): Promise<void> {
  if (!scopeRootFolderId) return;

  if (targetFolderId) {
    await assertAdminFolderInScope(
      db,
      tenantId,
      scopeRootFolderId,
      targetFolderId
    );
  }

  const folderIds = items
    .filter((item) => item.type === 'folder')
    .map((item) => item.id);
  if (folderIds.length > 0) {
    const placeholders = folderIds.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id FROM folders
          WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(tenantId, ...folderIds)
      .all<{ id: string }>();
    const known = new Set(rows.results.map((row) => row.id));
    for (const folderId of folderIds) {
      if (!known.has(folderId)) {
        throw new AdminDelegationError(
          404,
          'TRASH_ITEM_NOT_FOUND',
          'Trash folder not found'
        );
      }
      await assertAdminFolderInScope(
        db,
        tenantId,
        scopeRootFolderId,
        folderId
      );
    }
  }

  const fileIds = items
    .filter((item) => item.type === 'file')
    .map((item) => item.id);
  if (fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, folder_id FROM files
          WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(tenantId, ...fileIds)
      .all<{ id: string; folder_id: string | null }>();
    const byId = new Map(rows.results.map((row) => [row.id, row.folder_id]));
    for (const fileId of fileIds) {
      if (!byId.has(fileId)) {
        throw new AdminDelegationError(
          404,
          'TRASH_ITEM_NOT_FOUND',
          'Trash file not found'
        );
      }
      await assertAdminFolderInScope(
        db,
        tenantId,
        scopeRootFolderId,
        byId.get(fileId) ?? null
      );
    }
  }
}

interface PrivilegeTargetRow {
  id: string;
  role: UserRole;
  user_type: 'member' | 'guest';
  status: 'active' | 'suspended';
}

/**
 * Co-Admins must never act on a privileged account, another Co-Admin, or
 * themselves. `sys_admin` / `sec_admin` keep their legacy guards; this helper
 * is a no-op for them.
 */
export async function assertDelegatedTargetUserAllowed(
  db: D1Database,
  tenantId: string,
  actor: Pick<AuthUser, 'id' | 'role' | 'userType' | 'adminScope'>,
  targetUserId: string
): Promise<PrivilegeTargetRow> {
  const target = await db
    .prepare(
      'SELECT id, role, user_type, status FROM users WHERE tenant_id = ? AND id = ?'
    )
    .bind(tenantId, targetUserId)
    .first<PrivilegeTargetRow>();
  if (!target) {
    throw new AdminDelegationError(
      404,
      'MEMBER_NOT_FOUND',
      'Internal member not found'
    );
  }

  if (actor.role !== 'member') return target;

  if (target.id === actor.id) {
    throw new AdminDelegationError(
      403,
      'PRIVILEGE_ESCALATION_FORBIDDEN',
      'Co-Admins cannot modify or revoke their own account or sessions'
    );
  }
  if (target.role !== 'member' || target.user_type !== 'member') {
    throw new AdminDelegationError(
      403,
      'PRIVILEGE_ESCALATION_FORBIDDEN',
      'Co-Admins cannot modify sys_admin, sec_admin, or guest accounts'
    );
  }

  const otherDelegation = await db
    .prepare(
      'SELECT 1 AS hit FROM admin_delegations WHERE tenant_id = ? AND user_id = ? LIMIT 1'
    )
    .bind(tenantId, targetUserId)
    .first<{ hit: number }>();
  if (otherDelegation) {
    throw new AdminDelegationError(
      403,
      'PRIVILEGE_ESCALATION_FORBIDDEN',
      'Co-Admins cannot modify another Co-Admin'
    );
  }

  await assertAdminUserInScopeGroup(
    db,
    tenantId,
    actor.adminScope?.groupId ?? null,
    targetUserId
  );
  return target;
}

/**
 * Route-level guard for the small set of mutations that must stay `sys_admin`
 * only even when a delegation was created with a custom capability list.
 */
export function assertDelegatedSysAdminOperation(
  actor: Pick<AuthUser, 'role' | 'userType'>
): void {
  if (actor.userType !== 'guest' && actor.role === 'sys_admin') return;
  throw new AdminDelegationError(
    403,
    'PRIVILEGE_ESCALATION_FORBIDDEN',
    'This operation is reserved for sys_admin and cannot be delegated'
  );
}
