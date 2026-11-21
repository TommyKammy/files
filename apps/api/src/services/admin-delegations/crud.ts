import type { AdminCapability, AuthUser, UserRole } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import {
  expandAdminDelegationPreset,
  isAdminCapability,
  isAdminDelegationPreset,
  loadAdminDelegationRow,
  normalizeAdminCapabilities,
  parseAdminDelegationPermissions,
  projectDelegation,
} from './authorization';
import {
  ADMIN_CAPABILITIES,
  ADMIN_DELEGATION_CAPABILITY_LABELS,
  ADMIN_DELEGATION_PRESETS,
  AdminDelegationError,
  type AdminDelegationListResult,
  type AdminDelegationPreset,
  type AdminDelegationRow,
  type RawDelegationRow,
} from './types';

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
