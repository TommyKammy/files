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
import {
  normalizeSecurityRevocationEvent,
  type RealtimeConnectionState,
  type RealtimeSecurityRevocationEvent,
  WorkspaceRealtimeClient,
} from '@/lib/sync-ws';
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
const MAX_UNDO_STACK = 20;

export type SyncAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

export interface UndoAction {
  id: string;
  label: string;
  applyUndo: () => Promise<void> | void;
}

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

export interface DirectoryViewModel {
  dirKey: string;
  folderId: string | null;
  existsInCache: boolean;
  isStale: boolean;
  folder: FolderSummary | null;
  effectiveRole: ResourceRole;
  folders: FolderSummary[];
  files: FileItem[];
  breadcrumbs: BreadcrumbItem[];
  nextCursor: string | null;
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
    const dirKey = dirKeyForFolder(folderId);
    const record = this.directoriesByKey.get(dirKey);

    if (!record) {
      return {
        dirKey,
        folderId,
        existsInCache: false,
        isStale: true,
        folder: folderId ? this.foldersById.get(folderId) ?? null : null,
        effectiveRole: folderId ? this.foldersById.get(folderId)?.effectiveRole ?? 'viewer' : 'editor',
        folders: [],
        files: [],
        breadcrumbs: [],
        nextCursor: null,
      };
    }

    const folders: FolderSummary[] = [];
    for (const id of record.folderIds) {
      const f = this.foldersById.get(id);
      if (f && f.deleted_at == null) folders.push(f);
    }
    const files: FileItem[] = [];
    for (const id of record.fileIds) {
      const fl = this.filesById.get(id);
      if (fl && fl.deleted_at == null) files.push(fl);
    }

