import type { AuthUser, ResourceRole, UserRole } from '../types/api';
import { chunkArray } from '../utils/batch';
import { buildAuditLogStmt } from './audit';
import { countEffectiveOwners } from './authorization';
import { executeStatementChunks } from './d1-batch';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';

/**
 * P11-3 / TOM-69 tenant-admin group management.
 *
 * Groups are either SCIM-provisioned (`external_idp_id IS NOT NULL`) or created
 * manually from the admin console. SCIM-managed groups are read-only here so a
 * local rename/delete/member edit cannot silently diverge from the IdP until
 * the next SCIM reconcile. Every manual mutation writes both an
 * `admin.group.*` audit row and a tenant sync change event.
 */

export type AdminGroupSource = 'scim' | 'manual';
export type AdminGroupSourceFilter = 'all' | AdminGroupSource;
export type AdminGroupMemberStatus = 'active' | 'suspended';

export interface AdminGroupFilters {
  query: string | null;
  source: AdminGroupSourceFilter;
  limit: number;
  offset: number;
  /** TOM-73 Co-Admin group scope; restricts the list to this group. */
  scopeGroupId?: string | null;
}

export interface AdminGroupRow {
  id: string;
  name: string;
  source: AdminGroupSource;
  externalIdpId: string | null;
  memberCount: number;
  permissionCount: number;
  createdAt: string;
}

export interface AdminGroupSummary {
  total: number;
  manualCount: number;
  scimCount: number;
}

export interface AdminGroupListResult {
  groups: AdminGroupRow[];
  total: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  summary: AdminGroupSummary;
  aggregations: AdminGroupSummary;
}

export interface AdminGroupMember {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  role: UserRole;
  status: AdminGroupMemberStatus;
  addedAt: string;
}

export interface AdminGroupPermission {
  id: string;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string;
  targetPath: string;
  role: ResourceRole;
  grantedBy: string | null;
  grantedByName: string | null;
  createdAt: string;
}

export interface AdminGroupDetailResult {
  group: AdminGroupRow;
  members: AdminGroupMember[];
  permissions: AdminGroupPermission[];
  scimManaged: boolean;
}

export interface AdminGroupMutationResult {
  ok: true;
  group?: AdminGroupRow;
  groupId: string;
  deletedPermissions?: number;
  deletedMembers?: number;
  addedUserIds?: string[];
  addedCount?: number;
  alreadyMemberUserIds?: string[];
  memberCount?: number;
  syncSeq: number | null;
  notice: string;
}

export class AdminGroupError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminGroupError';
  }
}

interface RawGroupRow {
  id: string;
  name: string;
  external_idp_id: string | null;
  created_at: string;
  member_count: number;
  permission_count: number;
}

interface RawGroupMemberRow {
  id: string;
  email: string;
  display_name: string;
  department: string | null;
  role: UserRole;
  status: AdminGroupMemberStatus;
  added_at: string;
}

interface RawGroupPermissionRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  role: ResourceRole;
  granted_by: string | null;
  granted_by_name: string | null;
  created_at: string;
}

const MAX_GROUP_NAME_LENGTH = 120;
const MAX_GROUP_MEMBER_BATCH = 200;

export function isAdminGroupSourceFilter(
  value: string
): value is AdminGroupSourceFilter {
  return value === 'all' || value === 'scim' || value === 'manual';
}

