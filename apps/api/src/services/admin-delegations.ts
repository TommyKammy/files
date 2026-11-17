import type {
  AdminCapability,
  AdminScope,
  AuthUser,
  UserRole,
} from '../types/api';
import { buildAuditLogStmt } from './audit';

export type { AdminCapability, AdminScope } from '../types/api';

/**
 * P13-1 / TOM-73 Co-Admin delegation and scoped capability resolution.
 *
 * A Co-Admin is an ordinary internal `member` that `sys_admin` explicitly
 * delegated a subset of admin capabilities to. Delegation never changes
 * `users.role`, so every legacy `sys_admin`-only handler keeps rejecting
 * Co-Admins even when a custom capability set contains a similarly named
 * capability. The resolution helpers below are also used by
 * `sessionAuthMiddleware`, `/api/auth/me` and `/api/sync/bootstrap` so the
 * client can render only permitted navigation and sections.
 */

export const ADMIN_CAPABILITIES = [
  'admin.insights.read',
  'admin.users.read',
  'admin.users.suspend',
  'admin.users.manage',
  'admin.guests.manage',
  'admin.groups.manage',
  'admin.content.unlock',
  'admin.root_folders.read',
  'admin.permissions.audit',
  'admin.trash.manage',
  'admin.links.revoke',
  'admin.reports.run',
  'admin.audit.read',
  'admin.policies.read',
  'admin.policies.edit',
] as const;

export const ADMIN_DELEGATION_PRESETS = {
  helpdesk: [
    'admin.users.read',
    'admin.users.suspend',
    'admin.content.unlock',
    'admin.trash.manage',
  ],
  auditor: [
    'admin.insights.read',
    'admin.audit.read',
    'admin.reports.run',
    'admin.policies.read',
  ],
  group_manager: ['admin.users.read', 'admin.groups.manage'],
  content_operator: [
    'admin.content.unlock',
    'admin.trash.manage',
    'admin.links.revoke',
  ],
} as const satisfies Record<string, readonly AdminCapability[]>;

export type AdminDelegationPreset = keyof typeof ADMIN_DELEGATION_PRESETS;

const CAPABILITY_SET = new Set<string>(ADMIN_CAPABILITIES);
const PRESET_NAMES = new Set<string>(Object.keys(ADMIN_DELEGATION_PRESETS));

/**
 * `sec_admin` keeps the security-operator surface it had before TOM-73.
 * `admin.users.manage`, `admin.groups.manage` and tenant destructive actions
 * remain absent; the route handlers still enforce the legacy sys_admin-only
 * checks (offboarding, revoke-all, SCIM, delegation management, ...).
 */
export const SEC_ADMIN_ADMIN_CAPABILITIES: readonly AdminCapability[] = [
  'admin.insights.read',
  'admin.users.read',
  'admin.users.suspend',
  'admin.guests.manage',
  'admin.content.unlock',
  'admin.root_folders.read',
  'admin.permissions.audit',
  'admin.trash.manage',
  'admin.links.revoke',
  'admin.reports.run',
  'admin.audit.read',
  'admin.policies.read',
  'admin.policies.edit',
];

export interface AdminAuthorization {
  capabilities: AdminCapability[];
  scope: AdminScope | null;
}

export interface AdminDelegationRow {
  id: string;
  tenantId: string;
  userId: string;
  preset: string | null;
  permissions: AdminCapability[];
  scopeGroupId: string | null;
  scopeRootFolderId: string | null;
  note: string | null;
  grantedBy: string;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  userEmail: string | null;
  userStatus: 'active' | 'suspended' | null;
  groupName: string | null;
  rootFolderName: string | null;
  grantedByName: string | null;
}

export interface AdminDelegationListResult {
  delegations: AdminDelegationRow[];
  presets: Array<{
    id: AdminDelegationPreset;
    capabilities: AdminCapability[];
  }>;
  capabilities: Array<{
    id: AdminCapability;
    label: string;
  }>;
}

export class AdminDelegationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminDelegationError';
  }
}

