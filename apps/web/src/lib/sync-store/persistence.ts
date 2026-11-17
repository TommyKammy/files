import {
  pruneWorkingSetInMemory,
  type PersistedDirectoryRecord,
  type PersistedMetaRecord,
  type SyncPersistenceAdapter,
} from '@/lib/sync-idb';
import type {
  AuthUser,
  FileItem,
  FolderSummary,
  OutboxMutationRecord,
  TenantPolicyRow,
} from '@/types/files';

const ROOT_DIR_KEY = '__ROOT__';

function removeFromIdList(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

export interface PersistenceContext {
  persistence: SyncPersistenceAdapter;
  maxDirectories: number;
  now: () => number;
  user: AuthUser | null;
  policy: TenantPolicyRow | null;
  syncSeq: number;
  purgedBeforeSeq: number;
  rootFolderIds: string[];
  rootNextCursor: string | null;
  pinnedFolderIds: string[];
  getOutboxItems: () => OutboxMutationRecord[];
  bootstrapDone: boolean;
  hydratedScopeKey: string | null;
  activeDirectoryNotice: string | null;
  activeDirKey: string;
  persistTimer: ReturnType<typeof setTimeout> | null;
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  inFlightDirs: Map<string, Promise<void>>;
}

export function resetMemoryOnly(ctx: PersistenceContext): void {
  ctx.foldersById.clear();
  ctx.filesById.clear();
  ctx.directoriesByKey.clear();
  ctx.inFlightDirs.clear();
  ctx.user = null;
  ctx.policy = null;
  ctx.syncSeq = 0;
  ctx.purgedBeforeSeq = 0;
  ctx.rootFolderIds = [];
  ctx.rootNextCursor = null;
  ctx.pinnedFolderIds = [];
  ctx.bootstrapDone = false;
  ctx.hydratedScopeKey = null;
  ctx.activeDirectoryNotice = null;
}

export function invalidateAllCachedDirectories(
  ctx: PersistenceContext
): void {
  const keepRoot = ctx.directoriesByKey.get(ROOT_DIR_KEY);
  ctx.directoriesByKey.clear();
  if (keepRoot) {
    ctx.directoriesByKey.set(ROOT_DIR_KEY, {
      ...keepRoot,
      stale: true,
    });
  }
  pruneWorkingSetInMemory({
    directories: ctx.directoriesByKey,
    foldersById: ctx.foldersById,
    filesById: ctx.filesById,
    rootFolderIds: ctx.rootFolderIds,
    pinnedFolderIds: ctx.pinnedFolderIds,
    outboxItems: ctx.getOutboxItems(),
    activeDirKey: ctx.activeDirKey,
    maxDirectories: ctx.maxDirectories,
  });
}

export function pruneAndSchedulePersist(ctx: PersistenceContext): void {
  pruneWorkingSetInMemory({
    directories: ctx.directoriesByKey,
    foldersById: ctx.foldersById,
    filesById: ctx.filesById,
    rootFolderIds: ctx.rootFolderIds,
    pinnedFolderIds: ctx.pinnedFolderIds,
    outboxItems: ctx.getOutboxItems(),
    activeDirKey: ctx.activeDirKey,
    maxDirectories: ctx.maxDirectories,
  });

  if (typeof window === 'undefined' && !ctx.user) return;
  if (ctx.persistTimer) {
    clearTimeout(ctx.persistTimer);
  }
  const timer = setTimeout(() => {
    ctx.persistTimer = null;
    void persistNow(ctx);
  }, 120);
  ctx.persistTimer = timer;
}

async function persistNow(ctx: PersistenceContext): Promise<void> {
  if (!ctx.user) return;
  const meta: PersistedMetaRecord = {
    key: 'state',
    user: ctx.user,
    policy: ctx.policy,
    syncSeq: ctx.syncSeq,
    purgedBeforeSeq: ctx.purgedBeforeSeq,
    rootFolderIds: ctx.rootFolderIds,
    rootNextCursor: ctx.rootNextCursor,
    pinnedFolderIds: ctx.pinnedFolderIds,
    updatedAt: ctx.now(),
  };

  await ctx.persistence.saveSnapshot(ctx.user.tenantId, ctx.user.id, {
    meta,
    folders: Array.from(ctx.foldersById.values()).filter(
      (f) => !f.optimistic
    ),
    files: Array.from(ctx.filesById.values()).filter(
      (fl) => !fl.optimistic && fl.upload_state !== 'pending'
    ),
    directories: Array.from(ctx.directoriesByKey.values()),
  });
}

export async function flushPersistence(
  ctx: PersistenceContext
): Promise<void> {
  if (ctx.persistTimer) {
    clearTimeout(ctx.persistTimer);
    ctx.persistTimer = null;
  }
  await persistNow(ctx);
}

export function evictSubtreeFromCache(
  ctx: PersistenceContext,
  rootFolderId: string
): boolean {
  let touchedActive = ctx.activeDirKey === rootFolderId;
  ctx.directoriesByKey.delete(rootFolderId);
  ctx.foldersById.delete(rootFolderId);
  ctx.rootFolderIds = removeFromIdList(ctx.rootFolderIds, rootFolderId);
  ctx.pinnedFolderIds = removeFromIdList(ctx.pinnedFolderIds, rootFolderId);

  for (const [key, dir] of ctx.directoriesByKey.entries()) {
    const inSubtree = dir.breadcrumbs.some((b) => b.id === rootFolderId);
    if (inSubtree) {
      if (key === ctx.activeDirKey) touchedActive = true;
      ctx.directoriesByKey.delete(key);
    } else if (dir.folderIds.includes(rootFolderId)) {
      dir.folderIds = removeFromIdList(dir.folderIds, rootFolderId);
    }
  }
  return touchedActive;
}