function normalizeGroupName(raw: unknown): string {
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

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toGroupRow(row: RawGroupRow): AdminGroupRow {
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

async function loadGroupSummary(
  db: D1Database,
  tenantId: string,
  scopeGroupId?: string | null
): Promise<AdminGroupSummary> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN external_idp_id IS NULL THEN 1 ELSE 0 END) AS manual_count,
              SUM(CASE WHEN external_idp_id IS NOT NULL THEN 1 ELSE 0 END) AS scim_count
         FROM groups
        WHERE tenant_id = ?${scopeGroupId ? ' AND id = ?' : ''}`
    )
    .bind(...(scopeGroupId ? [tenantId, scopeGroupId] : [tenantId]))
    .first<{ total: number; manual_count: number | null; scim_count: number | null }>();
  return {
    total: row?.total ?? 0,
    manualCount: row?.manual_count ?? 0,
    scimCount: row?.scim_count ?? 0,
  };
}

export async function listAdminGroups(
  db: D1Database,
  tenantId: string,
  filters: AdminGroupFilters
): Promise<AdminGroupListResult> {
  const conditions = ['g.tenant_id = ?'];
  const bindings: Array<string | number> = [tenantId];

  if (filters.query) {
    const pattern = `%${escapeLike(filters.query.toLowerCase())}%`;
    conditions.push(
      `(lower(g.name) LIKE ? ESCAPE '\\'
        OR lower(g.id) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(g.external_idp_id, '')) LIKE ? ESCAPE '\\')`
    );
    bindings.push(pattern, pattern, pattern);
  }
  if (filters.source === 'scim') {
    conditions.push('g.external_idp_id IS NOT NULL');
  } else if (filters.source === 'manual') {
    conditions.push('g.external_idp_id IS NULL');
  }
  if (filters.scopeGroupId) {
    conditions.push('g.id = ?');
    bindings.push(filters.scopeGroupId);
  }

  const whereSql = conditions.join(' AND ');
  const [countRow, summary, rows] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM groups g WHERE ${whereSql}`)
      .bind(...bindings)
      .first<{ total: number }>(),
    loadGroupSummary(db, tenantId, filters.scopeGroupId ?? null),
    db
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
          WHERE ${whereSql}
          ORDER BY lower(g.name) ASC, g.id ASC
          LIMIT ? OFFSET ?`
      )
      .bind(...bindings, filters.limit, filters.offset)
      .all<RawGroupRow>(),
  ]);

  const total = countRow?.total ?? 0;
  const nextOffset =
    filters.offset + rows.results.length < total
      ? filters.offset + rows.results.length
      : null;

  return {
    groups: rows.results.map(toGroupRow),
    total,
    limit: filters.limit,
    offset: filters.offset,
    nextOffset,
    summary,
    aggregations: summary,
  };
}

async function loadGroupRow(
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

async function requireGroup(
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

function assertManualGroup(group: Pick<RawGroupRow, 'external_idp_id'>): void {
  if (group.external_idp_id !== null) {
    throw new AdminGroupError(
      409,
      'SCIM_MANAGED_GROUP',
      'SCIM-synchronized groups are read-only in the admin console'
    );
  }
}

function buildGroupAuditAndSync(input: {
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

async function loadGroupPermissions(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<AdminGroupPermission[]> {
  const rows = await db
    .prepare(
      `SELECT p.id,
              p.target_type,
              p.target_id,
              p.role,
              p.granted_by,
              u.display_name AS granted_by_name,
              p.created_at
         FROM permissions p
         LEFT JOIN users u ON u.id = p.granted_by
        WHERE p.tenant_id = ?
          AND p.grantee_type = 'group'
          AND p.grantee_id = ?
        ORDER BY p.target_type ASC, p.created_at ASC, p.id ASC`
    )
    .bind(tenantId, groupId)
    .all<RawGroupPermissionRow>();

  const folderIds = new Set<string>();
  const fileIds = new Set<string>();
  for (const row of rows.results) {
    if (row.target_type === 'folder') folderIds.add(row.target_id);
    else fileIds.add(row.target_id);
  }

  const fileRows: Array<{
    id: string;
    name: string;
    folder_id: string | null;
    deleted_at: string | null;
  }> = [];
  for (const chunk of chunkArray([...fileIds])) {
    const rows = await db
      .prepare(
        `SELECT id, name, folder_id, deleted_at
           FROM files
          WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`
      )
      .bind(tenantId, ...chunk)
      .all<{
        id: string;
        name: string;
        folder_id: string | null;
        deleted_at: string | null;
      }>();
    fileRows.push(...rows.results);
  }

  const files = new Map(fileRows.map((row) => [row.id, row]));
  for (const row of fileRows) {
    if (row.folder_id) folderIds.add(row.folder_id);
  }

  const folderRows: Array<{
    id: string;
    name: string;
    deleted_at: string | null;
  }> = [];
  for (const chunk of chunkArray([...folderIds])) {
    const rows = await db
      .prepare(
        `SELECT id, name, deleted_at
           FROM folders
          WHERE tenant_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`
      )
      .bind(tenantId, ...chunk)
      .all<{ id: string; name: string; deleted_at: string | null }>();
    folderRows.push(...rows.results);
  }

  const folders = new Map(folderRows.map((row) => [row.id, row]));

  const closureRows: Array<{ folder_id: string; depth: number; name: string }> =
    [];
  for (const chunk of chunkArray([...folderIds])) {
    const rows = await db
      .prepare(
        `SELECT fc.descendant_id AS folder_id, fc.depth, f.name
           FROM folder_closures fc
           JOIN folders f
             ON f.id = fc.ancestor_id
            AND f.tenant_id = fc.tenant_id
          WHERE fc.tenant_id = ?
            AND fc.descendant_id IN (${chunk.map(() => '?').join(', ')})
          ORDER BY fc.descendant_id ASC, fc.depth DESC`
      )
      .bind(tenantId, ...chunk)
      .all<{ folder_id: string; depth: number; name: string }>();
    closureRows.push(...rows.results);
  }

  const pathParts = new Map<string, string[]>();
  for (const row of closureRows) {
    const parts = pathParts.get(row.folder_id) ?? [];
    parts.push(row.name);
    pathParts.set(row.folder_id, parts);
  }

  const folderPath = (folderId: string | null): string => {
    if (!folderId) return 'ルート';
    const parts = pathParts.get(folderId);
    if (parts && parts.length > 0) return parts.join(' / ');
    return folders.get(folderId)?.name ?? '不明なフォルダ';
  };

  return rows.results.map((row) => {
    if (row.target_type === 'file') {
      const file = files.get(row.target_id);
      const deletedSuffix = file?.deleted_at ? '（削除済み）' : '';
      return {
        id: row.id,
        targetType: row.target_type,
        targetId: row.target_id,
        targetName: `${file?.name ?? row.target_id}${deletedSuffix}`,
        targetPath: folderPath(file?.folder_id ?? null),
        role: row.role,
        grantedBy: row.granted_by,
        grantedByName: row.granted_by_name,
        createdAt: row.created_at,
      };
    }
    const folder = folders.get(row.target_id);
    const deletedSuffix = folder?.deleted_at ? '（削除済み）' : '';
    return {
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      targetName: `${folder?.name ?? row.target_id}${deletedSuffix}`,
      targetPath: `${folderPath(row.target_id)}${deletedSuffix}`,
      role: row.role,
      grantedBy: row.granted_by,
      grantedByName: row.granted_by_name,
      createdAt: row.created_at,
    };
  });
}

export async function loadAdminGroupDetail(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<AdminGroupDetailResult | null> {
  const group = await loadGroupRow(db, tenantId, groupId);
  if (!group) return null;

  const [memberRows, permissions] = await Promise.all([
    db
      .prepare(
        `SELECT u.id,
                u.email,
                u.display_name,
                u.department,
                u.role,
                u.status,
                gm.created_at AS added_at
           FROM group_members gm
           JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = ? AND u.tenant_id = ?
          ORDER BY lower(u.email) ASC, u.id ASC`
      )
      .bind(groupId, tenantId)
      .all<RawGroupMemberRow>(),
    loadGroupPermissions(db, tenantId, groupId),
  ]);

  return {
    group: toGroupRow(group),
    members: memberRows.results.map((member) => ({
      id: member.id,
      email: member.email,
      displayName: member.display_name,
      department: member.department,
      role: member.role,
      status: member.status,
      addedAt: member.added_at,
    })),
    permissions,
    scimManaged: group.external_idp_id !== null,
  };
}

async function assertGroupNameAvailable(
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

export async function createAdminGroup(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  name: unknown;
}): Promise<AdminGroupMutationResult> {
  const { db, tenantId, actor } = input;
  const name = normalizeGroupName(input.name);
  await assertGroupNameAvailable(db, tenantId, name, null);

  const groupId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  let results: D1Result[];
  try {
    results = await db.batch([
      db
        .prepare(
          `INSERT INTO groups (id, tenant_id, external_idp_id, name, created_at)
           VALUES (?, ?, NULL, ?, ?)`
        )
        .bind(groupId, tenantId, name, nowIso),
      ...buildGroupAuditAndSync({
        db,
        tenantId,
        actor,
        action: 'admin.group.create',
        groupId,
        metadata: { groupId, name, source: 'manual' },
        nowIso,
      }),
    ]);
  } catch (err) {
    if (((err as Error).message ?? '').includes('UNIQUE constraint failed')) {
      throw new AdminGroupError(
        409,
        'GROUP_ALREADY_EXISTS',
        'A group with this name already exists in the tenant'
      );
    }
    throw err;
  }

  const group = await requireGroup(db, tenantId, groupId);
  return {
    ok: true,
    group: toGroupRow(group),
    groupId,
    syncSeq: extractLastSyncSeq(results),
    notice: `グループ「${name}」を作成しました。`,
  };
}

export async function renameAdminGroup(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  groupId: string;
  name: unknown;
}): Promise<AdminGroupMutationResult> {
  const { db, tenantId, actor, groupId } = input;
  const existing = await requireGroup(db, tenantId, groupId);
  assertManualGroup(existing);
  const name = normalizeGroupName(input.name);
  await assertGroupNameAvailable(db, tenantId, name, groupId);

  const nowIso = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE groups
            SET name = ?
          WHERE tenant_id = ? AND id = ? AND external_idp_id IS NULL`
      )
      .bind(name, tenantId, groupId),
    ...buildGroupAuditAndSync({
      db,
      tenantId,
      actor,
      action: 'admin.group.update',
      groupId,
      metadata: { groupId, previousName: existing.name, name },
      nowIso,
    }),
  ]);

  const group = await requireGroup(db, tenantId, groupId);
  return {
    ok: true,
    group: toGroupRow(group),
    groupId,
    syncSeq: extractLastSyncSeq(results),
    notice: `グループ名を「${name}」に変更しました。`,
  };
}

