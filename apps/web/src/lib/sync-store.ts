'use client';

import {
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import { registerAuthPurgeHook } from '@/lib/files-api';
import { MutationOutbox, type OutboxExecutionResult } from '@/lib/mutation-outbox';
import { applyDeltaChangesToCache } from '@/lib/sync-store/delta';
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
  type DirectoryViewModel,
} from '@/lib/sync-store/cache';
import {
  clearToastsAndUndo,
  dismissToast,
  pushToast,
  pushUndo,
  redoLatest,
  undoLatest,
  type UndoAction,
} from '@/lib/sync-store/toasts';
import {
  bootstrap,
  ensureDirectoryLoaded,
  loadMoreDirectory,
  syncDelta,
} from '@/lib/sync-store/directory-sync';
import * as copyOps from '@/lib/sync-store/optimistic-copy';
import * as fileOps from '@/lib/sync-store/optimistic-file';
import * as moveOps from '@/lib/sync-store/optimistic-move';
import * as folderOps from '@/lib/sync-store/optimistic-folder';
import * as uploadOps from '@/lib/sync-store/optimistic-upload';
import { executeOutboxMutation } from '@/lib/sync-store/outbox-execute';
import {
  evictSubtreeFromCache,
  flushPersistence,
  invalidateAllCachedDirectories,
  pruneAndSchedulePersist,
  resetMemoryOnly,
} from '@/lib/sync-store/persistence';
import {
  applyOutboxRollback,
  applyOutboxSuccess,
} from '@/lib/sync-store/outbox-result';
import { getSyncDbName } from '@/lib/sync-idb';
import type { RealtimeSecurityRevocationEvent } from '@/lib/sync-ws';
import {
  handleRealtimeSignal,
  startRealtime,
  stopRealtime,
} from '@/lib/sync-store/realtime';
import {
  buildCacheContext,
  buildDeltaContext,
  buildDirectorySyncContext,
  buildOptimisticCopyContext,
  buildOptimisticFileContext,
  buildOptimisticFolderContext,
  buildOptimisticMoveContext,
  buildOptimisticUploadContext,
  buildOutboxExecuteContext,
  buildOutboxRollbackContext,
  buildOutboxSuccessContext,
  buildPersistenceContext,
  buildRealtimeContext,
  buildToastContext,
  type SyncStoreContextHost,
} from '@/lib/sync-store/context-builders';
import {
  adoptAuthenticatedUserSession,
  buildSessionErrorFromError,
  buildSessionErrorFromRevocation,
  hydrateScopeFromHint,
  purgeCurrentScopeSession,
  scheduleAsyncCopyJobPoll,
  type SessionLifecycleContext,
} from '@/lib/sync-store/session-helpers';
import {
  createInitialSyncStoreState,
  createSyncStoreCollections,
  DEFAULT_SWR_TTL_MS,
  dirKeyForFolder,
  resolveSyncStoreFns,
  type SyncStoreCollections,
  type SyncStoreDeps,
  type SyncStoreMutableState,
  type SyncStoreRuntimeFns,
  type SyncStoreSnapshot,
} from '@/lib/sync-store/types';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type {
  AuthUser,
  BootstrapResponse,
  ClassificationLabel,
  FileItem,
  FolderSummary,
  OutboxMutationRecord,
  ResourceRole,
  SearchResultItem,
  SyncDeltaItem,
  SyncInvalidationSignal,
  WorkspaceConflictPolicy,
  WorkspaceToastItem,
} from '@/types/files';

export type { DirectoryViewModel } from '@/lib/sync-store/cache';
export type { UndoAction } from '@/lib/sync-store/toasts';
export type {
  SessionErrorInfo,
  SyncAuthStatus,
  SyncStoreDeps,
  SyncStoreSnapshot,
} from '@/lib/sync-store/types';
export { dirKeyForFolder } from '@/lib/sync-store/types';

export class WorkspaceSyncStore {
  private readonly state: SyncStoreMutableState;
  private readonly collections: SyncStoreCollections;
  private readonly fns: SyncStoreRuntimeFns;
  private readonly outbox: MutationOutbox;
  private readonly host: SyncStoreContextHost;
  private readonly sessionCtx: SessionLifecycleContext;
  private snapshot: SyncStoreSnapshot;

