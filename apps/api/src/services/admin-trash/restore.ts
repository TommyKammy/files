import type { AuthUser } from '../../types/api';
import { TrashRequestError, type TrashItemRefInput } from '../trash-items';
import {
  restoreTrashFile,
  restoreTrashFolder,
  type RestoreTrashFileResult,
  type RestoreTrashFolderResult,
  type TrashBulkItemResult,
} from '../trash-restore';
import { isPrivilegedAdmin } from '../trash-restore-context';
import { loadAdminTrashItemRefs } from './refs';
import {
  assertNoWritableRef,
  summaryKey,
  toDelegation,
  toRestoreFailure,
  validateAdminTargetFolder,
} from './shared';
import type {
  AdminTrashRestoreOptions,
  AdminTrashRestoreResult,
} from './types';

/**
 * Restore up to 100 Trash items as a tenant administrator. Every id is validated
 * against the session tenant first; one cross-tenant or unknown id rejects the
 * entire request before a single row is written. Per-item planning failures are
 * then reported independently.
 */
export async function restoreAdminTrashItems(
  db: D1Database,
  user: AuthUser,
  items: readonly TrashItemRefInput[],
  options: AdminTrashRestoreOptions
): Promise<AdminTrashRestoreResult> {
  if (!isPrivilegedAdmin(user)) {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }
  await validateAdminTargetFolder(db, user.tenantId, options.targetFolderId);

  const refs = await loadAdminTrashItemRefs(db, user.tenantId, items);
  assertNoWritableRef(items, refs);

  const results: TrashBulkItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;
  const hasTarget = options.targetFolderId !== undefined;

  for (const item of items) {
    const ref = refs.get(summaryKey(item.type, item.id))!;
    try {
      if (item.type === 'file') {
        const result: RestoreTrashFileResult = await restoreTrashFile(
          db,
          user,
          item.id,
          {
            conflictPolicy: options.conflictPolicy,
            restoreParentChain: options.restoreParentChain,
            ...(hasTarget ? { targetFolderId: options.targetFolderId } : {}),
            adminDelegation: toDelegation(ref),
          }
        );
        result.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
        if (result.syncSeq !== null) {
          lastSeq = Math.max(lastSeq ?? 0, result.syncSeq);
        }
        results.push({
          type: 'file',
          id: item.id,
          ok: true,
          status: 'succeeded',
          name: result.file.name,
          file: result.file,
        });
      } else {
        const result: RestoreTrashFolderResult = await restoreTrashFolder(
          db,
          user,
          item.id,
          options.conflictPolicy,
          {
            restoreParentChain: options.restoreParentChain,
            ...(hasTarget ? { targetParentId: options.targetFolderId } : {}),
            adminDelegation: toDelegation(ref),
          }
        );
        result.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
        if (result.syncSeq !== null) {
          lastSeq = Math.max(lastSeq ?? 0, result.syncSeq);
        }
        results.push({
          type: 'folder',
          id: item.id,
          ok: true,
          status: 'succeeded',
          name: result.folder.name,
          folder: result.folder,
        });
      }
    } catch (err) {
      results.push(toRestoreFailure(item, err));
    }
  }

  const succeededCount = results.filter((result) => result.ok).length;
  return {
    results,
    succeededCount,
    failedCount: results.length - succeededCount,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}