async function assertLastOwnerPreserved(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<void> {
  const ownerFolders = await db
    .prepare(
      `SELECT DISTINCT p.target_id
         FROM permissions p
         JOIN folders f
           ON f.id = p.target_id
          AND f.tenant_id = p.tenant_id
        WHERE p.tenant_id = ?
          AND p.grantee_type = 'group'
          AND p.grantee_id = ?
          AND p.target_type = 'folder'
          AND p.role = 'owner'
          AND f.deleted_at IS NULL`
    )
    .bind(tenantId, groupId)
    .all<{ target_id: string }>();

  for (const { target_id: folderId } of ownerFolders.results) {
    const effectiveOwners = await countEffectiveOwners(
      db,
      tenantId,
      'folder',
      folderId,
      null
    );
    const groupOwnerRows = await db
      .prepare(
        `SELECT COUNT(*) AS cnt
           FROM permissions p
          WHERE p.tenant_id = ?
            AND p.grantee_type = 'group'
            AND p.grantee_id = ?
            AND p.target_type = 'folder'
            AND p.role = 'owner'
            AND p.target_id IN (
              SELECT fc.ancestor_id
                FROM folder_closures fc
               WHERE fc.tenant_id = ? AND fc.descendant_id = ?
            )`
      )
      .bind(tenantId, groupId, tenantId, folderId)
      .first<{ cnt: number }>();
    if (effectiveOwners - (groupOwnerRows?.cnt ?? 0) <= 0) {
      throw new AdminGroupError(
        409,
        'LAST_OWNER_REQUIRED',
        'Deleting this group would leave a folder without an effective owner'
      );
    }
  }
}

export async function deleteAdminGroup(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  groupId: string;
}): Promise<AdminGroupMutationResult> {
  const { db, tenantId, actor, groupId } = input;
  const existing = await requireGroup(db, tenantId, groupId);
  assertManualGroup(existing);
  await assertLastOwnerPreserved(db, tenantId, groupId);

  const nowIso = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM permissions
          WHERE tenant_id = ? AND grantee_type = 'group' AND grantee_id = ?`
      )
      .bind(tenantId, groupId),
    db.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId),
    db
      .prepare('DELETE FROM groups WHERE tenant_id = ? AND id = ?')
      .bind(tenantId, groupId),
    ...buildGroupAuditAndSync({
      db,
      tenantId,
      actor,
      action: 'admin.group.delete',
      groupId,
      metadata: {
        groupId,
        name: existing.name,
        memberCount: existing.member_count,
        permissionCount: existing.permission_count,
      },
      nowIso,
    }),
  ]);

  return {
    ok: true,
    groupId,
    deletedPermissions: results[0]?.meta.changes ?? 0,
    deletedMembers: results[1]?.meta.changes ?? 0,
    syncSeq: extractLastSyncSeq(results),
    notice: `グループ「${existing.name}」を削除しました。`,
  };
}

function normalizeMemberIds(input: {
  userId?: unknown;
  userIds?: unknown;
}): string[] {
  const raw: unknown[] = [];
  if (input.userIds !== undefined) {
    if (!Array.isArray(input.userIds)) {
      throw new AdminGroupError(
        400,
        'INVALID_GROUP_MEMBER',
        'userIds must be an array of user ids'
      );
    }
    raw.push(...input.userIds);
  } else if (input.userId !== undefined) {
    raw.push(input.userId);
  }

  if (raw.length === 0) {
    throw new AdminGroupError(
      400,
      'INVALID_GROUP_MEMBER',
      'userId or userIds is required'
    );
  }
  if (raw.length > MAX_GROUP_MEMBER_BATCH) {
    throw new AdminGroupError(
      400,
      'INVALID_GROUP_MEMBER',
      `At most ${MAX_GROUP_MEMBER_BATCH} members can be added at once`
    );
  }

  const ids = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new AdminGroupError(
        400,
        'INVALID_GROUP_MEMBER',
        'Every member id must be a non-empty string'
      );
    }
    ids.add(value.trim());
  }
  return [...ids];
}

export async function addAdminGroupMembers(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  groupId: string;
  userId?: unknown;
  userIds?: unknown;
}): Promise<AdminGroupMutationResult> {
  const { db, tenantId, actor, groupId } = input;
  const existing = await requireGroup(db, tenantId, groupId);
  assertManualGroup(existing);
  const userIds = normalizeMemberIds({ userId: input.userId, userIds: input.userIds });

  const userRows = await db
    .prepare(
      `SELECT id, user_type
         FROM users
        WHERE tenant_id = ? AND id IN (${userIds.map(() => '?').join(', ')})`
    )
    .bind(tenantId, ...userIds)
    .all<{ id: string; user_type: 'member' | 'guest' }>();

  const byId = new Map(userRows.results.map((row) => [row.id, row]));
  const missing: string[] = [];
  const guestIds: string[] = [];
  for (const id of userIds) {
    const row = byId.get(id);
    if (!row) missing.push(id);
    else if (row.user_type !== 'member') guestIds.push(id);
  }
  if (missing.length > 0) {
    throw new AdminGroupError(
      404,
      'MEMBER_NOT_FOUND',
      `Unknown or cross-tenant member ids: ${missing.join(', ')}`
    );
  }
  if (guestIds.length > 0) {
    throw new AdminGroupError(
      400,
      'INVALID_GROUP_MEMBER',
      `Guest accounts cannot be added to groups: ${guestIds.join(', ')}`
    );
  }

  const nowIso = new Date().toISOString();
  const insertResults = await executeStatementChunks(
    db,
    userIds.map((userId) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO group_members (group_id, user_id, created_at)
           VALUES (?, ?, ?)`
        )
        .bind(groupId, userId, nowIso)
    )
  );
  const addedUserIds = userIds.filter(
    (_, index) => (insertResults[index]?.meta.changes ?? 0) > 0
  );

  const countRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?')
    .bind(groupId)
    .first<{ cnt: number }>();

  const results = await db.batch(
    buildGroupAuditAndSync({
      db,
      tenantId,
      actor,
      action: 'admin.group.member_add',
      groupId,
      metadata: {
        groupId,
        groupName: existing.name,
        userIds,
        addedUserIds,
        memberCount: countRow?.cnt ?? 0,
      },
      nowIso,
    })
  );

  return {
    ok: true,
    groupId,
    addedUserIds,
    addedCount: addedUserIds.length,
    alreadyMemberUserIds: userIds.filter((id) => !addedUserIds.includes(id)),
    memberCount: countRow?.cnt ?? 0,
    syncSeq: extractLastSyncSeq(results),
    notice: `${addedUserIds.length} 名をグループに追加しました。`,
  };
}

