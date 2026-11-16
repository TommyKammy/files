import type { MutationOutbox } from '@/lib/mutation-outbox';
import type { UndoAction } from '@/lib/sync-store/toasts';
import type {
  MovePlanningContext,
} from '@/lib/sync-store/optimistic-move-plan';
import { planOptimisticMove } from '@/lib/sync-store/optimistic-move-plan';
import { pickStricterClassification } from '@/lib/formatters';
import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import type {
  FileItem,
  FolderSummary,
  WorkspaceConflictPolicy,
} from '@/types/files';

export interface OptimisticMoveContext {
  planning: MovePlanningContext;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  getRootFolderIds: () => string[];
  setRootFolderIds: (ids: string[]) => void;
  upsertFolderInCache: (folder: FolderSummary) => void;
  upsertFileInCache: (file: FileItem) => void;
  markCachedSubtreeStale: (folderId: string) => void;
  outbox: MutationOutbox;
  now: () => number;
  pushUndo: (entry: Omit<UndoAction, 'id'>, message: string) => void;
  makeId: (prefix: string) => string;
  moveItems: (input: {
    items: Array<{ type: 'file' | 'folder'; id: string }>;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
    skipUndo?: boolean;
  }) => {
    ok: boolean;
    error?: string;
    movedCount: number;
    skippedCount: number;
  };
}

function dirKeyForFolder(folderId: string | null): string {
  return folderId ?? '__ROOT__';
}

function removeFromIdList(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

export function optimisticMoveItems(
  ctx: OptimisticMoveContext,
  input: {
    items: Array<{ type: 'file' | 'folder'; id: string }>;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
    skipUndo?: boolean;
    labelOverride?: string;
  }
): {
  ok: boolean;
  error?: string;
  movedCount: number;
  skippedCount: number;
} {
  const targetParentId = input.targetParentId;
  const conflictPolicy: WorkspaceConflictPolicy =
    input.conflictPolicy ?? 'fail';

  const plan = planOptimisticMove(input, ctx.planning);

  if (!plan.ok) {
    return {
      ok: false,
      error: plan.error,
      movedCount: 0,
      skippedCount: 0,
    };
  }
  if (plan.movedCount === 0) {
    return { ok: true, movedCount: 0, skippedCount: plan.skippedCount };
  }

  const { nowIso, destFloor, foldersToMove, filesToMove } = plan;

  for (const { prev, targetName } of foldersToMove) {
    const oldDir = ctx.directoriesByKey.get(
      dirKeyForFolder(prev.parent_id)
    );
    if (oldDir) {
      oldDir.folderIds = removeFromIdList(oldDir.folderIds, prev.id);
    }
    if (prev.parent_id === null && targetParentId !== null) {
      ctx.setRootFolderIds(
        removeFromIdList(ctx.getRootFolderIds(), prev.id)
      );
    }

    const nextFolder: FolderSummary = {
      ...prev,
      parent_id: targetParentId,
      name: targetName,
      classification:
        targetParentId !== null
          ? pickStricterClassification(prev.classification, destFloor)
          : prev.classification,
      updated_at: nowIso,
    };
    ctx.upsertFolderInCache(nextFolder);
    ctx.markCachedSubtreeStale(prev.id);
  }

  for (const { prev, targetName, targetExt } of filesToMove) {
    const oldDir = ctx.directoriesByKey.get(
      dirKeyForFolder(prev.folder_id)
    );
    if (oldDir) {
      oldDir.fileIds = removeFromIdList(oldDir.fileIds, prev.id);
    }

    const nextFile: FileItem = {
      ...prev,
      folder_id: targetParentId,
      name: targetName,
      extension: targetExt,
      classification:
        targetParentId !== null
          ? pickStricterClassification(prev.classification, destFloor)
          : prev.classification,
      updated_at: nowIso,
    };
    ctx.upsertFileInCache(nextFile);
  }

  const prevFolders = foldersToMove.map((m) => m.prev);
  const prevFiles = filesToMove.map((m) => m.prev);

  if (!input.skipUndo) {
    const undoGroups = new Map<
      string | null,
      Array<{ type: 'file' | 'folder'; id: string }>
    >();
    for (const f of prevFolders) {
      const list = undoGroups.get(f.parent_id) ?? [];
      list.push({ type: 'folder', id: f.id });
      undoGroups.set(f.parent_id, list);
    }
    for (const fl of prevFiles) {
      const list = undoGroups.get(fl.folder_id) ?? [];
      list.push({ type: 'file', id: fl.id });
      undoGroups.set(fl.folder_id, list);
    }

    const labelText =
      input.labelOverride ??
      (plan.movedCount === 1
        ? `「${foldersToMove[0]?.prev.name ?? filesToMove[0]?.prev.name}」を移動しました`
        : `${plan.movedCount} 件のアイテムを移動しました`);

    ctx.pushUndo(
      {
        label: '移動を元に戻す',
        applyUndo: () => {
          for (const [origParentId, origItems] of undoGroups.entries()) {
            ctx.moveItems({
              items: origItems,
              targetParentId: origParentId,
              conflictPolicy: 'fail',
              skipUndo: true,
            });
          }
        },
      },
      labelText
    );
  }

  const useSingleFolderMove =
    foldersToMove.length === 1 &&
    filesToMove.length === 0 &&
    conflictPolicy !== 'rename';

  if (useSingleFolderMove) {
    const f = foldersToMove[0]!.prev;
    ctx.outbox.enqueue({
      id: ctx.makeId('mut'),
      entityType: 'folder',
      entityId: f.id,
      kind: 'folder.move',
      payload: { fromParentId: f.parent_id, targetParentId },
      expectedVersion: f.version,
      createdAt: ctx.now(),
      retryCount: 0,
      rollback: {
        folder: f,
        folders: [f],
        files: [],
        targetParentId,
        existedBefore: true,
        parentId: f.parent_id,
      },
    });
  } else {
    const singleFileOnly =
      foldersToMove.length === 0 && filesToMove.length === 1;
    const mutId = ctx.makeId('mut');
    ctx.outbox.enqueue({
      id: mutId,
      entityType: singleFileOnly ? 'file' : 'folder',
      entityId: singleFileOnly
        ? filesToMove[0]!.prev.id
        : `batch:${mutId}`,
      involvedEntityKeys: plan.involvedEntityKeys,
      kind: singleFileOnly ? 'file.move' : 'workspace.batch_move',
      payload: {
        items: plan.batchRefs,
        targetParentId,
        conflictPolicy,
      },
      createdAt: ctx.now(),
      retryCount: 0,
      rollback: {
        folders: prevFolders,
        files: prevFiles,
        targetParentId,
        existedBefore: true,
      },
    });
  }

  return {
    ok: true,
    movedCount: plan.movedCount,
    skippedCount: plan.skippedCount,
  };
}
