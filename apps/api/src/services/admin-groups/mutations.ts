import type { AuthUser } from '../../types/api';
import { countEffectiveOwners } from '../authorization';
import { executeStatementChunks } from '../d1-batch';
import { extractLastSyncSeq } from '../sync-notifier';
import {
  MAX_GROUP_MEMBER_BATCH,
  assertGroupNameAvailable,
  assertManualGroup,
  buildGroupAuditAndSync,
  normalizeGroupName,
  requireGroup,
  toGroupRow,
} from './shared';
import { AdminGroupError, type AdminGroupMutationResult } from './types';

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

/** Stable alias for callers that follow the admin-user service naming. */
export const updateAdminGroup = renameAdminGroup;

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
}): Promise<AdminGroupMutationResult> {
  const { db, tenantId, actor, groupId, userId } = input;
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
