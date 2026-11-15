import type { OutboxExecutionResult } from '@/lib/mutation-outbox';
import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import type {
  FileItem,
  FolderSummary,
  OutboxMutationRecord,
  WorkspaceToastItem,
} from '@/types/files';

function dirKeyForFolder(folderId: string | null): string {
  return folderId ?? '__ROOT__';
}

function removeFromIdList(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

function replaceIdInList(
  list: string[],
  tempId: string,
  realId: string
): string[] {
  const withoutReal = list.filter((x) => x !== realId);
  const idx = withoutReal.indexOf(tempId);
  if (idx === -1) {
    return list.includes(realId) ? list : [realId, ...list];
  }
  const next = [...withoutReal];
  next[idx] = realId;
  return next;
}

export interface OutboxSuccessContext {
  idAliasMap: Map<string, string>;
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  rootFolderIds: string[];
  cancelledCopyMutationIds: Set<string>;
  copiedRootsByMutationId: Map<
    string,
    { folders: FolderSummary[]; files: FileItem[] }
  >;
  removeFolderFromCache: (folder: FolderSummary) => void;
  removeFileFromCache: (fileId: string, folderId: string | null) => void;
  upsertFolderInCache: (folder: FolderSummary) => void;
  upsertFileInCache: (file: FileItem) => void;
  markCachedSubtreeStale: (folderId: string) => void;
  scheduleAsyncCopyJobPoll: (
    jobId: string,
    refreshFolderIds: Array<string | null>,
    totalItems: number
  ) => void;
  syncDelta: () => void;
  ensureDirectoryLoadedForce: (folderId: string | null) => void;
  softDeleteFolder: (folderId: string, version: number | undefined) => void;
  softDeleteFile: (fileId: string, version: number | undefined) => void;
}

export function applyOutboxSuccess(
  item: OutboxMutationRecord,
  result: OutboxExecutionResult | void,
  ctx: OutboxSuccessContext
): void {
  if (item.kind === 'folder.create' && result?.folder) {
    ctx.idAliasMap.set(item.entityId, result.folder.id);
    const oldTemp = ctx.foldersById.get(item.entityId);
    if (oldTemp) {
      ctx.removeFolderFromCache(oldTemp);
    }
    ctx.upsertFolderInCache({ ...result.folder, optimistic: false });
    return;
  }

  if (item.kind === 'folder.restore') {
    ctx.syncDelta();
    const parentId =
      (item.payload.parentId as string | null | undefined) ?? null;
    ctx.ensureDirectoryLoadedForce(parentId);
    return;
  }

  if (item.kind === 'file.move' || item.kind === 'workspace.batch_move') {
    if (result?.movedFolders) {
      for (const folder of result.movedFolders) {
        const existing = ctx.foldersById.get(folder.id);
        ctx.upsertFolderInCache({
          ...folder,
          effectiveRole: folder.effectiveRole ?? existing?.effectiveRole,
          optimistic: false,
        });
        ctx.markCachedSubtreeStale(folder.id);
      }
    }
    if (result?.movedFiles) {
      for (const file of result.movedFiles) {
        ctx.upsertFileInCache({
          ...file,
          upload_state: 'active',
          optimistic: false,
        });
      }
    }
    return;
  }

  if (item.kind === 'workspace.copy') {
    const tempFolderIds = (item.payload.tempFolderIds as string[]) ?? [];
    const tempFileIds = (item.payload.tempFileIds as string[]) ?? [];
    const copiedFolders = result?.copiedFolders ?? [];
    const copiedFiles = result?.copiedFiles ?? [];

    const copiedFolderIdSet = new Set(copiedFolders.map((f) => f.id));
    const rootCopiedFolders = copiedFolders.filter(
      (f) => f.parent_id === null || !copiedFolderIdSet.has(f.parent_id)
    );
    const rootCopiedFiles = copiedFiles.filter(
      (fl) =>
        fl.folder_id === null || !copiedFolderIdSet.has(fl.folder_id)
    );

    // If user already triggered Undo while HTTP copy was in-flight, delete server roots cleanly
    if (ctx.cancelledCopyMutationIds.has(item.id)) {
      ctx.cancelledCopyMutationIds.delete(item.id);
      for (const tmpId of tempFolderIds) {
        const tmp = ctx.foldersById.get(tmpId);
        if (tmp) ctx.removeFolderFromCache(tmp);
      }
      for (const tmpId of tempFileIds) {
        const tmp = ctx.filesById.get(tmpId);
        if (tmp) ctx.removeFileFromCache(tmp.id, tmp.folder_id);
      }
      for (const f of rootCopiedFolders) {
        ctx.softDeleteFolder(f.id, f.version);
      }
      for (const fl of rootCopiedFiles) {
        ctx.softDeleteFile(fl.id, fl.meta_version);
      }
      return;
    }

    if (result?.queued && result.jobId) {
      const refreshSet = new Set<string | null>([
        (item.payload.targetParentId as string | null | undefined) ?? null,
      ]);
      for (const tmpId of tempFolderIds) {
        const tmp = ctx.foldersById.get(tmpId);
        if (tmp) {
          refreshSet.add(tmp.parent_id);
          ctx.removeFolderFromCache(tmp);
        }
      }
      for (const tmpId of tempFileIds) {
        const tmp = ctx.filesById.get(tmpId);
        if (tmp) {
          refreshSet.add(tmp.folder_id);
          ctx.removeFileFromCache(tmp.id, tmp.folder_id);
        }
      }
      const rawItems =
        (item.payload.items as Array<{ type: 'file' | 'folder'; id: string }>) ??
        [];
      ctx.scheduleAsyncCopyJobPoll(
        result.jobId,
        Array.from(refreshSet),
        Math.max(
          rawItems.length,
          copiedFolders.length + copiedFiles.length
        )
      );
      return;
    }

    rootCopiedFolders.forEach((realFolder, idx) => {
      const tempId = tempFolderIds[idx];
      if (tempId) {
        ctx.idAliasMap.set(tempId, realFolder.id);
        ctx.foldersById.delete(tempId);
        const dir = ctx.directoriesByKey.get(
          dirKeyForFolder(realFolder.parent_id)
        );
        if (dir) {
          dir.folderIds = replaceIdInList(
            dir.folderIds,
            tempId,
            realFolder.id
          );
        }
        if (realFolder.parent_id === null) {
          ctx.rootFolderIds = replaceIdInList(
            ctx.rootFolderIds,
            tempId,
            realFolder.id
          );
        }
      }
    });

    rootCopiedFiles.forEach((realFile, idx) => {
      const tempId = tempFileIds[idx];
      if (tempId) {
        ctx.idAliasMap.set(tempId, realFile.id);
        ctx.filesById.delete(tempId);
        const dir = ctx.directoriesByKey.get(
          dirKeyForFolder(realFile.folder_id)
        );
        if (dir) {
          dir.fileIds = replaceIdInList(
            dir.fileIds,
            tempId,
            realFile.id
          );
        }
      }
    });

    // Remove any leftover unmatched temp nodes
    for (const tmpId of tempFolderIds) {
      if (ctx.foldersById.has(tmpId)) {
        const tmp = ctx.foldersById.get(tmpId)!;
        ctx.removeFolderFromCache(tmp);
      }
    }
    for (const tmpId of tempFileIds) {
      if (ctx.filesById.has(tmpId)) {
        const tmp = ctx.filesById.get(tmpId)!;
        ctx.removeFileFromCache(tmp.id, tmp.folder_id);
      }
    }

    for (const folder of copiedFolders) {
      ctx.upsertFolderInCache({
        ...folder,
        effectiveRole: folder.effectiveRole ?? 'owner',
        optimistic: false,
      });
    }
    for (const file of copiedFiles) {
      ctx.upsertFileInCache({
        ...file,
        upload_state: 'active',
        optimistic: false,
      });
    }

    ctx.copiedRootsByMutationId.set(item.id, {
      folders: rootCopiedFolders,
      files: rootCopiedFiles,
    });
    return;
  }

  if (result?.folder) {
    const existing = ctx.foldersById.get(result.folder.id);
    ctx.upsertFolderInCache({
      ...result.folder,
      effectiveRole: result.folder.effectiveRole ?? existing?.effectiveRole,
      optimistic: false,
    });
  } else if (result?.file) {
    ctx.upsertFileInCache({
      ...result.file,
      upload_state: 'active',
      optimistic: false,
    });
  }
}

export interface OutboxRollbackContext {
  idAliasMap: Map<string, string>;
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  rootFolderIds: string[];
  removeFolderFromCache: (folder: FolderSummary) => void;
  removeFileFromCache: (fileId: string, folderId: string | null) => void;
  upsertFolderInCache: (folder: FolderSummary) => void;
  upsertFileInCache: (file: FileItem) => void;
  markCachedSubtreeStale: (folderId: string) => void;
  pushToast: (toast: Omit<WorkspaceToastItem, 'id'>, ttlMs?: number) => void;
  syncDelta: () => void;
}

export function applyOutboxRollback(
  item: OutboxMutationRecord,
  error: unknown,
  ctx: OutboxRollbackContext,
  latestFromServer?: FolderSummary | FileItem
): void {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;
  const message =
    error instanceof Error && error.message
      ? error.message
      : '変更の保存に失敗しました';

  if (item.kind === 'workspace.copy') {
    for (const tmpId of item.rollback?.tempFolderIds ?? []) {
      const tmp = ctx.foldersById.get(tmpId);
      if (tmp) ctx.removeFolderFromCache(tmp);
    }
    for (const tmpId of item.rollback?.tempFileIds ?? []) {
      const tmp = ctx.filesById.get(tmpId);
      if (tmp) ctx.removeFileFromCache(tmp.id, tmp.folder_id);
    }
  } else if (
    item.kind === 'folder.move' ||
    item.kind === 'file.move' ||
    item.kind === 'workspace.batch_move'
  ) {
    const targetParentId = item.rollback?.targetParentId ?? null;
    const targetDir = ctx.directoriesByKey.get(
      dirKeyForFolder(targetParentId)
    );
    for (const origFolder of item.rollback?.folders ?? []) {
      if (targetDir) {
        targetDir.folderIds = removeFromIdList(
          targetDir.folderIds,
          origFolder.id
        );
      }
      if (targetParentId === null && origFolder.parent_id !== null) {
        ctx.rootFolderIds = removeFromIdList(
          ctx.rootFolderIds,
          origFolder.id
        );
      }
      ctx.upsertFolderInCache(origFolder);
      ctx.markCachedSubtreeStale(origFolder.id);
    }
    for (const origFile of item.rollback?.files ?? []) {
      if (targetDir) {
        targetDir.fileIds = removeFromIdList(
          targetDir.fileIds,
          origFile.id
        );
      }
      ctx.upsertFileInCache(origFile);
    }
    if (latestFromServer) {
      if (item.entityType === 'folder') {
        const existing = ctx.foldersById.get(latestFromServer.id);
        ctx.upsertFolderInCache({
          ...(latestFromServer as FolderSummary),
          effectiveRole:
            (latestFromServer as FolderSummary).effectiveRole ??
            existing?.effectiveRole,
        });
      } else {
        ctx.upsertFileInCache(latestFromServer as FileItem);
      }
    }
  } else if (item.entityType === 'folder') {
    if (item.kind === 'folder.create') {
      const temp = ctx.foldersById.get(item.entityId);
      if (temp) {
        ctx.removeFolderFromCache(temp);
      }
    } else if (latestFromServer) {
      const existing = ctx.foldersById.get(latestFromServer.id);
      ctx.upsertFolderInCache({
        ...(latestFromServer as FolderSummary),
        effectiveRole:
          (latestFromServer as FolderSummary).effectiveRole ??
          existing?.effectiveRole,
      });
    } else if (item.rollback?.folder) {
      ctx.upsertFolderInCache(item.rollback.folder);
    } else if (item.kind === 'folder.restore') {
      const folderId = ctx.idAliasMap.get(item.entityId) ?? item.entityId;
      const f = ctx.foldersById.get(folderId);
      if (f) ctx.removeFolderFromCache(f);
    }
  } else if (item.entityType === 'file') {
    if (latestFromServer) {
      ctx.upsertFileInCache(latestFromServer as FileItem);
    } else if (item.rollback?.file) {
      ctx.upsertFileInCache(item.rollback.file);
    } else if (item.kind === 'file.restore') {
      ctx.removeFileFromCache(
        item.entityId,
        item.rollback?.parentId ?? null
      );
    }
  }

  const prefix =
    status === 409
      ? '別のユーザーによる更新と競合したため最新状態にロールバックしました'
      : status === 403
        ? '権限またはポリシー制限により変更が拒否されました'
        : '変更を保存できなかったためロールバックしました';

  ctx.pushToast(
    {
      kind: status === 409 ? 'warning' : 'error',
      message: `${prefix}: ${message}`,
    },
    8000
  );

  ctx.syncDelta();
}
