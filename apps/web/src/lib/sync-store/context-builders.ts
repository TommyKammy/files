import type { MutationOutbox } from '@/lib/mutation-outbox';
import type { CacheContext, DirectoryViewModel } from '@/lib/sync-store/cache';
import type { DeltaCacheContext } from '@/lib/sync-store/delta';
import type { DirectorySyncContext } from '@/lib/sync-store/directory-sync';
import type * as copyOps from '@/lib/sync-store/optimistic-copy';
import type * as fileOps from '@/lib/sync-store/optimistic-file';
import type * as folderOps from '@/lib/sync-store/optimistic-folder';
import type * as moveOps from '@/lib/sync-store/optimistic-move';
import type * as uploadOps from '@/lib/sync-store/optimistic-upload';
import type { OutboxExecuteContext } from '@/lib/sync-store/outbox-execute';
import type { OutboxRollbackContext, OutboxSuccessContext } from '@/lib/sync-store/outbox-result';
import type { PersistenceContext } from '@/lib/sync-store/persistence';
import type { RealtimeContext } from '@/lib/sync-store/realtime';
import type { ToastContext, UndoAction } from '@/lib/sync-store/toasts';
import {
  makeClientMutationId,
  type SyncStoreCollections,
  type SyncStoreMutableState,
  type SyncStoreRuntimeFns,
} from '@/lib/sync-store/types';
import type { RealtimeSecurityRevocationEvent } from '@/lib/sync-ws';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type {
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
  SyncDeltaItem,
  WorkspaceConflictPolicy,
  WorkspaceToastItem,
} from '@/types/files';

export interface SyncStoreContextHost {
  readonly state: SyncStoreMutableState;
  readonly collections: SyncStoreCollections;
  readonly fns: SyncStoreRuntimeFns;
  readonly outbox: MutationOutbox;

  emit: () => void;
  getDirectoryView: (folderId: string | null) => DirectoryViewModel;
  getAncestorClassifications: (folderId: string | null) => ClassificationLabel[];
  upsertFolderInCache: (folder: FolderSummary) => void;
  removeFolderFromCache: (folder: FolderSummary) => void;
  upsertFileInCache: (file: FileItem) => void;
  removeFileFromCache: (fileId: string, folderId: string | null) => void;
  markCachedSubtreeStale: (rootFolderId: string) => void;
  isFolderAncestorOf: (ancestorId: string, candidateId: string | null) => boolean;
  resolveItemEffectiveRole: (
    type: 'file' | 'folder',
    item: FolderSummary | FileItem
  ) => ResourceRole;
  collectDestNameSets: (targetParentId: string | null) => {
    existsInCache: boolean;
    folderNames: Set<string>;
    fileNames: Set<string>;
  };
  pushUndo: (entry: Omit<UndoAction, 'id'>, toastMessage: string) => void;
  pushToast: (toast: Omit<WorkspaceToastItem, 'id'>, ttlMs?: number) => string;
  optimisticRestoreFolder: (
    folder: FolderSummary,
    conflictPolicy?: 'fail' | 'rename'
  ) => void;
  optimisticRestoreFile: (file: FileItem) => void;
  optimisticSoftDeleteFolder: (
    folder: FolderSummary,
    options?: { skipUndo?: boolean }
  ) => { ok: boolean; error?: string };
  optimisticSoftDeleteFile: (
    file: FileItem,
    folderId: string | null,
    effectiveRole: ResourceRole,
    options?: { skipUndo?: boolean }
  ) => { ok: boolean; error?: string };
  optimisticMoveItems: (input: {
    items: Array<{ type: 'file' | 'folder'; id: string }>;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
    skipUndo?: boolean;
    labelOverride?: string;
  }) => {
    ok: boolean;
    error?: string;
    movedCount: number;
    skippedCount: number;
  };
  resetMemoryOnly: () => void;
  invalidateAllCachedDirectories: () => void;
  pruneAndSchedulePersist: () => void;
  evictSubtreeFromCache: (rootFolderId: string) => boolean;
  applyDeltaChanges: (changes: SyncDeltaItem[]) => {
    shouldRevokeAll: boolean;
    shouldRevalidateActive: boolean;
  };
  emitSecurityRevocation: (event: RealtimeSecurityRevocationEvent) => void;
  purgeCurrentScope: () => Promise<void>;
  reportSessionError: (err: unknown) => void;
  reportSessionRevocation: (event: RealtimeSecurityRevocationEvent) => void;
  startRealtime: () => void;
  syncDelta: () => Promise<void>;
  ensureDirectoryLoaded: (
    folderId: string | null,
    options?: {
      force?: boolean;
      signal?: AbortSignal;
      isPrefetch?: boolean;
      sortBy?: WorkspaceSortField;
      sortDir?: WorkspaceSortDirection;
    }
  ) => Promise<void>;
  bootstrapForce: () => void;
  scheduleAsyncCopyJobPoll: (
    jobId: string,
    refreshFolderIds: Array<string | null>,
    totalItems: number
  ) => void;
}

