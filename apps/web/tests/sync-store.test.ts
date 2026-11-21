import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IntentPrefetcher,
  PREFETCH_FRESH_TTL_MS,
} from '@/lib/intent-prefetch';
import {
  getSyncDbName,
  pruneWorkingSetInMemory,
  type PersistedDirectoryRecord,
  type SyncPersistenceAdapter,
  type SyncScopeHint,
  type WorkingSetSnapshot,
} from '@/lib/sync-idb';
import {
  dirKeyForFolder,
  WorkspaceSyncStore,
} from '@/lib/sync-store';
import { computeVirtualWindow } from '@/lib/use-virtual-window';
import type {
  AuthUser,
  BootstrapResponse,
  FileItem,
  FolderChildrenResponse,
  FolderSummary,
  SyncDeltaResponse,
  TenantPolicyRow,
} from '@/types/files';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    tenantId: 'tenant-a',
    email: 'alice@example.com',
    displayName: 'Alice',
    role: 'member',
    ipAddress: '127.0.0.1',
    userType: 'member',
    ...overrides,
  };
}

function makePolicy(tenantId = 'tenant-a'): TenantPolicyRow {
  return {
    tenant_id: tenantId,
    enforce_company_only_links: 1,
    require_watermark_confidential: 1,
    max_link_expiration_days: 30,
    session_max_hours: 12,
    trash_retention_days: 30,
    ai_classification_mode: 'metadata_only',
    ai_auto_apply_threshold: 0.9,
    updated_by: null,
    updated_at: '2026-11-15T00:00:00.000Z',
  };
}

function makeFolder(id: string, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id,
    parent_id: null,
    name: `Folder ${id}`,
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-11-15T00:00:00.000Z',
    effectiveRole: 'editor',
    ...overrides,
  };
}

function makeFile(id: string, folderId: string, overrides: Partial<FileItem> = {}): FileItem {
  return {
    id,
    folder_id: folderId,
    name: `${id}.pdf`,
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    current_version_num: 1,
    meta_version: 1,
    updated_at: '2026-11-15T00:00:00.000Z',
    ...overrides,
  };
}

class MemorySyncPersistence implements SyncPersistenceAdapter {
  scopes = new Map<string, WorkingSetSnapshot>();
  purgedScopes: string[] = [];
  purgeAllCalls = 0;

  async loadScope(tenantId: string, userId: string): Promise<WorkingSetSnapshot | null> {
    return this.scopes.get(getSyncDbName(tenantId, userId)) ?? null;
  }

  async saveSnapshot(tenantId: string, userId: string, snapshot: WorkingSetSnapshot): Promise<void> {
    this.scopes.set(getSyncDbName(tenantId, userId), structuredClone(snapshot));
  }

  async purgeScope(tenantId: string, userId: string): Promise<void> {
    const key = getSyncDbName(tenantId, userId);
    this.purgedScopes.push(key);
    this.scopes.delete(key);
  }

  async purgeAllScopes(exceptDbName?: string): Promise<void> {
    this.purgeAllCalls += 1;
    for (const key of Array.from(this.scopes.keys())) {
      if (key !== exceptDbName) {
        this.scopes.delete(key);
      }
    }
  }
}

