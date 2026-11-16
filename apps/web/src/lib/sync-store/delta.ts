import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import type {
  ClassificationLabel,
  FileItem,
  FolderSummary,
  SyncDeltaItem,
} from '@/types/files';

export interface DeltaCacheContext {
  userId: string | undefined;
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  rootFolderIds: string[];
  pinnedFolderIds: string[];
  activeDirKey: string;
  setActiveDirectoryNotice: (notice: string | null) => void;
  evictSubtreeFromCache: (folderId: string) => boolean;
  bootstrapForce: () => void;
  upsertFolderInCache: (folder: FolderSummary) => void;
  upsertFileInCache: (file: FileItem) => void;
}

export function dirKeyForDeltaFolder(folderId: string | null): string {
  return folderId ?? '__ROOT__';
}

function dedupePush(list: string[], id: string, prepend = false): string[] {
  const filtered = list.filter((x) => x !== id);
  return prepend ? [id, ...filtered] : [...filtered, id];
}

function removeFromIdList(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

/**
 * Purging a folder removes the whole subtree from the server. Directory
 * eviction already handles visible caches; also drop descendant folder/file
 * metadata so content-visibility and inspector lookups cannot resurrect rows.
 */
function purgeFolderSubtreeMetadata(
  ctx: DeltaCacheContext,
  rootFolderId: string
): void {
  const removedFolderIds = new Set<string>([rootFolderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, folder] of ctx.foldersById) {
      if (
        !removedFolderIds.has(id) &&
        folder.parent_id !== null &&
        removedFolderIds.has(folder.parent_id)
      ) {
        removedFolderIds.add(id);
        changed = true;
      }
    }
    for (const [key, dir] of ctx.directoriesByKey) {
      if (removedFolderIds.has(key)) continue;
      if (
        (dir.folderId !== null && removedFolderIds.has(dir.folderId)) ||
        dir.breadcrumbs.some((crumb) => removedFolderIds.has(crumb.id))
      ) {
        removedFolderIds.add(key);
        changed = true;
      }
    }
  }

  const removedFileIds = new Set<string>();
  for (const [id, file] of ctx.filesById) {
    if (file.folder_id !== null && removedFolderIds.has(file.folder_id)) {
      removedFileIds.add(id);
      ctx.filesById.delete(id);
    }
  }
  for (const id of removedFolderIds) {
    ctx.foldersById.delete(id);
  }
  ctx.rootFolderIds = ctx.rootFolderIds.filter(
    (id) => !removedFolderIds.has(id)
  );
  ctx.pinnedFolderIds = ctx.pinnedFolderIds.filter(
    (id) => !removedFolderIds.has(id)
  );

  for (const dir of ctx.directoriesByKey.values()) {
    dir.folderIds = dir.folderIds.filter((id) => !removedFolderIds.has(id));
    dir.fileIds = dir.fileIds.filter((id) => !removedFileIds.has(id));
  }
}

/**
 * Shared projection for `file.version_finalized` (WOPI save) and
 * `file.version_restored` (historical version restore): both replace the
 * current version pointer, size, MIME type and optimistic `meta_version`.
 */
function applyFileVersionDelta(
  ctx: DeltaCacheContext,
  change: SyncDeltaItem,
  p: Record<string, unknown>,
  targetFolderId: string | null
): boolean {
  const existing = ctx.filesById.get(change.entityId);
  if (existing) {
    ctx.filesById.set(change.entityId, {
      ...existing,
      folder_id: targetFolderId,
      size_bytes:
        typeof p.sizeBytes === 'number' ? p.sizeBytes : existing.size_bytes,
      mime_type:
        typeof p.mimeType === 'string' ? p.mimeType : existing.mime_type,
      current_version_num:
        typeof p.currentVersionNum === 'number'
          ? p.currentVersionNum
          : existing.current_version_num + 1,
      meta_version:
        typeof p.metaVersion === 'number'
          ? p.metaVersion
          : (existing.meta_version ?? 1) + 1,
      updated_at:
        typeof p.updatedAt === 'string' ? p.updatedAt : change.createdAt,
    });
    return false;
  }

  const dir = ctx.directoriesByKey.get(dirKeyForDeltaFolder(targetFolderId));
  if (!dir) return false;
  dir.stale = true;
  return dirKeyForDeltaFolder(targetFolderId) === ctx.activeDirKey;
}