  constructor(deps: SyncStoreDeps = {}) {
    this.state = createInitialSyncStoreState();
    this.collections = createSyncStoreCollections();
    this.fns = resolveSyncStoreFns(deps);

    this.outbox = new MutationOutbox({
      coalesceWindowMs: deps.outboxCoalesceMs,
      retryDelayBaseMs: deps.outboxRetryDelayBaseMs,
      execute: (item) => this.executeOutboxMutation(item),
      onSuccess: (item, result) => this.handleOutboxSuccess(item, result),
      onRollback: (item, err, latest) => this.handleOutboxRollback(item, err, latest),
      onQueueChange: (pendingCount, queuedItems) => {
        this.state.pendingMutationCount = pendingCount;
        if (this.state.user && this.state.authStatus === 'authenticated') {
          void this.fns.persistence.saveOutbox?.(
            this.state.user.tenantId,
            this.state.user.id,
            queuedItems
          );
        }
        this.emit();
      },
    });

    const registerHook = deps.registerPurgeHook ?? registerAuthPurgeHook;
    registerHook(() => this.purgeCurrentScope());

    this.host = this.createContextHost();
    this.sessionCtx = {
      state: this.state,
      collections: this.collections,
      fns: this.fns,
      outbox: this.outbox,
      emit: () => this.emit(),
      resetMemoryOnly: () => this.resetMemoryOnly(),
      stopRealtime: () => this.stopRealtime(),
      clearToastsAndUndo: () => this.clearToastsAndUndo(),
      bootstrap: (options) => this.bootstrap(options),
    };
    this.snapshot = this.buildSnapshot();
  }

  private createContextHost(): SyncStoreContextHost {
    return {
      state: this.state,
      collections: this.collections,
      fns: this.fns,
      outbox: this.outbox,
      emit: () => this.emit(),
      getDirectoryView: (folderId) => this.getDirectoryView(folderId),
      getAncestorClassifications: (folderId) =>
        this.getAncestorClassifications(folderId),
      upsertFolderInCache: (folder) => this.upsertFolderInCache(folder),
      removeFolderFromCache: (folder) => this.removeFolderFromCache(folder),
      upsertFileInCache: (file) => this.upsertFileInCache(file),
      removeFileFromCache: (fileId, folderId) =>
        this.removeFileFromCache(fileId, folderId),
      markCachedSubtreeStale: (rootFolderId) =>
        this.markCachedSubtreeStale(rootFolderId),
      isFolderAncestorOf: (ancestorId, candidateId) =>
        this.isFolderAncestorOf(ancestorId, candidateId),
      resolveItemEffectiveRole: (type, item) =>
        this.resolveItemEffectiveRole(type, item),
      collectDestNameSets: (targetParentId) =>
        this.collectDestNameSets(targetParentId),
      pushUndo: (entry, message) => this.pushUndo(entry, message),
      pushToast: (toast, ttlMs) => this.pushToast(toast, ttlMs),
      optimisticRestoreFolder: (folder, policy) =>
        this.optimisticRestoreFolder(folder, policy),
      optimisticRestoreFile: (file) => this.optimisticRestoreFile(file),
      optimisticSoftDeleteFolder: (folder, options) =>
        this.optimisticSoftDeleteFolder(folder, options),
      optimisticSoftDeleteFile: (file, folderId, role, options) =>
        this.optimisticSoftDeleteFile(file, folderId, role, options),
      optimisticMoveItems: (input) => this.optimisticMoveItems(input),
      resetMemoryOnly: () => this.resetMemoryOnly(),
      invalidateAllCachedDirectories: () => this.invalidateAllCachedDirectories(),
      pruneAndSchedulePersist: () => this.pruneAndSchedulePersist(),
      evictSubtreeFromCache: (rootFolderId) =>
        this.evictSubtreeFromCache(rootFolderId),
      applyDeltaChanges: (changes) => this.applyDeltaChanges(changes),
      emitSecurityRevocation: (event) => this.emitSecurityRevocation(event),
      purgeCurrentScope: () => this.purgeCurrentScope(),
      reportSessionError: (err) => this.reportSessionError(err),
      reportSessionRevocation: (event) => this.reportSessionRevocation(event),
      startRealtime: () => this.startRealtime(),
      syncDelta: () => this.syncDelta(),
      ensureDirectoryLoaded: (folderId, options) =>
        this.ensureDirectoryLoaded(folderId, options),
      bootstrapForce: () => {
        void this.bootstrap({ force: true });
      },
      scheduleAsyncCopyJobPoll: (jobId, refreshFolderIds, totalItems) =>
        this.scheduleAsyncCopyJobPoll(jobId, refreshFolderIds, totalItems),
    };
  }

