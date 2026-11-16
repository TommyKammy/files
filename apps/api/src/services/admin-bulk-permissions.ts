import type { AuthUser } from '../types/api';
import type { OidcEnv } from '../types/oidc';
import { chunkArray } from '../utils/batch';
import { buildAuditLogStmt } from './audit';
import {
  AdminRootFolderError,
  assertActiveUser,
  assertTenantGroups,
  buildAdminRootCoOwnerStatements,
  buildAdminRootOwnerTransferStatements,
  loadAdminRootFolderCandidates,
  normalizeIdArray,
  type AdminRootFolderCandidate,
  type AdminRootOwnerRef,
} from './admin-root-folders';
import {
  buildAdminBulkSummary,
  failedResult,
  normalizeBulkFolderIds,
  skippedResult,
  successResult,
  type AdminBulkItemResult,
  type AdminBulkResponse,
} from './admin-bulk';
import {
  beginAdminBulkOperation,
  resolveIdempotencyKey,
} from './admin-bulk-idempotency';
import { executeStatementChunks } from './d1-batch';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';

const GRANT_LOOKUP_CHUNK = 30;

interface ExistingGrantRow {
  target_id: string;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  role: string;
}

async function loadExistingGrants(
  db: D1Database,
  tenantId: string,
  folderIds: readonly string[],
  roles: readonly string[]
): Promise<ExistingGrantRow[]> {
  const rows: ExistingGrantRow[] = [];
  const roleSql = roles.map(() => '?').join(', ');
  for (const chunk of chunkArray([...folderIds], GRANT_LOOKUP_CHUNK)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `SELECT target_id, grantee_type, grantee_id, role
           FROM permissions
          WHERE tenant_id = ?
            AND target_type = 'folder'
            AND target_id IN (${placeholders})
            AND role IN (${roleSql})`
      )
      .bind(tenantId, ...chunk, ...roles)
      .all<ExistingGrantRow>();
    rows.push(...result.results);
  }
  return rows;
}

function classifyCandidate(
  folderId: string,
  candidates: Map<string, AdminRootFolderCandidate>
): { candidate: AdminRootFolderCandidate | null; failure: AdminBulkItemResult | null } {
  const candidate = candidates.get(folderId);
  if (!candidate) {
    return {
      candidate: null,
      failure: failedResult(
        folderId,
        '',
        'NOT_FOUND',
        'Root folder not found in this tenant'
      ),
    };
  }
  if (candidate.parent_id !== null) {
    return {
      candidate,
      failure: failedResult(
        folderId,
        candidate.name,
        'NOT_ROOT_FOLDER',
        'Target folder is not a workspace root folder'
      ),
    };
  }
  return { candidate, failure: null };
}

function grantKey(granteeType: 'user' | 'group', granteeId: string): string {
  return `${granteeType}:${granteeId}`;
}

export interface BulkCoOwnerInput {
  folderIds: unknown;
  userIds?: unknown;
  groupIds?: unknown;
  dryRun?: unknown;
  idempotencyKey?: unknown;
  headerIdempotencyKey?: string | null;
}

/**
 * Bulk co-owner grant across up to 50 root folders. Existing `owner` rows are
 * preserved by the shared upsert, archived roots are skipped, and ids from
 * another tenant are indistinguishable from missing ids.
 */
