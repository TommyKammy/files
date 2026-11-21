import type {
  AdminCapability,
  AdminScope,
  AuthUser,
  UserRole,
} from '../../types/api';
import {
  ADMIN_CAPABILITIES,
  ADMIN_DELEGATION_PRESETS,
  SEC_ADMIN_ADMIN_CAPABILITIES,
  type AdminAuthorization,
  type AdminDelegationPreset,
  type AdminDelegationRow,
  type RawDelegationRow,
} from './types';

const CAPABILITY_SET = new Set<string>(ADMIN_CAPABILITIES);
const PRESET_NAMES = new Set<string>(Object.keys(ADMIN_DELEGATION_PRESETS));

export function isAdminCapability(value: unknown): value is AdminCapability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

export function isAdminDelegationPreset(
  value: unknown
): value is AdminDelegationPreset {
  return typeof value === 'string' && PRESET_NAMES.has(value);
}

export function expandAdminDelegationPreset(
  preset: AdminDelegationPreset
): AdminCapability[] {
  return [...ADMIN_DELEGATION_PRESETS[preset]];
}

/** Canonical de-duplicated order so API responses and audit rows are stable. */
export function normalizeAdminCapabilities(raw: unknown): AdminCapability[] {
  let values: unknown[];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      values = Array.isArray(parsed) ? parsed : [];
    } catch {
      values = [];
    }
  } else {
    values = [];
  }
  const seen = new Set<AdminCapability>();
  const normalized: AdminCapability[] = [];
  for (const value of values) {
    if (!isAdminCapability(value) || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function parseAdminDelegationPermissions(
  permissionsJson: string | null
): AdminCapability[] {
  return normalizeAdminCapabilities(permissionsJson ?? '[]');
}

export function adminAuthorizationForRole(
  role: UserRole,
  userType: AuthUser['userType']
): AdminAuthorization {
  if (userType === 'guest') {
    return { capabilities: [], scope: null };
  }
  if (role === 'sys_admin') {
    return { capabilities: [...ADMIN_CAPABILITIES], scope: null };
  }
  if (role === 'sec_admin') {
    return { capabilities: [...SEC_ADMIN_ADMIN_CAPABILITIES], scope: null };
  }
  return { capabilities: [], scope: null };
}

function projectScope(
  scopeGroupId: string | null,
  scopeRootFolderId: string | null
): AdminScope | null {
  if (!scopeGroupId && !scopeRootFolderId) return null;
  return {
    groupId: scopeGroupId,
    rootFolderId: scopeRootFolderId,
  };
}

/**
 * Resolve the effective admin authorization for a user without trusting any
 * client-supplied projection. Called by the session middleware on every
 * request, so delegation changes take effect immediately.
 */
export async function resolveAdminAuthorization(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId' | 'role' | 'userType'>
): Promise<AdminAuthorization> {
  if (user.userType === 'guest') {
    return { capabilities: [], scope: null };
  }
  if (user.role === 'sys_admin' || user.role === 'sec_admin') {
    return adminAuthorizationForRole(user.role, user.userType);
  }

  const row = await loadAdminDelegationRow(db, user.tenantId, user.id);
  if (!row) return { capabilities: [], scope: null };
  return {
    capabilities: parseAdminDelegationPermissions(row.permissions_json),
    scope: projectScope(row.scope_group_id, row.scope_root_folder_id),
  };
}

export function hasAdminCapability(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined,
  capability: AdminCapability
): boolean {
  if (!user || user.userType === 'guest') return false;
  if (user.role === 'sys_admin') return true;
  if (user.role === 'sec_admin') {
    return SEC_ADMIN_ADMIN_CAPABILITIES.includes(capability);
  }
  return (user.adminCapabilities ?? []).includes(capability);
}

export function hasAnyAdminCapability(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined
): boolean {
  if (!user || user.userType === 'guest') return false;
  if (user.role === 'sys_admin' || user.role === 'sec_admin') return true;
  return (user.adminCapabilities ?? []).length > 0;
}

export function isDelegatedAdmin(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined
): boolean {
  return (
    !!user &&
    user.userType !== 'guest' &&
    user.role === 'member' &&
    (user.adminCapabilities ?? []).length > 0
  );
}

export function getAdminScope(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminScope'> | null | undefined
): AdminScope | null {
  if (!user || user.userType === 'guest') return null;
  if (user.role === 'sys_admin' || user.role === 'sec_admin') return null;
  return user.adminScope ?? null;
}

export async function loadAdminDelegationRow(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<RawDelegationRow | null> {
  return db
    .prepare(
      `SELECT d.*,
              u.display_name AS user_name,
              u.email AS user_email,
              u.status AS user_status,
              g.name AS group_name,
              f.name AS root_folder_name,
              gu.display_name AS granted_by_name
         FROM admin_delegations d
         LEFT JOIN users u
           ON u.tenant_id = d.tenant_id AND u.id = d.user_id
         LEFT JOIN groups g
           ON g.tenant_id = d.tenant_id AND g.id = d.scope_group_id
         LEFT JOIN folders f
           ON f.tenant_id = d.tenant_id AND f.id = d.scope_root_folder_id
         LEFT JOIN users gu
           ON gu.tenant_id = d.tenant_id AND gu.id = d.granted_by
        WHERE d.tenant_id = ? AND d.user_id = ?
        LIMIT 1`
    )
    .bind(tenantId, userId)
    .first<RawDelegationRow>();
}

export function projectDelegation(row: RawDelegationRow): AdminDelegationRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    preset: row.preset,
    permissions: parseAdminDelegationPermissions(row.permissions_json),
    scopeGroupId: row.scope_group_id,
    scopeRootFolderId: row.scope_root_folder_id,
    note: row.note,
    grantedBy: row.granted_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userName: row.user_name,
    userEmail: row.user_email,
    userStatus: row.user_status,
    groupName: row.group_name,
    rootFolderName: row.root_folder_name,
    grantedByName: row.granted_by_name,
  };
}
