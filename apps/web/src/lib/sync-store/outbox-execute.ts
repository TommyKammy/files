import {
  batchMoveWorkspaceItems,
  copyWorkspaceItems,
  createFolder,
  duplicateWorkspaceItems,
  moveFolder,
  restoreFile,
  restoreFolder,
  softDeleteFile,
  softDeleteFolder,
  updateFileClassification,
  updateFileMetadata,
  updateFolder,
} from '@/lib/files-api';
import type { OutboxExecutionResult } from '@/lib/mutation-outbox';
import type {
  BatchMoveWorkspaceResponse,
  ClassificationLabel,
  CopyWorkspaceResponse,
  FileItem,
  FolderSummary,
  OutboxMutationRecord,
  WorkspaceBatchItemRef,
  WorkspaceConflictPolicy,
} from '@/types/files';

export interface OutboxExecuteContext {
  idAliasMap: Map<string, string>;
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  createFolderFn: typeof createFolder;
  updateFolderFn: typeof updateFolder;
  softDeleteFolderFn: typeof softDeleteFolder;
  restoreFolderFn: typeof restoreFolder;
  updateFileMetadataFn: typeof updateFileMetadata;
  updateFileClassificationFn: typeof updateFileClassification;
  moveFolderFn: typeof moveFolder;
  batchMoveFn: typeof batchMoveWorkspaceItems;
  copyItemsFn: typeof copyWorkspaceItems;
  duplicateItemsFn: typeof duplicateWorkspaceItems;
  softDeleteFileFn: typeof softDeleteFile;
  restoreFileFn: typeof restoreFile;
}

export async function executeOutboxMutation(
  item: OutboxMutationRecord,
  ctx: OutboxExecuteContext
): Promise<OutboxExecutionResult | void> {
  const resolvedId = ctx.idAliasMap.get(item.entityId) ?? item.entityId;
  const p = item.payload;

  switch (item.kind) {
    case 'folder.create': {
      const res = await ctx.createFolderFn({
        parentId: (p.parentId as string | null) ?? null,
        name: String(p.name),
        classification: p.classification as ClassificationLabel | undefined,
      });
      const finalFolder =
        p.isPinned && res.folder.is_pinned !== 1
          ? (
              await ctx.updateFolderFn(res.folder.id, {
                isPinned: true,
                expectedVersion: res.folder.version,
              })
            ).folder
          : res.folder;
      return { folder: finalFolder };
    }
    case 'folder.patch': {
      return ctx.updateFolderFn(resolvedId, {
        name: typeof p.name === 'string' ? p.name : undefined,
        isPinned: typeof p.isPinned === 'boolean' ? p.isPinned : undefined,
        expectedVersion: item.expectedVersion,
      });
    }
    case 'folder.soft_delete': {
      await ctx.softDeleteFolderFn(resolvedId, item.expectedVersion);
      return;
    }
    case 'folder.restore': {
      await ctx.restoreFolderFn(
        resolvedId,
        (p.conflictPolicy as 'fail' | 'rename' | undefined) ?? 'rename'
      );
      return;
    }
    case 'file.patch': {
      return ctx.updateFileMetadataFn(resolvedId, {
        name: typeof p.name === 'string' ? p.name : undefined,
        folderId:
          p.folderId !== undefined
            ? (p.folderId as string | null)
            : undefined,
        expectedVersion: item.expectedVersion,
      });
    }
    case 'file.classification': {
      if (p.acceptSuggestion === true) {
        const res = await ctx.updateFileClassificationFn(resolvedId, {
          acceptSuggestion: true,
          expectedVersion: item.expectedVersion,
        });
        return { file: res.file };
      }
      const res = await ctx.updateFileClassificationFn(resolvedId, {
        classification: p.classification as Exclude<
          ClassificationLabel,
          'unset'
        >,
        expectedVersion: item.expectedVersion,
      });
      return { file: res.file };
    }
    case 'folder.move': {
      const live = ctx.foldersById.get(resolvedId);
      const res = await ctx.moveFolderFn(resolvedId, {
        targetParentId: (p.targetParentId as string | null) ?? null,
        expectedVersion:
          live && !live.optimistic ? live.version : item.expectedVersion,
      });
      return { folder: res.folder };
    }
    case 'file.move':
    case 'workspace.batch_move': {
      const rawRefs = (p.items as WorkspaceBatchItemRef[]) ?? [];
      const hydratedRefs = rawRefs.map((ref) => {
        const realId = ctx.idAliasMap.get(ref.id) ?? ref.id;
        if (ref.type === 'folder') {
          const live = ctx.foldersById.get(realId);
          return {
            ...ref,
            id: realId,
            expectedVersion:
              live && !live.optimistic ? live.version : ref.expectedVersion,
          };
        }
        const live = ctx.filesById.get(realId);
        return {
          ...ref,
          id: realId,
          expectedVersion:
            live && !live.optimistic ? live.meta_version : ref.expectedVersion,
        };
      });
      const res: BatchMoveWorkspaceResponse = await ctx.batchMoveFn({
        items: hydratedRefs,
        targetParentId: (p.targetParentId as string | null) ?? null,
        conflictPolicy:
          (p.conflictPolicy as WorkspaceConflictPolicy | undefined) ?? 'fail',
      });
      return {
        movedFolders: res.movedFolders,
        movedFiles: res.movedFiles,
      };
    }
    case 'workspace.copy': {
      const rawItems =
        (p.items as Array<{ type: 'file' | 'folder'; id: string }>) ?? [];
      const mappedItems = rawItems.map((entry) => ({
        type: entry.type,
        id: ctx.idAliasMap.get(entry.id) ?? entry.id,
      }));
      const res: CopyWorkspaceResponse = p.duplicateInPlace
        ? await ctx.duplicateItemsFn({ items: mappedItems })
        : await ctx.copyItemsFn({
            items: mappedItems,
            targetParentId: (p.targetParentId as string | null) ?? null,
            conflictPolicy:
              (p.conflictPolicy as WorkspaceConflictPolicy | undefined) ??
              'rename',
          });
      return {
        copiedFolders: res.copiedFolders,
        copiedFiles: res.copiedFiles,
        queued: res.queued,
        jobId: res.jobId,
      };
    }
    case 'file.soft_delete': {
      await ctx.softDeleteFileFn(resolvedId, item.expectedVersion);
      return;
    }
    case 'file.restore': {
      const res = await ctx.restoreFileFn(resolvedId);
      return { file: res.file };
    }
  }
}