export async function bulkGrantAdminRootFolderCoOwners(
  env: Pick<OidcEnv, 'DB'>,
  user: AuthUser,
  input: BulkCoOwnerInput
): Promise<AdminBulkResponse> {
  const db = env.DB;
  const folderIds = normalizeBulkFolderIds(input.folderIds);
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

  const dryRun = input.dryRun === true;
  const operation = 'admin.permission.bulk_grant';
  const payload = {
    folderIds: [...folderIds].sort(),
    userIds: [...userIds].sort(),
    groupIds: [...groupIds].sort(),
  };

  const candidates = await loadAdminRootFolderCandidates(
    db,
    user.tenantId,
    folderIds
  );
  const existing = await loadExistingGrants(
    db,
    user.tenantId,
    folderIds,
    ['owner', 'co_owner']
  );
  const existingByFolder = new Map<string, Set<string>>();
  for (const grant of existing) {
    const set = existingByFolder.get(grant.target_id) ?? new Set<string>();
    set.add(grantKey(grant.grantee_type, grant.grantee_id));
    existingByFolder.set(grant.target_id, set);
  }
  const requestedKeys = [
    ...userIds.map((id) => grantKey('user', id)),
    ...groupIds.map((id) => grantKey('group', id)),
  ];

  const plan = folderIds.map<AdminBulkItemResult>((folderId) => {
    const { candidate, failure } = classifyCandidate(folderId, candidates);
    if (failure) return failure;
    if (!candidate) {
      return failedResult(folderId, '', 'NOT_FOUND', 'Root folder not found');
    }
    if (candidate.deleted_at !== null) {
      return skippedResult(
        folderId,
        candidate.name,
        'ARCHIVED',
        'Archived root folders cannot receive new grants'
      );
    }
    const granted = existingByFolder.get(folderId) ?? new Set<string>();
    if (requestedKeys.every((key) => granted.has(key))) {
      return skippedResult(
        folderId,
        candidate.name,
        'ALREADY_GRANTED',
        'All requested principals already have owner or co-owner access'
      );
    }
    const added = requestedKeys.filter((key) => !granted.has(key)).length;
    return successResult(
      folderId,
      candidate.name,
      `${added}件の共同所有者権限を付与予定`
    );
  });

  if (dryRun) {
    return {
      operation,
      dryRun: true,
      replayed: false,
      results: plan,
      summary: buildAdminBulkSummary(plan),
      syncSeq: null,
    };
  }

  const idempotencyKey = resolveIdempotencyKey(
    input.idempotencyKey,
    input.headerIdempotencyKey
  );
  const session = await beginAdminBulkOperation<Omit<AdminBulkResponse, 'replayed'>>({
    db,
    tenantId: user.tenantId,
    operation,
    idempotencyKey,
    payload,
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const results: AdminBulkItemResult[] = [];
    let latestSyncSeq: number | null = null;

    for (const planned of plan) {
      if (planned.status !== 'succeeded') {
        results.push(planned);
        continue;
      }
      const candidate = candidates.get(planned.folderId);
      if (!candidate) {
        results.push(
          failedResult(planned.folderId, '', 'NOT_FOUND', 'Root folder not found')
        );
        continue;
      }
      try {
        const bundled = buildAdminRootCoOwnerStatements(db, {
          tenantId: user.tenantId,
          folderId: candidate.id,
          userIds,
          groupIds,
          grantedBy: user.id,
          nowIso,
        });
        const batchResults = await executeStatementChunks(db, [
          ...bundled.statements,
          ...bundled.syncStatements,
        ]);
        const seq = extractLastSyncSeq(batchResults);
        if (seq !== null) latestSyncSeq = seq;
        results.push(
          successResult(candidate.id, candidate.name, planned.message)
        );
      } catch (err) {
        results.push(
          failedResult(
            candidate.id,
            candidate.name,
            'GRANT_FAILED',
            err instanceof Error ? err.message : 'Co-owner grant failed'
          )
        );
      }
    }

    const response: Omit<AdminBulkResponse, 'replayed'> = {
      operation,
      dryRun: false,
      results,
      summary: buildAdminBulkSummary(results),
      syncSeq: latestSyncSeq,
    };

    const audit = buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: operation,
      targetType: 'permission',
      targetId: 'bulk',
      metadata: {
        folderIds,
        userIds,
        groupIds,
        summary: response.summary,
        results,
      },
      nowIso,
    });
    await audit.run();

    await session.complete(response);
    return { ...response, replayed: false };
  } catch (err) {
    await session.fail();
    throw err;
  }
}