export function buildOptimisticFolderContext(
  host: SyncStoreContextHost
): folderOps.OptimisticFolderContext {
  return {
    foldersById: host.collections.foldersById,
    outbox: host.outbox,
    now: host.fns.now,
    getDirectoryView: host.getDirectoryView,
    getAncestorClassifications: host.getAncestorClassifications,
    upsertFolderInCache: host.upsertFolderInCache,
    removeFolderFromCache: host.removeFolderFromCache,
    pushUndo: host.pushUndo,
    restoreFolder: host.optimisticRestoreFolder,
  };
}

export function buildOptimisticFileContext(
  host: SyncStoreContextHost
): fileOps.OptimisticFileContext {
  return {
    filesById: host.collections.filesById,
    userRole: host.state.user?.role,
    outbox: host.outbox,
    now: host.fns.now,
    getDirectoryView: host.getDirectoryView,
    getAncestorClassifications: host.getAncestorClassifications,
    upsertFileInCache: host.upsertFileInCache,
    removeFileFromCache: host.removeFileFromCache,
    pushUndo: host.pushUndo,
    restoreFile: host.optimisticRestoreFile,
  };
}

export function buildOptimisticUploadContext(
  host: SyncStoreContextHost
): uploadOps.OptimisticUploadContext {
  return {
    filesById: host.collections.filesById,
    directoriesByKey: host.collections.directoriesByKey,
    now: host.fns.now,
    emit: host.emit,
    upsertFileInCache: host.upsertFileInCache,
    getAncestorClassifications: host.getAncestorClassifications,
  };
}

export function buildCacheContext(host: SyncStoreContextHost): CacheContext {
  return {
    get authStatus() {
      return host.state.authStatus;
    },
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    directoriesByKey: host.collections.directoriesByKey,
    get rootFolderIds() {
      return host.state.rootFolderIds;
    },
    set rootFolderIds(value) {
      host.state.rootFolderIds = value;
    },
    get pinnedFolderIds() {
      return host.state.pinnedFolderIds;
    },
    set pinnedFolderIds(value) {
      host.state.pinnedFolderIds = value;
    },
    now: host.fns.now,
    pruneAndSchedulePersist: host.pruneAndSchedulePersist,
    emit: host.emit,
  };
}

