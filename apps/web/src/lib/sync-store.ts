'use client';

import {
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  batchMoveWorkspaceItems,
  copyWorkspaceItems,
  createFolder,
  duplicateWorkspaceItems,
  fetchSyncBootstrap,
  fetchSyncDelta,
  getWorkspaceJob,
  listFolderChildren,
  listRootFolders,
  moveFolder,
  registerAuthPurgeHook,
  restoreFile,
  restoreFolder,
  softDeleteFile,
  softDeleteFolder,
  updateFileClassification,
  updateFileMetadata,
  updateFolder,
} from '@/lib/files-api';
import {
  allocateCopyDisplayName,
  getExtensionFromName,
  hasRoleAtLeast,
  isClassificationFloorViolated,
  pickStricterClassification,
} from '@/lib/formatters';
import {
  matchesLocalSearchItem,
  parseSearchQuery,
} from '@/lib/keyboard-shortcuts';
import {
  checkClassificationFloorGuard,
  checkRoleGuard,
  MutationOutbox,
  type OutboxExecutionResult,
} from '@/lib/mutation-outbox';
import { applyDeltaChangesToCache } from '@/lib/sync-store/delta';
import { planOptimisticCopy } from '@/lib/sync-store/optimistic-copy-plan';
import { planOptimisticMove } from '@/lib/sync-store/optimistic-move-plan';
import {
  collectDestNameSets as cacheCollectDestNameSets,
  getAncestorClassifications as cacheGetAncestorClassifications,
  getDirectoryView as cacheGetDirectoryView,
  getPinnedFolders as cacheGetPinnedFolders,
  hasCachedDirectory as cacheHasCachedDirectory,
  isDirectoryFresh as cacheIsDirectoryFresh,
  isFolderAncestorOf as cacheIsFolderAncestorOf,
  markCachedSubtreeStale as cacheMarkCachedSubtreeStale,
  removeFileFromCache as cacheRemoveFileFromCache,
  removeFolderFromCache as cacheRemoveFolderFromCache,
  resolveItemEffectiveRole as cacheResolveItemEffectiveRole,
  searchCachedWorkspaceItems as cacheSearchCachedWorkspaceItems,
  upsertFileInCache as cacheUpsertFileInCache,
  upsertFolderInCache as cacheUpsertFolderInCache,
  type CacheContext,
  type DirectoryViewModel,
} from '@/lib/sync-store/cache';
export type { DirectoryViewModel } from '@/lib/sync-store/cache';
import {
  clearToastsAndUndo,
  dismissToast,
  pushToast,
  pushUndo,
  undoLatest,
  type ToastContext,
  type UndoAction,
} from '@/lib/sync-store/toasts';
export type { UndoAction } from '@/lib/sync-store/toasts';
import {
  bootstrap,
  ensureDirectoryLoaded,
  loadMoreDirectory,
  syncDelta,
  type DirectorySyncContext,
} from '@/lib/sync-store/directory-sync';
import * as fileOps from '@/lib/sync-store/optimistic-file';
import * as folderOps from '@/lib/sync-store/optimistic-folder';
import * as uploadOps from '@/lib/sync-store/optimistic-upload';
import { executeOutboxMutation } from '@/lib/sync-store/outbox-execute';
import {
  evictSubtreeFromCache,
  flushPersistence,
  invalidateAllCachedDirectories,
  pruneAndSchedulePersist,
  resetMemoryOnly,
  type PersistenceContext,
} from '@/lib/sync-store/persistence';
import {
  applyOutboxRollback,
  applyOutboxSuccess,
} from '@/lib/sync-store/outbox-result';
import {
  getSyncDbName,
  IndexedDbSyncPersistence,
  type PersistedDirectoryRecord,
  type PersistedMetaRecord,
  pruneWorkingSetInMemory,
  readSyncScopeHint,
  type SyncPersistenceAdapter,
  type SyncScopeHint,
  WORKING_SET_MAX_DIRECTORIES,
  writeSyncScopeHint,
} from '@/lib/sync-idb';
import type {
  RealtimeConnectionState,
  RealtimeSecurityRevocationEvent,
} from '@/lib/sync-ws';
import {
  handleRealtimeSignal,
  startRealtime,
  stopRealtime,
  type RealtimeContext,
} from '@/lib/sync-store/realtime';
import type {
  AuthUser,
  BatchMoveWorkspaceResponse,
  BootstrapResponse,
  BreadcrumbItem,
  ClassificationLabel,
  CopyWorkspaceResponse,
  FileItem,
  FolderChildrenResponse,
  FolderSummary,
  OutboxMutationRecord,
  ResourceRole,
  SearchResultItem,
  SyncDeltaItem,
  SyncDeltaResponse,
  SyncInvalidationSignal,
  TenantPolicyRow,
  WorkspaceBatchItemRef,
  WorkspaceConflictPolicy,
  WorkspaceToastItem,
} from '@/types/files';

const ROOT_DIR_KEY = '__ROOT__';
const DEFAULT_SWR_TTL_MS = 15_000;
const MAX_DELTA_PAGES_PER_SYNC = 5;

export type SyncAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

export interface SyncStoreSnapshot {
  authStatus: SyncAuthStatus;
  user: AuthUser | null;
  policy: TenantPolicyRow | null;
  syncSeq: number;
  purgedBeforeSeq: number;
  bootstrapDone: boolean;
  revalidating: boolean;
  realtimeState: RealtimeConnectionState;
  activeDirectoryNotice: string | null;
  toasts: WorkspaceToastItem[];
  canUndo: boolean;
  pendingMutationCount: number;
  revision: number;
}

export interface SyncStoreDeps {
  persistence?: SyncPersistenceAdapter;
  fetchBootstrap?: (signal?: AbortSignal) => Promise<BootstrapResponse>;
  fetchDelta?: (
    sinceSeq: number,
    limit?: number,
    signal?: AbortSignal
  ) => Promise<SyncDeltaResponse>;
  fetchFolderChildren?: (
    folderId: string,
    cursor?: string | null,
    limit?: number,
    options?: { includeBreadcrumbs?: boolean; signal?: AbortSignal }
  ) => Promise<FolderChildrenResponse>;
  fetchRootFolders?: (
    cursor?: string | null,
    signal?: AbortSignal
  ) => Promise<{ folders: FolderSummary[]; nextCursor: string | null }>;
  readScopeHint?: () => SyncScopeHint | null;
  writeScopeHint?: (user: AuthUser | null) => void;
  registerPurgeHook?: (hook: () => Promise<void> | void) => () => void;
  now?: () => number;
  maxDirectories?: number;
  createFolderFn?: typeof createFolder;
  updateFolderFn?: typeof updateFolder;
  moveFolderFn?: typeof moveFolder;
  softDeleteFolderFn?: typeof softDeleteFolder;
  restoreFolderFn?: typeof restoreFolder;
  updateFileMetadataFn?: typeof updateFileMetadata;
  updateFileClassificationFn?: typeof updateFileClassification;
  softDeleteFileFn?: typeof softDeleteFile;
  restoreFileFn?: typeof restoreFile;
  batchMoveFn?: typeof batchMoveWorkspaceItems;
  copyItemsFn?: typeof copyWorkspaceItems;
  duplicateItemsFn?: typeof duplicateWorkspaceItems;
  getWorkspaceJobFn?: typeof getWorkspaceJob;
  outboxCoalesceMs?: number;
  outboxRetryDelayBaseMs?: number;
  enableRealtime?: boolean;
  createRealtimeClient?: (handlers: {
    onSignal: (signal: SyncInvalidationSignal) => void | Promise<void>;
    onCatchup: () => void | Promise<void>;
    onStateChange: (state: RealtimeConnectionState) => void;
  }) => { start: () => void; stop: () => void };
}

