import type { AuthUser } from '../../types/api';
import { type FileRow } from '../file-upload-common';
import { type FolderRow } from '../folder-closure-service';
import { enqueueCopySubtreeJob } from './copy-async';
import { resolveCopyPlan } from './copy-plan';
import { executeSyncCopySubtree } from './copy-sync';
import {
  ASYNC_COPY_CHUNK_NODES,
  CopyWorkspaceResult,
  SYNC_COPY_NODE_LIMIT,
  WorkspaceBatchItemInput,
  WorkspaceConflictPolicy,
  WorkspaceOpError,
  dedupeBatchItems,
} from './shared';

export async function copyWorkspaceItems(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  input: {
    items: unknown;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
  }
): Promise<CopyWorkspaceResult> {
  const plan = await resolveCopyPlan(db, user, input);

  if (plan.totalNodes > SYNC_COPY_NODE_LIMIT) {
    return enqueueCopySubtreeJob({
      db,
      queue,
      user,
      dest: plan.dest,
      rootFolders: plan.rootFolders,
      rootFiles: plan.rootFiles,
      rootFolderTargetNames: plan.rootFolderTargetNames,
      rootFileTargetNames: plan.rootFileTargetNames,
      totalNodes: plan.totalNodes,
      nowIso: plan.nowIso,
    });
  }

  return executeSyncCopySubtree({
    db,
    user,
    dest: plan.dest,
    rootFolders: plan.rootFolders,
    rootFiles: plan.rootFiles,
    rootFolderTargetNames: plan.rootFolderTargetNames,
    rootFileTargetNames: plan.rootFileTargetNames,
    dedupedRootFolderIds: plan.dedupedRootFolderIds,
    nowIso: plan.nowIso,
  });
}

/**
 * Duplicate selected items in-place inside each item's current parent folder (`rename` policy).
 */
export async function duplicateWorkspaceItems(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  rawItems: unknown
): Promise<CopyWorkspaceResult & { jobIds: string[] }> {
  const items = dedupeBatchItems(rawItems);

  // Resolve current parent ID of every selected item so items can duplicate alongside themselves
  const groups = new Map<string | null, WorkspaceBatchItemInput[]>();
  const resolvedPairs = await Promise.all(
    items.map(async (ref) => {
      if (ref.type === 'folder') {
        const folder = await db
          .prepare('SELECT id, parent_id FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
          .bind(user.tenantId, ref.id)
          .first<{ id: string; parent_id: string | null }>();
        if (!folder) {
          throw new WorkspaceOpError(404, 'NOT_FOUND', `Folder not found: ${ref.id}`);
        }
        return { ref, parentId: folder.parent_id };
      }
      const file = await db
        .prepare(
          `SELECT id, folder_id FROM files
            WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND upload_state = 'active'`
        )
        .bind(user.tenantId, ref.id)
        .first<{ id: string; folder_id: string | null }>();
      if (!file) {
        throw new WorkspaceOpError(404, 'NOT_FOUND', `File not found: ${ref.id}`);
      }
      return { ref, parentId: file.folder_id };
    })
  );

  for (const pair of resolvedPairs) {
    const list = groups.get(pair.parentId) ?? [];
    list.push(pair.ref);
    groups.set(pair.parentId, list);
  }

  const copiedFolders: FolderRow[] = [];
  const copiedFiles: FileRow[] = [];
  const scopeFolderIds = new Set<string | null>();
  const jobIds: string[] = [];
  let queued = false;
  let totalItems = 0;
  let syncSeq: number | null = null;

  for (const [parentId, groupItems] of groups.entries()) {
    const res = await copyWorkspaceItems(db, queue, user, {
      items: groupItems,
      targetParentId: parentId,
      conflictPolicy: 'rename',
    });
    copiedFolders.push(...res.copiedFolders);
    copiedFiles.push(...res.copiedFiles);
    for (const s of res.scopeFolderIds) scopeFolderIds.add(s);
    if (res.queued && res.jobId) {
      queued = true;
      jobIds.push(res.jobId);
    }
    totalItems += res.totalItems;
    if (res.syncSeq !== null) syncSeq = res.syncSeq;
  }

  return {
    ok: true,
    queued,
    ...(jobIds.length > 0 ? { jobId: jobIds[0] } : {}),
    jobIds,
    totalItems,
    copiedFolders,
    copiedFiles,
    syncSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}

/**
 * Process a bounded chunk (`ASYNC_COPY_CHUNK_NODES = 15`) of a queued large subtree copy
 * so each Cloudflare Queue invocation finishes comfortably within Workers 10ms CPU limits.
 */