export function buildDirectorySyncContext(
  host: SyncStoreContextHost
): DirectorySyncContext {
  return {
    persistence: host.fns.persistence,
    outbox: host.outbox,
    fetchBootstrapFn: host.fns.fetchBootstrapFn,
    fetchDeltaFn: host.fns.fetchDeltaFn,
    fetchRootFoldersFn: host.fns.fetchRootFoldersFn,
    fetchFolderChildrenFn: host.fns.fetchFolderChildrenFn,
    readHintFn: host.fns.readHintFn,
    writeHintFn: host.fns.writeHintFn,
    now: host.fns.now,
    get bootstrapPromise() {
      return host.state.bootstrapPromise;
    },
    set bootstrapPromise(value) {
      host.state.bootstrapPromise = value;
    },
    get deltaPromise() {
      return host.state.deltaPromise;
    },
    set deltaPromise(value) {
      host.state.deltaPromise = value;
    },
    get revalidatingCount() {
      return host.state.revalidatingCount;
    },
    set revalidatingCount(value) {
      host.state.revalidatingCount = value;
    },
    get user() {
      return host.state.user;
    },
    set user(value) {
      host.state.user = value;
    },
    get authStatus() {
      return host.state.authStatus;
    },
    set authStatus(value) {
      host.state.authStatus = value;
    },
    get hydratedScopeKey() {
      return host.state.hydratedScopeKey;
    },
    set hydratedScopeKey(value) {
      host.state.hydratedScopeKey = value;
    },
    get policy() {
      return host.state.policy;
    },
    set policy(value) {
      host.state.policy = value;
    },
    get tosStatus() {
      return host.state.tosStatus;
    },
    set tosStatus(value) {
      host.state.tosStatus = value;
    },
    get purgedBeforeSeq() {
      return host.state.purgedBeforeSeq;
    },
    set purgedBeforeSeq(value) {
      host.state.purgedBeforeSeq = value;
    },
    get bootstrapDone() {
      return host.state.bootstrapDone;
    },
    set bootstrapDone(value) {
      host.state.bootstrapDone = value;
    },
    get syncSeq() {
      return host.state.syncSeq;
    },
    set syncSeq(value) {
      host.state.syncSeq = value;
    },
    get rootFolderIds() {
      return host.state.rootFolderIds;
    },
    set rootFolderIds(value) {
      host.state.rootFolderIds = value;
    },
    get rootNextCursor() {
      return host.state.rootNextCursor;
    },
    set rootNextCursor(value) {
      host.state.rootNextCursor = value;
    },
    get pinnedFolderIds() {
      return host.state.pinnedFolderIds;
    },
    set pinnedFolderIds(value) {
      host.state.pinnedFolderIds = value;
    },
    get outboxLoadedScopeKey() {
      return host.state.outboxLoadedScopeKey;
    },
    set outboxLoadedScopeKey(value) {
      host.state.outboxLoadedScopeKey = value;
    },
    get activeDirKey() {
      return host.state.activeDirKey;
    },
    set activeDirKey(value) {
      host.state.activeDirKey = value;
    },
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    directoriesByKey: host.collections.directoriesByKey,
    inFlightDirs: host.collections.inFlightDirs,
    inFlightLoadMore: host.collections.inFlightLoadMore,
    resetMemoryOnly: host.resetMemoryOnly,
    invalidateAllCachedDirectories: host.invalidateAllCachedDirectories,
    pruneAndSchedulePersist: host.pruneAndSchedulePersist,
    emit: host.emit,
    applyDeltaChanges: host.applyDeltaChanges,
    emitSecurityRevocation: host.emitSecurityRevocation,
    purgeCurrentScope: host.purgeCurrentScope,
    reportSessionError: host.reportSessionError,
    startRealtime: host.startRealtime,
    syncDelta: host.syncDelta,
    ensureDirectoryLoaded: host.ensureDirectoryLoaded,
  };
}

