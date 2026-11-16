import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import {
  matchesLocalSearchItem,
  parseSearchQuery,
} from '@/lib/keyboard-shortcuts';
import type {
  BreadcrumbItem,
  Capability,
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
  SearchResultItem,
} from '@/types/files';

export interface DirectoryViewModel {
  dirKey: string;
  folderId: string | null;
  existsInCache: boolean;
  isStale: boolean;
  folder: FolderSummary | null;
  effectiveRole: ResourceRole;
  capabilities?: Capability[];
  folders: FolderSummary[];
  files: FileItem[];
  breadcrumbs: BreadcrumbItem[];
  nextCursor: string | null;
}

const DEFAULT_SWR_TTL_MS = 15_000;

export interface CacheContext {
  authStatus: 'unknown' | 'authenticated' | 'unauthenticated';
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  rootFolderIds: string[];
  pinnedFolderIds: string[];
  now: () => number;
  pruneAndSchedulePersist: () => void;
  emit: () => void;
}

function dirKeyForFolder(folderId: string | null): string {
  return folderId ?? '__ROOT__';
}

function dedupePush(list: string[], id: string, prepend = false): string[] {
  const filtered = list.filter((x) => x !== id);
  return prepend ? [id, ...filtered] : [...filtered, id];
}

function removeFromIdList(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

export function getDirectoryView(
  ctx: CacheContext,
  folderId: string | null
): DirectoryViewModel {
  const dirKey = dirKeyForFolder(folderId);
  const record = ctx.directoriesByKey.get(dirKey);

  if (!record) {
    return {
      dirKey,
      folderId,
      existsInCache: false,
      isStale: true,
      folder: folderId ? ctx.foldersById.get(folderId) ?? null : null,
      effectiveRole: folderId
        ? ctx.foldersById.get(folderId)?.effectiveRole ?? 'viewer'
        : 'editor',
      capabilities: folderId
        ? ctx.foldersById.get(folderId)?.capabilities
        : undefined,
      folders: [],
      files: [],
      breadcrumbs: [],
      nextCursor: null,
    };
  }

  const folders: FolderSummary[] = [];
  for (const id of record.folderIds) {
    const f = ctx.foldersById.get(id);
    if (f && f.deleted_at == null) folders.push(f);
  }
  const files: FileItem[] = [];
  for (const id of record.fileIds) {
    const fl = ctx.filesById.get(id);
    if (fl && fl.deleted_at == null) files.push(fl);
  }

  return {
    dirKey,
    folderId,
    existsInCache: true,
    isStale: Boolean(record.stale),
    folder: folderId ? ctx.foldersById.get(folderId) ?? null : null,
    effectiveRole: record.effectiveRole,
    capabilities: record.capabilities,
    folders,
    files,
    breadcrumbs: record.breadcrumbs,
    nextCursor: record.nextCursor,
  };
}

export function getPinnedFolders(ctx: CacheContext): FolderSummary[] {
  const list: FolderSummary[] = [];
  for (const id of ctx.pinnedFolderIds) {
    const folder = ctx.foldersById.get(id);
    if (folder && folder.deleted_at == null) {
      list.push(folder);
    }
  }
  return list;
}

/**
 * 0ms synchronous search over the hydrated local working set (cached folders and files),
 * excluding deleted items and in-flight pending uploads.
 */
export function searchCachedWorkspaceItems(
  ctx: CacheContext,
  query: string,
  limit = 20
): {
  folders: Array<{ folder: FolderSummary; pathHint: string }>;
  files: SearchResultItem[];
} {
  if (ctx.authStatus !== 'authenticated') {
    return { folders: [], files: [] };
  }
  const parsed = parseSearchQuery(query);
  if (parsed.isCommandMode) {
    return { folders: [], files: [] };
  }

  const buildPathHint = (parentId: string | null): string => {
    if (!parentId) return 'ルート';
    const parts: string[] = [];
    let cursor: string | null = parentId;
    let guard = 0;
    while (cursor && guard < 10) {
      guard += 1;
      const f = ctx.foldersById.get(cursor);
      if (!f) break;
      parts.unshift(f.name);
      cursor = f.parent_id;
    }
    return parts.length > 0 ? parts.join(' / ') : 'フォルダ';
  };

  const folders = Array.from(ctx.foldersById.values())
    .filter(
      (folder) =>
        folder.deleted_at == null &&
        matchesLocalSearchItem(
          folder.name,
          folder.classification,
          buildPathHint(folder.parent_id),
          parsed
        )
    )
    .sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned;
      return b.updated_at.localeCompare(a.updated_at);
    })
    .slice(0, limit)
    .map((folder) => ({
      folder,
      pathHint: buildPathHint(folder.parent_id),
    }));

  const files = Array.from(ctx.filesById.values())
    .filter((file) => {
      if (file.deleted_at != null) return false;
      if (file.upload_state === 'pending') return false;
      const parentName = file.folder_id
        ? ctx.foldersById.get(file.folder_id)?.name ?? null
        : null;
      return matchesLocalSearchItem(
        file.name,
        file.classification,
        parentName,
        parsed
      );
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, limit)
    .map(
      (file): SearchResultItem => ({
        id: file.id,
        folderId: file.folder_id,
        folderName: file.folder_id
          ? ctx.foldersById.get(file.folder_id)?.name ?? null
          : null,
        name: file.name,
        extension: file.extension,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        classification: file.classification,
        aiSuggestedLabel: file.ai_suggested_label,
        aiConfidence: file.ai_confidence,
        updatedAt: file.updated_at,
      })
    );

  return { folders, files };
}

