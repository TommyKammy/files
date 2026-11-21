import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';
import type {
  SyncDeltaItem,
  AuthUser,
  BootstrapResponse,
  FileItem,
  FolderChildrenResponse,
  FolderSummary,
  TenantPolicyRow,
} from '@/types/files';
import type { PersistedDirectoryRecord, SyncPersistenceAdapter, SyncScopeHint } from '@/lib/sync-idb';
import type { MutationOutbox } from '@/lib/mutation-outbox';
import type { RealtimeSecurityRevocationEvent } from '@/lib/sync-ws';

const ROOT_DIR_KEY = '__ROOT__';
const DEFAULT_SWR_TTL_MS = 15_000;
const MAX_DELTA_PAGES_PER_SYNC = 5;

export interface DirectorySyncContext {
  persistence: SyncPersistenceAdapter;
  outbox: MutationOutbox;
  fetchBootstrapFn: (signal?: AbortSignal) => Promise<BootstrapResponse>;
  fetchDeltaFn: (sinceSeq: number, limit?: number, signal?: AbortSignal) => Promise<import('@/types/files').SyncDeltaResponse>;
  fetchRootFoldersFn: (
    cursor?: string | null,
    signal?: AbortSignal,
    options?: { sortBy?: WorkspaceSortField; sortDir?: WorkspaceSortDirection }
  ) => Promise<{ folders: FolderSummary[]; nextCursor: string | null }>;
  fetchFolderChildrenFn: (
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
  readHintFn: () => SyncScopeHint | null;
  writeHintFn: (user: AuthUser | null) => void;
  now: () => number;

  bootstrapPromise: Promise<BootstrapResponse | null> | null;
  deltaPromise: Promise<void> | null;
  revalidatingCount: number;
  user: AuthUser | null;
  authStatus: 'unknown' | 'authenticated' | 'unauthenticated';
  hydratedScopeKey: string | null;
  policy: TenantPolicyRow | null;
  tosStatus: import('@/types/files').TosStatus | null;
  purgedBeforeSeq: number;
  bootstrapDone: boolean;
  syncSeq: number;
  rootFolderIds: string[];
  rootNextCursor: string | null;
  pinnedFolderIds: string[];
  outboxLoadedScopeKey: string | null;
  activeDirKey: string;

  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  inFlightDirs: Map<string, Promise<void>>;
  inFlightLoadMore: Map<string, Promise<void>>;

  resetMemoryOnly: () => void;
  invalidateAllCachedDirectories: () => void;
  pruneAndSchedulePersist: () => void;
  emit: () => void;
  applyDeltaChanges: (changes: SyncDeltaItem[]) => { shouldRevokeAll: boolean; shouldRevalidateActive: boolean };
  emitSecurityRevocation: (event: RealtimeSecurityRevocationEvent) => void;
  purgeCurrentScope: () => Promise<void>;
  reportSessionError?: (err: unknown) => void;
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
}

function dirKeyForFolder(folderId: string | null): string {
  return folderId ?? ROOT_DIR_KEY;
}

const GUEST_SESSION_FAILURE_CODES = new Set([
  'GUEST_ACCOUNT_EXPIRED',
  'GUEST_ACCOUNT_SUSPENDED',
  'GUEST_ACCOUNT_INACTIVE',
  'INVITATION_REVOKED',
  'INVITATION_EXPIRED',
  'INVITATION_NOT_ACCEPTED',
  'EXTERNAL_COLLABORATORS_DISABLED',
  'EXTERNAL_DOMAIN_NOT_ALLOWED',
]);

function isUnauthorizedError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('status' in err)) {
    return false;
  }
  const status = (err as { status?: number }).status;
  if (status === 401) return true;
  if (status !== 403) return false;
  const code = (err as { code?: string }).code;
  return Boolean(code && GUEST_SESSION_FAILURE_CODES.has(code));
}

  export async function bootstrap(
  ctx: DirectorySyncContext,
  options?: { force?: boolean }
): Promise<BootstrapResponse | null> {
    if (ctx.bootstrapPromise && !options?.force) {
      return ctx.bootstrapPromise;
    }

    let promise: Promise<BootstrapResponse | null> | null = null;
    promise = (async (): Promise<BootstrapResponse | null> => {
      ctx.revalidatingCount += 1;
      ctx.emit();

      try {
        const res = await ctx.fetchBootstrapFn();
        const prevUser = ctx.user;
        const hint = ctx.readHintFn();

        // Detect tenant or user identity change and eradicate old local cache immediately
        if (
          prevUser &&
          (prevUser.id !== res.user.id || prevUser.tenantId !== res.user.tenantId)
        ) {
          await ctx.persistence.purgeScope(prevUser.tenantId, prevUser.id);
          ctx.resetMemoryOnly();
        } else if (
          hint &&
          (hint.userId !== res.user.id || hint.tenantId !== res.user.tenantId)
        ) {
          await ctx.persistence.purgeScope(hint.tenantId, hint.userId);
          ctx.resetMemoryOnly();
        }

        const previousSeq = ctx.syncSeq;
        ctx.user = res.user;
        ctx.authStatus = 'authenticated';
        ctx.hydratedScopeKey = `${res.user.tenantId}:${res.user.id}`;
        ctx.writeHintFn(res.user);
        ctx.policy = res.policy;
        ctx.tosStatus = res.tosStatus ?? null;
        ctx.purgedBeforeSeq = res.purgedBeforeSeq;
        ctx.bootstrapDone = true;

        // If client sync cursor predates Cron purge horizon, drop cached child directories
        if (previousSeq > 0 && previousSeq < res.purgedBeforeSeq) {
          ctx.invalidateAllCachedDirectories();
          ctx.syncSeq = res.currentSeq;
        } else if (ctx.syncSeq === 0) {
          ctx.syncSeq = res.currentSeq;
        }

        const nowMs = ctx.now();
        for (const rf of res.rootFolders) {
          ctx.foldersById.set(rf.id, rf);
        }
        for (const pf of res.pinnedFolders) {
          ctx.foldersById.set(pf.id, pf);
        }

        ctx.rootFolderIds = res.rootFolders.map((f) => f.id);
        ctx.rootNextCursor = null;
        ctx.pinnedFolderIds = res.pinnedFolders.map((f) => f.id);

        ctx.directoriesByKey.set(ROOT_DIR_KEY, {
          dirKey: ROOT_DIR_KEY,
          folderId: null,
          effectiveRole: 'editor',
          accessMode: 'full',
          folderIds: ctx.rootFolderIds,
          fileIds: [],
          nextCursor: null,
          breadcrumbs: [],
          lastAccessedAt: nowMs,
          revalidatedAt: nowMs,
          stale: false,
        });

        ctx.pruneAndSchedulePersist();
        ctx.emit();

        // Reconcile any incremental changes between previous cached seq and server head
        if (
          previousSeq > 0 &&
          previousSeq >= res.purgedBeforeSeq &&
          previousSeq < res.currentSeq
        ) {
          await ctx.syncDelta();
        }

        const currentScopeKey = `${res.user.tenantId}:${res.user.id}`;
        if (ctx.outboxLoadedScopeKey !== currentScopeKey) {
          ctx.outboxLoadedScopeKey = currentScopeKey;
          const persistedOutbox =
            (await ctx.persistence.loadOutbox?.(res.user.tenantId, res.user.id)) ?? [];
          if (persistedOutbox.length > 0) {
            ctx.outbox.restorePersistedItems(persistedOutbox);
          }
        }

        ctx.startRealtime();
        return res;
      } catch (err) {
        if (isUnauthorizedError(err)) {
          ctx.reportSessionError?.(err);
          await ctx.purgeCurrentScope();
          return null;
        }
        throw err;
      } finally {
        ctx.revalidatingCount = Math.max(0, ctx.revalidatingCount - 1);
        ctx.emit();
        if (ctx.bootstrapPromise === promise) {
          ctx.bootstrapPromise = null;
        }
      }
    })();

    ctx.bootstrapPromise = promise;
    return promise;
  }


  export async function syncDelta(ctx: DirectorySyncContext): Promise<void> {
    if (ctx.authStatus !== 'authenticated' || !ctx.user) return;
    if (ctx.deltaPromise) return ctx.deltaPromise;

    const promise = (async () => {
      let rounds = 0;
      let shouldReloadActive = false;

      while (rounds < MAX_DELTA_PAGES_PER_SYNC) {
        rounds += 1;
        const delta = await ctx.fetchDeltaFn(ctx.syncSeq, 200);
        ctx.purgedBeforeSeq = delta.purgedBeforeSeq;

        if (delta.resetRequired) {
          ctx.invalidateAllCachedDirectories();
          ctx.syncSeq = delta.currentSeq;
          shouldReloadActive = true;
          break;
        }

        if (delta.changes.length > 0) {
          const outcome = ctx.applyDeltaChanges(delta.changes);
          if (outcome.shouldRevokeAll) {
            ctx.emitSecurityRevocation({
              kind: 'user.suspended',
              scopeFolderIds: [],
              seq: null,
            });
            await ctx.purgeCurrentScope();
            return;
          }
          for (const change of delta.changes) {
            if (change.action === 'permission.revoke') {
              const myUserId = ctx.user?.id;
              const granteeType = change.payload?.granteeType;
              if (
                granteeType === 'group' ||
                (granteeType === 'user' && change.targetUserId === myUserId)
              ) {
                ctx.emitSecurityRevocation({
                  kind: 'permission.revoke',
                  scopeFolderIds: change.folderId ? [change.folderId] : [],
                  seq: change.seq,
                });
              }
            } else if (change.action === 'shared_link.revoke') {
              ctx.emitSecurityRevocation({
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

        ctx.syncSeq = Math.max(ctx.syncSeq, delta.nextSeq);
        if (!delta.hasMore) break;
      }

      ctx.pruneAndSchedulePersist();
      ctx.emit();

      if (shouldReloadActive) {
        const folderId = ctx.activeDirKey === ROOT_DIR_KEY ? null : ctx.activeDirKey;
        await ctx.ensureDirectoryLoaded(folderId, { force: true });
      }
    })()
      .catch(async (err) => {
        if (isUnauthorizedError(err)) {
          ctx.reportSessionError?.(err);
          await ctx.purgeCurrentScope();
        }
      })
      .finally(() => {
        if (ctx.deltaPromise === promise) {
          ctx.deltaPromise = null;
        }
      });

    ctx.deltaPromise = promise;
    return promise;
  }


  export async function ensureDirectoryLoaded(
  ctx: DirectorySyncContext,
  folderId: string | null,
  options?: {
    force?: boolean;
    signal?: AbortSignal;
    isPrefetch?: boolean;
    sortBy?: WorkspaceSortField;
    sortDir?: WorkspaceSortDirection;
  }
): Promise<void> {
    const dirKey = dirKeyForFolder(folderId);
    const cached = ctx.directoriesByKey.get(dirKey);
    const sortBy = options?.sortBy ?? cached?.sortBy ?? 'name';
    const sortDir = options?.sortDir ?? cached?.sortDir ?? 'asc';
    const sortChanged =
      Boolean(cached) &&
      ((cached!.sortBy ?? 'name') !== sortBy ||
        (cached!.sortDir ?? 'asc') !== sortDir);

    if (
      !options?.force &&
      !sortChanged &&
      cached &&
      !cached.stale &&
      (ctx.now() - cached.revalidatedAt < DEFAULT_SWR_TTL_MS ||
        (options?.isPrefetch && ctx.inFlightLoadMore.has(dirKey)))
    ) {
      cached.lastAccessedAt = ctx.now();
      return;
    }

    const existingReq = ctx.inFlightDirs.get(dirKey);
    if (existingReq) {
      await existingReq;
      const afterCached = ctx.directoriesByKey.get(dirKey);
      if (
        (afterCached?.sortBy ?? 'name') === sortBy &&
        (afterCached?.sortDir ?? 'asc') === sortDir
      ) {
        return;
      }
    }

    let run: Promise<void> | null = null;
    run = (async () => {
      if (!options?.isPrefetch) {
        ctx.revalidatingCount += 1;
        ctx.emit();
      }
      try {
        const nowMs = ctx.now();
        if (folderId === null) {
          const rootsRes = await ctx.fetchRootFoldersFn(null, options?.signal, {
            sortBy,
            sortDir,
          });
          for (const f of rootsRes.folders) {
            ctx.foldersById.set(f.id, f);
          }
          ctx.rootFolderIds = rootsRes.folders.map((f) => f.id);
          ctx.rootNextCursor = rootsRes.nextCursor;
          ctx.directoriesByKey.set(ROOT_DIR_KEY, {
            dirKey: ROOT_DIR_KEY,
            folderId: null,
            effectiveRole: 'editor',
            accessMode: 'full',
            folderIds: ctx.rootFolderIds,
            fileIds: [],
            nextCursor: rootsRes.nextCursor,
            sortBy,
            sortDir,
            breadcrumbs: [],
            lastAccessedAt: nowMs,
            revalidatedAt: nowMs,
            stale: false,
          });
        } else {
          const res = await ctx.fetchFolderChildrenFn(folderId, null, 50, {
            includeBreadcrumbs: true,
            signal: options?.signal,
            sortBy,
            sortDir,
          });
          const pathOnly = res.accessMode === 'path';
          // Path-only access must never keep stale cached files from a
          // previously broader grant.
          if (pathOnly) {
            for (const fileId of cached?.fileIds ?? []) {
              ctx.filesById.delete(fileId);
            }
          }
          if (res.folder) {
            ctx.foldersById.set(res.folder.id, {
              ...res.folder,
              effectiveRole: res.effectiveRole ?? undefined,
              accessMode: res.accessMode ?? null,
            });
          }
          for (const f of res.folders) {
            ctx.foldersById.set(f.id, f);
          }
          for (const fl of res.files) {
            ctx.filesById.set(fl.id, fl);
          }
          ctx.directoriesByKey.set(dirKey, {
            dirKey,
            folderId,
            effectiveRole: res.effectiveRole ?? 'previewer',
            capabilities: res.capabilities,
            accessMode: res.accessMode ?? null,
            folderIds: res.folders.map((f) => f.id),
            fileIds: pathOnly ? [] : res.files.map((fl) => fl.id),
            nextCursor: res.nextCursor,
            sortBy,
            sortDir,
            breadcrumbs: res.breadcrumbs ?? cached?.breadcrumbs ?? [],
            lastAccessedAt: nowMs,
            revalidatedAt: nowMs,
            stale: false,
          });
        }

        ctx.pruneAndSchedulePersist();
        ctx.emit();
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        if (isUnauthorizedError(err)) {
          ctx.reportSessionError?.(err);
          await ctx.purgeCurrentScope();
          return;
        }
        if (!options?.isPrefetch) {
          throw err;
        }
      } finally {
        if (!options?.isPrefetch) {
          ctx.revalidatingCount = Math.max(0, ctx.revalidatingCount - 1);
          ctx.emit();
        }
        if (ctx.inFlightDirs.get(dirKey) === run) {
          ctx.inFlightDirs.delete(dirKey);
        }
      }
    })();

    ctx.inFlightDirs.set(dirKey, run);
    return run;
  }


  export async function loadMoreDirectory(
  ctx: DirectorySyncContext,
  folderId: string | null,
  options?: { sortBy?: WorkspaceSortField; sortDir?: WorkspaceSortDirection }
): Promise<void> {
    const dirKey = dirKeyForFolder(folderId);
    const existingReq = ctx.inFlightLoadMore.get(dirKey);
    if (existingReq) {
      return existingReq;
    }

    const initial = ctx.directoriesByKey.get(dirKey);
    const requestedCursor = initial?.nextCursor ?? null;
    if (!requestedCursor) return;
    const sortBy = options?.sortBy ?? initial?.sortBy ?? 'name';
    const sortDir = options?.sortDir ?? initial?.sortDir ?? 'asc';

    let run: Promise<void> | null = null;
    run = (async () => {
      try {
        if (folderId === null) {
          const res = await ctx.fetchRootFoldersFn(requestedCursor, undefined, {
            sortBy,
            sortDir,
          });
          const latest = ctx.directoriesByKey.get(ROOT_DIR_KEY);
          if (
            !latest ||
            latest.nextCursor !== requestedCursor ||
            (latest.sortBy ?? 'name') !== sortBy ||
            (latest.sortDir ?? 'asc') !== sortDir
          ) {
            return;
          }

          const nowMs = ctx.now();
          for (const f of res.folders) {
            ctx.foldersById.set(f.id, f);
          }
          const nextIds = [...latest.folderIds];
          for (const f of res.folders) {
            if (!nextIds.includes(f.id)) nextIds.push(f.id);
          }
          ctx.rootFolderIds = nextIds;
          ctx.rootNextCursor = res.nextCursor;
          ctx.directoriesByKey.set(ROOT_DIR_KEY, {
            ...latest,
            folderIds: nextIds,
            nextCursor: res.nextCursor,
            lastAccessedAt: nowMs,
            revalidatedAt: nowMs,
          });
        } else {
          const res = await ctx.fetchFolderChildrenFn(folderId, requestedCursor, 50, {
            includeBreadcrumbs: false,
            sortBy,
            sortDir,
          });
          const latest = ctx.directoriesByKey.get(dirKey);
          if (
            !latest ||
            latest.nextCursor !== requestedCursor ||
            (latest.sortBy ?? 'name') !== sortBy ||
            (latest.sortDir ?? 'asc') !== sortDir
          ) {
            return;
          }

          const nowMs = ctx.now();
          for (const f of res.folders) ctx.foldersById.set(f.id, f);
          for (const fl of res.files) ctx.filesById.set(fl.id, fl);

          const nextFolderIds = [...latest.folderIds];
          for (const f of res.folders) {
            if (!nextFolderIds.includes(f.id)) nextFolderIds.push(f.id);
          }
          const pathOnly = (res.accessMode ?? latest.accessMode) === 'path';
          const nextFileIds = [...latest.fileIds];
          if (!pathOnly) {
            for (const fl of res.files) {
              if (!nextFileIds.includes(fl.id)) nextFileIds.push(fl.id);
            }
          }
          ctx.directoriesByKey.set(dirKey, {
            ...latest,
            accessMode: res.accessMode ?? latest.accessMode ?? null,
            folderIds: nextFolderIds,
            fileIds: pathOnly ? [] : nextFileIds,
            nextCursor: res.nextCursor,
            lastAccessedAt: nowMs,
            revalidatedAt: nowMs,
          });
        }

        ctx.pruneAndSchedulePersist();
        ctx.emit();
      } catch (err) {
        if (isUnauthorizedError(err)) {
          ctx.reportSessionError?.(err);
          await ctx.purgeCurrentScope();
          return;
        }
        throw err;
      } finally {
        if (ctx.inFlightLoadMore.get(dirKey) === run) {
          ctx.inFlightLoadMore.delete(dirKey);
        }
      }
    })();

    ctx.inFlightLoadMore.set(dirKey, run);
    return run;
  }

  /** Local cache helpers used by mutations to update store synchronously before/after server ack */