export function buildRealtimeContext(
  host: SyncStoreContextHost
): RealtimeContext {
  return {
    get authStatus() {
      return host.state.authStatus;
    },
    get user() {
      return host.state.user;
    },
    enableRealtimeOption: host.fns.enableRealtimeOption,
    createRealtimeClientFn: host.fns.createRealtimeClientFn,
    get realtimeClient() {
      return host.state.realtimeClient;
    },
    setRealtimeClient: (client) => {
      host.state.realtimeClient = client;
    },
    get realtimeState() {
      return host.state.realtimeState;
    },
    setRealtimeState: (state) => {
      host.state.realtimeState = state;
    },
    emit: host.emit,
    realtimeSignalListeners: host.collections.realtimeSignalListeners,
    securityRevocationListeners: host.collections.securityRevocationListeners,
    reportSessionRevocation: host.reportSessionRevocation,
    directoriesByKey: host.collections.directoriesByKey,
    foldersById: host.collections.foldersById,
    get activeDirKey() {
      return host.state.activeDirKey;
    },
    get syncSeq() {
      return host.state.syncSeq;
    },
    syncDelta: host.syncDelta,
    purgeCurrentScope: host.purgeCurrentScope,
    invalidateAllCachedDirectories: host.invalidateAllCachedDirectories,
  };
}

export function buildToastContext(host: SyncStoreContextHost): ToastContext {
  return {
    get toasts() {
      return host.state.toasts;
    },
    set toasts(value) {
      host.state.toasts = value;
    },
    get undoStack() {
      return host.state.undoStack;
    },
    set undoStack(value) {
      host.state.undoStack = value;
    },
    get redoStack() {
      return host.state.redoStack;
    },
    set redoStack(value) {
      host.state.redoStack = value;
    },
    toastTimers: host.collections.toastTimers,
    jobPollTimers: host.collections.jobPollTimers,
    copiedRootsByMutationId: host.collections.copiedRootsByMutationId,
    cancelledCopyMutationIds: host.collections.cancelledCopyMutationIds,
    get pendingMutationCount() {
      return host.state.pendingMutationCount;
    },
    set pendingMutationCount(value) {
      host.state.pendingMutationCount = value;
    },
    emit: host.emit,
  };
}

function buildMoveCopyPlanningContext(
  host: SyncStoreContextHost,
  targetParentId: string | null
) {
  return {
    idAliasMap: host.collections.idAliasMap,
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    userRole: host.state.user?.role,
    isFolderAncestorOf: host.isFolderAncestorOf,
    resolveItemEffectiveRole: host.resolveItemEffectiveRole,
    getDestinationNames: host.collectDestNameSets,
    destinationRole: host.getDirectoryView(targetParentId).effectiveRole,
    getAncestorClassifications: host.getAncestorClassifications,
    now: host.fns.now,
  };
}

export function buildOptimisticMoveContext(
  host: SyncStoreContextHost,
  targetParentId: string | null
): moveOps.OptimisticMoveContext {
  return {
    planning: buildMoveCopyPlanningContext(host, targetParentId),
    directoriesByKey: host.collections.directoriesByKey,
    getRootFolderIds: () => host.state.rootFolderIds,
    setRootFolderIds: (ids) => {
      host.state.rootFolderIds = ids;
    },
    upsertFolderInCache: host.upsertFolderInCache,
    upsertFileInCache: host.upsertFileInCache,
    markCachedSubtreeStale: host.markCachedSubtreeStale,
    outbox: host.outbox,
    now: host.fns.now,
    pushUndo: host.pushUndo,
    makeId: makeClientMutationId,
    moveItems: host.optimisticMoveItems,
  };
}

export function buildOptimisticCopyContext(
  host: SyncStoreContextHost,
  targetParentId: string | null
): copyOps.OptimisticCopyContext {
  return {
    planning: {
      ...buildMoveCopyPlanningContext(host, targetParentId),
      nextId: makeClientMutationId,
    },
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    outbox: host.outbox,
    now: host.fns.now,
    pushUndo: host.pushUndo,
    makeId: makeClientMutationId,
    copiedRootsByMutationId: host.collections.copiedRootsByMutationId,
    cancelledCopyMutationIds: host.collections.cancelledCopyMutationIds,
    removeFolderFromCache: host.removeFolderFromCache,
    removeFileFromCache: host.removeFileFromCache,
    softDeleteFolder: (folder) =>
      host.optimisticSoftDeleteFolder(folder, { skipUndo: true }),
    softDeleteFile: (file, role) =>
      host.optimisticSoftDeleteFile(file, file.folder_id, role, {
        skipUndo: true,
      }),
    resolveItemEffectiveRole: host.resolveItemEffectiveRole,
    upsertFolderInCache: host.upsertFolderInCache,
    upsertFileInCache: host.upsertFileInCache,
  };
}

