import type { AuthUser, ClassificationLabel } from '../../types/api';
import { VALID_CLASSIFICATIONS } from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import { validateFolderName } from '../folder-closure/shared';
import { buildRootFolderResetStmt } from '../root-folder-stats';
import { buildSyncChangeStmt } from '../sync-changes';
import { extractLastSyncSeq } from '../sync-notifier';
import { loadRecordById } from './queries';
import {
  buildAdminRootCoOwnerStatements,
  buildAdminRootOwnerTransferStatements,
} from './statements';
import {
  AdminRootFolderError,
  type AdminRootFolderMutationResult,
} from './types';
import {
  assertActiveUser,
  assertTenantGroups,
  loadRootFolderRow,
  normalizeIdArray,
} from './validation';

export async function createAdminRootFolder(
  db: D1Database,
  user: AuthUser,
  input: {
    name: unknown;
    classification?: unknown;
    isPinned?: unknown;
    ownerUserId: unknown;
    coOwnerUserIds?: unknown;
    coOwnerGroupIds?: unknown;
  }
): Promise<AdminRootFolderMutationResult> {
  const name = validateFolderName(input.name);
  const classification =
    input.classification === undefined
      ? 'unset'
      : (input.classification as ClassificationLabel);
  if (!VALID_CLASSIFICATIONS.has(classification)) {
    throw new AdminRootFolderError(
      400,
      'INVALID_CLASSIFICATION',
      'Invalid classification value'
    );
  }
  if (typeof input.ownerUserId !== 'string' || input.ownerUserId.trim().length === 0) {
    throw new AdminRootFolderError(
      400,
      'INVALID_OWNER',
      'ownerUserId is required'
    );
  }
  const ownerUserId = input.ownerUserId.trim();
  const coOwnerUserIds = normalizeIdArray(
    input.coOwnerUserIds,
    'coOwnerUserIds'
  );
  const coOwnerGroupIds = normalizeIdArray(
    input.coOwnerGroupIds,
    'coOwnerGroupIds'
  );

  const duplicate = await db
    .prepare(
      `SELECT id FROM folders
        WHERE tenant_id = ? AND parent_id IS NULL AND name = ? AND deleted_at IS NULL
        LIMIT 1`
    )
    .bind(user.tenantId, name)
    .first<{ id: string }>();
  if (duplicate) {
    throw new AdminRootFolderError(
      409,
      'NAME_CONFLICT',
      `A root folder named "${name}" already exists`
    );
  }

  await assertActiveUser(db, user.tenantId, ownerUserId);
  for (const userId of coOwnerUserIds) {
    if (userId === ownerUserId) continue;
    await assertActiveUser(db, user.tenantId, userId, 'INVALID_CO_OWNER');
  }
  await assertTenantGroups(db, user.tenantId, coOwnerGroupIds);

  const folderId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const isPinned = input.isPinned === true ? 1 : 0;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification,
           is_pinned, created_by, deleted_at, created_at, updated_at
         ) VALUES (?, ?, NULL, ?, 0, 1, ?, ?, ?, NULL, ?, ?)`
      )
      .bind(
        folderId,
        user.tenantId,
        name,
        classification,
        isPinned,
        user.id,
        nowIso,
        nowIso
      ),
    db
      .prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, 0)`
      )
      .bind(user.tenantId, folderId, folderId),
    buildRootFolderResetStmt(db, user.tenantId, folderId, nowIso),
    db
      .prepare(
        `INSERT INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by, created_at
         ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        user.tenantId,
        folderId,
        ownerUserId,
        user.id,
        nowIso
      ),
  ];

  const coOwnerGrantKeys = new Set<string>();
  for (const userId of coOwnerUserIds) {
    const key = `user:${userId}`;
    if (userId === ownerUserId || coOwnerGrantKeys.has(key)) continue;
    coOwnerGrantKeys.add(key);
    statements.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id,
             role, granted_by, created_at
           ) VALUES (?, ?, 'folder', ?, 'user', ?, 'co_owner', ?, ?)
           ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
           DO UPDATE SET role = 'co_owner', granted_by = excluded.granted_by`
        )
        .bind(
          crypto.randomUUID(),
          user.tenantId,
          folderId,
          userId,
          user.id,
          nowIso
        )
    );
  }
  for (const groupId of coOwnerGroupIds) {
    const key = `group:${groupId}`;
    if (coOwnerGrantKeys.has(key)) continue;
    coOwnerGrantKeys.add(key);
    statements.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id,
             role, granted_by, created_at
           ) VALUES (?, ?, 'folder', ?, 'group', ?, 'co_owner', ?, ?)
           ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
           DO UPDATE SET role = 'co_owner', granted_by = excluded.granted_by`
        )
        .bind(
          crypto.randomUUID(),
          user.tenantId,
          folderId,
          groupId,
          user.id,
          nowIso
        )
    );
  }

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.root_folder.create',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: classification,
      metadata: {
        name,
        ownerUserId,
        coOwnerUserIds,
        coOwnerGroupIds,
        classification,
        isPinned: isPinned === 1,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: null,
      action: 'folder.create',
      payload: {
        folder: {
          id: folderId,
          tenant_id: user.tenantId,
          parent_id: null,
          name,
          depth: 0,
          version: 1,
          classification,
          is_pinned: isPinned,
          created_by: user.id,
          deleted_at: null,
          deleted_by: null,
          created_at: nowIso,
          updated_at: nowIso,
        },
        adminCreated: true,
      },
      nowIso,
    })
  );

  const batchResults = await db.batch(statements);
  return {
    root: await loadRecordById(db, user.tenantId, folderId),
    syncSeq: extractLastSyncSeq(batchResults),
  };
}

export async function transferAdminRootFolderOwner(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  input: {
    newOwnerUserId?: unknown;
    demotePreviousOwnersTo?: unknown;
  }
): Promise<AdminRootFolderMutationResult> {
  const folder = await loadRootFolderRow(db, user.tenantId, folderId);
  if (typeof input.newOwnerUserId !== 'string' || input.newOwnerUserId.trim().length === 0) {
    throw new AdminRootFolderError(
      400,
      'INVALID_OWNER',
      'newOwnerUserId is required'
    );
  }
  const newOwnerUserId = input.newOwnerUserId.trim();
  const demote =
    input.demotePreviousOwnersTo === 'editor' ||
    input.demotePreviousOwnersTo === 'revoke'
      ? input.demotePreviousOwnersTo
      : 'co_owner';
  await assertActiveUser(db, user.tenantId, newOwnerUserId);
  if (newOwnerUserId.length === 0) {
    throw new AdminRootFolderError(
      409,
      'LAST_OWNER_PROTECTED',
      'At least one active owner must remain'
    );
  }

  const existingOwners = await db
    .prepare(
      `SELECT grantee_type, grantee_id
         FROM permissions
        WHERE tenant_id = ?
          AND target_type = 'folder'
          AND target_id = ?
          AND role = 'owner'`
    )
    .bind(user.tenantId, folderId)
    .all<{ grantee_type: 'user' | 'group'; grantee_id: string }>();
  const previousOwners = existingOwners.results.filter(
    (row) => !(row.grantee_type === 'user' && row.grantee_id === newOwnerUserId)
  );
  const previousOwnerIds = previousOwners.map((row) => row.grantee_id);

  const nowIso = new Date().toISOString();
  const statements = buildAdminRootOwnerTransferStatements(db, {
    tenantId: user.tenantId,
    folderId,
    newOwnerUserId,
    demote,
    previousOwners,
    grantedBy: user.id,
    nowIso,
  });

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.root_folder.owner_transfer',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folder.classification,
      metadata: {
        previousOwnerIds,
        newOwnerUserId,
        demotePreviousOwnersTo: demote,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: null,
      action: 'admin.root_folder.owner_transfer',
      payload: {
        previousOwnerIds,
        newOwnerUserId,
        demotePreviousOwnersTo: demote,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'permission',
      entityId: `${folderId}:user:${newOwnerUserId}`,
      folderId,
      action: 'permission.grant',
      payload: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: newOwnerUserId,
        role: 'owner',
      },
      nowIso,
    })
  );

  const batchResults = await db.batch(statements);
  const record = await loadRecordById(db, user.tenantId, folderId);
  if (
    !record.owners.some(
      (owner) => owner.granteeId === newOwnerUserId && owner.status === 'active'
    )
  ) {
    throw new AdminRootFolderError(
      409,
      'LAST_OWNER_PROTECTED',
      'At least one active owner must remain'
    );
  }

  return { root: record, syncSeq: extractLastSyncSeq(batchResults) };
}

export async function grantAdminRootFolderCoOwners(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  input: { userIds?: unknown; groupIds?: unknown }
): Promise<AdminRootFolderMutationResult> {
  const folder = await loadRootFolderRow(db, user.tenantId, folderId);
  const userIds = normalizeIdArray(input.userIds, 'userIds');
  const groupIds = normalizeIdArray(input.groupIds, 'groupIds');
  if (userIds.length === 0 && groupIds.length === 0) {
    throw new AdminRootFolderError(
      400,
      'INVALID_GRANTEE',
      'At least one userId or groupId is required'
    );
  }
  for (const userId of userIds) {
    await assertActiveUser(db, user.tenantId, userId, 'INVALID_CO_OWNER');
  }
  await assertTenantGroups(db, user.tenantId, groupIds);

  const nowIso = new Date().toISOString();
  const { statements, syncStatements } = buildAdminRootCoOwnerStatements(db, {
    tenantId: user.tenantId,
    folderId,
    userIds,
    groupIds,
    grantedBy: user.id,
    nowIso,
  });

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.root_folder.co_owner_grant',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folder.classification,
      metadata: { userIds, groupIds },
      nowIso,
    }),
    ...syncStatements
  );

  const batchResults = await db.batch(statements);
  return {
    root: await loadRecordById(db, user.tenantId, folderId),
    syncSeq: extractLastSyncSeq(batchResults),
  };
}