  private buildSnapshot(): SyncStoreSnapshot {
    const s = this.state;
    return {
      authStatus: s.authStatus,
      user: s.user,
      policy: s.policy,
      tosStatus: s.tosStatus,
      syncSeq: s.syncSeq,
      purgedBeforeSeq: s.purgedBeforeSeq,
      bootstrapDone: s.bootstrapDone,
      revalidating: s.revalidatingCount > 0,
      realtimeState: s.realtimeState,
      activeDirectoryNotice: s.activeDirectoryNotice,
      toasts: s.toasts,
      canUndo: s.undoStack.length > 0,
      canRedo: s.redoStack.length > 0,
      pendingMutationCount: s.pendingMutationCount,
      revision: s.revision,
      sessionError: s.sessionError,
    };
  }

  private emit(): void {
    this.state.revision += 1;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.collections.listeners) {
      listener();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.collections.listeners.add(listener);
    return () => {
      this.collections.listeners.delete(listener);
    };
  };

  subscribeRealtimeSignals = (
    listener: (signal: SyncInvalidationSignal) => void
  ): (() => void) => {
    this.collections.realtimeSignalListeners.add(listener);
    return () => {
      this.collections.realtimeSignalListeners.delete(listener);
    };
  };

  subscribeSecurityRevocations = (
    listener: (event: RealtimeSecurityRevocationEvent) => void
  ): (() => void) => {
    this.collections.securityRevocationListeners.add(listener);
    return () => {
      this.collections.securityRevocationListeners.delete(listener);
    };
  };

  getSnapshot = (): SyncStoreSnapshot => this.snapshot;

  setActiveFolder(folderId: string | null): void {
    this.state.activeDirKey = dirKeyForFolder(folderId);
    const existing = this.collections.directoriesByKey.get(this.state.activeDirKey);
    if (existing) {
      existing.lastAccessedAt = this.fns.now();
    }
    if (this.state.activeDirectoryNotice) {
      this.state.activeDirectoryNotice = null;
      this.emit();
    }
  }

  clearActiveDirectoryNotice(): void {
    if (this.state.activeDirectoryNotice !== null) {
      this.state.activeDirectoryNotice = null;
      this.emit();
    }
  }

  getDirectoryView(folderId: string | null): DirectoryViewModel {
    return cacheGetDirectoryView(buildCacheContext(this.host), folderId);
  }

  getPinnedFolders(): FolderSummary[] {
    return cacheGetPinnedFolders(buildCacheContext(this.host));
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
    return cacheSearchCachedWorkspaceItems(buildCacheContext(this.host), query, limit);
  }

  isDirectoryFresh(
    folderId: string | null,
    ttlMs = DEFAULT_SWR_TTL_MS
  ): boolean {
    return cacheIsDirectoryFresh(buildCacheContext(this.host), folderId, ttlMs);
  }

  hasCachedDirectory(folderId: string | null): boolean {
    return cacheHasCachedDirectory(buildCacheContext(this.host), folderId);
  }

  /**
   * Immediately hydrate from the user/tenant-scoped IndexedDB database identified
   * by the non-sensitive session scope hint so returning tabs paint in <16ms without spinners.
   */
  async hydrateFromScopeHint(): Promise<boolean> {
    return hydrateScopeFromHint(this.sessionCtx);
  }

  async adoptAuthenticatedUser(nextUser: AuthUser): Promise<void> {
    return adoptAuthenticatedUserSession(this.sessionCtx, nextUser);
  }

  async bootstrap(
    options?: { force?: boolean }
  ): Promise<BootstrapResponse | null> {
    const result = await bootstrap(buildDirectorySyncContext(this.host), options);
    if (result && this.state.sessionError) {
      this.state.sessionError = null;
      this.emit();
    }
    return result;
  }

  /**
   * Fetch and apply authorized incremental deltas from `sinceSeq`.
   * On `resetRequired: true`, wipes stale working-set directories immediately.
   */
  async syncDelta(): Promise<void> {
    return syncDelta(buildDirectorySyncContext(this.host));
  }

  /**
   * Load or SWR-revalidate a folder (or root). When cached in memory/IDB, returns immediately
   * without caller spinners and validates quietly in background unless `force: true`.
   */
  async ensureDirectoryLoaded(
    folderId: string | null,
    options?: {
      force?: boolean;
      signal?: AbortSignal;
      isPrefetch?: boolean;
      sortBy?: WorkspaceSortField;
      sortDir?: WorkspaceSortDirection;
    }
  ): Promise<void> {
    return ensureDirectoryLoaded(
      buildDirectorySyncContext(this.host),
      folderId,
      options
    );
  }

  async loadMoreDirectory(
    folderId: string | null,
    options?: { sortBy?: WorkspaceSortField; sortDir?: WorkspaceSortDirection }
  ): Promise<void> {
    return loadMoreDirectory(
      buildDirectorySyncContext(this.host),
      folderId,
      options
    );
  }