test('WorkspaceSyncStore hydrates via SWR scope hint, catches up deltas, and purges on security events', async () => {
  const userA = makeUser({ id: 'user-a', tenantId: 'tenant-1' });
  const persistence = new MemorySyncPersistence();
  let hint: SyncScopeHint | null = {
    tenantId: userA.tenantId,
    userId: userA.id,
    email: userA.email,
    displayName: userA.displayName,
    role: userA.role,
  };

  const rootFolder = makeFolder('root-1');
  const childFolder = makeFolder('child-1', { parent_id: 'root-1' });
  const grandChild = makeFolder('grand-1', { parent_id: 'child-1' });
  const cachedFile = makeFile('file-1', 'child-1', { name: 'cached.pdf' });

  await persistence.saveSnapshot(userA.tenantId, userA.id, {
    meta: {
      key: 'state',
      user: userA,
      policy: makePolicy('tenant-1'),
      syncSeq: 10,
      purgedBeforeSeq: 0,
      rootFolderIds: ['root-1'],
      rootNextCursor: null,
      pinnedFolderIds: [],
      updatedAt: 1000,
    },
    folders: [rootFolder, childFolder, grandChild],
    files: [cachedFile],
    directories: [
      {
        dirKey: '__ROOT__',
        folderId: null,
        effectiveRole: 'editor',
        folderIds: ['root-1'],
        fileIds: [],
        nextCursor: null,
        breadcrumbs: [],
        lastAccessedAt: 1000,
        revalidatedAt: 1000,
      },
      {
        dirKey: 'child-1',
        folderId: 'child-1',
        effectiveRole: 'editor',
        folderIds: ['grand-1'],
        fileIds: ['file-1'],
        nextCursor: null,
        breadcrumbs: [
          { id: 'root-1', name: 'Folder root-1', classification: 'internal', depth: 0 },
          { id: 'child-1', name: 'Folder child-1', classification: 'internal', depth: 1 },
        ],
        lastAccessedAt: 1000,
        revalidatedAt: 1000,
      },
      {
        dirKey: 'grand-1',
        folderId: 'grand-1',
        effectiveRole: 'editor',
        folderIds: [],
        fileIds: [],
        nextCursor: null,
        breadcrumbs: [
          { id: 'root-1', name: 'Folder root-1', classification: 'internal', depth: 0 },
          { id: 'child-1', name: 'Folder child-1', classification: 'internal', depth: 1 },
          { id: 'grand-1', name: 'Folder grand-1', classification: 'internal', depth: 2 },
        ],
        lastAccessedAt: 1000,
        revalidatedAt: 1000,
      },
    ],
  });

  let nowMs = 5000;
  const purgeHooks: Array<() => Promise<void> | void> = [];
  let deltaResponses: SyncDeltaResponse[] = [
    {
      currentSeq: 12,
      nextSeq: 12,
      purgedBeforeSeq: 0,
      resetRequired: false,
      hasMore: false,
      changes: [
        {
          seq: 11,
          entityType: 'file',
          entityId: 'file-1',
          folderId: 'child-1',
          action: 'file.classification_updated',
          targetUserId: null,
          payload: { classification: 'confidential', updatedAt: '2026-11-15T01:00:00.000Z' },
          createdAt: '2026-11-15T01:00:00.000Z',
        },
        {
          seq: 12,
          entityType: 'permission',
          entityId: 'perm-1',
          folderId: 'child-1',
          action: 'permission.revoke',
          targetUserId: userA.id,
          payload: {
            targetType: 'folder',
            targetId: 'child-1',
            granteeType: 'user',
          },
          createdAt: '2026-11-15T01:01:00.000Z',
        },
      ],
    },
  ];

  const store = new WorkspaceSyncStore({
    persistence,
    now: () => nowMs,
    readScopeHint: () => hint,
    writeScopeHint: (u) => {
      hint = u
        ? {
            tenantId: u.tenantId,
            userId: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
          }
        : null;
    },
    registerPurgeHook: (hook) => {
      purgeHooks.push(hook);
      return () => {
        const idx = purgeHooks.indexOf(hook);
        if (idx >= 0) purgeHooks.splice(idx, 1);
      };
    },
    fetchBootstrap: async (): Promise<BootstrapResponse> => ({
      user: userA,
      policy: makePolicy('tenant-1'),
      currentSeq: 12,
      purgedBeforeSeq: 0,
      rootFolders: [rootFolder],
      pinnedFolders: [],
    }),
    fetchDelta: async () => {
      const next = deltaResponses.shift();
      return (
        next ?? {
          currentSeq: 12,
          nextSeq: 12,
          purgedBeforeSeq: 0,
          resetRequired: false,
          hasMore: false,
          changes: [],
        }
      );
    },
    fetchFolderChildren: async (folderId): Promise<FolderChildrenResponse> => {
      throw Object.assign(new Error(`Forbidden: ${folderId}`), { status: 403 });
    },
    fetchRootFolders: async () => ({
      folders: [rootFolder],
      nextCursor: null,
    }),
  });

  // 1. Immediate SWR hydration paints cached child directory without network wait
  const hydrated = await store.hydrateFromScopeHint();
  assert.equal(hydrated, true);
  assert.equal(store.getSnapshot().authStatus, 'authenticated');
  assert.equal(store.getDirectoryView('child-1').files[0]?.name, 'cached.pdf');

  // 2. Active folder is set to child-1, then bootstrap + delta evicts revoked subtree (`child-1` & `grand-1`)
  store.setActiveFolder('child-1');
  await store.bootstrap({ force: true });
  assert.equal(store.getSnapshot().bootstrapDone, true);
  assert.equal(store.hasCachedDirectory('child-1'), false);
  assert.equal(store.hasCachedDirectory('grand-1'), false);
  assert.match(store.getSnapshot().activeDirectoryNotice ?? '', /アクセス権限/);

  // 3. `resetRequired: true` invalidates working-set directories cleanly
  await store.ensureDirectoryLoaded(null, { force: true }).catch(() => undefined);
  assert.equal(store.getDirectoryView(null).existsInCache, true);
  deltaResponses.push({
    currentSeq: 99,
    nextSeq: 99,
    purgedBeforeSeq: 50,
    resetRequired: true,
    hasMore: false,
    changes: [],
  });
  store.setActiveFolder('missing-folder');
  await store.syncDelta();
  assert.equal(store.getSnapshot().syncSeq, 99);
  assert.equal(store.getDirectoryView(null).isStale, true);

  // 4. `user.suspended` delta purges scoped cache completely
  deltaResponses.push({
    currentSeq: 100,
    nextSeq: 100,
    purgedBeforeSeq: 50,
    resetRequired: false,
    hasMore: false,
    changes: [
      {
        seq: 100,
        entityType: 'user',
        entityId: userA.id,
        folderId: null,
        action: 'user.suspended',
        targetUserId: userA.id,
        payload: {},
        createdAt: '2026-11-15T02:00:00.000Z',
      },
    ],
  });
  await store.syncDelta();
  assert.equal(store.getSnapshot().authStatus, 'unauthenticated');
  assert.equal(store.getSnapshot().user, null);
  assert.equal(hint, null);
  assert.equal(persistence.scopes.size, 0);

  // 5. Switching to another user purges any previous user's scoped cache & adopts new user
  const userB = makeUser({ id: 'user-b', tenantId: 'tenant-1', email: 'bob@example.com' });
  await persistence.saveSnapshot(userA.tenantId, userA.id, {
    meta: {
      key: 'state',
      user: userA,
      policy: null,
      syncSeq: 1,
      purgedBeforeSeq: 0,
      rootFolderIds: [],
      rootNextCursor: null,
      pinnedFolderIds: [],
      updatedAt: nowMs,
    },
    folders: [],
    files: [],
    directories: [],
  });
  hint = {
    tenantId: userA.tenantId,
    userId: userA.id,
    email: userA.email,
    displayName: userA.displayName,
    role: userA.role,
  };

  // Next bootstrap returns userB -> userA DB must be purged!
  const storeSwitch = new WorkspaceSyncStore({
    persistence,
    readScopeHint: () => hint,
    writeScopeHint: (u) => {
      hint = u
        ? {
            tenantId: u.tenantId,
            userId: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
          }
        : null;
    },
    registerPurgeHook: (hook) => {
      purgeHooks.push(hook);
      return () => {
        const idx = purgeHooks.indexOf(hook);
        if (idx >= 0) purgeHooks.splice(idx, 1);
      };
    },
    fetchBootstrap: async () => ({
      user: userB,
      policy: makePolicy('tenant-1'),
      currentSeq: 5,
      purgedBeforeSeq: 0,
      rootFolders: [],
      pinnedFolders: [],
    }),
  });
  await storeSwitch.bootstrap({ force: true });
  assert.ok(persistence.purgedScopes.includes(getSyncDbName(userA.tenantId, userA.id)));
  assert.equal(storeSwitch.getSnapshot().user?.id, 'user-b');
  assert.equal(hint?.userId, 'user-b');

  // 6. Auth purge hook (triggered on 401 / logout) clears all local state
  const activeHook = purgeHooks.at(-1);
  assert.ok(activeHook);
  await activeHook();
  assert.equal(storeSwitch.getSnapshot().authStatus, 'unauthenticated');
  assert.equal(hint, null);
  await store.flushPersistence();
  await storeSwitch.flushPersistence();
});

