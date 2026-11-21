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
  restoreFile,
  restoreFolder,
  softDeleteFile,
  softDeleteFolder,
  updateFileClassification,
  updateFileMetadata,
  updateFolder,
} from '@/lib/files-api';
import {
  IndexedDbSyncPersistence,
  type PersistedDirectoryRecord,
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
import type { UndoAction } from '@/lib/sync-store/toasts';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type {
  AuthUser,
  BootstrapResponse,
  FileItem,
  FolderChildrenResponse,
  FolderSummary,
  SyncDeltaResponse,
  SyncInvalidationSignal,
  TenantPolicyRow,
  TosStatus,
  UserType,
  WorkspaceToastItem,
} from '@/types/files';

export const ROOT_DIR_KEY = '__ROOT__';
export const DEFAULT_SWR_TTL_MS = 15_000;

export type SyncAuthStatus = 'unknown' | 'authenticated' | 'unauthenticated';

/**
 * P10-2: the last authentication failure that cleared the workspace cache.
 * `userType` is captured before the user is purged so the recovery screen can
 * offer the guest sign-in route without exposing member sessions to it.
 */
export interface SessionErrorInfo {
  status: number;
  code?: string;
  message: string;
  userType: UserType | null;
}

export interface SyncStoreSnapshot {
  authStatus: SyncAuthStatus;
  user: AuthUser | null;
  policy: TenantPolicyRow | null;
  tosStatus: TosStatus | null;
  syncSeq: number;
  purgedBeforeSeq: number;
  bootstrapDone: boolean;
  revalidating: boolean;
  realtimeState: RealtimeConnectionState;
  activeDirectoryNotice: string | null;
  toasts: WorkspaceToastItem[];
  canUndo: boolean;
  canRedo: boolean;
  pendingMutationCount: number;
  revision: number;
  sessionError: SessionErrorInfo | null;
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
    options?: {
      includeBreadcrumbs?: boolean;
      signal?: AbortSignal;
      sortBy?: WorkspaceSortField;
      sortDir?: WorkspaceSortDirection;
    }
  ) => Promise<FolderChildrenResponse>;
  fetchRootFolders?: (
    cursor?: string | null,
    signal?: AbortSignal,
    options?: { sortBy?: WorkspaceSortField; sortDir?: WorkspaceSortDirection }
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

export interface SyncStoreMutableState {
  authStatus: SyncAuthStatus;
  user: AuthUser | null;
  policy: TenantPolicyRow | null;
  tosStatus: TosStatus | null;
  syncSeq: number;
  purgedBeforeSeq: number;
  rootFolderIds: string[];
  rootNextCursor: string | null;
  pinnedFolderIds: string[];
  bootstrapDone: boolean;
  revalidatingCount: number;
  activeDirKey: string;
  activeDirectoryNotice: string | null;
  sessionError: SessionErrorInfo | null;
  revision: number;
  hydratedScopeKey: string | null;
  hydratePromise: Promise<boolean> | null;
  bootstrapPromise: Promise<BootstrapResponse | null> | null;
  deltaPromise: Promise<void> | null;
  persistTimer: ReturnType<typeof setTimeout> | null;
  outboxLoadedScopeKey: string | null;
  realtimeClient: { start: () => void; stop: () => void } | null;
  realtimeState: RealtimeConnectionState;
  toasts: WorkspaceToastItem[];
  undoStack: UndoAction[];
  redoStack: UndoAction[];
  pendingMutationCount: number;
}

export interface SyncStoreCollections {
  readonly listeners: Set<() => void>;
  readonly foldersById: Map<string, FolderSummary>;
  readonly filesById: Map<string, FileItem>;
  readonly directoriesByKey: Map<string, PersistedDirectoryRecord>;
  readonly inFlightDirs: Map<string, Promise<void>>;
  readonly inFlightLoadMore: Map<string, Promise<void>>;
  readonly idAliasMap: Map<string, string>;
  readonly copiedRootsByMutationId: Map<
    string,
    { folders: FolderSummary[]; files: FileItem[] }
  >;
  readonly cancelledCopyMutationIds: Set<string>;
  readonly jobPollTimers: Set<ReturnType<typeof setTimeout>>;
  readonly toastTimers: Map<string, ReturnType<typeof setTimeout>>;
  readonly realtimeSignalListeners: Set<(signal: SyncInvalidationSignal) => void>;
  readonly securityRevocationListeners: Set<
    (event: RealtimeSecurityRevocationEvent) => void
  >;
}

export interface SyncStoreRuntimeFns {
  readonly persistence: SyncPersistenceAdapter;
  readonly fetchBootstrapFn: (signal?: AbortSignal) => Promise<BootstrapResponse>;
  readonly fetchDeltaFn: (
    sinceSeq: number,
    limit?: number,
    signal?: AbortSignal
  ) => Promise<SyncDeltaResponse>;
  readonly fetchFolderChildrenFn: (
    folderId: string,
    cursor?: string | null,
    limit?: number,
    options?: {
      includeBreadcrumbs?: boolean;
      signal?: AbortSignal;
      sortBy?: WorkspaceSortField;
      sortDir?: WorkspaceSortDirection;
    }
  ) => Promise<FolderChildrenResponse>;
  readonly fetchRootFoldersFn: (
    cursor?: string | null,
    signal?: AbortSignal,
    options?: { sortBy?: WorkspaceSortField; sortDir?: WorkspaceSortDirection }
  ) => Promise<{ folders: FolderSummary[]; nextCursor: string | null }>;
  readonly readHintFn: () => SyncScopeHint | null;
  readonly writeHintFn: (user: AuthUser | null) => void;
  readonly now: () => number;
  readonly maxDirectories: number;
  readonly enableRealtimeOption?: boolean;
  readonly createRealtimeClientFn?: SyncStoreDeps['createRealtimeClient'];
  readonly createFolderFn: typeof createFolder;
  readonly updateFolderFn: typeof updateFolder;
  readonly moveFolderFn: typeof moveFolder;
  readonly softDeleteFolderFn: typeof softDeleteFolder;
  readonly restoreFolderFn: typeof restoreFolder;
  readonly updateFileMetadataFn: typeof updateFileMetadata;
  readonly updateFileClassificationFn: typeof updateFileClassification;
  readonly softDeleteFileFn: typeof softDeleteFile;
  readonly restoreFileFn: typeof restoreFile;
  readonly batchMoveFn: typeof batchMoveWorkspaceItems;
  readonly copyItemsFn: typeof copyWorkspaceItems;
  readonly duplicateItemsFn: typeof duplicateWorkspaceItems;
  readonly getWorkspaceJobFn: typeof getWorkspaceJob;
}

export function createInitialSyncStoreState(): SyncStoreMutableState {
  return {
    authStatus: 'unknown',
    user: null,
    policy: null,
    tosStatus: null,
    syncSeq: 0,
    purgedBeforeSeq: 0,
    rootFolderIds: [],
    rootNextCursor: null,
    pinnedFolderIds: [],
    bootstrapDone: false,
    revalidatingCount: 0,
    activeDirKey: ROOT_DIR_KEY,
    activeDirectoryNotice: null,
    sessionError: null,
    revision: 0,
    hydratedScopeKey: null,
    hydratePromise: null,
    bootstrapPromise: null,
    deltaPromise: null,
    persistTimer: null,
    outboxLoadedScopeKey: null,
    realtimeClient: null,
    realtimeState: 'disconnected',
    toasts: [],
    undoStack: [],
    redoStack: [],
    pendingMutationCount: 0,
  };
}

export function createSyncStoreCollections(): SyncStoreCollections {
  return {
    listeners: new Set(),
    foldersById: new Map(),
    filesById: new Map(),
    directoriesByKey: new Map(),
    inFlightDirs: new Map(),
    inFlightLoadMore: new Map(),
    idAliasMap: new Map(),
    copiedRootsByMutationId: new Map(),
    cancelledCopyMutationIds: new Set(),
    jobPollTimers: new Set(),
    toastTimers: new Map(),
    realtimeSignalListeners: new Set(),
    securityRevocationListeners: new Set(),
  };
}

export function resolveSyncStoreFns(deps: SyncStoreDeps): SyncStoreRuntimeFns {
  return {
    persistence: deps.persistence ?? new IndexedDbSyncPersistence(),
    fetchBootstrapFn: deps.fetchBootstrap ?? fetchSyncBootstrap,
    fetchDeltaFn: deps.fetchDelta ?? fetchSyncDelta,
    fetchFolderChildrenFn: deps.fetchFolderChildren ?? listFolderChildren,
    fetchRootFoldersFn: deps.fetchRootFolders ?? listRootFolders,
    readHintFn: deps.readScopeHint ?? readSyncScopeHint,
    writeHintFn: deps.writeScopeHint ?? writeSyncScopeHint,
    now: deps.now ?? (() => Date.now()),
    maxDirectories: deps.maxDirectories ?? WORKING_SET_MAX_DIRECTORIES,
    enableRealtimeOption: deps.enableRealtime,
    createRealtimeClientFn: deps.createRealtimeClient,
    createFolderFn: deps.createFolderFn ?? createFolder,
    updateFolderFn: deps.updateFolderFn ?? updateFolder,
    moveFolderFn: deps.moveFolderFn ?? moveFolder,
    softDeleteFolderFn: deps.softDeleteFolderFn ?? softDeleteFolder,
    restoreFolderFn: deps.restoreFolderFn ?? restoreFolder,
    updateFileMetadataFn: deps.updateFileMetadataFn ?? updateFileMetadata,
    updateFileClassificationFn:
      deps.updateFileClassificationFn ?? updateFileClassification,
    softDeleteFileFn: deps.softDeleteFileFn ?? softDeleteFile,
    restoreFileFn: deps.restoreFileFn ?? restoreFile,
    batchMoveFn: deps.batchMoveFn ?? batchMoveWorkspaceItems,
    copyItemsFn: deps.copyItemsFn ?? copyWorkspaceItems,
    duplicateItemsFn: deps.duplicateItemsFn ?? duplicateWorkspaceItems,
    getWorkspaceJobFn: deps.getWorkspaceJobFn ?? getWorkspaceJob,
  };
}

export function dirKeyForFolder(folderId: string | null): string {
  return folderId ?? ROOT_DIR_KEY;
}

export function makeClientMutationId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}
