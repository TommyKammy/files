import type { AuthUser } from '../../../types/api';
import { extractLastSyncSeq } from '../../sync-notifier';
import { buildRestoreDestinationContext } from '../../trash-restore-context';
import { FolderRow, FolderServiceError } from '../shared';
import { validateAndPlanFolderRestore } from './plan';
import { buildRestoreStatements } from './statements';
import type {
  FolderRestoreOptions,
  RestoreFolderWithOptionsResult,
} from './types';

/**
 * Restore a soft-deleted folder into its original parent or a chosen active
 * destination, atomically with an optional deleted-ancestor chain.
 *
 * The whole operation is planned (permissions, cycle check, depth, names,
 * classification floor) before a single D1 `batch()` runs. D1 batches are
 * transactional, so a unique-index race or unexpected statement failure rolls
 * every ancestor back as well.
 */
export async function restoreFolderWithOptions(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  options: FolderRestoreOptions = {}
): Promise<RestoreFolderWithOptionsResult> {
  const planData = await validateAndPlanFolderRestore(db, user, folderId, options);
  const nowIso = new Date().toISOString();
  const statements = buildRestoreStatements(db, user, planData, nowIso);
  const batchResults = await db.batch(statements);

  const restored = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!restored) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }

  const finalDestination =
    (await buildRestoreDestinationContext(db, user, planData.targetParentId, {
      bypassAccess: planData.adminBypass,
    })) ?? planData.destination;

  const ancestorIds = planData.restoredChain.map((plan) => plan.folder.id);
  const scopeFolderIds = new Set<string | null>([
    planData.folder.parent_id,
    planData.targetParentId,
    folderId,
  ]);
  for (const plan of planData.restoredChain) {
    scopeFolderIds.add(plan.folder.parent_id);
    scopeFolderIds.add(plan.folder.id);
  }
  const affectedFolderIds = new Set<string | null>([
    planData.targetParentId,
    folderId,
    planData.folder.parent_id,
  ]);
  for (const plan of planData.restoredChain) {
    affectedFolderIds.add(plan.folder.parent_id);
    affectedFolderIds.add(plan.folder.id);
  }

  return {
    folder: restored,
    restoredAt: nowIso,
    syncSeq: extractLastSyncSeq(batchResults),
    destination: finalDestination,
    restoredAncestorIds: ancestorIds,
    affectedFolderIds: [...affectedFolderIds],
    scopeFolderIds: [...scopeFolderIds],
  };
}