test('pruneWorkingSetInMemory evicts oldest non-pinned directories and sweeps orphaned entities', () => {
  const directories = new Map<string, PersistedDirectoryRecord>();
  const foldersById = new Map<string, FolderSummary>();
  const filesById = new Map<string, FileItem>();

  const root = makeFolder('root-a');
  const pinned = makeFolder('pinned-1', { is_pinned: 1 });
  const active = makeFolder('active-1');
  const oldDir = makeFolder('old-1');
  const midDir = makeFolder('mid-1');
  const recentDir = makeFolder('recent-1');

  for (const f of [root, pinned, active, oldDir, midDir, recentDir]) {
    foldersById.set(f.id, f);
  }
  filesById.set('file-old', makeFile('file-old', 'old-1'));
  filesById.set('file-active', makeFile('file-active', 'active-1'));

  directories.set('__ROOT__', {
    dirKey: '__ROOT__',
    folderId: null,
    effectiveRole: 'editor',
    folderIds: ['root-a'],
    fileIds: [],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 100,
    revalidatedAt: 100,
  });
  directories.set('pinned-1', {
    dirKey: 'pinned-1',
    folderId: 'pinned-1',
    effectiveRole: 'editor',
    folderIds: [],
    fileIds: [],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 50, // Even with oldest timestamp, pinned must survive
    revalidatedAt: 50,
  });
  directories.set('active-1', {
    dirKey: 'active-1',
    folderId: 'active-1',
    effectiveRole: 'editor',
    folderIds: [],
    fileIds: ['file-active'],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 60, // Active dir must survive
    revalidatedAt: 60,
  });
  directories.set('old-1', {
    dirKey: 'old-1',
    folderId: 'old-1',
    effectiveRole: 'editor',
    folderIds: [],
    fileIds: ['file-old'],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 200,
    revalidatedAt: 200,
  });
  directories.set('mid-1', {
    dirKey: 'mid-1',
    folderId: 'mid-1',
    effectiveRole: 'editor',
    folderIds: [],
    fileIds: [],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 300,
    revalidatedAt: 300,
  });
  directories.set('recent-1', {
    dirKey: 'recent-1',
    folderId: 'recent-1',
    effectiveRole: 'editor',
    folderIds: [],
    fileIds: [],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 400,
    revalidatedAt: 400,
  });

  const result = pruneWorkingSetInMemory({
    directories,
    foldersById,
    filesById,
    rootFolderIds: ['root-a'],
    pinnedFolderIds: ['pinned-1'],
    activeDirKey: 'active-1',
    maxDirectories: 4,
  });

  assert.equal(directories.size, 4);
  assert.equal(directories.has('__ROOT__'), true);
  assert.equal(directories.has('pinned-1'), true);
  assert.equal(directories.has('active-1'), true);
  assert.equal(directories.has('recent-1'), true);
  assert.deepEqual(result.evictedDirKeys.sort(), ['mid-1', 'old-1']);
  assert.equal(filesById.has('file-old'), false);
  assert.equal(filesById.has('file-active'), true);
  assert.equal(foldersById.has('old-1'), false);
  assert.equal(foldersById.has('pinned-1'), true);
});

