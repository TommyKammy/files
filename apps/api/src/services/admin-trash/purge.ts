import type { AuthUser } from '../../types/api';
import type { OidcEnv } from '../../types/oidc';
import { buildAuditLogStmt } from '../audit';
import { TrashRequestError, type TrashItemRefInput } from '../trash-items';
import {
  purgeTrashFileItem,
  purgeTrashFolderItem,
  type TrashPurgeAdminContext,
  type TrashPurgeItemResult,
} from '../trash-purge';
import { loadAdminTrashItemRefs } from './refs';
import {
  ADMIN_TRASH_UNION_SQL,
  assertNoWritableRef,
  summaryKey,
  toPurgeFailure,
  type TenantTrashCandidate,
} from './shared';
import type { AdminTrashEmptyResult, AdminTrashPurgeResult } from './types';

/** Permanently delete selected tenant Trash items as sys_admin. */
export async function purgeAdminTrashItems(
  env: Pick<OidcEnv, 'DB' | 'BUCKET' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  items: readonly TrashItemRefInput[],
  nowIso = new Date().toISOString()
): Promise<AdminTrashPurgeResult> {
  if (user.role !== 'sys_admin') {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  const refs = await loadAdminTrashItemRefs(env.DB, user.tenantId, items);
  assertNoWritableRef(items, refs);

  const results: TrashPurgeItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;

  for (const item of items) {
    const ref = refs.get(summaryKey(item.type, item.id))!;
    const adminContext: TrashPurgeAdminContext = {
      adminBypass: true,
      owner: {
        id: ref.ownerId,
        name: ref.ownerName,
        email: ref.ownerEmail,
      },
    };
    try {
      const outcome =
        item.type === 'file'
          ? await purgeTrashFileItem(
              env,
              user,
              item.id,
              nowIso,
              adminContext
            )
          : await purgeTrashFolderItem(
              env,
              user,
              item.id,
              nowIso,
              adminContext
            );
      results.push({ ...outcome.result, name: outcome.result.name ?? ref.name });
      outcome.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
      if (outcome.syncSeq !== null) {
        lastSeq = Math.max(lastSeq ?? 0, outcome.syncSeq);
      }
    } catch (err) {
      const failure = toPurgeFailure(item, err);
      results.push({ ...failure, name: failure.name ?? ref.name });
    }
  }

  const succeededCount = results.filter((result) => result.ok).length;
  return {
    results,
    succeededCount,
    failedCount: results.length - succeededCount,
    skippedCount: results.filter((result) => result.status === 'skipped').length,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}

/**
 * Permanently delete every top-level item in the tenant Trash. Unlike
 * `emptyTrash()` this intentionally ignores individual ACLs; the route and this
 * service both require sys_admin. Locked files are skipped, never forced.
 */
export async function emptyAdminTrash(
  env: Pick<OidcEnv, 'DB' | 'BUCKET' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  nowIso = new Date().toISOString()
): Promise<AdminTrashEmptyResult> {
  if (user.role !== 'sys_admin') {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  const candidates = await env.DB.prepare(
    `SELECT t.item_type, t.id, t.name, t.owner_id,
            u.display_name AS owner_name, u.email AS owner_email
       FROM (${ADMIN_TRASH_UNION_SQL}) t
       LEFT JOIN users u
         ON u.tenant_id = ? AND u.id = t.owner_id
      WHERE t.parent_deleted_at IS NULL
      ORDER BY t.deleted_at ASC, t.item_type ASC, t.id ASC`
  )
    .bind(user.tenantId, user.tenantId, user.tenantId)
    .all<TenantTrashCandidate>();

  const results: TrashPurgeItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;

  for (const candidate of candidates.results) {
    const item: TrashItemRefInput = {
      type: candidate.item_type,
      id: candidate.id,
    };
    const adminContext: TrashPurgeAdminContext = {
      adminBypass: true,
      owner: {
        id: candidate.owner_id ?? user.id,
        name: candidate.owner_name ?? '不明',
        email: candidate.owner_email ?? null,
      },
    };
    try {
      const outcome =
        candidate.item_type === 'file'
          ? await purgeTrashFileItem(
              env,
              user,
              candidate.id,
              nowIso,
              adminContext
            )
          : await purgeTrashFolderItem(
              env,
              user,
              candidate.id,
              nowIso,
              adminContext
            );
      results.push({ ...outcome.result, name: outcome.result.name ?? candidate.name });
      outcome.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
      if (outcome.syncSeq !== null) {
        lastSeq = Math.max(lastSeq ?? 0, outcome.syncSeq);
      }
    } catch (err) {
      const failure = toPurgeFailure(item, err);
      results.push({ ...failure, name: failure.name ?? candidate.name });
    }
  }

  const deletedCount = results.filter((result) => result.ok).length;
  const skippedCount = results.filter(
    (result) => result.status === 'skipped'
  ).length;
  const failedCount = results.length - deletedCount - skippedCount;

  await buildAuditLogStmt(env.DB, {
    tenantId: user.tenantId,
    actorId: user.id,
    actorEmail: user.email,
    actorIp: user.ipAddress,
    action: 'admin.trash.empty',
    targetType: 'tenant',
    targetId: user.tenantId,
    classificationSnapshot: null,
    metadata: {
      targetName: 'テナント全体のゴミ箱',
      deletedCount,
      failedCount,
      skippedCount,
      failedItems: results
        .filter((result) => result.status === 'failed')
        .map((result) => ({
          type: result.type,
          id: result.id,
          name: result.name ?? null,
          code: result.code ?? null,
          error: result.error ?? null,
        })),
      skippedItems: results
        .filter((result) => result.status === 'skipped')
        .map((result) => ({
          type: result.type,
          id: result.id,
          name: result.name ?? null,
          code: result.code ?? null,
          error: result.error ?? null,
        })),
    },
    nowIso,
  }).run();

  return {
    results,
    deletedCount,
    failedCount,
    skippedCount,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}