export function buildOutboxExecuteContext(
  host: SyncStoreContextHost
): OutboxExecuteContext {
  return {
    idAliasMap: host.collections.idAliasMap,
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    createFolderFn: host.fns.createFolderFn,
    updateFolderFn: host.fns.updateFolderFn,
    softDeleteFolderFn: host.fns.softDeleteFolderFn,
    restoreFolderFn: host.fns.restoreFolderFn,
    updateFileMetadataFn: host.fns.updateFileMetadataFn,
    updateFileClassificationFn: host.fns.updateFileClassificationFn,
    moveFolderFn: host.fns.moveFolderFn,
    batchMoveFn: host.fns.batchMoveFn,
    copyItemsFn: host.fns.copyItemsFn,
    duplicateItemsFn: host.fns.duplicateItemsFn,
    softDeleteFileFn: host.fns.softDeleteFileFn,
    restoreFileFn: host.fns.restoreFileFn,
  };
}

export function buildOutboxSuccessContext(
  host: SyncStoreContextHost
): OutboxSuccessContext {
  return {
    idAliasMap: host.collections.idAliasMap,
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    directoriesByKey: host.collections.directoriesByKey,
    get rootFolderIds() {
      return host.state.rootFolderIds;
    },
    set rootFolderIds(next) {
      host.state.rootFolderIds = next;
    },
    cancelledCopyMutationIds: host.collections.cancelledCopyMutationIds,
    copiedRootsByMutationId: host.collections.copiedRootsByMutationId,
    removeFolderFromCache: host.removeFolderFromCache,
    removeFileFromCache: host.removeFileFromCache,
    upsertFolderInCache: host.upsertFolderInCache,
    upsertFileInCache: host.upsertFileInCache,
    markCachedSubtreeStale: host.markCachedSubtreeStale,
    getQueuedFolderPatch: (folderId) => {
      const queued = host.outbox
        .getQueuedItems()
        .find(
          (queuedItem) =>
            queuedItem.entityType === 'folder' &&
            queuedItem.entityId === folderId &&
            queuedItem.kind === 'folder.patch'
        );
      if (!queued) return null;
      return {
        name:
          typeof queued.payload.name === 'string'
            ? queued.payload.name
            : undefined,
        isPinned:
          typeof queued.payload.isPinned === 'boolean'
            ? queued.payload.isPinned
            : undefined,
      };
    },
    scheduleAsyncCopyJobPoll: host.scheduleAsyncCopyJobPoll,
    syncDelta: () => {
      void host.syncDelta();
    },
    ensureDirectoryLoadedForce: (folderId) => {
      void host.ensureDirectoryLoaded(folderId, { force: true }).catch(
        () => undefined
      );
    },
    softDeleteFolder: (folderId, version) => {
      void host.fns.softDeleteFolderFn(folderId, version).catch(() => undefined);
    },
    softDeleteFile: (fileId, version) => {
      void host.fns.softDeleteFileFn(fileId, version).catch(() => undefined);
    },
  };
}