test('pinning then unpinning while the first PATCH is in-flight keeps the folder unpinned and advances expectedVersion', async () => {
  const folder = makeFolder('pin-folder', {
    name: 'Pin Docs',
    is_pinned: 0,
    version: 1,
  });
  const calls: Array<{ expectedVersion?: number; isPinned?: boolean }> = [];
  let signalFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  let releaseFirst!: () => void;
  const firstResponse = new Promise<{ folder: FolderSummary }>((resolve) => {
    releaseFirst = () =>
      resolve({
        folder: {
          ...folder,
          is_pinned: 1,
          version: 2,
          updated_at: '2026-11-15T01:00:00.000Z',
        },
      });
  });

  const store = new WorkspaceSyncStore({
    persistence: new MemorySyncPersistence(),
    outboxCoalesceMs: 5,
    fetchBootstrap: async () => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [folder],
      pinnedFolders: [],
      currentSeq: 1,
      purgedBeforeSeq: 0,
    }),
    updateFolderFn: async (_folderId, payload) => {
      calls.push({
        expectedVersion: payload.expectedVersion,
        isPinned: payload.isPinned,
      });
      if (calls.length === 1) {
        signalFirstStarted();
        return firstResponse;
      }
      return {
        folder: {
          ...folder,
          is_pinned: payload.isPinned ? 1 : 0,
          version: (payload.expectedVersion ?? folder.version) + 1,
        },
      };
    },
  });

  await store.bootstrap({ force: true });

  // The stale record a UI row or Undo callback may still hold after a re-render.
  const staleFolder = { ...folder };

  assert.equal(store.optimisticToggleFolderPin(staleFolder).ok, true);
  const afterPin = store
    .getDirectoryView(null)
    .folders.find((f) => f.id === folder.id);
  assert.equal(afterPin?.is_pinned, 1);

  await firstStarted;

  // Unpin immediately while the first PATCH is still in-flight.
  assert.equal(store.optimisticToggleFolderPin(staleFolder).ok, true);
  const afterUnpin = store
    .getDirectoryView(null)
    .folders.find((f) => f.id === folder.id);
  assert.equal(afterUnpin?.is_pinned, 0);

  releaseFirst();
  await store.flushOutbox();

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.isPinned, true);
  assert.equal(calls[1]?.isPinned, false);
  assert.equal(calls[1]?.expectedVersion, 2);

  const settled = store
    .getDirectoryView(null)
    .folders.find((f) => f.id === folder.id);
  assert.equal(settled?.is_pinned, 0);
  assert.equal(settled?.version, 3);
  await store.flushPersistence();
});