interface RawDelegationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  preset: string | null;
  permissions_json: string;
  scope_group_id: string | null;
  scope_root_folder_id: string | null;
  note: string | null;
  granted_by: string;
  created_at: string;
  updated_at: string;
  user_name: string | null;
  user_email: string | null;
  user_status: 'active' | 'suspended' | null;
  group_name: string | null;
  root_folder_name: string | null;
  granted_by_name: string | null;
}

export const ADMIN_DELEGATION_CAPABILITY_LABELS: Record<
  AdminCapability,
  string
> = {
  'admin.insights.read': 'インサイト閲覧',
  'admin.users.read': 'メンバー閲覧',
  'admin.users.suspend': 'メンバー停止/再開',
  'admin.users.manage': 'メンバー管理 (sys_admin 専用)',
  'admin.guests.manage': 'ゲスト管理',
  'admin.groups.manage': 'グループ管理',
  'admin.content.unlock': 'コンテンツ検査/強制解除',
  'admin.root_folders.read': 'ルートフォルダ閲覧',
  'admin.permissions.audit': '権限監査',
  'admin.trash.manage': 'ゴミ箱の復元',
  'admin.links.revoke': '共有リンク失効',
  'admin.reports.run': 'レポート実行',
  'admin.audit.read': '監査ログ閲覧',
  'admin.policies.read': 'ポリシー閲覧',
  'admin.policies.edit': 'ポリシー編集',
};

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

async function loadAdminDelegationRow(
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

function projectDelegation(row: RawDelegationRow): AdminDelegationRow {
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

export async function listAdminDelegations(
  db: D1Database,
  tenantId: string
): Promise<AdminDelegationListResult> {
  const rows = await db
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
        WHERE d.tenant_id = ?
        ORDER BY d.created_at DESC, d.id DESC`
    )
    .bind(tenantId)
    .all<RawDelegationRow>();

  return {
    delegations: rows.results.map(projectDelegation),
    presets: (Object.keys(ADMIN_DELEGATION_PRESETS) as AdminDelegationPreset[]).map(
      (id) => ({ id, capabilities: expandAdminDelegationPreset(id) })
    ),
    capabilities: ADMIN_CAPABILITIES.map((id) => ({
      id,
      label: ADMIN_DELEGATION_CAPABILITY_LABELS[id],
    })),
  };
}

interface DelegationTargetUserRow {
  id: string;
  role: UserRole;
  user_type: 'member' | 'guest';
  status: 'active' | 'suspended';
  email: string;
  display_name: string;
}

async function loadDelegationTargetUser(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<DelegationTargetUserRow | null> {
  return db
    .prepare(
      `SELECT id, role, user_type, status, email, display_name
         FROM users
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, userId)
    .first<DelegationTargetUserRow>();
}

async function assertDelegationTargetIsEligible(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<DelegationTargetUserRow> {
  const target = await loadDelegationTargetUser(db, tenantId, userId);
  if (!target) {
    throw new AdminDelegationError(
      404,
      'DELEGATION_USER_NOT_FOUND',
      'Delegation target user not found'
    );
  }
  if (target.user_type === 'guest') {
    throw new AdminDelegationError(
      400,
      'GUEST_DELEGATION_FORBIDDEN',
      'Guest accounts cannot receive admin capabilities'
    );
  }
  if (target.role !== 'member') {
    throw new AdminDelegationError(
      400,
      'DELEGATION_TARGET_NOT_MEMBER',
      'Only ordinary members can receive a Co-Admin delegation'
    );
  }
  return target;
}

async function assertDelegationGroupExists(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<void> {
  const row = await db
    .prepare('SELECT 1 AS hit FROM groups WHERE tenant_id = ? AND id = ?')
    .bind(tenantId, groupId)
    .first<{ hit: number }>();
  if (!row) {
    throw new AdminDelegationError(
      404,
      'DELEGATION_GROUP_NOT_FOUND',
      'Delegation scope group not found'
    );
  }
}

async function assertDelegationRootFolderExists(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT parent_id, deleted_at FROM folders
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, folderId)
    .first<{ parent_id: string | null; deleted_at: string | null }>();
  if (!row) {
    throw new AdminDelegationError(
      404,
      'DELEGATION_ROOT_FOLDER_NOT_FOUND',
      'Delegation scope root folder not found'
    );
  }
  if (row.parent_id !== null || row.deleted_at !== null) {
    throw new AdminDelegationError(
      400,
      'DELEGATION_ROOT_FOLDER_INVALID',
      'Delegation scope must be an active root folder'
    );
  }
}

function normalizeNote(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (raw === null) return null;
  if (typeof raw !== 'string') {
    throw new AdminDelegationError(400, 'INVALID_NOTE', 'note must be a string or null');
  }
  const note = raw.trim();
  if (note.length > 500) {
    throw new AdminDelegationError(
      400,
      'INVALID_NOTE',
      'note must be at most 500 characters'
    );
  }
  return note.length > 0 ? note : null;
}

function resolveRequestedCapabilities(input: {
  preset: unknown;
  permissions: unknown;
  fallback?: AdminCapability[];
}): { preset: AdminDelegationPreset | null; permissions: AdminCapability[] } {
  const preset = input.preset;
  if (preset !== undefined && preset !== null && !isAdminDelegationPreset(preset)) {
    throw new AdminDelegationError(
      400,
      'INVALID_DELEGATION_PRESET',
      'preset must be helpdesk, auditor, group_manager, content_operator or null'
    );
  }

  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions)) {
      throw new AdminDelegationError(
        400,
        'INVALID_DELEGATION_PERMISSIONS',
        'permissions must be an array of admin capabilities'
      );
    }
    for (const value of input.permissions) {
      if (!isAdminCapability(value)) {
        throw new AdminDelegationError(
          400,
          'INVALID_ADMIN_CAPABILITY',
          `Unknown admin capability: ${String(value)}`
        );
      }
    }
    return {
      preset: (preset as AdminDelegationPreset | null | undefined) ?? null,
      permissions: normalizeAdminCapabilities(input.permissions),
    };
  }

  if (preset) {
    return {
      preset: preset as AdminDelegationPreset,
      permissions: expandAdminDelegationPreset(preset as AdminDelegationPreset),
    };
  }
  if (input.fallback) {
    return { preset: null, permissions: input.fallback };
  }
  throw new AdminDelegationError(
    400,
    'INVALID_DELEGATION_PERMISSIONS',
    'preset or permissions is required'
  );
}