  upsertFileInCache(file: FileItem): void {
    cacheUpsertFileInCache(buildCacheContext(this.host), file);
  }

  removeFileFromCache(fileId: string, folderId: string | null): void {
    cacheRemoveFileFromCache(buildCacheContext(this.host), fileId, folderId);
  }

  upsertFolderInCache(folder: FolderSummary): void {
    cacheUpsertFolderInCache(buildCacheContext(this.host), folder);
  }

  removeFolderFromCache(folder: FolderSummary): void {
    cacheRemoveFolderFromCache(buildCacheContext(this.host), folder);
  }

  /**
   * Capture an authentication failure before the cache is purged so the
   * workspace can render a cause-specific recovery screen. Only guest codes
   * and generic 401s are retained; ordinary member 403s are not session errors.
   */
  reportSessionError(err: unknown): void {
    const nextError = buildSessionErrorFromError(err, this.state.user);
    if (!nextError) return;
    this.state.sessionError = nextError;
    this.emit();
  }

  /**
   * Records why the workspace was forcibly signed out before the cache purge
   * flips `authStatus` to unauthenticated, so the SignInCard can explain the
   * administrative revocation instead of showing a generic prompt.
   */
  reportSessionRevocation(event: RealtimeSecurityRevocationEvent): void {
    const nextError = buildSessionErrorFromRevocation(event, this.state.user);
    if (!nextError) return;
    this.state.sessionError = nextError;
    this.emit();
  }

  /** Complete security purge of memory + IndexedDB + scope hint on logout, 401, or user switch. */
  async purgeCurrentScope(): Promise<void> {
    return purgeCurrentScopeSession(this.sessionCtx);
  }

  private emitSecurityRevocation(
    event: RealtimeSecurityRevocationEvent
  ): void {
    for (const listener of this.collections.securityRevocationListeners) {
      listener(event);
    }
  }

  startRealtime(): void {
    startRealtime(buildRealtimeContext(this.host));
  }

  stopRealtime(): void {
    stopRealtime(buildRealtimeContext(this.host));
  }

  async handleRealtimeSignal(
    signal: SyncInvalidationSignal
  ): Promise<void> {
    await handleRealtimeSignal(signal, buildRealtimeContext(this.host));
  }

  async flushOutbox(): Promise<void> {
    await this.outbox.flushAll();
  }

  async flushPersistence(): Promise<void> {
    return flushPersistence(buildPersistenceContext(this.host));
  }

  private clearToastsAndUndo(): void {
    clearToastsAndUndo(buildToastContext(this.host));
  }

  dismissToast(id: string): void {
    dismissToast(buildToastContext(this.host), id);
  }

  pushToast(
    toast: Omit<WorkspaceToastItem, 'id'>,
    ttlMs = 6000
  ): string {
    return pushToast(buildToastContext(this.host), toast, ttlMs);
  }

  async undoLatest(): Promise<boolean> {
    return undoLatest(buildToastContext(this.host));
  }

  async redoLatest(): Promise<void> {
    await redoLatest(buildToastContext(this.host));
  }

  private pushUndo(entry: Omit<UndoAction, 'id'>, toastMessage: string): void {
    pushUndo(buildToastContext(this.host), entry, toastMessage);
  }

  getAncestorClassifications(
    folderId: string | null
  ): ClassificationLabel[] {
    return cacheGetAncestorClassifications(buildCacheContext(this.host), folderId);
  }

  optimisticCreateFolder(input: {
    parentId: string | null;
    name: string;
    classification: ClassificationLabel;
    isPinned?: boolean;
  }): { ok: boolean; error?: string; tempId?: string } {
    return folderOps.optimisticCreateFolder(
      buildOptimisticFolderContext(this.host),
      input
    );
  }

  optimisticRenameFolder(
    folder: FolderSummary,
    nextName: string,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    return folderOps.optimisticRenameFolder(
      buildOptimisticFolderContext(this.host),
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
      buildOptimisticFolderContext(this.host),
      folder,
      options
    );
  }

  optimisticSoftDeleteFolder(
    folder: FolderSummary,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    return folderOps.optimisticSoftDeleteFolder(
      buildOptimisticFolderContext(this.host),
      folder,
      options
    );
  }

  optimisticRestoreFolder(
    folder: FolderSummary,
    conflictPolicy: 'fail' | 'rename' = 'rename'
  ): void {
    folderOps.optimisticRestoreFolder(
      buildOptimisticFolderContext(this.host),
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
      buildOptimisticFileContext(this.host),
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
      buildOptimisticFileContext(this.host),
      file,
      folderId,
      effectiveRole,
      options
    );
  }