test('IntentPrefetcher enforces debounce cancel, concurrency limit (2), 30s TTL, and never calls content-url', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const requestedUrls: string[] = [];
  const resolvers: Array<() => void> = [];
  const freshIds = new Set<string>(['already-fresh']);

  const mockStore = {
    isDirectoryFresh: (folderId: string | null, ttlMs?: number) => {
      assert.equal(ttlMs, PREFETCH_FRESH_TTL_MS);
      return Boolean(folderId && freshIds.has(folderId));
    },
    ensureDirectoryLoaded: async (
      folderId: string | null,
      options?: { isPrefetch?: boolean; signal?: AbortSignal }
    ) => {
      assert.equal(options?.isPrefetch, true);
      requestedUrls.push(`/api/folders/${folderId}/children?include=breadcrumbs`);
      await new Promise<void>((resolve) => {
        if (options?.signal) {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        }
        resolvers.push(resolve);
      });
    },
  };

  let pdfWarmCount = 0;
  const prefetcher = new IntentPrefetcher(mockStore, {
    warmPdfFn: () => {
      pdfWarmCount += 1;
    },
  });

  // 1. Fresh folder skips scheduling completely
  prefetcher.scheduleHoverPrefetch('already-fresh');
  t.mock.timers.tick(200);
  assert.equal(requestedUrls.length, 0);

  // 2. Cancel before 80ms hover threshold triggers zero requests
  prefetcher.scheduleHoverPrefetch('f-cancelled');
  t.mock.timers.tick(50);
  prefetcher.cancel('f-cancelled');
  t.mock.timers.tick(100);
  assert.equal(requestedUrls.length, 0);

  // 3. Three concurrent folder prefetches cap in-flight concurrency at 2
  prefetcher.scheduleHoverPrefetch('f-1');
  prefetcher.scheduleHoverPrefetch('f-2');
  prefetcher.scheduleCursorPrefetch('f-3');
  t.mock.timers.tick(150);
  assert.equal(prefetcher.getInFlightCount(), 2);
  assert.equal(requestedUrls.length, 3);
  assert.equal(
    requestedUrls.some((url) => url.includes('content-url')),
    false
  );

  // Resolve remaining promises cleanly
  for (const r of resolvers) r();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(prefetcher.getInFlightCount(), 0);

  // 4. PDF runtime warm runs at most once and never touches /content-url
  prefetcher.warmPdfPreviewRuntime();
  prefetcher.warmPdfPreviewRuntime();
  assert.equal(pdfWarmCount, 1);
  assert.equal(dirKeyForFolder(null), '__ROOT__');
});