export function buildOutboxRollbackContext(
  host: SyncStoreContextHost
): OutboxRollbackContext {
  return {
    idAliasMap: host.collections.idAliasMap,
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    directoriesByKey: host.collections.directoriesByKey,
    get rootFolderIds() {
      return host.state.rootFolderIds;
    },
    set rootFolderIds(next) {
      host.state.rootFolderIds = next;
    },
    removeFolderFromCache: host.removeFolderFromCache,
    removeFileFromCache: host.removeFileFromCache,
    upsertFolderInCache: host.upsertFolderInCache,
    upsertFileInCache: host.upsertFileInCache,
    markCachedSubtreeStale: host.markCachedSubtreeStale,
    setResolvedVersion: (entityType, entityId, version) =>
      host.outbox.setResolvedVersion(entityType, entityId, version),
    pushToast: host.pushToast,
    syncDelta: () => {
      void host.syncDelta();
    },
  };
}

export function buildPersistenceContext(
  host: SyncStoreContextHost
): PersistenceContext {
  return {
    persistence: host.fns.persistence,
    maxDirectories: host.fns.maxDirectories,
    now: host.fns.now,
    get user() {
      return host.state.user;
    },
    set user(value) {
      host.state.user = value;
    },
    get policy() {
      return host.state.policy;
    },
    set policy(value) {
      host.state.policy = value;
    },
    get syncSeq() {
      return host.state.syncSeq;
    },
    set syncSeq(value) {
      host.state.syncSeq = value;
    },
    get purgedBeforeSeq() {
      return host.state.purgedBeforeSeq;
    },
    set purgedBeforeSeq(value) {
      host.state.purgedBeforeSeq = value;
    },
    get rootFolderIds() {
      return host.state.rootFolderIds;
    },
    set rootFolderIds(value) {
      host.state.rootFolderIds = value;
    },
    get rootNextCursor() {
      return host.state.rootNextCursor;
    },
    set rootNextCursor(value) {
      host.state.rootNextCursor = value;
    },
    get pinnedFolderIds() {
      return host.state.pinnedFolderIds;
    },
    set pinnedFolderIds(value) {
      host.state.pinnedFolderIds = value;
    },
    getOutboxItems: () => host.outbox.getQueuedItems(),
    get bootstrapDone() {
      return host.state.bootstrapDone;
    },
    set bootstrapDone(value) {
      host.state.bootstrapDone = value;
    },
    get hydratedScopeKey() {
      return host.state.hydratedScopeKey;
    },
    set hydratedScopeKey(value) {
      host.state.hydratedScopeKey = value;
    },
    get activeDirectoryNotice() {
      return host.state.activeDirectoryNotice;
    },
    set activeDirectoryNotice(value) {
      host.state.activeDirectoryNotice = value;
    },
    get activeDirKey() {
      return host.state.activeDirKey;
    },
    set activeDirKey(value) {
      host.state.activeDirKey = value;
    },
    get persistTimer() {
      return host.state.persistTimer;
    },
    set persistTimer(value) {
      host.state.persistTimer = value;
    },
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    directoriesByKey: host.collections.directoriesByKey,
    inFlightDirs: host.collections.inFlightDirs,
    inFlightLoadMore: host.collections.inFlightLoadMore,
  };
}

export function buildDeltaContext(
  host: SyncStoreContextHost
): DeltaCacheContext {
  return {
    get userId() {
      return host.state.user?.id;
    },
    foldersById: host.collections.foldersById,
    filesById: host.collections.filesById,
    directoriesByKey: host.collections.directoriesByKey,
    get rootFolderIds() {
      return host.state.rootFolderIds;
    },
    set rootFolderIds(next) {
      host.state.rootFolderIds = next;
    },
    get pinnedFolderIds() {
      return host.state.pinnedFolderIds;
    },
    set pinnedFolderIds(next) {
      host.state.pinnedFolderIds = next;
    },
    get activeDirKey() {
      return host.state.activeDirKey;
    },
    setActiveDirectoryNotice: (notice) => {
      host.state.activeDirectoryNotice = notice;
    },
    evictSubtreeFromCache: host.evictSubtreeFromCache,
    bootstrapForce: host.bootstrapForce,
    upsertFolderInCache: host.upsertFolderInCache,
    upsertFileInCache: host.upsertFileInCache,
  };
}