  optimisticRestoreFile(file: FileItem): void {
    fileOps.optimisticRestoreFile(buildOptimisticFileContext(this.host), file);
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
      buildOptimisticFileContext(this.host),
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
      buildCacheContext(this.host),
      ancestorId,
      candidateId
    );
  }

  private resolveItemEffectiveRole(
    type: 'file' | 'folder',
    item: FolderSummary | FileItem
  ): ResourceRole {
    return cacheResolveItemEffectiveRole(buildCacheContext(this.host), type, item);
  }

  private markCachedSubtreeStale(rootFolderId: string): void {
    cacheMarkCachedSubtreeStale(buildCacheContext(this.host), rootFolderId);
  }

  private collectDestNameSets(targetParentId: string | null): {
    existsInCache: boolean;
    folderNames: Set<string>;
    fileNames: Set<string>;
  } {
    return cacheCollectDestNameSets(buildCacheContext(this.host), targetParentId);
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
    return moveOps.optimisticMoveItems(
      buildOptimisticMoveContext(this.host, input.targetParentId),
      input
    );
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
    return copyOps.optimisticCopyItems(
      buildOptimisticCopyContext(this.host, input.targetParentId),
      input
    );
  }

  private scheduleAsyncCopyJobPoll(
    jobId: string,
    refreshFolderIds: Array<string | null>,
    totalItems: number
  ): void {
    scheduleAsyncCopyJobPoll(
      {
        getAuthStatus: () => this.state.authStatus,
        getWorkspaceJobFn: this.fns.getWorkspaceJobFn,
        jobPollTimers: this.collections.jobPollTimers,
        pushToast: (toast, ttlMs) => this.pushToast(toast, ttlMs),
        ensureDirectoryLoadedForce: (dirId) => {
          void this.ensureDirectoryLoaded(dirId, { force: true }).catch(
            () => undefined
          );
        },
        syncDelta: () => {
          void this.syncDelta();
        },
      },
      jobId,
      refreshFolderIds,
      totalItems
    );
  }

  startOptimisticUpload(
    folderId: string | null,
    tempId: string,
    meta: { name: string; mimeType: string; sizeBytes: number }
  ): void {
    uploadOps.startOptimisticUpload(
      buildOptimisticUploadContext(this.host),
      folderId,
      tempId,
      meta
    );
  }

  updateOptimisticUploadProgress(tempId: string, percent: number): void {
    uploadOps.updateOptimisticUploadProgress(
      buildOptimisticUploadContext(this.host),
      tempId,
      percent
    );
  }

  completeOptimisticUpload(tempId: string, serverFile: FileItem): void {
    uploadOps.completeOptimisticUpload(
      buildOptimisticUploadContext(this.host),
      tempId,
      serverFile
    );
  }

  failOrCancelOptimisticUpload(tempId: string): void {
    uploadOps.failOrCancelOptimisticUpload(
      buildOptimisticUploadContext(this.host),
      tempId
    );
  }

  private async executeOutboxMutation(
    item: OutboxMutationRecord
  ): Promise<OutboxExecutionResult | void> {
    return executeOutboxMutation(item, buildOutboxExecuteContext(this.host));
  }

  private handleOutboxSuccess(
    item: OutboxMutationRecord,
    result: OutboxExecutionResult | void
  ): void {
    applyOutboxSuccess(item, result, buildOutboxSuccessContext(this.host));
  }

  private handleOutboxRollback(
    item: OutboxMutationRecord,
    error: unknown,
    latestFromServer?: FolderSummary | FileItem
  ): void {
    applyOutboxRollback(
      item,
      error,
      buildOutboxRollbackContext(this.host),
      latestFromServer
    );
  }

  private resetMemoryOnly(): void {
    resetMemoryOnly(buildPersistenceContext(this.host));
  }

  private invalidateAllCachedDirectories(): void {
    invalidateAllCachedDirectories(buildPersistenceContext(this.host));
  }

  private pruneAndSchedulePersist(): void {
    pruneAndSchedulePersist(buildPersistenceContext(this.host));
  }

  private evictSubtreeFromCache(rootFolderId: string): boolean {
    return evictSubtreeFromCache(buildPersistenceContext(this.host), rootFolderId);
  }

  private applyDeltaChanges(changes: SyncDeltaItem[]): {
    shouldRevokeAll: boolean;
    shouldRevalidateActive: boolean;
  } {
    return applyDeltaChangesToCache(changes, buildDeltaContext(this.host));
  }
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
