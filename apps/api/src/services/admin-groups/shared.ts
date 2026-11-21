import type { AuthUser, ResourceRole, UserRole } from '../../types/api';
import { buildAuditLogStmt } from '../audit';
import { buildSyncChangeStmt } from '../sync-changes';
import {
  AdminGroupError,
  type AdminGroupMemberStatus,
  type AdminGroupRow,
} from './types';

export interface RawGroupRow {
  id: string;
  name: string;
  external_idp_id: string | null;
  created_at: string;
  member_count: number;
  permission_count: number;
}

export interface RawGroupMemberRow {
  id: string;
  email: string;
  display_name: string;
  department: string | null;
  role: UserRole;
  status: AdminGroupMemberStatus;
  added_at: string;
}

export interface RawGroupPermissionRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  role: ResourceRole;
  granted_by: string | null;
  granted_by_name: string | null;
  created_at: string;
}

export const MAX_GROUP_NAME_LENGTH = 120;
export const MAX_GROUP_MEMBER_BATCH = 200;

export function normalizeGroupName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AdminGroupError(
      400,
      'INVALID_GROUP_NAME',
      'name must be a non-empty string'
    );
  }
  const name = raw.trim();
  if (!name) {
    throw new AdminGroupError(
      400,
      'INVALID_GROUP_NAME',
      'name must be a non-empty string'
    );
  }
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    throw new AdminGroupError(
      400,
      'INVALID_GROUP_NAME',
      `name must be at most ${MAX_GROUP_NAME_LENGTH} characters`
    );
  }
  return name;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function toGroupRow(row: RawGroupRow): AdminGroupRow {
  return {
    id: row.id,
    name: row.name,
    source: row.external_idp_id !== null ? 'scim' : 'manual',
    externalIdpId: row.external_idp_id,
    memberCount: row.member_count ?? 0,
    permissionCount: row.permission_count ?? 0,
    createdAt: row.created_at,
  };
}

export async function loadGroupRow(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<RawGroupRow | null> {
  return db
    .prepare(
      `SELECT g.id,
              g.name,
              g.external_idp_id,
              g.created_at,
              (
                SELECT COUNT(*)
                  FROM group_members gm
                 WHERE gm.group_id = g.id
              ) AS member_count,
              (
                SELECT COUNT(*)
                  FROM permissions p
                 WHERE p.tenant_id = g.tenant_id
                   AND p.grantee_type = 'group'
                   AND p.grantee_id = g.id
              ) AS permission_count
         FROM groups g
        WHERE g.tenant_id = ? AND g.id = ?`
    )
    .bind(tenantId, groupId)
    .first<RawGroupRow>();
}

export async function requireGroup(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<RawGroupRow> {
  const group = await loadGroupRow(db, tenantId, groupId);
  if (!group) {
    throw new AdminGroupError(404, 'GROUP_NOT_FOUND', 'Group not found');
  }
  return group;
}

export function assertManualGroup(
  group: Pick<RawGroupRow, 'external_idp_id'>
): void {
  if (group.external_idp_id !== null) {
    throw new AdminGroupError(
      409,
      'SCIM_MANAGED_GROUP',
      'SCIM-synchronized groups are read-only in the admin console'
    );
  }
}

export function buildGroupAuditAndSync(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  action: string;
  groupId: string;
  metadata: Record<string, unknown>;
  nowIso: string;
}): [D1PreparedStatement, D1PreparedStatement] {
  return [
    buildAuditLogStmt(input.db, {
      tenantId: input.tenantId,
      actorId: input.actor.id,
      actorEmail: input.actor.email,
      actorIp: input.actor.ipAddress,
      action: input.action,
      targetType: 'group',
      targetId: input.groupId,
      metadata: input.metadata,
      nowIso: input.nowIso,
    }),
    buildSyncChangeStmt(input.db, {
      tenantId: input.tenantId,
      // `sync_changes.entity_type` currently has a CHECK constraint without a
      // `group` value. Group membership is a permission-grantee concern, so the
      // event is recorded under `permission` with an explicit grantee payload;
      // this also lets group members receive the delta through the existing
      // permission delivery branch.
      entityType: 'permission',
      entityId: input.groupId,
      action: input.action,
      payload: {
        groupId: input.groupId,
        granteeType: 'group',
        granteeId: input.groupId,
        ...input.metadata,
      },
      nowIso: input.nowIso,
    }),
  ];
}

export async function assertGroupNameAvailable(
  db: D1Database,
  tenantId: string,
  name: string,
  excludeGroupId: string | null
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT id
         FROM groups
        WHERE tenant_id = ?
          AND lower(name) = lower(?)
          AND (? IS NULL OR id <> ?)
        LIMIT 1`
    )
    .bind(tenantId, name, excludeGroupId, excludeGroupId)
    .first<{ id: string }>();
  if (row) {
    throw new AdminGroupError(
      409,
      'GROUP_ALREADY_EXISTS',
      'A group with this name already exists in the tenant'
    );
  }
}