export function dirKeyForFolder(folderId: string | null): string {
  return folderId ?? ROOT_DIR_KEY;
}

function dedupePush(list: string[], id: string, prepend = false): string[] {
  const filtered = list.filter((x) => x !== id);
  return prepend ? [id, ...filtered] : [...filtered, id];
}

function removeFromIdList(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

function replaceIdInList(list: string[], tempId: string, realId: string): string[] {
  const withoutReal = list.filter((x) => x !== realId);
  const idx = withoutReal.indexOf(tempId);
  if (idx === -1) {
    return list.includes(realId) ? list : [realId, ...list];
  }
  const next = [...withoutReal];
  next[idx] = realId;
  return next;
}

function makeClientMutationId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export class WorkspaceSyncStore {
  private readonly persistence: SyncPersistenceAdapter;
  private readonly fetchBootstrapFn: (signal?: AbortSignal) => Promise<BootstrapResponse>;
  private readonly fetchDeltaFn: (
    sinceSeq: number,
    limit?: number,
    signal?: AbortSignal
  ) => Promise<SyncDeltaResponse>;
  private readonly fetchFolderChildrenFn: (
    folderId: string,
    cursor?: string | null,
    limit?: number,
    options?: { includeBreadcrumbs?: boolean; signal?: AbortSignal }
  ) => Promise<FolderChildrenResponse>;
  private readonly fetchRootFoldersFn: (
    cursor?: string | null,
    signal?: AbortSignal
  ) => Promise<{ folders: FolderSummary[]; nextCursor: string | null }>;
  private readonly readHintFn: () => SyncScopeHint | null;
  private readonly writeHintFn: (user: AuthUser | null) => void;
  private readonly now: () => number;
  private readonly maxDirectories: number;

  private readonly createFolderFn: typeof createFolder;
  private readonly updateFolderFn: typeof updateFolder;
  private readonly moveFolderFn: typeof moveFolder;
  private readonly softDeleteFolderFn: typeof softDeleteFolder;
  private readonly restoreFolderFn: typeof restoreFolder;
  private readonly updateFileMetadataFn: typeof updateFileMetadata;
  private readonly updateFileClassificationFn: typeof updateFileClassification;
  private readonly softDeleteFileFn: typeof softDeleteFile;
  private readonly restoreFileFn: typeof restoreFile;
  private readonly batchMoveFn: typeof batchMoveWorkspaceItems;
  private readonly copyItemsFn: typeof copyWorkspaceItems;
  private readonly duplicateItemsFn: typeof duplicateWorkspaceItems;
  private readonly getWorkspaceJobFn: typeof getWorkspaceJob;

  private readonly outbox: MutationOutbox;
  private readonly idAliasMap = new Map<string, string>();
  private readonly copiedRootsByMutationId = new Map<
    string,
    { folders: FolderSummary[]; files: FileItem[] }
  >();
  private readonly cancelledCopyMutationIds = new Set<string>();
  private readonly jobPollTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private toasts: WorkspaceToastItem[] = [];
  private undoStack: UndoAction[] = [];
  private pendingMutationCount = 0;
  private outboxLoadedScopeKey: string | null = null;

  private readonly enableRealtimeOption?: boolean;
  private readonly createRealtimeClientFn?: SyncStoreDeps['createRealtimeClient'];
  private readonly realtimeSignalListeners = new Set<
    (signal: SyncInvalidationSignal) => void
  >();
  private readonly securityRevocationListeners = new Set<
    (event: RealtimeSecurityRevocationEvent) => void
  >();
  private realtimeClient: { start: () => void; stop: () => void } | null = null;
  private realtimeState: RealtimeConnectionState = 'disconnected';

  private readonly listeners = new Set<() => void>();
  private readonly foldersById = new Map<string, FolderSummary>();
  private readonly filesById = new Map<string, FileItem>();
  private readonly directoriesByKey = new Map<string, PersistedDirectoryRecord>();

  private authStatus: SyncAuthStatus = 'unknown';
  private user: AuthUser | null = null;
  private policy: TenantPolicyRow | null = null;
  private syncSeq = 0;
  private purgedBeforeSeq = 0;
  private rootFolderIds: string[] = [];
  private rootNextCursor: string | null = null;
  private pinnedFolderIds: string[] = [];
  private bootstrapDone = false;
  private revalidatingCount = 0;
  private activeDirKey: string = ROOT_DIR_KEY;
  private activeDirectoryNotice: string | null = null;
  private revision = 0;

  private hydratedScopeKey: string | null = null;
  private hydratePromise: Promise<boolean> | null = null;
  private bootstrapPromise: Promise<BootstrapResponse | null> | null = null;
  private deltaPromise: Promise<void> | null = null;
  private readonly inFlightDirs = new Map<string, Promise<void>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshot: SyncStoreSnapshot;

  constructor(deps: SyncStoreDeps = {}) {
    this.persistence = deps.persistence ?? new IndexedDbSyncPersistence();
    this.fetchBootstrapFn = deps.fetchBootstrap ?? fetchSyncBootstrap;
    this.fetchDeltaFn = deps.fetchDelta ?? fetchSyncDelta;
    this.fetchFolderChildrenFn = deps.fetchFolderChildren ?? listFolderChildren;
    this.fetchRootFoldersFn = deps.fetchRootFolders ?? listRootFolders;
    this.readHintFn = deps.readScopeHint ?? readSyncScopeHint;
    this.writeHintFn = deps.writeScopeHint ?? writeSyncScopeHint;
    this.now = deps.now ?? (() => Date.now());
    this.maxDirectories = deps.maxDirectories ?? WORKING_SET_MAX_DIRECTORIES;
    this.enableRealtimeOption = deps.enableRealtime;
    this.createRealtimeClientFn = deps.createRealtimeClient;

    this.createFolderFn = deps.createFolderFn ?? createFolder;
    this.updateFolderFn = deps.updateFolderFn ?? updateFolder;
    this.moveFolderFn = deps.moveFolderFn ?? moveFolder;
    this.softDeleteFolderFn = deps.softDeleteFolderFn ?? softDeleteFolder;
    this.restoreFolderFn = deps.restoreFolderFn ?? restoreFolder;
    this.updateFileMetadataFn = deps.updateFileMetadataFn ?? updateFileMetadata;
    this.updateFileClassificationFn =
      deps.updateFileClassificationFn ?? updateFileClassification;
    this.softDeleteFileFn = deps.softDeleteFileFn ?? softDeleteFile;
    this.restoreFileFn = deps.restoreFileFn ?? restoreFile;
    this.batchMoveFn = deps.batchMoveFn ?? batchMoveWorkspaceItems;
    this.copyItemsFn = deps.copyItemsFn ?? copyWorkspaceItems;
    this.duplicateItemsFn = deps.duplicateItemsFn ?? duplicateWorkspaceItems;
    this.getWorkspaceJobFn = deps.getWorkspaceJobFn ?? getWorkspaceJob;

    this.outbox = new MutationOutbox({
      coalesceWindowMs: deps.outboxCoalesceMs,
      retryDelayBaseMs: deps.outboxRetryDelayBaseMs,
      execute: (item) => this.executeOutboxMutation(item),
      onSuccess: (item, result) => this.handleOutboxSuccess(item, result),
      onRollback: (item, err, latest) => this.handleOutboxRollback(item, err, latest),
      onQueueChange: (pendingCount, queuedItems) => {
        this.pendingMutationCount = pendingCount;
        if (this.user && this.authStatus === 'authenticated') {
          void this.persistence.saveOutbox?.(
            this.user.tenantId,
            this.user.id,
            queuedItems
          );
        }
        this.emit();
      },
    });

    const registerHook = deps.registerPurgeHook ?? registerAuthPurgeHook;
    registerHook(() => this.purgeCurrentScope());

    this.snapshot = this.buildSnapshot();
  }

  private buildSnapshot(): SyncStoreSnapshot {
    return {
      authStatus: this.authStatus,
      user: this.user,
      policy: this.policy,
      syncSeq: this.syncSeq,
      purgedBeforeSeq: this.purgedBeforeSeq,
      bootstrapDone: this.bootstrapDone,
      revalidating: this.revalidatingCount > 0,
      realtimeState: this.realtimeState,
      activeDirectoryNotice: this.activeDirectoryNotice,
      toasts: this.toasts,
      canUndo: this.undoStack.length > 0,
      pendingMutationCount: this.pendingMutationCount,
      revision: this.revision,
    };
  }

  private emit(): void {
    this.revision += 1;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  subscribeRealtimeSignals = (
    listener: (signal: SyncInvalidationSignal) => void
  ): (() => void) => {
    this.realtimeSignalListeners.add(listener);
    return () => {
      this.realtimeSignalListeners.delete(listener);
    };
  };

  subscribeSecurityRevocations = (
    listener: (event: RealtimeSecurityRevocationEvent) => void
  ): (() => void) => {
    this.securityRevocationListeners.add(listener);
    return () => {
      this.securityRevocationListeners.delete(listener);
    };
  };

  getSnapshot = (): SyncStoreSnapshot => this.snapshot;

  setActiveFolder(folderId: string | null): void {
    this.activeDirKey = dirKeyForFolder(folderId);
    const existing = this.directoriesByKey.get(this.activeDirKey);
    if (existing) {
      existing.lastAccessedAt = this.now();
    }
    if (this.activeDirectoryNotice) {
      this.activeDirectoryNotice = null;
      this.emit();
    }
  }

  clearActiveDirectoryNotice(): void {
    if (this.activeDirectoryNotice !== null) {
      this.activeDirectoryNotice = null;
      this.emit();
    }
  }

  getDirectoryView(folderId: string | null): DirectoryViewModel {
    return cacheGetDirectoryView(this.cacheContext(), folderId);
  }

  getPinnedFolders(): FolderSummary[] {
    return cacheGetPinnedFolders(this.cacheContext());
  }

  /**
   * 0ms synchronous search over the hydrated local working set (cached folders and files),
   * excluding deleted items and in-flight pending uploads.
   */
  searchCachedWorkspaceItems(
    query: string,
    limit = 20
  ): {
    folders: Array<{ folder: FolderSummary; pathHint: string }>;
    files: SearchResultItem[];
  } {
    return cacheSearchCachedWorkspaceItems(this.cacheContext(), query, limit);
  }

  isDirectoryFresh(
    folderId: string | null,
    ttlMs = DEFAULT_SWR_TTL_MS
  ): boolean {
    return cacheIsDirectoryFresh(this.cacheContext(), folderId, ttlMs);
  }

  hasCachedDirectory(folderId: string | null): boolean {
    return cacheHasCachedDirectory(this.cacheContext(), folderId);
  }

  /**
   * Immediately hydrate from the user/tenant-scoped IndexedDB database identified
   * by the non-sensitive session scope hint so returning tabs paint in <16ms without spinners.
   */
  async hydrateFromScopeHint(): Promise<boolean> {
    const hint = this.readHintFn();
    if (!hint) return false;
    const scopeKey = `${hint.tenantId}:${hint.userId}`;
    if (this.hydratedScopeKey === scopeKey && this.user) {
      return true;
    }
    if (this.hydratePromise) return this.hydratePromise;

    this.hydratePromise = (async () => {
      const snapshot = await this.persistence.loadScope(hint.tenantId, hint.userId);
      if (!snapshot) return false;

      // Guard against race if session was revoked or changed while IDB opened
      if (this.authStatus === 'unauthenticated') return false;
      if (
        this.user &&
        (this.user.id !== snapshot.meta.user.id ||
          this.user.tenantId !== snapshot.meta.user.tenantId)
      ) {
        return false;
      }

      this.resetMemoryOnly();
      this.user = snapshot.meta.user;
      this.authStatus = 'authenticated';
      this.policy = snapshot.meta.policy;
      this.syncSeq = snapshot.meta.syncSeq;
      this.purgedBeforeSeq = snapshot.meta.purgedBeforeSeq;
      this.rootFolderIds = snapshot.meta.rootFolderIds;
      this.rootNextCursor = snapshot.meta.rootNextCursor;
      this.pinnedFolderIds = snapshot.meta.pinnedFolderIds;
      this.hydratedScopeKey = scopeKey;

      for (const folder of snapshot.folders) {
        this.foldersById.set(folder.id, folder);
      }
      for (const file of snapshot.files) {
        this.filesById.set(file.id, file);
      }
      for (const dir of snapshot.directories) {
        this.directoriesByKey.set(dir.dirKey, dir);
      }

      this.emit();
      return true;
    })().finally(() => {
      this.hydratePromise = null;
    });

    return this.hydratePromise;
  }

  async adoptAuthenticatedUser(nextUser: AuthUser): Promise<void> {
    const previous = this.user;
    if (
      previous &&
      (previous.id !== nextUser.id || previous.tenantId !== nextUser.tenantId)
    ) {
      this.stopRealtime();
      await this.persistence.purgeScope(previous.tenantId, previous.id);
      this.resetMemoryOnly();
    }
    this.user = nextUser;
    this.authStatus = 'authenticated';
    this.hydratedScopeKey = `${nextUser.tenantId}:${nextUser.id}`;
    this.writeHintFn(nextUser);
    this.emit();
    await this.bootstrap({ force: true });
  }

  private optimisticFolderContext(): folderOps.OptimisticFolderContext {
    return {
      foldersById: this.foldersById,
      outbox: this.outbox,
      now: this.now,
      getDirectoryView: (folderId) => this.getDirectoryView(folderId),
      getAncestorClassifications: (folderId) =>
        this.getAncestorClassifications(folderId),
      upsertFolderInCache: (folder) => this.upsertFolderInCache(folder),
      removeFolderFromCache: (folder) =>
        this.removeFolderFromCache(folder),
      pushUndo: (entry, message) => this.pushUndo(entry, message),
      restoreFolder: (folder, policy) =>
        this.optimisticRestoreFolder(folder, policy),
    };
  }

  private optimisticFileContext(): fileOps.OptimisticFileContext {
    return {
      filesById: this.filesById,
      userRole: this.user?.role,
      outbox: this.outbox,
      now: this.now,
      getDirectoryView: (folderId) => this.getDirectoryView(folderId),
      getAncestorClassifications: (folderId) =>
        this.getAncestorClassifications(folderId),
      upsertFileInCache: (file) => this.upsertFileInCache(file),
      removeFileFromCache: (fileId, folderId) =>
        this.removeFileFromCache(fileId, folderId),
      pushUndo: (entry, message) => this.pushUndo(entry, message),
      restoreFile: (file) => this.optimisticRestoreFile(file),
    };
  }

  private optimisticUploadContext(): uploadOps.OptimisticUploadContext {
    return {
      filesById: this.filesById,
      directoriesByKey: this.directoriesByKey,
      now: this.now,
      emit: () => this.emit(),
      upsertFileInCache: (file) => this.upsertFileInCache(file),
      getAncestorClassifications: (folderId) =>
        this.getAncestorClassifications(folderId),
    };
  }

  private cacheContext(): CacheContext {
    const self = this;
    return {
      get authStatus() {
        return self.authStatus;
      },
      foldersById: this.foldersById,
      filesById: this.filesById,
      directoriesByKey: this.directoriesByKey,
      get rootFolderIds() {
        return self.rootFolderIds;
      },
      set rootFolderIds(value) {
        self.rootFolderIds = value;
      },
      get pinnedFolderIds() {
        return self.pinnedFolderIds;
      },
      set pinnedFolderIds(value) {
        self.pinnedFolderIds = value;
      },
      now: this.now,
      pruneAndSchedulePersist: () => this.pruneAndSchedulePersist(),
      emit: () => this.emit(),
    };
  }

  private directorySyncContext(): DirectorySyncContext {
    const self = this;
    return {
      persistence: this.persistence,
      outbox: this.outbox,
      fetchBootstrapFn: this.fetchBootstrapFn,
      fetchDeltaFn: this.fetchDeltaFn,
      fetchRootFoldersFn: this.fetchRootFoldersFn,
      fetchFolderChildrenFn: this.fetchFolderChildrenFn,
      readHintFn: this.readHintFn,
      writeHintFn: this.writeHintFn,
      now: this.now,
      get bootstrapPromise() {
        return self.bootstrapPromise;
      },
      set bootstrapPromise(value) {
        self.bootstrapPromise = value;
      },
      get deltaPromise() {
        return self.deltaPromise;
      },
      set deltaPromise(value) {
        self.deltaPromise = value;
      },
      get revalidatingCount() {
        return self.revalidatingCount;
      },
      set revalidatingCount(value) {
        self.revalidatingCount = value;
      },
      get user() {
        return self.user;
      },
      set user(value) {
        self.user = value;
      },
      get authStatus() {
        return self.authStatus;
      },
      set authStatus(value) {
        self.authStatus = value;
      },
      get hydratedScopeKey() {
        return self.hydratedScopeKey;
      },
      set hydratedScopeKey(value) {
        self.hydratedScopeKey = value;
      },
      get policy() {
        return self.policy;
      },
      set policy(value) {
        self.policy = value;
      },
      get purgedBeforeSeq() {
        return self.purgedBeforeSeq;
      },
      set purgedBeforeSeq(value) {
        self.purgedBeforeSeq = value;
      },
      get bootstrapDone() {
        return self.bootstrapDone;
      },
      set bootstrapDone(value) {
        self.bootstrapDone = value;
      },
      get syncSeq() {
        return self.syncSeq;
      },
      set syncSeq(value) {
        self.syncSeq = value;
      },
      get rootFolderIds() {
        return self.rootFolderIds;
      },
      set rootFolderIds(value) {
        self.rootFolderIds = value;
      },
      get rootNextCursor() {
        return self.rootNextCursor;
      },
      set rootNextCursor(value) {
        self.rootNextCursor = value;
      },
      get pinnedFolderIds() {
        return self.pinnedFolderIds;
      },
      set pinnedFolderIds(value) {
        self.pinnedFolderIds = value;
      },
      get outboxLoadedScopeKey() {
        return self.outboxLoadedScopeKey;
      },
      set outboxLoadedScopeKey(value) {
        self.outboxLoadedScopeKey = value;
      },
      get activeDirKey() {
        return self.activeDirKey;
      },
      set activeDirKey(value) {
        self.activeDirKey = value;
      },
      foldersById: this.foldersById,
      filesById: this.filesById,
      directoriesByKey: this.directoriesByKey,
      inFlightDirs: this.inFlightDirs,
      resetMemoryOnly: () => this.resetMemoryOnly(),
      invalidateAllCachedDirectories: () =>
        this.invalidateAllCachedDirectories(),
      pruneAndSchedulePersist: () => this.pruneAndSchedulePersist(),
      emit: () => this.emit(),
      applyDeltaChanges: (changes) => this.applyDeltaChanges(changes),
      emitSecurityRevocation: (event) =>
        this.emitSecurityRevocation(event),
      purgeCurrentScope: () => this.purgeCurrentScope(),
      startRealtime: () => this.startRealtime(),
      syncDelta: () => this.syncDelta(),
      ensureDirectoryLoaded: (folderId, options) =>
        this.ensureDirectoryLoaded(folderId, options),
    };
  }

  async bootstrap(
    options?: { force?: boolean }
  ): Promise<BootstrapResponse | null> {
    return bootstrap(this.directorySyncContext(), options);
  }

  /**
   * Fetch and apply authorized incremental deltas from `sinceSeq`.
   * On `resetRequired: true`, wipes stale working-set directories immediately.
   */
  async syncDelta(): Promise<void> {
    return syncDelta(this.directorySyncContext());
  }

  /**
   * Load or SWR-revalidate a folder (or root). When cached in memory/IDB, returns immediately
   * without caller spinners and validates quietly in background unless `force: true`.
   */
  async ensureDirectoryLoaded(
    folderId: string | null,
    options?: { force?: boolean; signal?: AbortSignal; isPrefetch?: boolean }
  ): Promise<void> {
    return ensureDirectoryLoaded(this.directorySyncContext(), folderId, options);
  }

  async loadMoreDirectory(folderId: string | null): Promise<void> {
    return loadMoreDirectory(this.directorySyncContext(), folderId);
  }

  upsertFileInCache(file: FileItem): void {
    cacheUpsertFileInCache(this.cacheContext(), file);
  }

  removeFileFromCache(fileId: string, folderId: string | null): void {
    cacheRemoveFileFromCache(this.cacheContext(), fileId, folderId);
  }

  upsertFolderInCache(folder: FolderSummary): void {
    cacheUpsertFolderInCache(this.cacheContext(), folder);
  }

  removeFolderFromCache(folder: FolderSummary): void {
    cacheRemoveFolderFromCache(this.cacheContext(), folder);
  }

  /** Complete security purge of memory + IndexedDB + scope hint on logout, 401, or user switch. */
  async purgeCurrentScope(): Promise<void> {
    this.stopRealtime();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    this.outbox.clearAll();
    this.clearToastsAndUndo();
    this.idAliasMap.clear();
    this.outboxLoadedScopeKey = null;

    const curUser = this.user;
    const hint = this.readHintFn();
    this.resetMemoryOnly();
    this.authStatus = 'unauthenticated';
    this.bootstrapDone = true;
    this.writeHintFn(null);
    this.emit();

    const tasks: Array<Promise<void>> = [this.persistence.purgeAllScopes()];
    if (curUser) {
      tasks.push(this.persistence.purgeScope(curUser.tenantId, curUser.id));
    }
    if (hint) {
      tasks.push(this.persistence.purgeScope(hint.tenantId, hint.userId));
    }
    await Promise.allSettled(tasks);
  }

  private emitSecurityRevocation(
    event: RealtimeSecurityRevocationEvent
  ): void {
    for (const listener of this.securityRevocationListeners) {
      listener(event);
    }
  }

  private realtimeContext(): RealtimeContext {
    const self = this;
    return {
      get authStatus() {
        return self.authStatus;
      },
      get user() {
        return self.user;
      },
      enableRealtimeOption: this.enableRealtimeOption,
      createRealtimeClientFn: this.createRealtimeClientFn,
      get realtimeClient() {
        return self.realtimeClient;
      },
      setRealtimeClient: (client) => {
        this.realtimeClient = client;
      },
      get realtimeState() {
        return self.realtimeState;
      },
      setRealtimeState: (state) => {
        this.realtimeState = state;
      },
      emit: () => this.emit(),
      realtimeSignalListeners: this.realtimeSignalListeners,
      securityRevocationListeners: this.securityRevocationListeners,
      directoriesByKey: this.directoriesByKey,
      foldersById: this.foldersById,
      get activeDirKey() {
        return self.activeDirKey;
      },
      get syncSeq() {
        return self.syncSeq;
      },
      syncDelta: () => this.syncDelta(),
      purgeCurrentScope: () => this.purgeCurrentScope(),
      invalidateAllCachedDirectories: () =>
        this.invalidateAllCachedDirectories(),
    };
  }

  startRealtime(): void {
    startRealtime(this.realtimeContext());
  }

  stopRealtime(): void {
    stopRealtime(this.realtimeContext());
  }

  async handleRealtimeSignal(
    signal: SyncInvalidationSignal
  ): Promise<void> {
    await handleRealtimeSignal(signal, this.realtimeContext());
  }

  async flushOutbox(): Promise<void> {
    await this.outbox.flushAll();
  }

  async flushPersistence(): Promise<void> {
    return flushPersistence(this.persistenceContext());
  }

  private toastContext(): ToastContext {
    const self = this;
    return {
      get toasts() {
        return self.toasts;
      },
      set toasts(value) {
        self.toasts = value;
      },
      get undoStack() {
        return self.undoStack;
      },
      set undoStack(value) {
        self.undoStack = value;
      },
      toastTimers: this.toastTimers,
      jobPollTimers: this.jobPollTimers,
      copiedRootsByMutationId: this.copiedRootsByMutationId,
      cancelledCopyMutationIds: this.cancelledCopyMutationIds,
      get pendingMutationCount() {
        return self.pendingMutationCount;
      },
      set pendingMutationCount(value) {
        self.pendingMutationCount = value;
      },
      emit: () => this.emit(),
    };
  }

  private clearToastsAndUndo(): void {
    clearToastsAndUndo(this.toastContext());
  }

  dismissToast(id: string): void {
    dismissToast(this.toastContext(), id);
  }

  pushToast(
    toast: Omit<WorkspaceToastItem, 'id'>,
    ttlMs = 6000
  ): string {
    return pushToast(this.toastContext(), toast, ttlMs);
  }

  async undoLatest(): Promise<boolean> {
    return undoLatest(this.toastContext());
  }

  private pushUndo(entry: Omit<UndoAction, 'id'>, toastMessage: string): void {
    pushUndo(this.toastContext(), entry, toastMessage);
  }

  getAncestorClassifications(
    folderId: string | null
  ): ClassificationLabel[] {
    return cacheGetAncestorClassifications(this.cacheContext(), folderId);
  }

  optimisticCreateFolder(input: {
    parentId: string | null;
    name: string;
    classification: ClassificationLabel;
    isPinned?: boolean;
  }): { ok: boolean; error?: string; tempId?: string } {
    return folderOps.optimisticCreateFolder(
      this.optimisticFolderContext(),
      input
    );
  }

  optimisticRenameFolder(
    folder: FolderSummary,
    nextName: string,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    return folderOps.optimisticRenameFolder(
      this.optimisticFolderContext(),
      folder,
      nextName,
      options
    );
  }

  optimisticToggleFolderPin(
    folder: FolderSummary,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    return folderOps.optimisticToggleFolderPin(
      this.optimisticFolderContext(),
      folder,
      options
    );
  }

  optimisticSoftDeleteFolder(
    folder: FolderSummary,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    return folderOps.optimisticSoftDeleteFolder(
      this.optimisticFolderContext(),
      folder,
      options
    );
  }

  optimisticRestoreFolder(
    folder: FolderSummary,
    conflictPolicy: 'fail' | 'rename' = 'rename'
  ): void {
    folderOps.optimisticRestoreFolder(
      this.optimisticFolderContext(),
      folder,
      conflictPolicy
    );
  }

  optimisticRenameFile(
    file: FileItem,
    nextName: string,
    effectiveRole: ResourceRole,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    return fileOps.optimisticRenameFile(
      this.optimisticFileContext(),
      file,
      nextName,
      effectiveRole,
      options
    );
  }

  optimisticSoftDeleteFile(
    file: FileItem,
    folderId: string | null,
    effectiveRole: ResourceRole,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    return fileOps.optimisticSoftDeleteFile(
      this.optimisticFileContext(),
      file,
      folderId,
      effectiveRole,
      options
    );
  }

  optimisticRestoreFile(file: FileItem): void {
    fileOps.optimisticRestoreFile(this.optimisticFileContext(), file);
  }

  optimisticUpdateFileClassification(
    file: FileItem,
    next:
      | { acceptSuggestion: true }
      | { classification: Exclude<ClassificationLabel, 'unset'> },
    options?: {
      effectiveRole?: ResourceRole;
      isPrivilegedAdmin?: boolean;
      skipUndo?: boolean;
    }
  ): { ok: boolean; error?: string; file?: FileItem } {
    return fileOps.optimisticUpdateFileClassification(
      this.optimisticFileContext(),
      file,
      next,
      options
    );
  }

  isFolderAncestorOf(
    ancestorId: string,
    candidateId: string | null
  ): boolean {
    return cacheIsFolderAncestorOf(
      this.cacheContext(),
      ancestorId,
      candidateId
    );
  }

  private resolveItemEffectiveRole(
    type: 'file' | 'folder',
    item: FolderSummary | FileItem
  ): ResourceRole {
    return cacheResolveItemEffectiveRole(this.cacheContext(), type, item);
  }

  private markCachedSubtreeStale(rootFolderId: string): void {
    cacheMarkCachedSubtreeStale(this.cacheContext(), rootFolderId);
  }

  private collectDestNameSets(targetParentId: string | null): {
    existsInCache: boolean;
    folderNames: Set<string>;
    fileNames: Set<string>;
  } {
    return cacheCollectDestNameSets(this.cacheContext(), targetParentId);
  }

  optimisticMoveItems(input: {
    items: Array<{ type: 'file' | 'folder'; id: string }>;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
    skipUndo?: boolean;
    labelOverride?: string;
  }): {
    ok: boolean;
    error?: string;
    movedCount: number;
    skippedCount: number;
  } {
    const targetParentId = input.targetParentId;
    const conflictPolicy: WorkspaceConflictPolicy = input.conflictPolicy ?? 'fail';
    const destView = this.getDirectoryView(targetParentId);

    const plan = planOptimisticMove(input, {
      idAliasMap: this.idAliasMap,
      foldersById: this.foldersById,
      filesById: this.filesById,
      userRole: this.user?.role,
      isFolderAncestorOf: (ancestorId, descendantId) =>
        this.isFolderAncestorOf(ancestorId, descendantId),
      resolveItemEffectiveRole: (type, item) =>
        this.resolveItemEffectiveRole(type, item),
      getDestinationNames: (folderId) => this.collectDestNameSets(folderId),
      destinationRole: destView.effectiveRole,
      getAncestorClassifications: (folderId) =>
        this.getAncestorClassifications(folderId),
      now: this.now,
    });

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
      const oldDir = this.directoriesByKey.get(dirKeyForFolder(prev.parent_id));
      if (oldDir) {
        oldDir.folderIds = removeFromIdList(oldDir.folderIds, prev.id);
      }
      if (prev.parent_id === null && targetParentId !== null) {
        this.rootFolderIds = removeFromIdList(this.rootFolderIds, prev.id);
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
      this.upsertFolderInCache(nextFolder);
      this.markCachedSubtreeStale(prev.id);
    }

    for (const { prev, targetName, targetExt } of filesToMove) {
      const oldDir = this.directoriesByKey.get(dirKeyForFolder(prev.folder_id));
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
      this.upsertFileInCache(nextFile);
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

      this.pushUndo(
        {
          label: '移動を元に戻す',
          applyUndo: () => {
            for (const [origParentId, origItems] of undoGroups.entries()) {
              this.optimisticMoveItems({
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

    // Use `folder.move` for single-folder fail-mode move; `file.move` or `workspace.batch_move` otherwise
    const useSingleFolderMove =
      foldersToMove.length === 1 &&
      filesToMove.length === 0 &&
      conflictPolicy !== 'rename';

    if (useSingleFolderMove) {
      const f = foldersToMove[0]!.prev;
      this.outbox.enqueue({
        id: makeClientMutationId('mut'),
        entityType: 'folder',
        entityId: f.id,
        kind: 'folder.move',
        payload: { fromParentId: f.parent_id, targetParentId },
        expectedVersion: f.version,
        createdAt: this.now(),
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
      const mutId = makeClientMutationId('mut');
      this.outbox.enqueue({
        id: mutId,
        entityType: singleFileOnly ? 'file' : 'folder',
        entityId: singleFileOnly ? filesToMove[0]!.prev.id : `batch:${mutId}`,
        involvedEntityKeys: plan.involvedEntityKeys,
        kind: singleFileOnly ? 'file.move' : 'workspace.batch_move',
        payload: {
          items: plan.batchRefs,
          targetParentId,
          conflictPolicy,
        },
        createdAt: this.now(),
        retryCount: 0,
        rollback: {
          folders: prevFolders,
          files: prevFiles,
          targetParentId,
          existedBefore: true,
        },
      });
    }

    return { ok: true, movedCount: plan.movedCount, skippedCount: plan.skippedCount };
  }

  optimisticCopyItems(input: {
    items: Array<{ type: 'file' | 'folder'; id: string }>;
    targetParentId: string | null;
    mode?: 'copy' | 'duplicate';
    conflictPolicy?: WorkspaceConflictPolicy;
    skipUndo?: boolean;
  }): {
    ok: boolean;
    error?: string;
    tempIds: string[];
    mutationId?: string;
  } {
    const targetParentId = input.targetParentId;
    const destView = this.getDirectoryView(targetParentId);
    const plan = planOptimisticCopy(input, {
      idAliasMap: this.idAliasMap,
      foldersById: this.foldersById,
      filesById: this.filesById,
      userRole: this.user?.role,
      isFolderAncestorOf: (ancestorId, descendantId) =>
        this.isFolderAncestorOf(ancestorId, descendantId),
      resolveItemEffectiveRole: (type, item) =>
        this.resolveItemEffectiveRole(type, item),
      getDestinationNames: (folderId) => this.collectDestNameSets(folderId),
      destinationRole: destView.effectiveRole,
      getAncestorClassifications: (folderId) =>
        this.getAncestorClassifications(folderId),
      now: this.now,
      nextId: (prefix) => makeClientMutationId(prefix),
    });

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
      this.upsertFolderInCache(folder);
    }
    for (const file of plan.tempFiles) {
      this.upsertFileInCache(file);
    }

    if (!input.skipUndo) {
      this.pushUndo(
        {
          label: 'コピーを取り消す',
          applyUndo: () => {
            const realRoots = this.copiedRootsByMutationId.get(mutationId);
            if (realRoots) {
              this.copiedRootsByMutationId.delete(mutationId);
              for (const folder of realRoots.folders) {
                const live = this.foldersById.get(folder.id) ?? folder;
                this.optimisticSoftDeleteFolder(live, { skipUndo: true });
              }
              for (const file of realRoots.files) {
                const live = this.filesById.get(file.id) ?? file;
                const role = this.resolveItemEffectiveRole('file', live);
                this.optimisticSoftDeleteFile(live, live.folder_id, role, {
                  skipUndo: true,
                });
              }
              return;
            }

            // Undone before server ACK arrived (or still queued inside 100ms coalesce window)
            const canceledFromQueue =
              this.outbox.cancelQueuedMutation(mutationId);
            if (!canceledFromQueue) {
              this.cancelledCopyMutationIds.add(mutationId);
            }
            for (const tmpId of tempFolderIds) {
              const tmp = this.foldersById.get(tmpId);
              if (tmp) this.removeFolderFromCache(tmp);
            }
            for (const tmpId of tempFileIds) {
              const tmp = this.filesById.get(tmpId);
              if (tmp) this.removeFileFromCache(tmp.id, tmp.folder_id);
            }
          },
        },
        totalCount === 1
          ? `1 件のアイテムを${duplicateInPlace ? '複製' : 'コピー'}しました`
          : `${totalCount} 件のアイテムを${duplicateInPlace ? '複製' : 'コピー'}しました`
      );
    }

    this.outbox.enqueue({
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
      createdAt: this.now(),
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

  private scheduleAsyncCopyJobPoll(
    jobId: string,
    refreshFolderIds: Array<string | null>,
    totalItems: number,
    attempt = 0
  ): void {
    if (attempt === 0) {
      this.pushToast({
        kind: 'info',
        message: `大容量フォルダ（${totalItems} 件）をバックグラウンドでコピー中...`,
      });
    }
    if (attempt >= 45 || this.authStatus !== 'authenticated') {
      return;
    }
    const timer = setTimeout(async () => {
      this.jobPollTimers.delete(timer);
      if (this.authStatus !== 'authenticated') return;
      try {
        const res = await this.getWorkspaceJobFn(jobId);
        if (res.job.status === 'completed') {
          this.pushToast({
            kind: 'info',
            message: `${res.job.processedItems} 件のバックグラウンドコピーが完了しました`,
          });
          for (const dirId of refreshFolderIds) {
            void this.ensureDirectoryLoaded(dirId, { force: true }).catch(() => undefined);
          }
          void this.syncDelta();
          return;
        }
        if (res.job.status === 'failed') {
          this.pushToast({
            kind: 'error',
            message: res.job.errorMessage ?? 'バックグラウンドコピーに失敗しました',
          });
          return;
        }
        this.scheduleAsyncCopyJobPoll(jobId, refreshFolderIds, totalItems, attempt + 1);
      } catch {
        this.scheduleAsyncCopyJobPoll(jobId, refreshFolderIds, totalItems, attempt + 1);
      }
    }, 600);
    this.jobPollTimers.add(timer);
  }

  startOptimisticUpload(
    folderId: string | null,
    tempId: string,
    meta: { name: string; mimeType: string; sizeBytes: number }
  ): void {
    uploadOps.startOptimisticUpload(
      this.optimisticUploadContext(),
      folderId,
      tempId,
      meta
    );
  }

  updateOptimisticUploadProgress(tempId: string, percent: number): void {
    uploadOps.updateOptimisticUploadProgress(
      this.optimisticUploadContext(),
      tempId,
      percent
    );
  }

  completeOptimisticUpload(tempId: string, serverFile: FileItem): void {
    uploadOps.completeOptimisticUpload(
      this.optimisticUploadContext(),
      tempId,
      serverFile
    );
  }

  failOrCancelOptimisticUpload(tempId: string): void {
    uploadOps.failOrCancelOptimisticUpload(
      this.optimisticUploadContext(),
      tempId
    );
  }

  private async executeOutboxMutation(
    item: OutboxMutationRecord
  ): Promise<OutboxExecutionResult | void> {
    return executeOutboxMutation(item, {
      idAliasMap: this.idAliasMap,
      foldersById: this.foldersById,
      filesById: this.filesById,
      createFolderFn: this.createFolderFn,
      updateFolderFn: this.updateFolderFn,
      softDeleteFolderFn: this.softDeleteFolderFn,
      restoreFolderFn: this.restoreFolderFn,
      updateFileMetadataFn: this.updateFileMetadataFn,
      updateFileClassificationFn: this.updateFileClassificationFn,
      moveFolderFn: this.moveFolderFn,
      batchMoveFn: this.batchMoveFn,
      copyItemsFn: this.copyItemsFn,
      duplicateItemsFn: this.duplicateItemsFn,
      softDeleteFileFn: this.softDeleteFileFn,
      restoreFileFn: this.restoreFileFn,
    });
  }

  private handleOutboxSuccess(
    item: OutboxMutationRecord,
    result: OutboxExecutionResult | void
  ): void {
    const self = this;
    applyOutboxSuccess(item, result, {
      idAliasMap: this.idAliasMap,
      foldersById: this.foldersById,
      filesById: this.filesById,
      directoriesByKey: this.directoriesByKey,
      get rootFolderIds() {
        return self.rootFolderIds;
      },
      set rootFolderIds(next) {
        self.rootFolderIds = next;
      },
      cancelledCopyMutationIds: this.cancelledCopyMutationIds,
      copiedRootsByMutationId: this.copiedRootsByMutationId,
      removeFolderFromCache: (folder) => this.removeFolderFromCache(folder),
      removeFileFromCache: (fileId, folderId) =>
        this.removeFileFromCache(fileId, folderId),
      upsertFolderInCache: (folder) => this.upsertFolderInCache(folder),
      upsertFileInCache: (file) => this.upsertFileInCache(file),
      markCachedSubtreeStale: (folderId) =>
        this.markCachedSubtreeStale(folderId),
      scheduleAsyncCopyJobPoll: (jobId, refreshFolderIds, totalItems) =>
        this.scheduleAsyncCopyJobPoll(jobId, refreshFolderIds, totalItems),
      syncDelta: () => {
        void this.syncDelta();
      },
      ensureDirectoryLoadedForce: (folderId) => {
        void this.ensureDirectoryLoaded(folderId, { force: true }).catch(
          () => undefined
        );
      },
      softDeleteFolder: (folderId, version) => {
        void this.softDeleteFolderFn(folderId, version).catch(() => undefined);
      },
      softDeleteFile: (fileId, version) => {
        void this.softDeleteFileFn(fileId, version).catch(() => undefined);
      },
    });
  }

  private handleOutboxRollback(
    item: OutboxMutationRecord,
    error: unknown,
    latestFromServer?: FolderSummary | FileItem
  ): void {
    const self = this;
    applyOutboxRollback(
      item,
      error,
      {
        idAliasMap: this.idAliasMap,
        foldersById: this.foldersById,
        filesById: this.filesById,
        directoriesByKey: this.directoriesByKey,
        get rootFolderIds() {
          return self.rootFolderIds;
        },
        set rootFolderIds(next) {
          self.rootFolderIds = next;
        },
        removeFolderFromCache: (folder) =>
          this.removeFolderFromCache(folder),
        removeFileFromCache: (fileId, folderId) =>
          this.removeFileFromCache(fileId, folderId),
        upsertFolderInCache: (folder) => this.upsertFolderInCache(folder),
        upsertFileInCache: (file) => this.upsertFileInCache(file),
        markCachedSubtreeStale: (folderId) =>
          this.markCachedSubtreeStale(folderId),
        pushToast: (toast, ttlMs) => this.pushToast(toast, ttlMs),
        syncDelta: () => {
          void this.syncDelta();
        },
      },
      latestFromServer
    );
  }

  private persistenceContext(): PersistenceContext {
    const self = this;
    return {
      persistence: this.persistence,
      maxDirectories: this.maxDirectories,
      now: this.now,
      get user() {
        return self.user;
      },
      set user(value) {
        self.user = value;
      },
      get policy() {
        return self.policy;
      },
      set policy(value) {
        self.policy = value;
      },
      get syncSeq() {
        return self.syncSeq;
      },
      set syncSeq(value) {
        self.syncSeq = value;
      },
      get purgedBeforeSeq() {
        return self.purgedBeforeSeq;
      },
      set purgedBeforeSeq(value) {
        self.purgedBeforeSeq = value;
      },
      get rootFolderIds() {
        return self.rootFolderIds;
      },
      set rootFolderIds(value) {
        self.rootFolderIds = value;
      },
      get rootNextCursor() {
        return self.rootNextCursor;
      },
      set rootNextCursor(value) {
        self.rootNextCursor = value;
      },
      get pinnedFolderIds() {
        return self.pinnedFolderIds;
      },
      set pinnedFolderIds(value) {
        self.pinnedFolderIds = value;
      },
      get bootstrapDone() {
        return self.bootstrapDone;
      },
      set bootstrapDone(value) {
        self.bootstrapDone = value;
      },
      get hydratedScopeKey() {
        return self.hydratedScopeKey;
      },
      set hydratedScopeKey(value) {
        self.hydratedScopeKey = value;
      },
      get activeDirectoryNotice() {
        return self.activeDirectoryNotice;
      },
      set activeDirectoryNotice(value) {
        self.activeDirectoryNotice = value;
      },
      get activeDirKey() {
        return self.activeDirKey;
      },
      set activeDirKey(value) {
        self.activeDirKey = value;
      },
      get persistTimer() {
        return self.persistTimer;
      },
      set persistTimer(value) {
        self.persistTimer = value;
      },
      foldersById: this.foldersById,
      filesById: this.filesById,
      directoriesByKey: this.directoriesByKey,
      inFlightDirs: this.inFlightDirs,
    };
  }

  private resetMemoryOnly(): void {
    resetMemoryOnly(this.persistenceContext());
  }

  private invalidateAllCachedDirectories(): void {
    invalidateAllCachedDirectories(this.persistenceContext());
  }

  private pruneAndSchedulePersist(): void {
    pruneAndSchedulePersist(this.persistenceContext());
  }

  private evictSubtreeFromCache(rootFolderId: string): boolean {
    return evictSubtreeFromCache(this.persistenceContext(), rootFolderId);
  }

  private applyDeltaChanges(changes: SyncDeltaItem[]): {
    shouldRevokeAll: boolean;
    shouldRevalidateActive: boolean;
  } {
    const self = this;
    return applyDeltaChangesToCache(changes, {
      get userId() {
        return self.user?.id;
      },
      foldersById: this.foldersById,
      filesById: this.filesById,
      directoriesByKey: this.directoriesByKey,
      get rootFolderIds() {
        return self.rootFolderIds;
      },
      set rootFolderIds(next) {
        self.rootFolderIds = next;
      },
      get pinnedFolderIds() {
        return self.pinnedFolderIds;
      },
      set pinnedFolderIds(next) {
        self.pinnedFolderIds = next;
      },
      get activeDirKey() {
        return self.activeDirKey;
      },
      setActiveDirectoryNotice: (notice) => {
        this.activeDirectoryNotice = notice;
      },
      evictSubtreeFromCache: (folderId) =>
        this.evictSubtreeFromCache(folderId),
      bootstrapForce: () => {
        void this.bootstrap({ force: true });
      },
      upsertFolderInCache: (folder) => this.upsertFolderInCache(folder),
      upsertFileInCache: (file) => this.upsertFileInCache(file),
    });
  }
}

function isUnauthorizedError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    (err as { status?: number }).status === 401
  );
}

let singletonStore: WorkspaceSyncStore | null = null;

export function getWorkspaceSyncStore(): WorkspaceSyncStore {
  if (!singletonStore) {
    singletonStore = new WorkspaceSyncStore();
  }
  return singletonStore;
}

export function resetWorkspaceSyncStoreForTests(): void {
  singletonStore = null;
}

export function useWorkspaceSyncSnapshot(): SyncStoreSnapshot {
  const store = getWorkspaceSyncStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
}

export function useWorkspaceDirectory(folderId: string | null): {
  snapshot: SyncStoreSnapshot;
  directory: DirectoryViewModel;
  pinnedFolders: FolderSummary[];
} {
  const store = getWorkspaceSyncStore();
  const snapshot = useWorkspaceSyncSnapshot();

  useEffect(() => {
    store.setActiveFolder(folderId);
  }, [store, folderId]);

  const directory = useMemo(
    () => store.getDirectoryView(folderId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, folderId, snapshot.revision]
  );

  const pinnedFolders = useMemo(
    () => store.getPinnedFolders(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, snapshot.revision]
  );

  return { snapshot, directory, pinnedFolders };
}

export { getSyncDbName };