    return {
      dirKey,
      folderId,
      existsInCache: true,
      isStale: Boolean(record.stale),
      folder: folderId ? this.foldersById.get(folderId) ?? null : null,
      effectiveRole: record.effectiveRole,
      folders,
      files,
      breadcrumbs: record.breadcrumbs,
      nextCursor: record.nextCursor,
    };
  }

  getPinnedFolders(): FolderSummary[] {
    const list: FolderSummary[] = [];
    for (const id of this.pinnedFolderIds) {
      const folder = this.foldersById.get(id);
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
  searchCachedWorkspaceItems(
    query: string,
    limit = 20
  ): {
    folders: Array<{ folder: FolderSummary; pathHint: string }>;
    files: SearchResultItem[];
  } {
    if (this.authStatus !== 'authenticated') {
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
        const f = this.foldersById.get(cursor);
        if (!f) break;
        parts.unshift(f.name);
        cursor = f.parent_id;
      }
      return parts.length > 0 ? parts.join(' / ') : 'フォルダ';
    };

    const folders = Array.from(this.foldersById.values())
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

    const files = Array.from(this.filesById.values())
      .filter((file) => {
        if (file.deleted_at != null) return false;
        if (file.upload_state === 'pending') return false;
        const parentName = file.folder_id
          ? this.foldersById.get(file.folder_id)?.name ?? null
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
            ? this.foldersById.get(file.folder_id)?.name ?? null
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

  isDirectoryFresh(folderId: string | null, ttlMs = DEFAULT_SWR_TTL_MS): boolean {
    const dir = this.directoriesByKey.get(dirKeyForFolder(folderId));
    if (!dir || dir.stale) return false;
    return this.now() - dir.revalidatedAt < ttlMs;
  }

  hasCachedDirectory(folderId: string | null): boolean {
    return this.directoriesByKey.has(dirKeyForFolder(folderId));
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

  async bootstrap(options?: { force?: boolean }): Promise<BootstrapResponse | null> {
    if (this.bootstrapPromise && !options?.force) {
      return this.bootstrapPromise;
    }

    let promise: Promise<BootstrapResponse | null> | null = null;
    promise = (async (): Promise<BootstrapResponse | null> => {
      this.revalidatingCount += 1;
      this.emit();

      try {
        const res = await this.fetchBootstrapFn();
        const prevUser = this.user;
        const hint = this.readHintFn();

        // Detect tenant or user identity change and eradicate old local cache immediately
        if (
          prevUser &&
          (prevUser.id !== res.user.id || prevUser.tenantId !== res.user.tenantId)
        ) {
          await this.persistence.purgeScope(prevUser.tenantId, prevUser.id);
          this.resetMemoryOnly();
        } else if (
          hint &&
          (hint.userId !== res.user.id || hint.tenantId !== res.user.tenantId)
        ) {
          await this.persistence.purgeScope(hint.tenantId, hint.userId);
          this.resetMemoryOnly();
        }

        const previousSeq = this.syncSeq;
        this.user = res.user;
        this.authStatus = 'authenticated';
        this.hydratedScopeKey = `${res.user.tenantId}:${res.user.id}`;
        this.writeHintFn(res.user);
        this.policy = res.policy;
        this.purgedBeforeSeq = res.purgedBeforeSeq;
        this.bootstrapDone = true;

        // If client sync cursor predates Cron purge horizon, drop cached child directories
        if (previousSeq > 0 && previousSeq < res.purgedBeforeSeq) {
          this.invalidateAllCachedDirectories();
          this.syncSeq = res.currentSeq;
        } else if (this.syncSeq === 0) {
          this.syncSeq = res.currentSeq;
        }

        const nowMs = this.now();
        for (const rf of res.rootFolders) {
          this.foldersById.set(rf.id, rf);
        }
        for (const pf of res.pinnedFolders) {
          this.foldersById.set(pf.id, pf);
        }

        this.rootFolderIds = res.rootFolders.map((f) => f.id);
        this.rootNextCursor = null;
        this.pinnedFolderIds = res.pinnedFolders.map((f) => f.id);

        this.directoriesByKey.set(ROOT_DIR_KEY, {
          dirKey: ROOT_DIR_KEY,
          folderId: null,
          effectiveRole: 'editor',
          folderIds: this.rootFolderIds,
          fileIds: [],
          nextCursor: null,
          breadcrumbs: [],
          lastAccessedAt: nowMs,
          revalidatedAt: nowMs,
          stale: false,
        });

        this.pruneAndSchedulePersist();
        this.emit();

        // Reconcile any incremental changes between previous cached seq and server head
        if (
          previousSeq > 0 &&
          previousSeq >= res.purgedBeforeSeq &&
          previousSeq < res.currentSeq
        ) {
          await this.syncDelta();
        }

        const currentScopeKey = `${res.user.tenantId}:${res.user.id}`;
        if (this.outboxLoadedScopeKey !== currentScopeKey) {
          this.outboxLoadedScopeKey = currentScopeKey;
          const persistedOutbox =
            (await this.persistence.loadOutbox?.(res.user.tenantId, res.user.id)) ?? [];
          if (persistedOutbox.length > 0) {
            this.outbox.restorePersistedItems(persistedOutbox);
          }
        }

        this.startRealtime();
        return res;
      } catch (err) {
        if (isUnauthorizedError(err)) {
          await this.purgeCurrentScope();
          return null;
        }
        throw err;
      } finally {
        this.revalidatingCount = Math.max(0, this.revalidatingCount - 1);
        this.emit();
        if (this.bootstrapPromise === promise) {
          this.bootstrapPromise = null;
        }
      }
    })();

    this.bootstrapPromise = promise;
    return promise;
  }

  /**
   * Fetch and apply authorized incremental deltas from `sinceSeq`.
   * On `resetRequired: true`, wipes stale working-set directories immediately.
   */
  async syncDelta(): Promise<void> {
    if (this.authStatus !== 'authenticated' || !this.user) return;
    if (this.deltaPromise) return this.deltaPromise;

    const promise = (async () => {
      let rounds = 0;
      let shouldReloadActive = false;

      while (rounds < MAX_DELTA_PAGES_PER_SYNC) {
        rounds += 1;
        const delta = await this.fetchDeltaFn(this.syncSeq, 200);
        this.purgedBeforeSeq = delta.purgedBeforeSeq;

        if (delta.resetRequired) {
          this.invalidateAllCachedDirectories();
          this.syncSeq = delta.currentSeq;
          shouldReloadActive = true;
          break;
        }

        if (delta.changes.length > 0) {
          const outcome = this.applyDeltaChanges(delta.changes);
          if (outcome.shouldRevokeAll) {
            this.emitSecurityRevocation({
              kind: 'user.suspended',
              scopeFolderIds: [],
              seq: null,
            });
            await this.purgeCurrentScope();
            return;
          }
          for (const change of delta.changes) {
            if (change.action === 'permission.revoke') {
              const myUserId = this.user?.id;
              const granteeType = change.payload?.granteeType;
              if (
                granteeType === 'group' ||
                (granteeType === 'user' && change.targetUserId === myUserId)
              ) {
                this.emitSecurityRevocation({
                  kind: 'permission.revoke',
                  scopeFolderIds: change.folderId ? [change.folderId] : [],
                  seq: change.seq,
                });
              }
            } else if (change.action === 'shared_link.revoke') {
              this.emitSecurityRevocation({
                kind: 'shared_link.revoke',
                scopeFolderIds: change.folderId ? [change.folderId] : [],
                seq: change.seq,
              });
            }
          }
          if (outcome.shouldRevalidateActive) {
            shouldReloadActive = true;
          }
        }

        this.syncSeq = Math.max(this.syncSeq, delta.nextSeq);
        if (!delta.hasMore) break;
      }

      this.pruneAndSchedulePersist();
      this.emit();

      if (shouldReloadActive) {
        const folderId = this.activeDirKey === ROOT_DIR_KEY ? null : this.activeDirKey;
        await this.ensureDirectoryLoaded(folderId, { force: true });
      }
    })()
      .catch(async (err) => {
        if (isUnauthorizedError(err)) {
          await this.purgeCurrentScope();
        }
      })
      .finally(() => {
        if (this.deltaPromise === promise) {
          this.deltaPromise = null;
        }
      });

    this.deltaPromise = promise;
    return promise;
  }

  /**
   * Load or SWR-revalidate a folder (or root). When cached in memory/IDB, returns immediately
   * without caller spinners and validates quietly in background unless `force: true`.
   */
  async ensureDirectoryLoaded(
    folderId: string | null,
    options?: { force?: boolean; signal?: AbortSignal; isPrefetch?: boolean }
  ): Promise<void> {
    const dirKey = dirKeyForFolder(folderId);
    const cached = this.directoriesByKey.get(dirKey);

    if (
      !options?.force &&
      cached &&
      !cached.stale &&
      this.now() - cached.revalidatedAt < DEFAULT_SWR_TTL_MS
    ) {
      cached.lastAccessedAt = this.now();
      return;
    }

    const existingReq = this.inFlightDirs.get(dirKey);
    if (existingReq) {
      return existingReq;
    }

    let run: Promise<void> | null = null;
    run = (async () => {
      if (!options?.isPrefetch) {
        this.revalidatingCount += 1;
        this.emit();
      }
      try {
        const nowMs = this.now();
        if (folderId === null) {
          const rootsRes = await this.fetchRootFoldersFn(null, options?.signal);
          for (const f of rootsRes.folders) {
            this.foldersById.set(f.id, f);
          }
          this.rootFolderIds = rootsRes.folders.map((f) => f.id);
          this.rootNextCursor = rootsRes.nextCursor;
          this.directoriesByKey.set(ROOT_DIR_KEY, {
            dirKey: ROOT_DIR_KEY,
            folderId: null,
            effectiveRole: 'editor',
            folderIds: this.rootFolderIds,
            fileIds: [],
            nextCursor: rootsRes.nextCursor,
            breadcrumbs: [],
            lastAccessedAt: nowMs,
            revalidatedAt: nowMs,
            stale: false,
          });
        } else {
          const res = await this.fetchFolderChildrenFn(folderId, null, 50, {
            includeBreadcrumbs: true,
            signal: options?.signal,
          });
          if (res.folder) {
            this.foldersById.set(res.folder.id, {
              ...res.folder,
              effectiveRole: res.effectiveRole,
            });
          }
          for (const f of res.folders) {
            this.foldersById.set(f.id, f);
          }
          for (const fl of res.files) {
            this.filesById.set(fl.id, fl);
          }
          this.directoriesByKey.set(dirKey, {
            dirKey,
            folderId,
            effectiveRole: res.effectiveRole,
            folderIds: res.folders.map((f) => f.id),
            fileIds: res.files.map((fl) => fl.id),
            nextCursor: res.nextCursor,
            breadcrumbs: res.breadcrumbs ?? cached?.breadcrumbs ?? [],
            lastAccessedAt: nowMs,
            revalidatedAt: nowMs,
            stale: false,
          });
        }

        this.pruneAndSchedulePersist();
        this.emit();
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        if (isUnauthorizedError(err)) {
          await this.purgeCurrentScope();
          return;
        }
        if (!options?.isPrefetch) {
          throw err;
        }
      } finally {
        if (!options?.isPrefetch) {
          this.revalidatingCount = Math.max(0, this.revalidatingCount - 1);
          this.emit();
        }
        if (this.inFlightDirs.get(dirKey) === run) {
          this.inFlightDirs.delete(dirKey);
        }
      }
    })();

    this.inFlightDirs.set(dirKey, run);
    return run;
  }

  async loadMoreDirectory(folderId: string | null): Promise<void> {
    const dirKey = dirKeyForFolder(folderId);
    const current = this.directoriesByKey.get(dirKey);
    if (!current?.nextCursor) return;

    const nowMs = this.now();
    if (folderId === null) {
      const res = await this.fetchRootFoldersFn(current.nextCursor);
      for (const f of res.folders) {
        this.foldersById.set(f.id, f);
      }
      const nextIds = [...current.folderIds];
      for (const f of res.folders) {
        if (!nextIds.includes(f.id)) nextIds.push(f.id);
      }
      this.rootFolderIds = nextIds;
      this.rootNextCursor = res.nextCursor;
      this.directoriesByKey.set(ROOT_DIR_KEY, {
        ...current,
        folderIds: nextIds,
        nextCursor: res.nextCursor,
        lastAccessedAt: nowMs,
      });
    } else {
      const res = await this.fetchFolderChildrenFn(folderId, current.nextCursor, 50, {
        includeBreadcrumbs: false,
      });
      for (const f of res.folders) this.foldersById.set(f.id, f);
      for (const fl of res.files) this.filesById.set(fl.id, fl);

      const nextFolderIds = [...current.folderIds];
      for (const f of res.folders) {
        if (!nextFolderIds.includes(f.id)) nextFolderIds.push(f.id);
      }
      const nextFileIds = [...current.fileIds];
      for (const fl of res.files) {
        if (!nextFileIds.includes(fl.id)) nextFileIds.push(fl.id);
      }
      this.directoriesByKey.set(dirKey, {
        ...current,
        folderIds: nextFolderIds,
        fileIds: nextFileIds,
        nextCursor: res.nextCursor,
        lastAccessedAt: nowMs,
      });
    }

    this.pruneAndSchedulePersist();
    this.emit();
  }

  /** Local cache helpers used by mutations to update store synchronously before/after server ack */
  upsertFileInCache(file: FileItem): void {
    this.filesById.set(file.id, file);
    const dirKey = dirKeyForFolder(file.folder_id);
    const dir = this.directoriesByKey.get(dirKey);
    if (dir && !dir.fileIds.includes(file.id)) {
      dir.fileIds = [file.id, ...dir.fileIds];
    }
    this.pruneAndSchedulePersist();
    this.emit();
  }

  removeFileFromCache(fileId: string, folderId: string | null): void {
    this.filesById.delete(fileId);
    const dir = this.directoriesByKey.get(dirKeyForFolder(folderId));
    if (dir) {
      dir.fileIds = removeFromIdList(dir.fileIds, fileId);
    }
    this.pruneAndSchedulePersist();
    this.emit();
  }

  upsertFolderInCache(folder: FolderSummary): void {
    this.foldersById.set(folder.id, folder);
    const parentKey = dirKeyForFolder(folder.parent_id);
    const dir = this.directoriesByKey.get(parentKey);
    if (dir && !dir.folderIds.includes(folder.id)) {
      dir.folderIds = [folder.id, ...dir.folderIds];
    }
    if (folder.parent_id === null && !this.rootFolderIds.includes(folder.id)) {
      this.rootFolderIds = [folder.id, ...this.rootFolderIds];
    }
    if (folder.is_pinned === 1) {
      this.pinnedFolderIds = dedupePush(this.pinnedFolderIds, folder.id);
    } else {
      this.pinnedFolderIds = removeFromIdList(this.pinnedFolderIds, folder.id);
    }
    this.pruneAndSchedulePersist();
    this.emit();
  }

  removeFolderFromCache(folder: FolderSummary): void {
    this.foldersById.delete(folder.id);
    this.directoriesByKey.delete(folder.id);
    this.rootFolderIds = removeFromIdList(this.rootFolderIds, folder.id);
    this.pinnedFolderIds = removeFromIdList(this.pinnedFolderIds, folder.id);
    const parentDir = this.directoriesByKey.get(dirKeyForFolder(folder.parent_id));
    if (parentDir) {
      parentDir.folderIds = removeFromIdList(parentDir.folderIds, folder.id);
    }
    this.pruneAndSchedulePersist();
    this.emit();
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

  private emitSecurityRevocation(event: RealtimeSecurityRevocationEvent): void {
    for (const listener of this.securityRevocationListeners) {
      listener(event);
    }
  }

  private markScopeFoldersStale(
    scopeFolderIds: readonly string[],
    markAllOnEmpty = false
  ): void {
    if (scopeFolderIds.length === 0) {
      if (markAllOnEmpty) {
        this.invalidateAllCachedDirectories();
      }
      return;
    }

    for (const folderId of scopeFolderIds) {
      const dir = this.directoriesByKey.get(folderId);
      if (dir) {
        dir.stale = true;
      }
      const folder = this.foldersById.get(folderId);
      if (folder) {
        const parentDir = this.directoriesByKey.get(dirKeyForFolder(folder.parent_id));
        if (parentDir) {
          parentDir.stale = true;
        }
      }
    }
  }

  startRealtime(): void {
    if (this.authStatus !== 'authenticated' || !this.user) return;
    if (this.enableRealtimeOption === false) return;
    const hasNativeWs =
      typeof window !== 'undefined' && typeof WebSocket !== 'undefined';
    if (!this.createRealtimeClientFn && !hasNativeWs) return;

    if (!this.realtimeClient) {
      const onSignal = (signal: SyncInvalidationSignal) =>
        this.handleRealtimeSignal(signal);
      const onCatchup = () => this.syncDelta();
      const onStateChange = (state: RealtimeConnectionState) => {
        if (this.realtimeState !== state) {
          this.realtimeState = state;
          this.emit();
        }
      };

      this.realtimeClient = this.createRealtimeClientFn
        ? this.createRealtimeClientFn({ onSignal, onCatchup, onStateChange })
        : new WorkspaceRealtimeClient({ onSignal, onCatchup, onStateChange });
    }

    this.realtimeClient.start();
  }

  stopRealtime(): void {
    if (this.realtimeClient) {
      this.realtimeClient.stop();
    }
    if (this.realtimeState !== 'disconnected') {
      this.realtimeState = 'disconnected';
    }
  }

  async handleRealtimeSignal(signal: SyncInvalidationSignal): Promise<void> {
    if (this.authStatus !== 'authenticated' || !this.user) return;

    for (const listener of this.realtimeSignalListeners) {
      listener(signal);
    }

    const revocation = normalizeSecurityRevocationEvent(signal);
    if (revocation?.kind === 'user.suspended') {
      this.emitSecurityRevocation(revocation);
      await this.purgeCurrentScope();
      return;
    }

    if (revocation) {
      this.emitSecurityRevocation(revocation);
      this.markScopeFoldersStale(
        signal.scopeFolderIds,
        revocation.kind === 'permission.revoke'
      );
      await this.syncDelta();
      return;
    }

    this.markScopeFoldersStale(signal.scopeFolderIds, false);
    const activeStale = Boolean(this.directoriesByKey.get(this.activeDirKey)?.stale);
    if (signal.seq === null || signal.seq > this.syncSeq || activeStale) {
      await this.syncDelta();
    } else {
      this.emit();
    }
  }

  async flushOutbox(): Promise<void> {
    await this.outbox.flushAll();
  }

  async flushPersistence(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistNow();
  }

  private clearToastsAndUndo(): void {
    for (const timer of this.toastTimers.values()) {
      clearTimeout(timer);
    }
    this.toastTimers.clear();
    for (const timer of this.jobPollTimers) {
      clearTimeout(timer);
    }
    this.jobPollTimers.clear();
    this.toasts = [];
    this.undoStack = [];
    this.copiedRootsByMutationId.clear();
    this.cancelledCopyMutationIds.clear();
    this.pendingMutationCount = 0;
  }

  dismissToast(id: string): void {
    const timer = this.toastTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.toastTimers.delete(id);
    }
    if (this.toasts.some((t) => t.id === id)) {
      this.toasts = this.toasts.filter((t) => t.id !== id);
      this.emit();
    }
  }

  pushToast(
    toast: Omit<WorkspaceToastItem, 'id'>,
    ttlMs = 6000
  ): string {
    const id = makeClientMutationId('toast');
    const next: WorkspaceToastItem = { id, ...toast };
    this.toasts = [...this.toasts.slice(-2), next];
    this.emit();

    if (ttlMs > 0) {
      const timer = setTimeout(() => {
        this.toastTimers.delete(id);
        this.dismissToast(id);
      }, ttlMs);
      this.toastTimers.set(id, timer);
    }
    return id;
  }

  async undoLatest(): Promise<boolean> {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    for (const t of this.toasts) {
      if (t.canUndo) {
        this.dismissToast(t.id);
      }
    }
    await entry.applyUndo();
    this.emit();
    return true;
  }

  private pushUndo(entry: Omit<UndoAction, 'id'>, toastMessage: string): void {
    const action: UndoAction = {
      id: makeClientMutationId('undo'),
      ...entry,
    };
    this.undoStack = [...this.undoStack.slice(-(MAX_UNDO_STACK - 1)), action];
    this.pushToast({
      kind: 'undo',
      message: toastMessage,
      undoLabel: '元に戻す',
      canUndo: true,
    });
  }

  getAncestorClassifications(folderId: string | null): ClassificationLabel[] {
    if (!folderId) return [];
    const labels: ClassificationLabel[] = [];
    const dir = this.directoriesByKey.get(dirKeyForFolder(folderId));
    if (dir) {
      for (const crumb of dir.breadcrumbs) {
        labels.push(crumb.classification);
      }
    }
    let cursorId: string | null = folderId;
    const seen = new Set<string>();
    while (cursorId && !seen.has(cursorId)) {
      seen.add(cursorId);
      const folder = this.foldersById.get(cursorId);
      if (!folder) break;
      labels.push(folder.classification);
      cursorId = folder.parent_id;
    }
    return labels;
  }

  optimisticCreateFolder(input: {
    parentId: string | null;
    name: string;
    classification: ClassificationLabel;
    isPinned?: boolean;
  }): { ok: boolean; error?: string; tempId?: string } {
    const name = input.name.trim();
    if (!name) {
      return { ok: false, error: 'フォルダ名を入力してください' };
    }

    const parentRole = this.getDirectoryView(input.parentId).effectiveRole;
    const roleCheck = checkRoleGuard(parentRole, 'editor');
    if (!roleCheck.ok) {
      return { ok: false, error: roleCheck.message };
    }

    const parentView = this.getDirectoryView(input.parentId);
    if (parentView.folders.some((f) => f.name === name && f.deleted_at == null)) {
      return { ok: false, error: `同名フォルダ「${name}」がすでに存在します` };
    }

    const tempId = makeClientMutationId('tmp-folder');
    const nowIso = new Date(this.now()).toISOString();
    const effectiveClassification = isClassificationFloorViolated(
      this.getAncestorClassifications(input.parentId),
      input.classification
    )
      ? 'confidential'
      : input.classification;

    const tempFolder: FolderSummary = {
      id: tempId,
      parent_id: input.parentId,
      name,
      classification: effectiveClassification,
      is_pinned: input.isPinned ? 1 : 0,
      version: 1,
      updated_at: nowIso,
      effectiveRole: 'owner',
      optimistic: true,
    };

    this.upsertFolderInCache(tempFolder);
    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'folder',
      entityId: tempId,
      kind: 'folder.create',
      payload: {
        parentId: input.parentId,
        name,
        classification: effectiveClassification,
        isPinned: Boolean(input.isPinned),
      },
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        existedBefore: false,
        parentId: input.parentId,
      },
    });
    return { ok: true, tempId };
  }

  optimisticRenameFolder(
    folder: FolderSummary,
    nextName: string,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    const trimmed = nextName.trim();
    if (!trimmed) {
      return { ok: false, error: 'フォルダ名を入力してください' };
    }
    if (trimmed === folder.name) {
      return { ok: true };
    }

    const parentView = this.getDirectoryView(folder.parent_id);
    const effectiveRole = folder.effectiveRole ?? parentView.effectiveRole;
    const roleCheck = checkRoleGuard(effectiveRole, 'editor');
    if (!roleCheck.ok) {
      return { ok: false, error: roleCheck.message };
    }
    if (
      parentView.folders.some(
        (f) => f.id !== folder.id && f.name === trimmed && f.deleted_at == null
      )
    ) {
      return { ok: false, error: `同名フォルダ「${trimmed}」がすでに存在します` };
    }

    const prevFolder: FolderSummary = { ...folder };
    const updated: FolderSummary = {
      ...folder,
      name: trimmed,
      updated_at: new Date(this.now()).toISOString(),
    };

    this.upsertFolderInCache(updated);
    if (!options?.skipUndo) {
      this.pushUndo(
        {
          label: `「${trimmed}」の名前変更を取り消す`,
          applyUndo: () => {
            const current = this.foldersById.get(updated.id) ?? updated;
            this.optimisticRenameFolder(current, prevFolder.name, { skipUndo: true });
          },
        },
        `フォルダ名を「${trimmed}」に変更しました`
      );
    }

    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'folder',
      entityId: folder.id,
      kind: 'folder.patch',
      payload: { name: trimmed },
      expectedVersion: folder.version,
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        folder: prevFolder,
        existedBefore: true,
        parentId: folder.parent_id,
      },
    });

    return { ok: true };
  }

  optimisticToggleFolderPin(
    folder: FolderSummary,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    const parentView = this.getDirectoryView(folder.parent_id);
    const effectiveRole = folder.effectiveRole ?? parentView.effectiveRole;
    const roleCheck = checkRoleGuard(effectiveRole, 'editor');
    if (!roleCheck.ok) {
      return { ok: false, error: roleCheck.message };
    }

    const prevFolder: FolderSummary = { ...folder };
    const nextPinned = folder.is_pinned === 1 ? 0 : 1;
    const updated: FolderSummary = {
      ...folder,
      is_pinned: nextPinned,
      updated_at: new Date(this.now()).toISOString(),
    };

    this.upsertFolderInCache(updated);
    if (!options?.skipUndo) {
      this.pushUndo(
        {
          label: 'ピン留め変更を取り消す',
          applyUndo: () => {
            const current = this.foldersById.get(updated.id) ?? updated;
            this.optimisticToggleFolderPin(current, { skipUndo: true });
          },
        },
        nextPinned === 1
          ? `「${folder.name}」をピン留めしました`
          : `「${folder.name}」のピン留めを解除しました`
      );
    }

    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'folder',
      entityId: folder.id,
      kind: 'folder.patch',
      payload: { isPinned: nextPinned === 1 },
      expectedVersion: folder.version,
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        folder: prevFolder,
        existedBefore: true,
        parentId: folder.parent_id,
      },
    });

    return { ok: true };
  }

  optimisticSoftDeleteFolder(
    folder: FolderSummary,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    const parentView = this.getDirectoryView(folder.parent_id);
    const effectiveRole = folder.effectiveRole ?? parentView.effectiveRole;
    const roleCheck = checkRoleGuard(effectiveRole, 'editor');
    if (!roleCheck.ok) {
      return { ok: false, error: roleCheck.message };
    }

    const prevFolder: FolderSummary = { ...folder };
    this.removeFolderFromCache(folder);

    if (!options?.skipUndo) {
      this.pushUndo(
        {
          label: `「${folder.name}」の削除を取り消す`,
          applyUndo: () => {
            this.optimisticRestoreFolder(prevFolder);
          },
        },
        `「${folder.name}」をゴミ箱へ移動しました`
      );
    }

    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'folder',
      entityId: folder.id,
      kind: 'folder.soft_delete',
      payload: {},
      expectedVersion: folder.version,
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        folder: prevFolder,
        existedBefore: true,
        parentId: folder.parent_id,
      },
    });

    return { ok: true };
  }

  optimisticRestoreFolder(
    folder: FolderSummary,
    conflictPolicy: 'fail' | 'rename' = 'rename'
  ): void {
    const restored: FolderSummary = {
      ...folder,
      deleted_at: null,
      updated_at: new Date(this.now()).toISOString(),
    };
    this.upsertFolderInCache(restored);
    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'folder',
      entityId: folder.id,
      kind: 'folder.restore',
      payload: { conflictPolicy, parentId: folder.parent_id },
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        folder,
        existedBefore: false,
        parentId: folder.parent_id,
      },
    });
  }

  optimisticRenameFile(
    file: FileItem,
    nextName: string,
    effectiveRole: ResourceRole,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    if (file.upload_state === 'pending' || file.optimistic) {
      return { ok: false, error: 'アップロード完了後に名前を変更できます' };
    }
    const trimmed = nextName.trim();
    if (!trimmed) {
      return { ok: false, error: 'ファイル名を入力してください' };
    }
    if (trimmed === file.name) {
      return { ok: true };
    }

    const roleCheck = checkRoleGuard(effectiveRole, 'editor');
    if (!roleCheck.ok) {
      return { ok: false, error: roleCheck.message };
    }

    const dirView = this.getDirectoryView(file.folder_id);
    if (
      dirView.files.some(
        (f) => f.id !== file.id && f.name === trimmed && f.deleted_at == null
      )
    ) {
      return { ok: false, error: `同名ファイル「${trimmed}」がすでに存在します` };
    }

    const prevFile: FileItem = { ...file };
    const nextExt = getExtensionFromName(trimmed) || null;
    const updated: FileItem = {
      ...file,
      name: trimmed,
      extension: nextExt,
      updated_at: new Date(this.now()).toISOString(),
    };

    this.upsertFileInCache(updated);
    if (!options?.skipUndo) {
      this.pushUndo(
        {
          label: `「${trimmed}」の名前変更を取り消す`,
          applyUndo: () => {
            const current = this.filesById.get(updated.id) ?? updated;
            this.optimisticRenameFile(current, prevFile.name, effectiveRole, {
              skipUndo: true,
            });
          },
        },
        `ファイル名を「${trimmed}」に変更しました`
      );
    }

    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'file',
      entityId: file.id,
      kind: 'file.patch',
      payload: { name: trimmed },
      expectedVersion: file.meta_version,
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        file: prevFile,
        existedBefore: true,
        parentId: file.folder_id,
      },
    });

    return { ok: true };
  }

  optimisticSoftDeleteFile(
    file: FileItem,
    folderId: string | null,
    effectiveRole: ResourceRole,
    options?: { skipUndo?: boolean }
  ): { ok: boolean; error?: string } {
    if (file.upload_state === 'pending' || file.optimistic) {
      return { ok: false, error: 'アップロード完了後に削除できます' };
    }
    const roleCheck = checkRoleGuard(effectiveRole, 'editor');
    if (!roleCheck.ok) {
      return { ok: false, error: roleCheck.message };
    }

    const prevFile: FileItem = { ...file };
    this.removeFileFromCache(file.id, folderId);

    if (!options?.skipUndo) {
      this.pushUndo(
        {
          label: `「${file.name}」の削除を取り消す`,
          applyUndo: () => {
            this.optimisticRestoreFile(prevFile);
          },
        },
        `「${file.name}」をゴミ箱へ移動しました`
      );
    }

    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'file',
      entityId: file.id,
      kind: 'file.soft_delete',
      payload: { folderId },
      expectedVersion: file.meta_version,
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        file: prevFile,
        existedBefore: true,
        parentId: folderId,
      },
    });

    return { ok: true };
  }

  optimisticRestoreFile(file: FileItem): void {
    const restored: FileItem = {
      ...file,
      deleted_at: null,
      updated_at: new Date(this.now()).toISOString(),
    };
    this.upsertFileInCache(restored);
    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'file',
      entityId: file.id,
      kind: 'file.restore',
      payload: { folderId: file.folder_id },
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        file,
        existedBefore: false,
        parentId: file.folder_id,
      },
    });
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
    if (file.upload_state === 'pending' || file.optimistic) {
      return { ok: false, error: 'アップロード完了後に機密区分を変更できます' };
    }

    const dirView = this.getDirectoryView(file.folder_id);
    const role = options?.effectiveRole ?? dirView.effectiveRole;
    const isAdmin =
      options?.isPrivilegedAdmin ??
      (this.user?.role === 'sec_admin' || this.user?.role === 'sys_admin');

    const roleCheck = checkRoleGuard(role, 'editor', {
      isPrivilegedAdmin: isAdmin,
      allowAdminOverride: true,
    });
    if (!roleCheck.ok) {
      return { ok: false, error: roleCheck.message };
    }

    let targetLabel: Exclude<ClassificationLabel, 'unset'>;
    if ('acceptSuggestion' in next) {
      if (!file.ai_suggested_label || file.ai_suggested_label === 'unset') {
        return { ok: false, error: '承認可能な AI 分類提案がありません' };
      }
      targetLabel = file.ai_suggested_label;
    } else {
      targetLabel = next.classification;
    }

    const ancestorLabels = this.getAncestorClassifications(file.folder_id);
    const floorCheck = checkClassificationFloorGuard(ancestorLabels, targetLabel);
    if (!floorCheck.ok) {
      return { ok: false, error: floorCheck.message };
    }

    const prevFile: FileItem = { ...file };
    const updated: FileItem = {
      ...file,
      classification: targetLabel,
      ai_suggested_label: null,
      ai_confidence: null,
      ai_reason: null,
      updated_at: new Date(this.now()).toISOString(),
    };

    this.upsertFileInCache(updated);
    if (!options?.skipUndo && prevFile.classification !== 'unset') {
      const revertLabel = prevFile.classification;
      this.pushUndo(
        {
          label: `「${file.name}」の機密区分変更を取り消す`,
          applyUndo: () => {
            const current = this.filesById.get(updated.id) ?? updated;
            this.optimisticUpdateFileClassification(
              current,
              { classification: revertLabel },
              {
                effectiveRole: role,
                isPrivilegedAdmin: isAdmin,
                skipUndo: true,
              }
            );
          },
        },
        `「${file.name}」の機密区分を ${targetLabel} に変更しました`
      );
    }

    this.outbox.enqueue({
      id: makeClientMutationId('mut'),
      entityType: 'file',
      entityId: file.id,
      kind: 'file.classification',
      payload:
        'acceptSuggestion' in next
          ? { acceptSuggestion: true }
          : { classification: targetLabel },
      expectedVersion: file.meta_version,
      createdAt: this.now(),
      retryCount: 0,
      rollback: {
        file: prevFile,
        existedBefore: true,
        parentId: file.folder_id,
      },
    });

    return { ok: true, file: updated };
  }

  isFolderAncestorOf(ancestorId: string, candidateId: string | null): boolean {
    if (!candidateId) return false;
    if (ancestorId === candidateId) return true;

    const dir = this.directoriesByKey.get(candidateId);
    if (dir && dir.breadcrumbs.some((b) => b.id === ancestorId)) {
      return true;
    }

    let cursor: string | null = candidateId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = this.foldersById.get(cursor);
      if (!folder) break;
      if (folder.parent_id === ancestorId) return true;
      cursor = folder.parent_id;
    }
    return false;
  }

  private resolveItemEffectiveRole(
    type: 'file' | 'folder',
    item: FolderSummary | FileItem
  ): ResourceRole {
    if (type === 'folder') {
      const f = item as FolderSummary;
      if (f.effectiveRole) return f.effectiveRole;
      return this.getDirectoryView(f.parent_id).effectiveRole;
    }
    const fl = item as FileItem;
    return this.getDirectoryView(fl.folder_id).effectiveRole;
  }

  private markCachedSubtreeStale(rootFolderId: string): void {
    const rootDir = this.directoriesByKey.get(rootFolderId);
    if (rootDir) rootDir.stale = true;
    for (const dir of this.directoriesByKey.values()) {
      if (dir.breadcrumbs.some((b) => b.id === rootFolderId)) {
        dir.stale = true;
      }
    }
  }

  private collectDestNameSets(targetParentId: string | null): {
    existsInCache: boolean;
    folderNames: Set<string>;
    fileNames: Set<string>;
  } {
    const view = this.getDirectoryView(targetParentId);
    return {
      existsInCache: view.existsInCache,
      folderNames: new Set(view.folders.map((f) => f.name)),
      fileNames: new Set(view.files.map((fl) => fl.name)),
    };
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

    // Dedupe references and resolve temp aliases
    const deduped = new Map<string, { type: 'file' | 'folder'; id: string }>();
    for (const raw of input.items) {
      const resolvedId = this.idAliasMap.get(raw.id) ?? raw.id;
      deduped.set(`${raw.type}:${resolvedId}`, { type: raw.type, id: resolvedId });
    }
    if (deduped.size === 0) {
      return { ok: false, error: '移動するアイテムを選択してください', movedCount: 0, skippedCount: 0 };
    }

    const resolvedFolders: FolderSummary[] = [];
    const resolvedFiles: FileItem[] = [];

    for (const ref of deduped.values()) {
      if (ref.type === 'folder') {
        const folder = this.foldersById.get(ref.id);
        if (!folder || folder.deleted_at != null) {
          return { ok: false, error: '移動対象のフォルダが見つかりません', movedCount: 0, skippedCount: 0 };
        }
        if (folder.optimistic) {
          return { ok: false, error: '作成完了後に移動できます', movedCount: 0, skippedCount: 0 };
        }
        resolvedFolders.push(folder);
      } else {
        const file = this.filesById.get(ref.id);
        if (!file || file.deleted_at != null) {
          return { ok: false, error: '移動対象のファイルが見つかりません', movedCount: 0, skippedCount: 0 };
        }
        if (file.upload_state === 'pending' || file.optimistic) {
          return { ok: false, error: 'アップロード完了後に移動できます', movedCount: 0, skippedCount: 0 };
        }
        resolvedFiles.push(file);
      }
    }

    // Prune redundant descendants when an ancestor folder is also selected
    const selectedFolderIds = new Set(resolvedFolders.map((f) => f.id));
    const rootFolders = resolvedFolders.filter(
      (folder) =>
        !Array.from(selectedFolderIds).some(
          (otherId) => otherId !== folder.id && this.isFolderAncestorOf(otherId, folder.id)
        )
    );
    const rootFiles = resolvedFiles.filter(
      (file) =>
        file.folder_id === null ||
        (!selectedFolderIds.has(file.folder_id) &&
          !Array.from(selectedFolderIds).some((ancId) =>
            this.isFolderAncestorOf(ancId, file.folder_id)
          ))
    );

    const destView = this.getDirectoryView(targetParentId);
    if (destView.existsInCache) {
      const destRole = checkRoleGuard(destView.effectiveRole, 'editor', {
        isPrivilegedAdmin: this.user?.role === 'sys_admin',
        allowAdminOverride: true,
      });
      if (!destRole.ok) {
        return { ok: false, error: destRole.message, movedCount: 0, skippedCount: 0 };
      }
    }

    let skippedCount = 0;
    const foldersToMove: Array<{ prev: FolderSummary; targetName: string }> = [];
    const filesToMove: Array<{ prev: FileItem; targetName: string; targetExt: string | null }> = [];
    const destNames = this.collectDestNameSets(targetParentId);

    for (const folder of rootFolders) {
      if (folder.parent_id === targetParentId) {
        skippedCount += 1;
        continue;
      }
      if (folder.id === targetParentId || this.isFolderAncestorOf(folder.id, targetParentId)) {
        return {
          ok: false,
          error: '自分自身または配下のフォルダには移動できません',
          movedCount: 0,
          skippedCount: 0,
        };
      }
      const role = this.resolveItemEffectiveRole('folder', folder);
      const roleCheck = checkRoleGuard(role, 'editor', {
        isPrivilegedAdmin: this.user?.role === 'sys_admin',
        allowAdminOverride: true,
      });
      if (!roleCheck.ok) {
        return { ok: false, error: roleCheck.message, movedCount: 0, skippedCount: 0 };
      }
      if (targetParentId === null && folder.parent_id !== null) {
        const rootOwnerCheck = checkRoleGuard(role, 'owner', {
          isPrivilegedAdmin: this.user?.role === 'sys_admin',
          allowAdminOverride: true,
        });
        if (!rootOwnerCheck.ok) {
          return {
            ok: false,
            error: 'ルートへ移動するには Owner 権限が必要です',
            movedCount: 0,
            skippedCount: 0,
          };
        }
      }

      let targetName = folder.name;
      if (destNames.existsInCache && destNames.folderNames.has(targetName)) {
        if (conflictPolicy === 'fail') {
          return {
            ok: false,
            error: `移動先に同名フォルダ「${targetName}」がすでに存在します`,
            movedCount: 0,
            skippedCount: 0,
          };
        }
        targetName = allocateCopyDisplayName(targetName, 'folder', destNames.folderNames);
      } else {
        destNames.folderNames.add(targetName);
      }

      foldersToMove.push({ prev: { ...folder }, targetName });
    }

    for (const file of rootFiles) {
      if (file.folder_id === targetParentId) {
        skippedCount += 1;
        continue;
      }
      const role = this.resolveItemEffectiveRole('file', file);
      const roleCheck = checkRoleGuard(role, 'editor', {
        isPrivilegedAdmin: this.user?.role === 'sys_admin',
        allowAdminOverride: true,
      });
      if (!roleCheck.ok) {
        return { ok: false, error: roleCheck.message, movedCount: 0, skippedCount: 0 };
      }

      let targetName = file.name;
      if (destNames.existsInCache && destNames.fileNames.has(targetName)) {
        if (conflictPolicy === 'fail') {
          return {
            ok: false,
            error: `移動先に同名ファイル「${targetName}」がすでに存在します`,
            movedCount: 0,
            skippedCount: 0,
          };
        }
        targetName = allocateCopyDisplayName(targetName, 'file', destNames.fileNames);
      } else {
        destNames.fileNames.add(targetName);
      }
      const targetExt = getExtensionFromName(targetName) || null;
      filesToMove.push({ prev: { ...file }, targetName, targetExt });
    }

    const movedCount = foldersToMove.length + filesToMove.length;
    if (movedCount === 0) {
      return { ok: true, movedCount: 0, skippedCount };
    }

    const nowIso = new Date(this.now()).toISOString();
    const destAncestors = this.getAncestorClassifications(targetParentId);
    const destFloor: ClassificationLabel = destAncestors.includes('confidential')
      ? 'confidential'
      : 'unset';

    const batchRefs: WorkspaceBatchItemRef[] = [];
    const involvedEntityKeys: string[] = [];

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

      batchRefs.push({ type: 'folder', id: prev.id, expectedVersion: prev.version });
      involvedEntityKeys.push(`folder:${prev.id}`);
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

      batchRefs.push({ type: 'file', id: prev.id, expectedVersion: prev.meta_version });
      involvedEntityKeys.push(`file:${prev.id}`);
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
        (movedCount === 1
          ? `「${foldersToMove[0]?.prev.name ?? filesToMove[0]?.prev.name}」を移動しました`
          : `${movedCount} 件のアイテムを移動しました`);

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
      const singleFileOnly = foldersToMove.length === 0 && filesToMove.length === 1;
      const mutId = makeClientMutationId('mut');
      this.outbox.enqueue({
        id: mutId,
        entityType: singleFileOnly ? 'file' : 'folder',
        entityId: singleFileOnly ? filesToMove[0]!.prev.id : `batch:${mutId}`,
        involvedEntityKeys,
        kind: singleFileOnly ? 'file.move' : 'workspace.batch_move',
        payload: {
          items: batchRefs,
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

    return { ok: true, movedCount, skippedCount };
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
    const mode = input.mode ?? 'copy';
    const duplicateInPlace = mode === 'duplicate';
    const targetParentId = input.targetParentId;
    const conflictPolicy: WorkspaceConflictPolicy = input.conflictPolicy ?? 'rename';

    const deduped = new Map<string, { type: 'file' | 'folder'; id: string }>();
    for (const raw of input.items) {
      const resolvedId = this.idAliasMap.get(raw.id) ?? raw.id;
      deduped.set(`${raw.type}:${resolvedId}`, { type: raw.type, id: resolvedId });
    }
    if (deduped.size === 0) {
      return { ok: false, error: 'コピーするアイテムを選択してください', tempIds: [] };
    }

    const srcFolders: FolderSummary[] = [];
    const srcFiles: FileItem[] = [];
    for (const ref of deduped.values()) {
      if (ref.type === 'folder') {
        const f = this.foldersById.get(ref.id);
        if (!f || f.deleted_at != null) {
          return { ok: false, error: 'コピー元のフォルダが見つかりません', tempIds: [] };
        }
        if (f.optimistic) {
          return { ok: false, error: 'フォルダ作成完了後にコピーできます', tempIds: [] };
        }
        srcFolders.push(f);
      } else {
        const fl = this.filesById.get(ref.id);
        if (!fl || fl.deleted_at != null) {
          return { ok: false, error: 'コピー元のファイルが見つかりません', tempIds: [] };
        }
        if (fl.upload_state === 'pending' || fl.optimistic) {
          return { ok: false, error: 'アップロード完了後にコピーできます', tempIds: [] };
        }
        srcFiles.push(fl);
      }
    }

    // Prune redundant selected descendants
    const selectedFolderIds = new Set(srcFolders.map((f) => f.id));
    const rootFolders = srcFolders.filter(
      (f) =>
        !Array.from(selectedFolderIds).some(
          (otherId) => otherId !== f.id && this.isFolderAncestorOf(otherId, f.id)
        )
    );
    const rootFiles = srcFiles.filter(
      (fl) =>
        fl.folder_id === null ||
        (!selectedFolderIds.has(fl.folder_id) &&
          !Array.from(selectedFolderIds).some((ancId) =>
            this.isFolderAncestorOf(ancId, fl.folder_id)
          ))
    );

    // Zero-Trust DLP client guardrail: viewer+ required on source (previewer blocked at 0ms)
    for (const f of rootFolders) {
      const role = this.resolveItemEffectiveRole('folder', f);
      if (!hasRoleAtLeast(role, 'viewer') && this.user?.role !== 'sys_admin') {
        return {
          ok: false,
          error: 'Previewer 権限のフォルダはコピーできません (DLP 保護)',
          tempIds: [],
        };
      }
    }
    for (const fl of rootFiles) {
      const role = this.resolveItemEffectiveRole('file', fl);
      if (!hasRoleAtLeast(role, 'viewer') && this.user?.role !== 'sys_admin') {
        return {
          ok: false,
          error: 'Previewer 権限のファイルはコピーできません (DLP 保護)',
          tempIds: [],
        };
      }
    }

    if (!duplicateInPlace) {
      const destView = this.getDirectoryView(targetParentId);
      if (destView.existsInCache) {
        const destRole = checkRoleGuard(destView.effectiveRole, 'editor', {
          isPrivilegedAdmin: this.user?.role === 'sys_admin',
          allowAdminOverride: true,
        });
        if (!destRole.ok) {
          return { ok: false, error: destRole.message, tempIds: [] };
        }
      }
    }

    const namesCache = new Map<string, ReturnType<typeof this.collectDestNameSets>>();
    const getDestNames = (parentId: string | null) => {
      const key = dirKeyForFolder(parentId);
      let entry = namesCache.get(key);
      if (!entry) {
        entry = this.collectDestNameSets(parentId);
        namesCache.set(key, entry);
      }
      return entry;
    };

    const nowIso = new Date(this.now()).toISOString();
    const mutationId = makeClientMutationId('mut');
    const tempFolderIds: string[] = [];
    const tempFileIds: string[] = [];
    const apiItems: Array<{ type: 'file' | 'folder'; id: string }> = [];
    const involvedEntityKeys: string[] = [];

    for (const f of rootFolders) {
      const destParentId = duplicateInPlace ? f.parent_id : targetParentId;
      const destNames = getDestNames(destParentId);
      if (
        conflictPolicy === 'fail' &&
        !duplicateInPlace &&
        destNames.existsInCache &&
        destNames.folderNames.has(f.name)
      ) {
        return {
          ok: false,
          error: `コピー先に同名フォルダ「${f.name}」がすでに存在します`,
          tempIds: [],
        };
      }
      const nextName = allocateCopyDisplayName(f.name, 'folder', destNames.folderNames);
      const destFloor: ClassificationLabel = this.getAncestorClassifications(destParentId).includes(
        'confidential'
      )
        ? 'confidential'
        : 'unset';
      const tempId = makeClientMutationId('tmp-copy-folder');
      const tempFolder: FolderSummary = {
        id: tempId,
        parent_id: destParentId,
        name: nextName,
        classification: pickStricterClassification(f.classification, destFloor),
        is_pinned: 0,
        version: 1,
        updated_at: nowIso,
        effectiveRole: 'owner',
        optimistic: true,
      };
      tempFolderIds.push(tempId);
      apiItems.push({ type: 'folder', id: f.id });
      involvedEntityKeys.push(`folder:${f.id}`);
      this.upsertFolderInCache(tempFolder);
    }

    for (const fl of rootFiles) {
      const destParentId = duplicateInPlace ? fl.folder_id : targetParentId;
      const destNames = getDestNames(destParentId);
      if (
        conflictPolicy === 'fail' &&
        !duplicateInPlace &&
        destNames.existsInCache &&
        destNames.fileNames.has(fl.name)
      ) {
        return {
          ok: false,
          error: `コピー先に同名ファイル「${fl.name}」がすでに存在します`,
          tempIds: [],
        };
      }
      const nextName = allocateCopyDisplayName(fl.name, 'file', destNames.fileNames);
      const destFloor: ClassificationLabel = this.getAncestorClassifications(destParentId).includes(
        'confidential'
      )
        ? 'confidential'
        : 'unset';
      const tempId = makeClientMutationId('tmp-copy-file');
      const tempFile: FileItem = {
        id: tempId,
        folder_id: destParentId,
        name: nextName,
        extension: getExtensionFromName(nextName) || fl.extension,
        mime_type: fl.mime_type,
        size_bytes: fl.size_bytes,
        current_version_num: 1,
        meta_version: 1,
        classification: pickStricterClassification(fl.classification, destFloor),
        ai_suggested_label: null,
        ai_confidence: null,
        ai_reason: null,
        updated_at: nowIso,
        upload_state: 'active',
        optimistic: true,
      };
      tempFileIds.push(tempId);
      apiItems.push({ type: 'file', id: fl.id });
      involvedEntityKeys.push(`file:${fl.id}`);
      this.upsertFileInCache(tempFile);
    }

    const totalCount = tempFolderIds.length + tempFileIds.length;
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
            const canceledFromQueue = this.outbox.cancelQueuedMutation(mutationId);
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
      involvedEntityKeys,
      kind: 'workspace.copy',
      payload: {
        items: apiItems,
        targetParentId,
        duplicateInPlace,
        conflictPolicy,
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
    const ancestorLabels = this.getAncestorClassifications(folderId);
    const defaultLabel: ClassificationLabel = ancestorLabels.includes('confidential')
      ? 'confidential'
      : 'unset';

    const pendingRow: FileItem = {
      id: tempId,
      folder_id: folderId,
      name: meta.name,
      extension: getExtensionFromName(meta.name) || null,
      mime_type: meta.mimeType,
      size_bytes: meta.sizeBytes,
      current_version_num: 1,
      meta_version: 1,
      classification: defaultLabel,
      ai_suggested_label: null,
      ai_confidence: null,
      ai_reason: null,
      updated_at: new Date(this.now()).toISOString(),
      upload_state: 'pending',
      upload_progress: 0,
      optimistic: true,
    };

    this.filesById.set(tempId, pendingRow);
    const dir = this.directoriesByKey.get(dirKeyForFolder(folderId));
    if (dir && !dir.fileIds.includes(tempId)) {
      dir.fileIds = [tempId, ...dir.fileIds];
    }
    this.emit();
  }

  updateOptimisticUploadProgress(tempId: string, percent: number): void {
    const existing = this.filesById.get(tempId);
    if (!existing || existing.upload_state !== 'pending') return;
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));
    if (existing.upload_progress === clamped) return;

    this.filesById.set(tempId, {
      ...existing,
      upload_progress: clamped,
    });
    this.emit();
  }

  completeOptimisticUpload(tempId: string, serverFile: FileItem): void {
    const existing = this.filesById.get(tempId);
    const folderId = existing?.folder_id ?? serverFile.folder_id;

    this.filesById.delete(tempId);
    const dir = this.directoriesByKey.get(dirKeyForFolder(folderId));
    if (dir) {
      dir.fileIds = removeFromIdList(dir.fileIds, tempId);
    }

    this.upsertFileInCache({
      ...serverFile,
      upload_state: 'active',
      upload_progress: 100,
      optimistic: false,
    });
  }

  failOrCancelOptimisticUpload(tempId: string): void {
    const existing = this.filesById.get(tempId);
    if (!existing) return;
    this.filesById.delete(tempId);
    const dir = this.directoriesByKey.get(dirKeyForFolder(existing.folder_id));
    if (dir) {
      dir.fileIds = removeFromIdList(dir.fileIds, tempId);
    }
    this.emit();
  }

  private async executeOutboxMutation(
    item: OutboxMutationRecord
  ): Promise<OutboxExecutionResult | void> {
    const resolvedId = this.idAliasMap.get(item.entityId) ?? item.entityId;
    const p = item.payload;

    switch (item.kind) {
      case 'folder.create': {
        const res = await this.createFolderFn({
          parentId: (p.parentId as string | null) ?? null,
          name: String(p.name),
          classification: p.classification as ClassificationLabel | undefined,
        });
        const finalFolder =
          p.isPinned && res.folder.is_pinned !== 1
            ? (
                await this.updateFolderFn(res.folder.id, {
                  isPinned: true,
                  expectedVersion: res.folder.version,
                })
              ).folder
            : res.folder;
        return { folder: finalFolder };
      }
      case 'folder.patch': {
        return this.updateFolderFn(resolvedId, {
          name: typeof p.name === 'string' ? p.name : undefined,
          isPinned: typeof p.isPinned === 'boolean' ? p.isPinned : undefined,
          expectedVersion: item.expectedVersion,
        });
      }
      case 'folder.soft_delete': {
        await this.softDeleteFolderFn(resolvedId, item.expectedVersion);
        return;
      }
      case 'folder.restore': {
        await this.restoreFolderFn(
          resolvedId,
          (p.conflictPolicy as 'fail' | 'rename' | undefined) ?? 'rename'
        );
        return;
      }
      case 'file.patch': {
        return this.updateFileMetadataFn(resolvedId, {
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
          const res = await this.updateFileClassificationFn(resolvedId, {
            acceptSuggestion: true,
            expectedVersion: item.expectedVersion,
          });
          return { file: res.file };
        }
        const res = await this.updateFileClassificationFn(resolvedId, {
          classification: p.classification as Exclude<ClassificationLabel, 'unset'>,
          expectedVersion: item.expectedVersion,
        });
        return { file: res.file };
      }
      case 'folder.move': {
        const live = this.foldersById.get(resolvedId);
        const res = await this.moveFolderFn(resolvedId, {
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
          const realId = this.idAliasMap.get(ref.id) ?? ref.id;
          if (ref.type === 'folder') {
            const live = this.foldersById.get(realId);
            return {
              ...ref,
              id: realId,
              expectedVersion:
                live && !live.optimistic ? live.version : ref.expectedVersion,
            };
          }
          const live = this.filesById.get(realId);
          return {
            ...ref,
            id: realId,
            expectedVersion:
              live && !live.optimistic ? live.meta_version : ref.expectedVersion,
          };
        });
        const res: BatchMoveWorkspaceResponse = await this.batchMoveFn({
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
          id: this.idAliasMap.get(entry.id) ?? entry.id,
        }));
        const res: CopyWorkspaceResponse = p.duplicateInPlace
          ? await this.duplicateItemsFn({ items: mappedItems })
          : await this.copyItemsFn({
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
        await this.softDeleteFileFn(resolvedId, item.expectedVersion);
        return;
      }
      case 'file.restore': {
        const res = await this.restoreFileFn(resolvedId);
        return { file: res.file };
      }
    }
  }

  private handleOutboxSuccess(
    item: OutboxMutationRecord,
    result: OutboxExecutionResult | void
  ): void {
    if (item.kind === 'folder.create' && result?.folder) {
      this.idAliasMap.set(item.entityId, result.folder.id);
      const oldTemp = this.foldersById.get(item.entityId);
      if (oldTemp) {
        this.removeFolderFromCache(oldTemp);
      }
      this.upsertFolderInCache({ ...result.folder, optimistic: false });
      return;
    }

    if (item.kind === 'folder.restore') {
      void this.syncDelta();
      const parentId = (item.payload.parentId as string | null | undefined) ?? null;
      void this.ensureDirectoryLoaded(parentId, { force: true }).catch(() => undefined);
      return;
    }

    if (item.kind === 'file.move' || item.kind === 'workspace.batch_move') {
      if (result?.movedFolders) {
        for (const folder of result.movedFolders) {
          const existing = this.foldersById.get(folder.id);
          this.upsertFolderInCache({
            ...folder,
            effectiveRole: folder.effectiveRole ?? existing?.effectiveRole,
            optimistic: false,
          });
          this.markCachedSubtreeStale(folder.id);
        }
      }
      if (result?.movedFiles) {
        for (const file of result.movedFiles) {
          this.upsertFileInCache({
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
        (fl) => fl.folder_id === null || !copiedFolderIdSet.has(fl.folder_id)
      );

      // If user already triggered Undo while HTTP copy was in-flight, delete server roots cleanly
      if (this.cancelledCopyMutationIds.has(item.id)) {
        this.cancelledCopyMutationIds.delete(item.id);
        for (const tmpId of tempFolderIds) {
          const tmp = this.foldersById.get(tmpId);
          if (tmp) this.removeFolderFromCache(tmp);
        }
        for (const tmpId of tempFileIds) {
          const tmp = this.filesById.get(tmpId);
          if (tmp) this.removeFileFromCache(tmp.id, tmp.folder_id);
        }
        for (const f of rootCopiedFolders) {
          void this.softDeleteFolderFn(f.id, f.version).catch(() => undefined);
        }
        for (const fl of rootCopiedFiles) {
          void this.softDeleteFileFn(fl.id, fl.meta_version).catch(() => undefined);
        }
        return;
      }

      if (result?.queued && result.jobId) {
        const refreshSet = new Set<string | null>([
          (item.payload.targetParentId as string | null | undefined) ?? null,
        ]);
        for (const tmpId of tempFolderIds) {
          const tmp = this.foldersById.get(tmpId);
          if (tmp) {
            refreshSet.add(tmp.parent_id);
            this.removeFolderFromCache(tmp);
          }
        }
        for (const tmpId of tempFileIds) {
          const tmp = this.filesById.get(tmpId);
          if (tmp) {
            refreshSet.add(tmp.folder_id);
            this.removeFileFromCache(tmp.id, tmp.folder_id);
          }
        }
        const rawItems =
          (item.payload.items as Array<{ type: 'file' | 'folder'; id: string }>) ?? [];
        this.scheduleAsyncCopyJobPoll(
          result.jobId,
          Array.from(refreshSet),
          Math.max(rawItems.length, copiedFolders.length + copiedFiles.length)
        );
        return;
      }

      rootCopiedFolders.forEach((realFolder, idx) => {
        const tempId = tempFolderIds[idx];
        if (tempId) {
          this.idAliasMap.set(tempId, realFolder.id);
          this.foldersById.delete(tempId);
          const dir = this.directoriesByKey.get(dirKeyForFolder(realFolder.parent_id));
          if (dir) {
            dir.folderIds = replaceIdInList(dir.folderIds, tempId, realFolder.id);
          }
          if (realFolder.parent_id === null) {
            this.rootFolderIds = replaceIdInList(
              this.rootFolderIds,
              tempId,
              realFolder.id
            );
          }
        }
      });

      rootCopiedFiles.forEach((realFile, idx) => {
        const tempId = tempFileIds[idx];
        if (tempId) {
          this.idAliasMap.set(tempId, realFile.id);
          this.filesById.delete(tempId);
          const dir = this.directoriesByKey.get(dirKeyForFolder(realFile.folder_id));
          if (dir) {
            dir.fileIds = replaceIdInList(dir.fileIds, tempId, realFile.id);
          }
        }
      });

      // Remove any leftover unmatched temp nodes
      for (const tmpId of tempFolderIds) {
        if (this.foldersById.has(tmpId)) {
          const tmp = this.foldersById.get(tmpId)!;
          this.removeFolderFromCache(tmp);
        }
      }
      for (const tmpId of tempFileIds) {
        if (this.filesById.has(tmpId)) {
          const tmp = this.filesById.get(tmpId)!;
          this.removeFileFromCache(tmp.id, tmp.folder_id);
        }
      }

      for (const folder of copiedFolders) {
        this.upsertFolderInCache({
          ...folder,
          effectiveRole: folder.effectiveRole ?? 'owner',
          optimistic: false,
        });
      }
      for (const file of copiedFiles) {
        this.upsertFileInCache({
          ...file,
          upload_state: 'active',
          optimistic: false,
        });
      }

      this.copiedRootsByMutationId.set(item.id, {
        folders: rootCopiedFolders,
        files: rootCopiedFiles,
      });
      return;
    }

    if (result?.folder) {
      const existing = this.foldersById.get(result.folder.id);
      this.upsertFolderInCache({
        ...result.folder,
        effectiveRole: result.folder.effectiveRole ?? existing?.effectiveRole,
        optimistic: false,
      });
    } else if (result?.file) {
      this.upsertFileInCache({
        ...result.file,
        upload_state: 'active',
        optimistic: false,
      });
    }
  }

  private handleOutboxRollback(
    item: OutboxMutationRecord,
    error: unknown,
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
        const tmp = this.foldersById.get(tmpId);
        if (tmp) this.removeFolderFromCache(tmp);
      }
      for (const tmpId of item.rollback?.tempFileIds ?? []) {
        const tmp = this.filesById.get(tmpId);
        if (tmp) this.removeFileFromCache(tmp.id, tmp.folder_id);
      }
    } else if (
      item.kind === 'folder.move' ||
      item.kind === 'file.move' ||
      item.kind === 'workspace.batch_move'
    ) {
      const targetParentId = item.rollback?.targetParentId ?? null;
      const targetDir = this.directoriesByKey.get(dirKeyForFolder(targetParentId));
      for (const origFolder of item.rollback?.folders ?? []) {
        if (targetDir) {
          targetDir.folderIds = removeFromIdList(targetDir.folderIds, origFolder.id);
        }
        if (targetParentId === null && origFolder.parent_id !== null) {
          this.rootFolderIds = removeFromIdList(this.rootFolderIds, origFolder.id);
        }
        this.upsertFolderInCache(origFolder);
        this.markCachedSubtreeStale(origFolder.id);
      }
      for (const origFile of item.rollback?.files ?? []) {
        if (targetDir) {
          targetDir.fileIds = removeFromIdList(targetDir.fileIds, origFile.id);
        }
        this.upsertFileInCache(origFile);
      }
      if (latestFromServer) {
        if (item.entityType === 'folder') {
          const existing = this.foldersById.get(latestFromServer.id);
          this.upsertFolderInCache({
            ...(latestFromServer as FolderSummary),
            effectiveRole:
              (latestFromServer as FolderSummary).effectiveRole ?? existing?.effectiveRole,
          });
        } else {
          this.upsertFileInCache(latestFromServer as FileItem);
        }
      }
    } else if (item.entityType === 'folder') {
      if (item.kind === 'folder.create') {
        const temp = this.foldersById.get(item.entityId);
        if (temp) {
          this.removeFolderFromCache(temp);
        }
      } else if (latestFromServer) {
        const existing = this.foldersById.get(latestFromServer.id);
        this.upsertFolderInCache({
          ...(latestFromServer as FolderSummary),
          effectiveRole:
            (latestFromServer as FolderSummary).effectiveRole ??
            existing?.effectiveRole,
        });
      } else if (item.rollback?.folder) {
        this.upsertFolderInCache(item.rollback.folder);
      } else if (item.kind === 'folder.restore') {
        const folderId = this.idAliasMap.get(item.entityId) ?? item.entityId;
        const f = this.foldersById.get(folderId);
        if (f) this.removeFolderFromCache(f);
      }
    } else if (item.entityType === 'file') {
      if (latestFromServer) {
        this.upsertFileInCache(latestFromServer as FileItem);
      } else if (item.rollback?.file) {
        this.upsertFileInCache(item.rollback.file);
      } else if (item.kind === 'file.restore') {
        this.removeFileFromCache(
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

    this.pushToast(
      {
        kind: status === 409 ? 'warning' : 'error',
        message: `${prefix}: ${message}`,
      },
      8000
    );

    void this.syncDelta();
  }

  private resetMemoryOnly(): void {
    this.foldersById.clear();
    this.filesById.clear();
    this.directoriesByKey.clear();
    this.inFlightDirs.clear();
    this.user = null;
    this.policy = null;
    this.syncSeq = 0;
    this.purgedBeforeSeq = 0;
    this.rootFolderIds = [];
    this.rootNextCursor = null;
    this.pinnedFolderIds = [];
    this.bootstrapDone = false;
    this.hydratedScopeKey = null;
    this.activeDirectoryNotice = null;
  }

  private invalidateAllCachedDirectories(): void {
    const keepRoot = this.directoriesByKey.get(ROOT_DIR_KEY);
    this.directoriesByKey.clear();
    if (keepRoot) {
      this.directoriesByKey.set(ROOT_DIR_KEY, {
        ...keepRoot,
        stale: true,
      });
    }
    pruneWorkingSetInMemory({
      directories: this.directoriesByKey,
      foldersById: this.foldersById,
      filesById: this.filesById,
      rootFolderIds: this.rootFolderIds,
      pinnedFolderIds: this.pinnedFolderIds,
      activeDirKey: this.activeDirKey,
      maxDirectories: this.maxDirectories,
    });
  }

  private pruneAndSchedulePersist(): void {
    pruneWorkingSetInMemory({
      directories: this.directoriesByKey,
      foldersById: this.foldersById,
      filesById: this.filesById,
      rootFolderIds: this.rootFolderIds,
      pinnedFolderIds: this.pinnedFolderIds,
      activeDirKey: this.activeDirKey,
      maxDirectories: this.maxDirectories,
    });

    if (typeof window === 'undefined' && !this.user) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, 120);
  }

  private async persistNow(): Promise<void> {
    if (!this.user) return;
    const meta: PersistedMetaRecord = {
      key: 'state',
      user: this.user,
      policy: this.policy,
      syncSeq: this.syncSeq,
      purgedBeforeSeq: this.purgedBeforeSeq,
      rootFolderIds: this.rootFolderIds,
      rootNextCursor: this.rootNextCursor,
      pinnedFolderIds: this.pinnedFolderIds,
      updatedAt: this.now(),
    };

    await this.persistence.saveSnapshot(this.user.tenantId, this.user.id, {
      meta,
      folders: Array.from(this.foldersById.values()).filter((f) => !f.optimistic),
      files: Array.from(this.filesById.values()).filter(
        (fl) => !fl.optimistic && fl.upload_state !== 'pending'
      ),
      directories: Array.from(this.directoriesByKey.values()),
    });
  }

  private evictSubtreeFromCache(rootFolderId: string): boolean {
    let touchedActive = this.activeDirKey === rootFolderId;
    this.directoriesByKey.delete(rootFolderId);
    this.foldersById.delete(rootFolderId);
    this.rootFolderIds = removeFromIdList(this.rootFolderIds, rootFolderId);
    this.pinnedFolderIds = removeFromIdList(this.pinnedFolderIds, rootFolderId);

    for (const [key, dir] of this.directoriesByKey.entries()) {
      const inSubtree = dir.breadcrumbs.some((b) => b.id === rootFolderId);
      if (inSubtree) {
        if (key === this.activeDirKey) touchedActive = true;
        this.directoriesByKey.delete(key);
      } else if (dir.folderIds.includes(rootFolderId)) {
        dir.folderIds = removeFromIdList(dir.folderIds, rootFolderId);
      }
    }
    return touchedActive;
  }

  private applyDeltaChanges(changes: SyncDeltaItem[]): {
    shouldRevokeAll: boolean;
    shouldRevalidateActive: boolean;
  } {
    let shouldRevokeAll = false;
    let shouldRevalidateActive = false;
    const myUserId = this.user?.id;

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
        void this.bootstrap({ force: true });
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
              const hitActive = this.evictSubtreeFromCache(targetId);
              if (hitActive) {
                shouldRevalidateActive = true;
                this.activeDirectoryNotice = 'このフォルダへのアクセス権限が変更されました';
              }
            } else {
              this.filesById.delete(targetId);
              const dir = this.directoriesByKey.get(dirKeyForFolder(change.folderId));
              if (dir) {
                dir.fileIds = removeFromIdList(dir.fileIds, targetId);
              }
            }
          }
        } else if (
          (change.action === 'permission.grant' || change.action === 'permission.update') &&
          targetId
        ) {
          if (targetType === 'folder') {
            const dir = this.directoriesByKey.get(targetId);
            if (dir) dir.stale = true;
            if (change.targetUserId === myUserId) {
              const root = this.directoriesByKey.get(ROOT_DIR_KEY);
              if (root) root.stale = true;
              if (this.activeDirKey === ROOT_DIR_KEY || this.activeDirKey === targetId) {
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
            this.foldersById.set(folder.id, folder);
            const parentDir = this.directoriesByKey.get(dirKeyForFolder(folder.parent_id));
            if (parentDir && !parentDir.folderIds.includes(folder.id)) {
              parentDir.folderIds = dedupePush(parentDir.folderIds, folder.id);
            }
            if (folder.parent_id === null) {
              this.rootFolderIds = dedupePush(this.rootFolderIds, folder.id);
            }
          } else {
            const dir = this.directoriesByKey.get(dirKeyForFolder(change.folderId));
            if (dir) dir.stale = true;
            if (dirKeyForFolder(change.folderId) === this.activeDirKey) {
              shouldRevalidateActive = true;
            }
          }
          continue;
        }

        if (change.action === 'folder.update' || change.action === 'folder.classification_propagated') {
          const existing = this.foldersById.get(change.entityId);
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
            this.foldersById.set(change.entityId, updated);
            if (nextPinned === 1) {
              this.pinnedFolderIds = dedupePush(this.pinnedFolderIds, change.entityId);
            } else if (typeof p.isPinned === 'number') {
              this.pinnedFolderIds = removeFromIdList(this.pinnedFolderIds, change.entityId);
            }
          }
          continue;
        }

        if (change.action === 'folder.moved_out') {
          const oldDir = this.directoriesByKey.get(dirKeyForFolder(change.folderId));
          if (oldDir) {
            oldDir.folderIds = removeFromIdList(oldDir.folderIds, change.entityId);
          }
          continue;
        }

        if (change.action === 'folder.move') {
          const fromParentId = (p.fromParentId as string | null | undefined) ?? null;
          const toParentId = (p.toParentId as string | null | undefined) ?? change.folderId;
          const oldDir = this.directoriesByKey.get(dirKeyForFolder(fromParentId));
          if (oldDir) {
            oldDir.folderIds = removeFromIdList(oldDir.folderIds, change.entityId);
          }
          const existing = this.foldersById.get(change.entityId);
          if (existing) {
            this.foldersById.set(change.entityId, {
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
              updated_at: typeof p.updatedAt === 'string' ? p.updatedAt : change.createdAt,
            });
            if (fromParentId === null && toParentId !== null) {
              this.rootFolderIds = removeFromIdList(this.rootFolderIds, change.entityId);
            } else if (toParentId === null) {
              this.rootFolderIds = dedupePush(this.rootFolderIds, change.entityId, true);
            }
            const newDir = this.directoriesByKey.get(dirKeyForFolder(toParentId));
            if (newDir && !newDir.folderIds.includes(change.entityId)) {
              newDir.folderIds = dedupePush(newDir.folderIds, change.entityId);
            }
          }
          const cachedTargetDir = this.directoriesByKey.get(change.entityId);
          if (cachedTargetDir) {
            cachedTargetDir.stale = true;
            if (this.activeDirKey === change.entityId) {
              shouldRevalidateActive = true;
            }
          }
          continue;
        }

        if (change.action === 'folder.soft_delete') {
          const hitActive = this.evictSubtreeFromCache(change.entityId);
          if (hitActive) {
            this.activeDirectoryNotice = 'このフォルダは別のユーザーによって削除されました';
          }
          continue;
        }

        if (change.action === 'folder.restore') {
          const folder = p.folder as FolderSummary | undefined;
          if (folder) {
            this.upsertFolderInCache(folder);
          } else {
            const parent = this.directoriesByKey.get(dirKeyForFolder(change.folderId));
            if (parent) parent.stale = true;
          }
          continue;
        }
      }

      if (change.entityType === 'file') {
        const targetFolderId =
          p.folderId !== undefined ? (p.folderId as string | null) : change.folderId;

        if (change.action === 'file.soft_delete') {
          this.filesById.delete(change.entityId);
          const dir = this.directoriesByKey.get(dirKeyForFolder(change.folderId));
          if (dir) {
            dir.fileIds = removeFromIdList(dir.fileIds, change.entityId);
          }
          continue;
        }

        if (change.action === 'file.moved_out') {
          const oldDir = this.directoriesByKey.get(dirKeyForFolder(change.folderId));
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
            classification: (p.classification as ClassificationLabel) ?? 'unset',
            ai_suggested_label: null,
            ai_confidence: null,
            ai_reason: null,
            updated_at: String(p.updatedAt ?? change.createdAt),
          };
          this.upsertFileInCache(item);
          continue;
        }

        if (change.action === 'file.update') {
          const prevFolderId = p.previousFolderId as string | null | undefined;
          if (prevFolderId !== undefined && prevFolderId !== targetFolderId) {
            const oldDir = this.directoriesByKey.get(dirKeyForFolder(prevFolderId));
            if (oldDir) {
              oldDir.fileIds = removeFromIdList(oldDir.fileIds, change.entityId);
            }
          }

          const existing = this.filesById.get(change.entityId);
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
            this.upsertFileInCache(updated);
          } else {
            const newDir = this.directoriesByKey.get(dirKeyForFolder(targetFolderId));
            if (newDir) {
              newDir.stale = true;
              if (dirKeyForFolder(targetFolderId) === this.activeDirKey) {
                shouldRevalidateActive = true;
              }
            }
          }
          continue;
        }

        if (change.action === 'file.restore') {
          const dir = this.directoriesByKey.get(dirKeyForFolder(change.folderId));
          if (dir) {
            dir.stale = true;
            if (dirKeyForFolder(change.folderId) === this.activeDirKey) {
              shouldRevalidateActive = true;
            }
          }
          continue;
        }

        if (change.action === 'ai.suggestion_recorded') {
          const existing = this.filesById.get(change.entityId);
          if (existing) {
            this.filesById.set(change.entityId, {
              ...existing,
              ai_suggested_label:
                (p.aiSuggestedLabel as ClassificationLabel | null) ??
                existing.ai_suggested_label,
              ai_confidence:
                typeof p.aiConfidence === 'number'
                  ? p.aiConfidence
                  : existing.ai_confidence,
              ai_reason:
                typeof p.aiReason === 'string' ? p.aiReason : existing.ai_reason,
              meta_version: (existing.meta_version ?? 1) + 1,
              updated_at:
                typeof p.updatedAt === 'string' ? p.updatedAt : change.createdAt,
            });
          }
          continue;
        }

        // Classification change actions (`file.classification_updated`, `ai.*`, `admin.*`)
        const existing = this.filesById.get(change.entityId);
        if (existing) {
          this.filesById.set(change.entityId, {
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