export interface CreateAdminDelegationInput {
  db: D1Database;
  tenantId: string;
  actor: Pick<AuthUser, 'id' | 'email' | 'ipAddress'>;
  userId: unknown;
  preset?: unknown;
  permissions?: unknown;
  scopeGroupId?: unknown;
  scopeRootFolderId?: unknown;
  note?: unknown;
  nowIso?: string;
}

export async function createAdminDelegation(
  input: CreateAdminDelegationInput
): Promise<AdminDelegationRow> {
  if (typeof input.userId !== 'string' || !input.userId.trim()) {
    throw new AdminDelegationError(
      400,
      'INVALID_DELEGATION_USER',
      'userId is required'
    );
  }
  const userId = input.userId.trim();
  await assertDelegationTargetIsEligible(input.db, input.tenantId, userId);

  const existing = await loadAdminDelegationRow(
    input.db,
    input.tenantId,
    userId
  );
  if (existing) {
    throw new AdminDelegationError(
      409,
      'DELEGATION_EXISTS',
      'This member already has an active Co-Admin delegation'
    );
  }

  const resolved = resolveRequestedCapabilities({
    preset: input.preset,
    permissions: input.permissions,
  });
  if (resolved.permissions.length === 0) {
    throw new AdminDelegationError(
      400,
      'EMPTY_DELEGATION',
      'A delegation must contain at least one capability'
    );
  }

  const scopeGroupId =
    typeof input.scopeGroupId === 'string' && input.scopeGroupId.trim()
      ? input.scopeGroupId.trim()
      : null;
  const scopeRootFolderId =
    typeof input.scopeRootFolderId === 'string' && input.scopeRootFolderId.trim()
      ? input.scopeRootFolderId.trim()
      : null;
  if (input.scopeGroupId !== undefined && input.scopeGroupId !== null && typeof input.scopeGroupId !== 'string') {
    throw new AdminDelegationError(
      400,
      'INVALID_DELEGATION_SCOPE',
      'scopeGroupId must be a string or null'
    );
  }
  if (
    input.scopeRootFolderId !== undefined &&
    input.scopeRootFolderId !== null &&
    typeof input.scopeRootFolderId !== 'string'
  ) {
    throw new AdminDelegationError(
      400,
      'INVALID_DELEGATION_SCOPE',
      'scopeRootFolderId must be a string or null'
    );
  }
  if (scopeGroupId) {
    await assertDelegationGroupExists(input.db, input.tenantId, scopeGroupId);
  }
  if (scopeRootFolderId) {
    await assertDelegationRootFolderExists(
      input.db,
      input.tenantId,
      scopeRootFolderId
    );
  }

  const nowIso = input.nowIso ?? new Date().toISOString();
  const id = crypto.randomUUID();
  await input.db.batch([
    input.db
      .prepare(
        `INSERT INTO admin_delegations (
           id, tenant_id, user_id, preset, permissions_json,
           scope_group_id, scope_root_folder_id, note, granted_by,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.tenantId,
        userId,
        resolved.preset,
        JSON.stringify(resolved.permissions),
        scopeGroupId,
        scopeRootFolderId,
        normalizeNote(input.note),
        input.actor.id,
        nowIso,
        nowIso
      ),
    buildAuditLogStmt(input.db, {
      tenantId: input.tenantId,
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      actorIp: input.actor.ipAddress,
      action: 'admin.delegation.created',
      targetType: 'admin_delegation',
      targetId: id,
      metadata: {
        userId,
        preset: resolved.preset,
        permissions: resolved.permissions,
        scopeGroupId,
        scopeRootFolderId,
      },
      nowIso,
    }),
  ]);

  const created = await loadAdminDelegationRow(input.db, input.tenantId, userId);
  if (!created) {
    throw new AdminDelegationError(
      409,
      'DELEGATION_CREATE_FAILED',
      'Delegation was not persisted'
    );
  }
  return projectDelegation(created);
}

export interface UpdateAdminDelegationInput {
  db: D1Database;
  tenantId: string;
  actor: Pick<AuthUser, 'id' | 'email' | 'ipAddress'>;
  delegationId: string;
  preset?: unknown;
  permissions?: unknown;
  scopeGroupId?: unknown;
  scopeRootFolderId?: unknown;
  note?: unknown;
  nowIso?: string;
}

export async function updateAdminDelegation(
  input: UpdateAdminDelegationInput
): Promise<AdminDelegationRow> {
  const existing = await input.db
    .prepare(
      'SELECT * FROM admin_delegations WHERE tenant_id = ? AND id = ?'
    )
    .bind(input.tenantId, input.delegationId)
    .first<RawDelegationRow>();
  if (!existing) {
    throw new AdminDelegationError(
      404,
      'DELEGATION_NOT_FOUND',
      'Delegation not found'
    );
  }

  const presetProvided =
    input.preset !== undefined || input.permissions !== undefined;
  const resolved = presetProvided
    ? resolveRequestedCapabilities({
        preset: input.preset,
        permissions: input.permissions,
        fallback: parseAdminDelegationPermissions(existing.permissions_json),
      })
    : {
        preset: isAdminDelegationPreset(existing.preset)
          ? existing.preset
          : null,
        permissions: parseAdminDelegationPermissions(existing.permissions_json),
      };
  if (resolved.permissions.length === 0) {
    throw new AdminDelegationError(
      400,
      'EMPTY_DELEGATION',
      'A delegation must contain at least one capability'
    );
  }

  let scopeGroupId = existing.scope_group_id;
  if (input.scopeGroupId !== undefined) {
    if (input.scopeGroupId !== null && typeof input.scopeGroupId !== 'string') {
      throw new AdminDelegationError(
        400,
        'INVALID_DELEGATION_SCOPE',
        'scopeGroupId must be a string or null'
      );
    }
    scopeGroupId =
      typeof input.scopeGroupId === 'string' && input.scopeGroupId.trim()
        ? input.scopeGroupId.trim()
        : null;
    if (scopeGroupId) {
      await assertDelegationGroupExists(input.db, input.tenantId, scopeGroupId);
    }
  }

  let scopeRootFolderId = existing.scope_root_folder_id;
  if (input.scopeRootFolderId !== undefined) {
    if (
      input.scopeRootFolderId !== null &&
      typeof input.scopeRootFolderId !== 'string'
    ) {
      throw new AdminDelegationError(
        400,
        'INVALID_DELEGATION_SCOPE',
        'scopeRootFolderId must be a string or null'
      );
    }
    scopeRootFolderId =
      typeof input.scopeRootFolderId === 'string' &&
      input.scopeRootFolderId.trim()
        ? input.scopeRootFolderId.trim()
        : null;
    if (scopeRootFolderId) {
      await assertDelegationRootFolderExists(
        input.db,
        input.tenantId,
        scopeRootFolderId
      );
    }
  }

  const note =
    input.note !== undefined ? normalizeNote(input.note) : existing.note;
  const nowIso = input.nowIso ?? new Date().toISOString();

  await input.db.batch([
    input.db
      .prepare(
        `UPDATE admin_delegations
            SET preset = ?,
                permissions_json = ?,
                scope_group_id = ?,
                scope_root_folder_id = ?,
                note = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .bind(
        resolved.preset,
        JSON.stringify(resolved.permissions),
        scopeGroupId,
        scopeRootFolderId,
        note,
        nowIso,
        input.tenantId,
        input.delegationId
      ),
    buildAuditLogStmt(input.db, {
      tenantId: input.tenantId,
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      actorIp: input.actor.ipAddress,
      action: 'admin.delegation.updated',
      targetType: 'admin_delegation',
      targetId: input.delegationId,
      metadata: {
        userId: existing.user_id,
        preset: resolved.preset,
        permissions: resolved.permissions,
        scopeGroupId,
        scopeRootFolderId,
      },
      nowIso,
    }),
  ]);

  const updated = await input.db
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
        WHERE d.tenant_id = ? AND d.id = ?
        LIMIT 1`
    )
    .bind(input.tenantId, input.delegationId)
    .first<RawDelegationRow>();
  if (!updated) {
    throw new AdminDelegationError(
      404,
      'DELEGATION_NOT_FOUND',
      'Delegation not found'
    );
  }
  return projectDelegation(updated);
}

export async function deleteAdminDelegation(input: {
  db: D1Database;
  tenantId: string;
  actor: Pick<AuthUser, 'id' | 'email' | 'ipAddress'>;
  delegationId: string;
  nowIso?: string;
}): Promise<{ delegation: AdminDelegationRow }> {
  const existing = await input.db
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
        WHERE d.tenant_id = ? AND d.id = ?
        LIMIT 1`
    )
    .bind(input.tenantId, input.delegationId)
    .first<RawDelegationRow>();
  if (!existing) {
    throw new AdminDelegationError(
      404,
      'DELEGATION_NOT_FOUND',
      'Delegation not found'
    );
  }

  const nowIso = input.nowIso ?? new Date().toISOString();
  await input.db.batch([
    input.db
      .prepare(
        'DELETE FROM admin_delegations WHERE tenant_id = ? AND id = ?'
      )
      .bind(input.tenantId, input.delegationId),
    buildAuditLogStmt(input.db, {
      tenantId: input.tenantId,
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      actorIp: input.actor.ipAddress,
      action: 'admin.delegation.deleted',
      targetType: 'admin_delegation',
      targetId: input.delegationId,
      metadata: {
        userId: existing.user_id,
        preset: existing.preset,
        permissions: parseAdminDelegationPermissions(
          existing.permissions_json
        ),
        scopeGroupId: existing.scope_group_id,
        scopeRootFolderId: existing.scope_root_folder_id,
      },
      nowIso,
    }),
  ]);
  return { delegation: projectDelegation(existing) };
}

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

/** Build the JSON envelope every Co-Admin error response uses. */
export function adminDelegationErrorBody(err: AdminDelegationError): {
  error: string;
  code: string;
} {
  return { error: err.message, code: err.code };
}

/** Normalize a header/body-supplied scope value. */
export function normalizeDelegationScopeValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