export function applyDeltaChangesToCache(
  changes: SyncDeltaItem[],
  ctx: DeltaCacheContext
): {
  shouldRevokeAll: boolean;
  shouldRevalidateActive: boolean;
} {
  let shouldRevokeAll = false;
  let shouldRevalidateActive = false;
  const myUserId = ctx.userId;

  for (const change of changes) {
    const p = change.payload ?? {};

    if (change.entityType === 'user') {
      if (change.action === 'user.suspended' && change.entityId === myUserId) {
        shouldRevokeAll = true;
        break;
      }
      continue;
    }

    if (change.entityType === 'policy') {
      ctx.bootstrapForce();
      continue;
    }

    if (change.entityType === 'permission') {
      const targetType = p.targetType as 'folder' | 'file' | undefined;
      const targetId = p.targetId as string | undefined;
      const granteeType = p.granteeType as 'user' | 'group' | undefined;

      if (change.action === 'permission.revoke' && targetType && targetId) {
        const affectsMe =
          (granteeType === 'user' && change.targetUserId === myUserId) ||
          granteeType === 'group';
        if (affectsMe) {
          if (targetType === 'folder') {
            const hitActive = ctx.evictSubtreeFromCache(targetId);
            if (hitActive) {
              shouldRevalidateActive = true;
              ctx.setActiveDirectoryNotice(
                'このフォルダへのアクセス権限が変更されました'
              );
            }
          } else {
            ctx.filesById.delete(targetId);
            const dir = ctx.directoriesByKey.get(
              dirKeyForDeltaFolder(change.folderId)
            );
            if (dir) {
              dir.fileIds = removeFromIdList(dir.fileIds, targetId);
            }
          }
        }
      } else if (
        (change.action === 'permission.grant' ||
          change.action === 'permission.update') &&
        targetId
      ) {
        if (targetType === 'folder') {
          const dir = ctx.directoriesByKey.get(targetId);
          if (dir) dir.stale = true;
          if (change.targetUserId === myUserId) {
            const root = ctx.directoriesByKey.get('__ROOT__');
            if (root) root.stale = true;
            if (
              ctx.activeDirKey === '__ROOT__' ||
              ctx.activeDirKey === targetId
            ) {
              shouldRevalidateActive = true;
            }
          }
        }
      }
      continue;
    }

    if (change.entityType === 'folder') {
      if (change.action === 'folder.create') {
        const folder = p.folder as FolderSummary | undefined;
        if (folder) {
          ctx.foldersById.set(folder.id, folder);
          const parentDir = ctx.directoriesByKey.get(
            dirKeyForDeltaFolder(folder.parent_id)
          );
          if (parentDir && !parentDir.folderIds.includes(folder.id)) {
            parentDir.folderIds = dedupePush(parentDir.folderIds, folder.id);
          }
          if (folder.parent_id === null) {
            ctx.rootFolderIds = dedupePush(ctx.rootFolderIds, folder.id);
          }
        } else {
          const dir = ctx.directoriesByKey.get(
            dirKeyForDeltaFolder(change.folderId)
          );
          if (dir) dir.stale = true;
          if (
            dirKeyForDeltaFolder(change.folderId) === ctx.activeDirKey
          ) {
            shouldRevalidateActive = true;
          }
        }
        continue;
      }

      if (
        change.action === 'folder.update' ||
        change.action === 'folder.classification_propagated'
      ) {
        const existing = ctx.foldersById.get(change.entityId);
        if (existing) {
          const nextPinned =
            typeof p.isPinned === 'number' ? p.isPinned : existing.is_pinned;
          const updated: FolderSummary = {
            ...existing,
            name: typeof p.name === 'string' ? p.name : existing.name,
            is_pinned: nextPinned,
            classification:
              (p.classification as ClassificationLabel | undefined) ??
              existing.classification,
            version:
              typeof p.version === 'number' ? p.version : existing.version + 1,
            updated_at:
              typeof p.updatedAt === 'string' ? p.updatedAt : change.createdAt,
          };
          ctx.foldersById.set(change.entityId, updated);
          if (nextPinned === 1) {
            ctx.pinnedFolderIds = dedupePush(
              ctx.pinnedFolderIds,
              change.entityId
            );
          } else if (typeof p.isPinned === 'number') {
            ctx.pinnedFolderIds = removeFromIdList(
              ctx.pinnedFolderIds,
              change.entityId
            );
          }
        }
        continue;
      }

      if (change.action === 'folder.moved_out') {
        const oldDir = ctx.directoriesByKey.get(
          dirKeyForDeltaFolder(change.folderId)
        );
        if (oldDir) {
          oldDir.folderIds = removeFromIdList(
            oldDir.folderIds,
            change.entityId
          );
        }
        continue;
      }

      if (change.action === 'folder.move') {
        const fromParentId = (p.fromParentId as string | null | undefined) ?? null;
        const toParentId =
          (p.toParentId as string | null | undefined) ?? change.folderId;
        const oldDir = ctx.directoriesByKey.get(
          dirKeyForDeltaFolder(fromParentId)
        );
        if (oldDir) {
          oldDir.folderIds = removeFromIdList(
            oldDir.folderIds,
            change.entityId
          );
        }
        const existing = ctx.foldersById.get(change.entityId);
        if (existing) {
          ctx.foldersById.set(change.entityId, {
            ...existing,
            parent_id: toParentId,
            name: typeof p.name === 'string' ? p.name : existing.name,
            classification:
              (p.classification as ClassificationLabel | undefined) ??
              existing.classification,
            version:
              typeof p.version === 'number'
                ? Math.max(existing.version, p.version)
                : existing.version,
            updated_at:
              typeof p.updatedAt === 'string' ? p.updatedAt : change.createdAt,
          });
          if (fromParentId === null && toParentId !== null) {
            ctx.rootFolderIds = removeFromIdList(
              ctx.rootFolderIds,
              change.entityId
            );
          } else if (toParentId === null) {
            ctx.rootFolderIds = dedupePush(
              ctx.rootFolderIds,
              change.entityId,
              true
            );
          }
          const newDir = ctx.directoriesByKey.get(
            dirKeyForDeltaFolder(toParentId)
          );
          if (newDir && !newDir.folderIds.includes(change.entityId)) {
            newDir.folderIds = dedupePush(newDir.folderIds, change.entityId);
          }
        }
        const cachedTargetDir = ctx.directoriesByKey.get(change.entityId);
        if (cachedTargetDir) {
          cachedTargetDir.stale = true;
          if (ctx.activeDirKey === change.entityId) {
            shouldRevalidateActive = true;
          }
        }
        continue;
      }

      if (change.action === 'folder.soft_delete') {
        const hitActive = ctx.evictSubtreeFromCache(change.entityId);
        if (hitActive) {
          ctx.setActiveDirectoryNotice(
            'このフォルダは別のユーザーによって削除されました'
          );
        }
        continue;
      }

      if (change.action === 'folder.purged') {
        purgeFolderSubtreeMetadata(ctx, change.entityId);
        const hitActive = ctx.evictSubtreeFromCache(change.entityId);
        if (hitActive) {
          ctx.setActiveDirectoryNotice(
            'このフォルダは完全削除されました'
          );
          shouldRevalidateActive = true;
        }
        continue;
      }

      if (change.action === 'folder.restore') {
        const folder = p.folder as FolderSummary | undefined;
        if (folder) {
          ctx.upsertFolderInCache(folder);
        } else {
          const parent = ctx.directoriesByKey.get(
            dirKeyForDeltaFolder(change.folderId)
          );
          if (parent) parent.stale = true;
        }
        continue;
      }
    }

    if (change.entityType === 'file') {
      const targetFolderId =
        p.folderId !== undefined
          ? (p.folderId as string | null)
          : change.folderId;

      if (change.action === 'file.soft_delete') {
        ctx.filesById.delete(change.entityId);
        const dir = ctx.directoriesByKey.get(
          dirKeyForDeltaFolder(change.folderId)
        );
        if (dir) {
          dir.fileIds = removeFromIdList(dir.fileIds, change.entityId);
        }
        continue;
      }

      if (change.action === 'file.purged') {
        ctx.filesById.delete(change.entityId);
        const dir = ctx.directoriesByKey.get(
          dirKeyForDeltaFolder(change.folderId)
        );
        if (dir) {
          dir.fileIds = removeFromIdList(dir.fileIds, change.entityId);
        }
        if (
          dirKeyForDeltaFolder(change.folderId) === ctx.activeDirKey
        ) {
          shouldRevalidateActive = true;
        }
        continue;
      }

      if (change.action === 'file.moved_out') {
        const oldDir = ctx.directoriesByKey.get(
          dirKeyForDeltaFolder(change.folderId)
        );
        if (oldDir) {
          oldDir.fileIds = removeFromIdList(oldDir.fileIds, change.entityId);
        }
        continue;
      }

      if (change.action === 'file.upload_complete') {
        const item: FileItem = {
          id: change.entityId,
          folder_id: targetFolderId,
          name: String(p.name ?? 'untitled'),
          extension: (p.extension as string | null) ?? null,
          mime_type: (p.mimeType as string | null) ?? null,
          size_bytes: Number(p.sizeBytes ?? 0),
          current_version_num: Number(p.currentVersionNum ?? 1),
          meta_version: Number(p.metaVersion ?? 1),
          classification:
            (p.classification as ClassificationLabel) ?? 'unset',
          ai_suggested_label: null,
          ai_confidence: null,
          ai_reason: null,
          updated_at: String(p.updatedAt ?? change.createdAt),
        };
        ctx.upsertFileInCache(item);
        continue;
      }

      if (
        change.action === 'file.version_finalized' ||
        change.action === 'file.version_restored'
      ) {
        if (applyFileVersionDelta(ctx, change, p, targetFolderId)) {
          shouldRevalidateActive = true;
        }
        continue;
      }

      if (change.action === 'file.update') {
        const prevFolderId = p.previousFolderId as string | null | undefined;
        if (prevFolderId !== undefined && prevFolderId !== targetFolderId) {
          const oldDir = ctx.directoriesByKey.get(
            dirKeyForDeltaFolder(prevFolderId)
          );
          if (oldDir) {
            oldDir.fileIds = removeFromIdList(
              oldDir.fileIds,
              change.entityId
            );
          }
        }

        const existing = ctx.filesById.get(change.entityId);
        if (existing) {
          const updated: FileItem = {
            ...existing,
            folder_id: targetFolderId,
            name: typeof p.name === 'string' ? p.name : existing.name,
            extension:
              p.extension !== undefined
                ? (p.extension as string | null)
                : existing.extension,
            classification:
              (p.classification as ClassificationLabel | undefined) ??
              existing.classification,
            meta_version:
              typeof p.metaVersion === 'number'
                ? p.metaVersion
                : (existing.meta_version ?? 1) + 1,
            updated_at:
              typeof p.updatedAt === 'string' ? p.updatedAt : change.createdAt,
          };
          ctx.upsertFileInCache(updated);
        } else {
          const newDir = ctx.directoriesByKey.get(
            dirKeyForDeltaFolder(targetFolderId)
          );
          if (newDir) {
            newDir.stale = true;
            if (
              dirKeyForDeltaFolder(targetFolderId) === ctx.activeDirKey
            ) {
              shouldRevalidateActive = true;
            }
          }
        }
        continue;
      }

      if (change.action === 'file.restore') {
        const dir = ctx.directoriesByKey.get(
          dirKeyForDeltaFolder(change.folderId)
        );
        if (dir) {
          dir.stale = true;
          if (dirKeyForDeltaFolder(change.folderId) === ctx.activeDirKey) {
            shouldRevalidateActive = true;
          }
        }
        continue;
      }

      if (change.action === 'ai.suggestion_recorded') {
        const existing = ctx.filesById.get(change.entityId);
        if (existing) {
          ctx.filesById.set(change.entityId, {
            ...existing,
            ai_suggested_label:
              (p.aiSuggestedLabel as ClassificationLabel | null) ??
              existing.ai_suggested_label,
            ai_confidence:
              typeof p.aiConfidence === 'number'
                ? p.aiConfidence
                : existing.ai_confidence,
            ai_reason:
              typeof p.aiReason === 'string'
                ? p.aiReason
                : existing.ai_reason,
            meta_version: (existing.meta_version ?? 1) + 1,
            updated_at:
              typeof p.updatedAt === 'string' ? p.updatedAt : change.createdAt,
          });
        }
        continue;
      }

      // Classification change actions (`file.classification_updated`, `ai.*`, `admin.*`)
      const existing = ctx.filesById.get(change.entityId);
      if (existing) {
        ctx.filesById.set(change.entityId, {
          ...existing,
          classification:
            (p.classification as ClassificationLabel | undefined) ??
            existing.classification,
          ...(p.clearSuggestion
            ? { ai_suggested_label: null, ai_confidence: null, ai_reason: null }
            : {}),
          meta_version: (existing.meta_version ?? 1) + 1,
          updated_at:
            typeof p.updatedAt === 'string' ? p.updatedAt : change.createdAt,
        });
      }
    }
  }

  return { shouldRevokeAll, shouldRevalidateActive };
}
