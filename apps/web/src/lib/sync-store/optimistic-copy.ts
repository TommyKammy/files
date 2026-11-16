import type { MutationOutbox } from '@/lib/mutation-outbox';
import type { UndoAction } from '@/lib/sync-store/toasts';
import {
  planOptimisticCopy,
  type CopyPlanningContext,
} from '@/lib/sync-store/optimistic-copy-plan';
import type {
  FileItem,
  FolderSummary,
  ResourceRole,
  WorkspaceConflictPolicy,
} from '@/types/files';

export interface OptimisticCopyContext {
  planning: CopyPlanningContext;
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  outbox: MutationOutbox;
  now: () => number;
  pushUndo: (entry: Omit<UndoAction, 'id'>, message: string) => void;
  makeId: (prefix: string) => string;
  copiedRootsByMutationId: Map<
    string,
    { folders: FolderSummary[]; files: FileItem[] }
  >;
  cancelledCopyMutationIds: Set<string>;
  removeFolderFromCache: (folder: FolderSummary) => void;
  removeFileFromCache: (fileId: string, folderId: string | null) => void;
  softDeleteFolder: (folder: FolderSummary) => void;
  softDeleteFile: (file: FileItem, role: ResourceRole) => void;
  resolveItemEffectiveRole: (
    type: 'file' | 'folder',
    item: FolderSummary | FileItem
  ) => ResourceRole;
  upsertFolderInCache: (folder: FolderSummary) => void;
  upsertFileInCache: (file: FileItem) => void;
}

export function optimisticCopyItems(
  ctx: OptimisticCopyContext,
  input: {
    items: Array<{ type: 'file' | 'folder'; id: string }>;
    targetParentId: string | null;
    mode?: 'copy' | 'duplicate';
    conflictPolicy?: WorkspaceConflictPolicy;
    skipUndo?: boolean;
  }
): {
  ok: boolean;
  error?: string;
  tempIds: string[];
  mutationId?: string;
} {
  const targetParentId = input.targetParentId;
  const plan = planOptimisticCopy(input, ctx.planning);

  if (!plan.ok) {
    return { ok: false, error: plan.error, tempIds: [] };
  }

  const {
    mutationId,
    tempFolderIds,
    tempFileIds,
    totalCount,
    duplicateInPlace,
  } = plan;

  for (const folder of plan.tempFolders) {
    ctx.upsertFolderInCache(folder);
  }
  for (const file of plan.tempFiles) {
    ctx.upsertFileInCache(file);
  }

  if (!input.skipUndo) {
    ctx.pushUndo(
      {
        label: 'コピーを取り消す',
        applyUndo: () => {
          const realRoots = ctx.copiedRootsByMutationId.get(mutationId);
          if (realRoots) {
            ctx.copiedRootsByMutationId.delete(mutationId);
            for (const folder of realRoots.folders) {
              const live = ctx.foldersById.get(folder.id) ?? folder;
              ctx.softDeleteFolder(live);
            }
            for (const file of realRoots.files) {
              const live = ctx.filesById.get(file.id) ?? file;
              const role = ctx.resolveItemEffectiveRole('file', live);
              ctx.softDeleteFile(live, role);
            }
            return;
          }

          const canceledFromQueue =
            ctx.outbox.cancelQueuedMutation(mutationId);
          if (!canceledFromQueue) {
            ctx.cancelledCopyMutationIds.add(mutationId);
          }
          for (const tmpId of tempFolderIds) {
            const tmp = ctx.foldersById.get(tmpId);
            if (tmp) ctx.removeFolderFromCache(tmp);
          }
          for (const tmpId of tempFileIds) {
            const tmp = ctx.filesById.get(tmpId);
            if (tmp) ctx.removeFileFromCache(tmp.id, tmp.folder_id);
          }
        },
      },
      totalCount === 1
        ? `1 件のアイテムを${duplicateInPlace ? '複製' : 'コピー'}しました`
        : `${totalCount} 件のアイテムを${duplicateInPlace ? '複製' : 'コピー'}しました`
    );
  }

  ctx.outbox.enqueue({
    id: mutationId,
    entityType: 'folder',
    entityId: `copy:${mutationId}`,
    involvedEntityKeys: plan.involvedEntityKeys,
    kind: 'workspace.copy',
    payload: {
      items: plan.apiItems,
      targetParentId,
      duplicateInPlace,
      conflictPolicy: plan.conflictPolicy,
      tempFolderIds,
      tempFileIds,
    },
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      tempFolderIds,
      tempFileIds,
      targetParentId,
    },
  });

  return {
    ok: true,
    tempIds: [...tempFolderIds, ...tempFileIds],
    mutationId,
  };
}