export async function removeAdminGroupMember(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  groupId: string;
  userId: string;
}): Promise<AdminGroupMutationResult> {  const { db, tenantId, actor, groupId, userId } = input;
  const existing = await requireGroup(db, tenantId, groupId);
  assertManualGroup(existing);

  const membership = await db
    .prepare(
      `SELECT gm.user_id
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND gm.user_id = ? AND u.tenant_id = ?`
    )
    .bind(groupId, userId, tenantId)
    .first<{ user_id: string }>();
  if (!membership) {
    throw new AdminGroupError(
      404,
      'MEMBER_NOT_IN_GROUP',
      'The user is not a member of this group'
    );
  }

  const nowIso = new Date().toISOString();
  const results = await db.batch([
    db
      .prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
      .bind(groupId, userId),
    ...buildGroupAuditAndSync({
      db,
      tenantId,
      actor,
      action: 'admin.group.member_remove',
      groupId,
      metadata: { groupId, groupName: existing.name, userId },
      nowIso,
    }),
  ]);

  const countRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM group_members WHERE group_id = ?')
    .bind(groupId)
    .first<{ cnt: number }>();

  return {
    ok: true,
    groupId,
    memberCount: countRow?.cnt ?? 0,
    syncSeq: extractLastSyncSeq(results),
    notice: 'グループからメンバーを削除しました。',
  };
}

/** Stable aliases for callers that follow the admin-user service naming. */
export const getAdminGroupDetail = loadAdminGroupDetail;
export const updateAdminGroup = renameAdminGroup;
