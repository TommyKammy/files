import assert from 'node:assert/strict';
import test from 'node:test';
import { IntentPrefetcher } from '@/lib/intent-prefetch';
import type { SyncPersistenceAdapter, SyncScopeHint, WorkingSetSnapshot } from '@/lib/sync-idb';
import { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  computeReconnectDelayMs,
  type RealtimeSecurityRevocationEvent,
  type RealtimeSocketLike,
  WorkspaceRealtimeClient,
} from '@/lib/sync-ws';
import type {
  AuthUser,
  BootstrapResponse,
  FolderChildrenResponse,
  FolderSummary,
  SyncDeltaResponse,
  SyncInvalidationSignal,
  TenantPolicyRow,
} from '@/types/files';

class FakeTimerHub {
  nowMs = 1_000;
  private nextId = 1;
  private timers = new Map<number, { fireAt: number; fn: () => void }>();

  setTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { fireAt: this.nowMs + Math.max(0, ms), fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(timer as unknown as number);
  };

  advanceBy(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      let earliestId: number | null = null;
      let earliestTime = Infinity;
      for (const [id, entry] of this.timers.entries()) {
        if (entry.fireAt <= target && entry.fireAt < earliestTime) {
          earliestTime = entry.fireAt;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const entry = this.timers.get(earliestId);
      this.timers.delete(earliestId);
      if (entry) {
        this.nowMs = entry.fireAt;
        entry.fn();
      }
    }
    this.nowMs = target;
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

class FakeWebSocket implements RealtimeSocketLike {
  readyState = 0;
  sent: string[] = [];
  closedWith: Array<{ code?: number; reason?: string }> = [];
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith.push({ code, reason });
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  emitMessage(data: string): void {
    this.dispatch('message', { data });
  }

  emitClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.dispatch('close', { code, reason });
  }

  private dispatch(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(event);
    }
  }
}

function createMemoryPersistence(): SyncPersistenceAdapter & {
  purgedScopes: string[];
  purgeAllCalls: number;
} {
  const scopes = new Map<string, WorkingSetSnapshot>();
  const purgedScopes: string[] = [];
  let purgeAllCalls = 0;

  return {
    purgedScopes,
    get purgeAllCalls() {
      return purgeAllCalls;
    },
    async loadScope(tenantId: string, userId: string): Promise<WorkingSetSnapshot | null> {
      return scopes.get(`${tenantId}:${userId}`) ?? null;
    },
    async saveSnapshot(
      tenantId: string,
      userId: string,
      snapshot: WorkingSetSnapshot
    ): Promise<void> {
      scopes.set(`${tenantId}:${userId}`, structuredClone(snapshot));
    },
    async purgeScope(tenantId: string, userId: string): Promise<void> {
      purgedScopes.push(`${tenantId}:${userId}`);
      scopes.delete(`${tenantId}:${userId}`);
    },
    async purgeAllScopes(): Promise<void> {
      purgeAllCalls += 1;
      scopes.clear();
    },
  };
}

function makeUser(): AuthUser {
  return {
    id: 'user-rt-1',
    tenantId: 'tenant-rt',
    email: 'rt@example.com',
    displayName: 'RT User',
    role: 'member',
    ipAddress: '127.0.0.1',
  };
}

function makePolicy(): TenantPolicyRow {
  return {
    tenant_id: 'tenant-rt',
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

function makeFolder(id: string): FolderSummary {
  return {
    id,
    parent_id: null,
    name: `Folder ${id}`,
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-11-15T00:00:00.000Z',
    effectiveRole: 'editor',
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('computeReconnectDelayMs applies bounded exponential backoff with jitter', () => {
  assert.equal(computeReconnectDelayMs(0, 1000, 30_000, () => 0.5), 1000);
  assert.equal(computeReconnectDelayMs(1, 1000, 30_000, () => 0.5), 2000);
  assert.equal(computeReconnectDelayMs(2, 1000, 30_000, () => 0.5), 4000);
  assert.equal(computeReconnectDelayMs(5, 1000, 30_000, () => 1.0), 30_000);
  assert.equal(computeReconnectDelayMs(0, 1000, 30_000, () => 0), 850);
});

test('WorkspaceRealtimeClient sends hibernatable ping/pong heartbeat and deduplicates non-security seq', async () => {
  const timers = new FakeTimerHub();
  const sockets: FakeWebSocket[] = [];
  const signals: SyncInvalidationSignal[] = [];
  let catchupCalls = 0;

  const client = new WorkspaceRealtimeClient({
    requestTicket: async () => ({
      ticket: 't1',
      wsUrl: 'ws://127.0.0.1:8787/api/sync/ws?ticket=t1',
      expiresInSeconds: 30,
      expiresAt: '2026-11-15T01:00:00.000Z',
    }),
    createSocket: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    },
    onSignal: (s) => {
      signals.push(s);
    },
    onCatchup: () => {
      catchupCalls += 1;
    },
    heartbeatIntervalMs: 25_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => timers.nowMs,
    random: () => 0.5,
  });

  client.start();
  await flushMicrotasks();
  assert.equal(sockets.length, 1);
  sockets[0].emitOpen();
  assert.equal(client.getState(), 'connected');
  assert.equal(catchupCalls, 0);

  // Hibernatable heartbeat sends raw 'ping' and ignores 'pong'
  timers.advanceBy(25_000);
  assert.deepEqual(sockets[0].sent, ['ping']);
  sockets[0].emitMessage('pong');
  assert.equal(signals.length, 0);

  // Duplicate/older seq is skipped for normal invalidate signals
  sockets[0].emitMessage(
    JSON.stringify({
      type: 'sync.invalidate',
      seq: 10,
      scopeFolderIds: ['f1'],
      eventKind: 'file.update',
      timestamp: '2026-11-15T00:00:01.000Z',
    })
  );
  sockets[0].emitMessage(
    JSON.stringify({
      type: 'sync.invalidate',
      seq: 10,
      scopeFolderIds: ['f1'],
      eventKind: 'file.update',
      timestamp: '2026-11-15T00:00:02.000Z',
    })
  );
  assert.equal(signals.length, 1);

  client.stop();
  assert.equal(client.getState(), 'disconnected');
  assert.equal(timers.pendingCount(), 0);
});

test('WorkspaceRealtimeClient reconnects with backoff, catches up on visibilitychange/online, and stops permanently on 4001 revocation', async () => {
  const timers = new FakeTimerHub();
  const sockets: FakeWebSocket[] = [];
  const signals: SyncInvalidationSignal[] = [];
  const docListeners = new Map<string, () => void>();
  const winListeners = new Map<string, () => void>();
  let ticketCalls = 0;
  let catchups = 0;
  let visibility = 'hidden';

  const client = new WorkspaceRealtimeClient({
    requestTicket: async () => {
      ticketCalls += 1;
      return {
        ticket: `t-${ticketCalls}`,
        wsUrl: `ws://127.0.0.1:8787/api/sync/ws?ticket=t-${ticketCalls}`,
        expiresInSeconds: 30,
        expiresAt: '2026-11-15T01:00:00.000Z',
      };
    },
    createSocket: () => {
      const ws = new FakeWebSocket();
      sockets.push(ws);
      return ws;
    },
    onSignal: (s) => {
      signals.push(s);
    },
    onCatchup: () => {
      catchups += 1;
    },
    baseReconnectDelayMs: 1000,
    maxReconnectDelayMs: 8000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: () => timers.nowMs,
    random: () => 0.5,
    addDocumentListener: (type, fn) => {
      docListeners.set(type, fn);
      return () => docListeners.delete(type);
    },
    addWindowListener: (type, fn) => {
      winListeners.set(type, fn);
      return () => winListeners.delete(type);
    },
    getVisibilityState: () => visibility,
    isOnline: () => true,
  });

  client.start();
  await flushMicrotasks();
  sockets[0].emitOpen();
  sockets[0].emitClose(1006, 'network_drop');

  // Reconnect attempt 0 waits 1000ms
  timers.advanceBy(999);
  assert.equal(ticketCalls, 1);
  timers.advanceBy(1);
  await flushMicrotasks();
  assert.equal(ticketCalls, 2);
  assert.equal(sockets.length, 2);

  // Drop again before open -> attempt 1 waits 2000ms; visibilitychange wakes up early + triggers catchup
  sockets[1].emitClose(1006, 'network_drop');
  visibility = 'visible';
  docListeners.get('visibilitychange')?.();
  await flushMicrotasks();
  assert.equal(catchups, 1);
  assert.equal(ticketCalls, 3);

  sockets[2].emitOpen();
  await flushMicrotasks();
  // Re-open triggers catchup automatically
  assert.equal(catchups, 2);

  // Online event triggers immediate delta catchup even while connected
  winListeners.get('online')?.();
  assert.equal(catchups, 3);

  // Security revocation close (4001) emits synthetic user.suspended and NEVER schedules reconnect
  sockets[2].emitClose(4001, 'Session revoked');
  await flushMicrotasks();
  assert.equal(client.isRevoked(), true);
  assert.equal(signals.at(-1)?.eventKind, 'user.suspended');
  assert.equal(timers.pendingCount(), 0);

  timers.advanceBy(60_000);
  await flushMicrotasks();
  assert.equal(ticketCalls, 3);

  client.stop();
});

test('WorkspaceSyncStore handles real-time invalidation, skips stale delta fetches, and purges caches on user.suspended / permission.revoke', async () => {
  const persistence = createMemoryPersistence();
  let scopeHint: SyncScopeHint | null = null;
  let deltaFetches = 0;
  let deltaResponse: SyncDeltaResponse = {
    resetRequired: false,
    currentSeq: 20,
    purgedBeforeSeq: 0,
    nextSeq: 20,
    hasMore: false,
    changes: [],
  };

  let injectedHandlers: {
    onSignal: (signal: SyncInvalidationSignal) => void | Promise<void>;
    onCatchup: () => void | Promise<void>;
    onStateChange: (state: 'disconnected' | 'connecting' | 'connected') => void;
  } | null = null;
  let stopCount = 0;

  const store = new WorkspaceSyncStore({
    persistence,
    readScopeHint: () => scopeHint,
    writeScopeHint: (u) => {
      scopeHint = u
        ? {
            tenantId: u.tenantId,
            userId: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
          }
        : null;
    },
    fetchBootstrap: async (): Promise<BootstrapResponse> => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [makeFolder('f1')],
      pinnedFolders: [],
      currentSeq: 20,
      purgedBeforeSeq: 0,
    }),
    fetchDelta: async (): Promise<SyncDeltaResponse> => {
      deltaFetches += 1;
      return deltaResponse;
    },
    fetchFolderChildren: async (folderId): Promise<FolderChildrenResponse> => ({
      folder: makeFolder(folderId),
      effectiveRole: 'editor',
      folders: [],
      files: [],
      nextCursor: null,
      breadcrumbs: [],
    }),
    createRealtimeClient: (handlers) => {
      injectedHandlers = handlers;
      return {
        start: () => handlers.onStateChange('connected'),
        stop: () => {
          stopCount += 1;
          handlers.onStateChange('disconnected');
        },
      };
    },
  });

  const revocations: RealtimeSecurityRevocationEvent[] = [];
  const signalsSeen: SyncInvalidationSignal[] = [];
  store.subscribeSecurityRevocations((ev) => revocations.push(ev));
  store.subscribeRealtimeSignals((sig) => signalsSeen.push(sig));

  await store.bootstrap();
  assert.equal(store.getSnapshot().realtimeState, 'connected');
  assert.ok(injectedHandlers);

  await store.ensureDirectoryLoaded('f1');
  store.setActiveFolder('f1');

  // Redundant seq <= syncSeq (20) on an unaffected folder skips unnecessary delta fetch
  await store.handleRealtimeSignal({
    type: 'sync.invalidate',
    seq: 20,
    scopeFolderIds: ['other-folder'],
    eventKind: 'file.update',
    timestamp: '2026-11-15T00:00:01.000Z',
  });
  assert.equal(deltaFetches, 0);
  assert.equal(signalsSeen.length, 1);

  // Higher seq marks scoped folder stale and fetches delta
  deltaResponse = {
    resetRequired: false,
    currentSeq: 21,
    purgedBeforeSeq: 0,
    nextSeq: 21,
    hasMore: false,
    changes: [],
  };
  await store.handleRealtimeSignal({
    type: 'sync.invalidate',
    seq: 21,
    scopeFolderIds: ['f1'],
    eventKind: 'file.upload_complete',
    timestamp: '2026-11-15T00:00:02.000Z',
  });
  assert.equal(deltaFetches, 1);
  assert.equal(store.getSnapshot().syncSeq, 21);

  // permission.revoke emits security revocation event to close preview modals & syncs delta
  await store.handleRealtimeSignal({
    type: 'sync.invalidate',
    seq: 22,
    scopeFolderIds: ['f1'],
    eventKind: 'permission.revoke',
    revoked: true,
    timestamp: '2026-11-15T00:00:03.000Z',
  });
  assert.equal(revocations.at(-1)?.kind, 'permission.revoke');
  assert.equal(deltaFetches, 2);

  // user.suspended immediately emits security revocation, stops WS, and purges IndexedDB + scope
  await store.handleRealtimeSignal({
    type: 'sync.security_revoke',
    seq: 23,
    scopeFolderIds: [],
    eventKind: 'user.suspended',
    revoked: true,
    timestamp: '2026-11-15T00:00:04.000Z',
  });
  assert.equal(revocations.at(-1)?.kind, 'user.suspended');
  assert.equal(store.getSnapshot().authStatus, 'unauthenticated');
  assert.equal(store.getSnapshot().user, null);
  assert.equal(store.getSnapshot().realtimeState, 'disconnected');
  assert.ok(stopCount >= 1);
  assert.ok(persistence.purgeAllCalls >= 1);
  assert.equal(scopeHint, null);
});

test('IntentPrefetcher.warmPdfPreviewRuntime only runs static chunk warm once and never touches /content-url', () => {
  let warmCalls = 0;
  let folderLoads = 0;
  const prefetcher = new IntentPrefetcher(
    {
      isDirectoryFresh: () => false,
      ensureDirectoryLoaded: async () => {
        folderLoads += 1;
      },
    },
    {
      warmPdfFn: () => {
        warmCalls += 1;
      },
    }
  );

  prefetcher.warmPdfPreviewRuntime();
  prefetcher.warmPdfPreviewRuntime();
  assert.equal(warmCalls, 1);
  assert.equal(folderLoads, 0);
});