export function isDirectoryFresh(
  ctx: CacheContext,
  folderId: string | null,
  ttlMs = DEFAULT_SWR_TTL_MS
): boolean {
  const dir = ctx.directoriesByKey.get(dirKeyForFolder(folderId));
  if (!dir || dir.stale) return false;
  return ctx.now() - dir.revalidatedAt < ttlMs;
}

export function hasCachedDirectory(
  ctx: CacheContext,
  folderId: string | null
): boolean {
  return ctx.directoriesByKey.has(dirKeyForFolder(folderId));
}

export function upsertFileInCache(ctx: CacheContext, file: FileItem): void {
  ctx.filesById.set(file.id, file);
  const dirKey = dirKeyForFolder(file.folder_id);
  const dir = ctx.directoriesByKey.get(dirKey);
  if (dir && !dir.fileIds.includes(file.id)) {
    dir.fileIds = [file.id, ...dir.fileIds];
  }
  ctx.pruneAndSchedulePersist();
  ctx.emit();
}

export function removeFileFromCache(
  ctx: CacheContext,
  fileId: string,
  folderId: string | null
): void {
  ctx.filesById.delete(fileId);
  const dir = ctx.directoriesByKey.get(dirKeyForFolder(folderId));
  if (dir) {
    dir.fileIds = removeFromIdList(dir.fileIds, fileId);
  }
  ctx.pruneAndSchedulePersist();
  ctx.emit();
}

export function upsertFolderInCache(
  ctx: CacheContext,
  folder: FolderSummary
): void {
  ctx.foldersById.set(folder.id, folder);
  const parentKey = dirKeyForFolder(folder.parent_id);
  const dir = ctx.directoriesByKey.get(parentKey);
  if (dir && !dir.folderIds.includes(folder.id)) {
    dir.folderIds = [folder.id, ...dir.folderIds];
  }
  if (folder.parent_id === null && !ctx.rootFolderIds.includes(folder.id)) {
    ctx.rootFolderIds = [folder.id, ...ctx.rootFolderIds];
  }
  if (folder.is_pinned === 1) {
    ctx.pinnedFolderIds = dedupePush(ctx.pinnedFolderIds, folder.id);
  } else {
    ctx.pinnedFolderIds = removeFromIdList(ctx.pinnedFolderIds, folder.id);
  }
  ctx.pruneAndSchedulePersist();
  ctx.emit();
}

export function removeFolderFromCache(
  ctx: CacheContext,
  folder: FolderSummary
): void {
  ctx.foldersById.delete(folder.id);
  ctx.directoriesByKey.delete(folder.id);
  ctx.rootFolderIds = removeFromIdList(ctx.rootFolderIds, folder.id);
  ctx.pinnedFolderIds = removeFromIdList(ctx.pinnedFolderIds, folder.id);
  const parentDir = ctx.directoriesByKey.get(
    dirKeyForFolder(folder.parent_id)
  );
  if (parentDir) {
    parentDir.folderIds = removeFromIdList(parentDir.folderIds, folder.id);
  }
  ctx.pruneAndSchedulePersist();
  ctx.emit();
}

export function getAncestorClassifications(
  ctx: CacheContext,
  folderId: string | null
): ClassificationLabel[] {
  if (!folderId) return [];
  const labels: ClassificationLabel[] = [];
  const dir = ctx.directoriesByKey.get(dirKeyForFolder(folderId));
  if (dir) {
    for (const crumb of dir.breadcrumbs) {
      labels.push(crumb.classification);
    }
  }
  let cursorId: string | null = folderId;
  const seen = new Set<string>();
  while (cursorId && !seen.has(cursorId)) {
    seen.add(cursorId);
    const folder = ctx.foldersById.get(cursorId);
    if (!folder) break;
    labels.push(folder.classification);
    cursorId = folder.parent_id;
  }
  return labels;
}

export function isFolderAncestorOf(
  ctx: CacheContext,
  ancestorId: string,
  candidateId: string | null
): boolean {
  if (!candidateId) return false;
  if (ancestorId === candidateId) return true;

  const dir = ctx.directoriesByKey.get(candidateId);
  if (dir && dir.breadcrumbs.some((b) => b.id === ancestorId)) {
    return true;
  }

  let cursor: string | null = candidateId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = ctx.foldersById.get(cursor);
    if (!folder) break;
    if (folder.parent_id === ancestorId) return true;
    cursor = folder.parent_id;
  }
  return false;
}

export function resolveItemEffectiveRole(
  ctx: CacheContext,
  type: 'file' | 'folder',
  item: FolderSummary | FileItem
): ResourceRole {
  if (type === 'folder') {
    const f = item as FolderSummary;
    if (f.effectiveRole) return f.effectiveRole;
    return getDirectoryView(ctx, f.parent_id).effectiveRole;
  }
  const fl = item as FileItem;
  return getDirectoryView(ctx, fl.folder_id).effectiveRole;
}

export function markCachedSubtreeStale(
  ctx: CacheContext,
  rootFolderId: string
): void {
  const rootDir = ctx.directoriesByKey.get(rootFolderId);
  if (rootDir) rootDir.stale = true;
  for (const dir of ctx.directoriesByKey.values()) {
    if (dir.breadcrumbs.some((b) => b.id === rootFolderId)) {
      dir.stale = true;
    }
  }
}

export function collectDestNameSets(
  ctx: CacheContext,
  targetParentId: string | null
): {
  existsInCache: boolean;
  folderNames: Set<string>;
  fileNames: Set<string>;
} {
  const view = getDirectoryView(ctx, targetParentId);
  return {
    existsInCache: view.existsInCache,
    folderNames: new Set(view.folders.map((f) => f.name)),
    fileNames: new Set(view.files.map((fl) => fl.name)),
  };
}