test('computeVirtualWindow bypasses small lists and slices 10,000-row tables accurately', () => {
  const small = computeVirtualWindow({
    totalCount: 25,
    scrollTop: 0,
    viewportHeight: 600,
  });
  assert.equal(small.virtualized, false);
  assert.equal(small.startIndex, 0);
  assert.equal(small.endIndex, 25);
  assert.equal(small.topSpacerPx, 0);
  assert.equal(small.bottomSpacerPx, 0);

  const large = computeVirtualWindow({
    totalCount: 10_000,
    rowHeight: 52,
    scrollTop: 52 * 500,
    viewportHeight: 520,
    overscan: 10,
    threshold: 40,
  });
  assert.equal(large.virtualized, true);
  assert.equal(large.startIndex, 490);
  assert.equal(large.endIndex, 520);
  assert.equal(large.topSpacerPx, 490 * 52);
  assert.equal(large.bottomSpacerPx, (10_000 - 520) * 52);
  assert.equal(
    large.topSpacerPx + (large.endIndex - large.startIndex) * 52 + large.bottomSpacerPx,
    10_000 * 52
  );
});

test('loadMoreDirectory deduplicates concurrent calls and preserves revalidatedAt against prefetch resets', async () => {
  let clock = 10_000;
  const folderId = 'paged-folder';
  const parentFolder = makeFolder(folderId, { name: 'Paged' });
  const file1 = makeFile('f-1', folderId, { name: 'a.txt' });
  const file2 = makeFile('f-2', folderId, { name: 'b.txt' });
  const file3 = makeFile('f-3', folderId, { name: 'c.txt' });

  const requestedCursors: Array<string | null | undefined> = [];
  let releasePage2!: () => void;
  const page2Gate = new Promise<void>((resolve) => {
    releasePage2 = resolve;
  });

  const store = new WorkspaceSyncStore({
    persistence: new MemorySyncPersistence(),
    now: () => clock,
    fetchBootstrap: async () => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [parentFolder],
      pinnedFolders: [],
      currentSeq: 1,
      purgedBeforeSeq: 0,
    }),
    fetchFolderChildren: async (_id, cursor) => {
      requestedCursors.push(cursor);
      if (!cursor) {
        return {
          folder: parentFolder,
          effectiveRole: 'editor',
          folders: [],
          files: [file1],
          breadcrumbs: [{ id: folderId, name: 'Paged', classification: 'internal', depth: 0 }],
          nextCursor: 'cursor-p2',
        };
      }
      if (cursor === 'cursor-p2') {
        await page2Gate;
        return {
          folder: parentFolder,
          effectiveRole: 'editor',
          folders: [],
          files: [file2],
          nextCursor: 'cursor-p3',
        };
      }
      return {
        folder: parentFolder,
        effectiveRole: 'editor',
        folders: [],
        files: [file3],
        nextCursor: null,
      };
    },
    enableRealtime: false,
  });

  await store.bootstrap();
  await store.ensureDirectoryLoaded(folderId);
  assert.equal(store.getDirectoryView(folderId).nextCursor, 'cursor-p2');

  // Fire two concurrent loadMoreDirectory calls (e.g., StrictMode double-effect)
  clock += 20_000; // Past 15s SWR TTL
  const pA = store.loadMoreDirectory(folderId);
  const pB = store.loadMoreDirectory(folderId);

  // Prefetch while loadMoreDirectory is in flight must not reset back to page 1
  await store.ensureDirectoryLoaded(folderId, { isPrefetch: true });

  releasePage2();
  await Promise.all([pA, pB]);

  assert.deepEqual(requestedCursors, [null, 'cursor-p2']);
  assert.equal(store.getDirectoryView(folderId).nextCursor, 'cursor-p3');
  assert.deepEqual(
    store.getDirectoryView(folderId).files.map((f) => f.id),
    ['f-1', 'f-2']
  );

  // Because loadMoreDirectory refreshed revalidatedAt, a prefetch right after must still be fresh
  await store.ensureDirectoryLoaded(folderId, { isPrefetch: true });
  assert.deepEqual(requestedCursors, [null, 'cursor-p2']);

  // Final page drains cleanly to nextCursor: null
  await store.loadMoreDirectory(folderId);
  assert.equal(store.getDirectoryView(folderId).nextCursor, null);
  assert.deepEqual(
    store.getDirectoryView(folderId).files.map((f) => f.id),
    ['f-1', 'f-2', 'f-3']
  );
});