export interface BulkTransferOwnerInput {
  folderIds: unknown;
  newOwnerUserId: unknown;
  demotePreviousOwnersTo?: unknown;
  dryRun?: unknown;
  idempotencyKey?: unknown;
  headerIdempotencyKey?: string | null;
}

/**
 * Bulk root-folder ownership transfer. Each folder is processed with the same
 * shared statement builder as the single-folder API: grant/promote the new
 * owner first, then demote or revoke previous owners in one ordered batch.
 */
export async function bulkTransferAdminRootFolderOwner(
  env: Pick<OidcEnv, 'DB'>,
  user: AuthUser,
  input: BulkTransferOwnerInput
): Promise<AdminBulkResponse> {
  const db = env.DB;
  const folderIds = normalizeBulkFolderIds(input.folderIds);
  if (
    typeof input.newOwnerUserId !== 'string' ||
    input.newOwnerUserId.trim().length === 0
  ) {
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
      : input.demotePreviousOwnersTo === undefined ||
          input.demotePreviousOwnersTo === 'co_owner'
        ? 'co_owner'
        : null;
  if (demote === null) {
    throw new AdminRootFolderError(
      400,
      'INVALID_DEMOTION',
      'demotePreviousOwnersTo must be co_owner, editor, or revoke'
    );
  }
  await assertActiveUser(db, user.tenantId, newOwnerUserId);

  const dryRun = input.dryRun === true;
  const operation = 'admin.root_folder.bulk_transfer';
  const payload = {
    folderIds: [...folderIds].sort(),
    newOwnerUserId,
    demotePreviousOwnersTo: demote,
  };

  const candidates = await loadAdminRootFolderCandidates(
    db,
    user.tenantId,
    folderIds
  );
  const ownerRows = await loadExistingGrants(db, user.tenantId, folderIds, [
    'owner',
  ]);
  const ownersByFolder = new Map<string, AdminRootOwnerRef[]>();
  for (const row of ownerRows) {
    const owners = ownersByFolder.get(row.target_id) ?? [];
    owners.push({
      grantee_type: row.grantee_type,
      grantee_id: row.grantee_id,
    });
    ownersByFolder.set(row.target_id, owners);
  }

  function previousOwnersFor(folderId: string): AdminRootOwnerRef[] {
    return (ownersByFolder.get(folderId) ?? []).filter(
      (owner) =>
        !(owner.grantee_type === 'user' && owner.grantee_id === newOwnerUserId)
    );
  }

  const plan = folderIds.map<AdminBulkItemResult>((folderId) => {
    const { candidate, failure } = classifyCandidate(folderId, candidates);
    if (failure) return failure;
    if (!candidate) {
      return failedResult(folderId, '', 'NOT_FOUND', 'Root folder not found');
    }
    if (candidate.deleted_at !== null) {
      return failedResult(
        folderId,
        candidate.name,
        'ARCHIVED',
        'Archived root folders cannot be transferred'
      );
    }
    const owners = ownersByFolder.get(folderId) ?? [];
    const alreadyOwner = owners.some(
      (owner) =>
        owner.grantee_type === 'user' && owner.grantee_id === newOwnerUserId
    );
    if (owners.length === 1 && alreadyOwner) {
      return skippedResult(
        folderId,
        candidate.name,
        'ALREADY_OWNER',
        'The requested user is already the sole owner'
      );
    }
    const previous = previousOwnersFor(folderId);
    return successResult(
      folderId,
      candidate.name,
      previous.length === 0
        ? 'New owner will be granted (no previous owners to change)'
        : `${previous.length}名の旧所有者を ${demote} へ変更予定`
    );
  });

  if (dryRun) {
    return {
      operation,
      dryRun: true,
      replayed: false,
      results: plan,
      summary: buildAdminBulkSummary(plan),
      syncSeq: null,
    };
  }

  const idempotencyKey = resolveIdempotencyKey(
    input.idempotencyKey,
    input.headerIdempotencyKey
  );
  const session = await beginAdminBulkOperation<Omit<AdminBulkResponse, 'replayed'>>({
    db,
    tenantId: user.tenantId,
    operation,
    idempotencyKey,
    payload,
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const results: AdminBulkItemResult[] = [];
    const details: Array<Record<string, unknown>> = [];
    let latestSyncSeq: number | null = null;

    for (const planned of plan) {
      if (planned.status !== 'succeeded') {
        results.push(planned);
        continue;
      }
      const candidate = candidates.get(planned.folderId);
      if (!candidate) {
        results.push(
          failedResult(planned.folderId, '', 'NOT_FOUND', 'Root folder not found')
        );
        continue;
      }
      const previousOwners = previousOwnersFor(candidate.id);
      const previousOwnerIds = previousOwners.map((owner) => owner.grantee_id);
      try {
        const statements = buildAdminRootOwnerTransferStatements(db, {
          tenantId: user.tenantId,
          folderId: candidate.id,
          newOwnerUserId,
          demote,
          previousOwners,
          grantedBy: user.id,
          nowIso,
        });
        statements.push(
          buildSyncChangeStmt(db, {
            tenantId: user.tenantId,
            entityType: 'folder',
            entityId: candidate.id,
            folderId: null,
            action: 'admin.root_folder.owner_transfer',
            payload: {
              previousOwnerIds,
              newOwnerUserId,
              demotePreviousOwnersTo: demote,
              bulk: true,
            },
            nowIso,
          }),
          buildSyncChangeStmt(db, {
            tenantId: user.tenantId,
            entityType: 'permission',
            entityId: `${candidate.id}:user:${newOwnerUserId}`,
            folderId: candidate.id,
            action: 'permission.grant',
            payload: {
              targetType: 'folder',
              targetId: candidate.id,
              granteeType: 'user',
              granteeId: newOwnerUserId,
              role: 'owner',
            },
            nowIso,
          })
        );
        const batchResults = await executeStatementChunks(db, statements);
        const seq = extractLastSyncSeq(batchResults);
        if (seq !== null) latestSyncSeq = seq;

        const ownerCheck = await db
          .prepare(
            `SELECT COUNT(*) AS cnt
               FROM permissions
              WHERE tenant_id = ?
                AND target_type = 'folder'
                AND target_id = ?
                AND role = 'owner'`
          )
          .bind(user.tenantId, candidate.id)
          .first<{ cnt: number }>();
        if ((ownerCheck?.cnt ?? 0) === 0) {
          results.push(
            failedResult(
              candidate.id,
              candidate.name,
              'LAST_OWNER_PROTECTED',
              'At least one owner must remain'
            )
          );
        } else {
          results.push(
            successResult(candidate.id, candidate.name, planned.message)
          );
        }
        details.push({
          folderId: candidate.id,
          folderName: candidate.name,
          previousOwnerIds,
          newOwnerUserId,
          demotePreviousOwnersTo: demote,
          status:
            (ownerCheck?.cnt ?? 0) === 0 ? 'failed' : 'succeeded',
        });
      } catch (err) {
        results.push(
          failedResult(
            candidate.id,
            candidate.name,
            'TRANSFER_FAILED',
            err instanceof Error ? err.message : 'Owner transfer failed'
          )
        );
        details.push({
          folderId: candidate.id,
          folderName: candidate.name,
          previousOwnerIds,
          newOwnerUserId,
          demotePreviousOwnersTo: demote,
          status: 'failed',
        });
      }
    }

    const response: Omit<AdminBulkResponse, 'replayed'> = {
      operation,
      dryRun: false,
      results,
      summary: buildAdminBulkSummary(results),
      syncSeq: latestSyncSeq,
    };

    const audit = buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: operation,
      targetType: 'folder',
      targetId: 'bulk',
      metadata: {
        folderIds,
        newOwnerUserId,
        demotePreviousOwnersTo: demote,
        summary: response.summary,
        details,
      },
      nowIso,
    });
    await audit.run();

    await session.complete(response);
    return { ...response, replayed: false };
  } catch (err) {
    await session.fail();
    throw err;
  }
}