test('loadMoreDirectory ignores stale response if directory was force-refreshed while in flight', async () => {
  const folderId = 'refresh-race-folder';
  const parentFolder = makeFolder(folderId, { name: 'Race' });
  const file1 = makeFile('r-1', folderId, { name: 'a.txt' });
  const file2 = makeFile('r-2', folderId, { name: 'b.txt' });
  const freshFile = makeFile('r-fresh', folderId, { name: 'fresh.txt' });

  let releaseStalePage2!: () => void;
  const stalePage2Gate = new Promise<void>((resolve) => {
    releaseStalePage2 = resolve;
  });
  let initialCalls = 0;

  const store = new WorkspaceSyncStore({
    persistence: new MemorySyncPersistence(),
    fetchBootstrap: async () => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [parentFolder],
      pinnedFolders: [],
      currentSeq: 1,
      purgedBeforeSeq: 0,
    }),
    fetchFolderChildren: async (_id, cursor) => {
      if (!cursor) {
        initialCalls += 1;
        if (initialCalls === 1) {
          return {
            folder: parentFolder,
            effectiveRole: 'editor',
            folders: [],
            files: [file1],
            breadcrumbs: [{ id: folderId, name: 'Race', classification: 'internal', depth: 0 }],
            nextCursor: 'stale-cursor',
          };
        }
        return {
          folder: parentFolder,
          effectiveRole: 'editor',
          folders: [],
          files: [freshFile],
          breadcrumbs: [{ id: folderId, name: 'Race', classification: 'internal', depth: 0 }],
          nextCursor: null,
        };
      }
      await stalePage2Gate;
      return {
        folder: parentFolder,
        effectiveRole: 'editor',
        folders: [],
        files: [file2],
        nextCursor: 'stale-cursor-next',
      };
    },
    enableRealtime: false,
  });

  await store.bootstrap();
  await store.ensureDirectoryLoaded(folderId);
  const inFlightMore = store.loadMoreDirectory(folderId);

  // Force refresh completes while loadMoreDirectory is still awaiting stale-cursor
  await store.ensureDirectoryLoaded(folderId, { force: true });
  assert.equal(store.getDirectoryView(folderId).nextCursor, null);
  assert.deepEqual(
    store.getDirectoryView(folderId).files.map((f) => f.id),
    ['r-fresh']
  );

  releaseStalePage2();
  await inFlightMore;

  // Stale loadMore response must not rewind nextCursor or clobber fresh files
  assert.equal(store.getDirectoryView(folderId).nextCursor, null);
  assert.deepEqual(
    store.getDirectoryView(folderId).files.map((f) => f.id),
    ['r-fresh']
  );
});
