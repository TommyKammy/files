import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import {
  normalizeSecurityRevocationEvent,
  type RealtimeConnectionState,
  type RealtimeSecurityRevocationEvent,
  WorkspaceRealtimeClient,
} from '@/lib/sync-ws';
import type {
  AuthUser,
  FolderSummary,
  SyncInvalidationSignal,
} from '@/types/files';

export interface RealtimeContext {
  authStatus: 'unknown' | 'authenticated' | 'unauthenticated';
  user: AuthUser | null;
  enableRealtimeOption?: boolean;
  createRealtimeClientFn?: (handlers: {
    onSignal: (signal: SyncInvalidationSignal) => void | Promise<void>;
    onCatchup: () => void | Promise<void>;
    onStateChange: (state: RealtimeConnectionState) => void;
  }) => { start: () => void; stop: () => void };
  realtimeClient: { start: () => void; stop: () => void } | null;
  realtimeState: RealtimeConnectionState;
  emit: () => void;
  setRealtimeClient: (
    client: { start: () => void; stop: () => void } | null
  ) => void;
  setRealtimeState: (state: RealtimeConnectionState) => void;
  realtimeSignalListeners: Set<(signal: SyncInvalidationSignal) => void>;
  securityRevocationListeners: Set<
    (event: RealtimeSecurityRevocationEvent) => void
  >;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  foldersById: Map<string, FolderSummary>;
  activeDirKey: string;
  syncSeq: number;
  syncDelta: () => Promise<void>;
  purgeCurrentScope: () => Promise<void>;
  invalidateAllCachedDirectories: () => void;
}

export function startRealtime(ctx: RealtimeContext): void {
  if (ctx.authStatus !== 'authenticated' || !ctx.user) return;
  if (ctx.enableRealtimeOption === false) return;
  const hasNativeWs =
    typeof window !== 'undefined' && typeof WebSocket !== 'undefined';
  if (!ctx.createRealtimeClientFn && !hasNativeWs) return;

  if (!ctx.realtimeClient) {
    const onSignal = (signal: SyncInvalidationSignal) =>
      handleRealtimeSignal(signal, ctx);
    const onCatchup = () => ctx.syncDelta();
    const onStateChange = (state: RealtimeConnectionState) => {
      if (ctx.realtimeState !== state) {
        ctx.setRealtimeState(state);
        ctx.emit();
      }
    };

    ctx.setRealtimeClient(
      ctx.createRealtimeClientFn
        ? ctx.createRealtimeClientFn({ onSignal, onCatchup, onStateChange })
        : new WorkspaceRealtimeClient({ onSignal, onCatchup, onStateChange })
    );
  }

  ctx.realtimeClient?.start();
}

export function stopRealtime(ctx: RealtimeContext): void {
  if (ctx.realtimeClient) {
    ctx.realtimeClient.stop();
  }
  if (ctx.realtimeState !== 'disconnected') {
    ctx.setRealtimeState('disconnected');
  }
}

export async function handleRealtimeSignal(
  signal: SyncInvalidationSignal,
  ctx: RealtimeContext
): Promise<void> {
  if (ctx.authStatus !== 'authenticated' || !ctx.user) return;

  for (const listener of ctx.realtimeSignalListeners) {
    listener(signal);
  }

  const revocation = normalizeSecurityRevocationEvent(signal);
  if (revocation?.kind === 'user.suspended') {
    emitSecurityRevocation(revocation, ctx);
    await ctx.purgeCurrentScope();
    return;
  }

  if (revocation) {
    emitSecurityRevocation(revocation, ctx);
    markScopeFoldersStale(
      signal.scopeFolderIds,
      revocation.kind === 'permission.revoke',
      ctx
    );
    await ctx.syncDelta();
    return;
  }

  markScopeFoldersStale(signal.scopeFolderIds, false, ctx);
  const activeStale = Boolean(
    ctx.directoriesByKey.get(ctx.activeDirKey)?.stale
  );
  if (signal.seq === null || signal.seq > ctx.syncSeq || activeStale) {
    await ctx.syncDelta();
  } else {
    ctx.emit();
  }
}

function emitSecurityRevocation(
  event: RealtimeSecurityRevocationEvent,
  ctx: RealtimeContext
): void {
  for (const listener of ctx.securityRevocationListeners) {
    listener(event);
  }
}

function markScopeFoldersStale(
  scopeFolderIds: readonly string[],
  markAllOnEmpty: boolean,
  ctx: RealtimeContext
): void {
  if (scopeFolderIds.length === 0) {
    if (markAllOnEmpty) {
      ctx.invalidateAllCachedDirectories();
    }
    return;
  }

  for (const folderId of scopeFolderIds) {
    const dir = ctx.directoriesByKey.get(folderId);
    if (dir) {
      dir.stale = true;
    }
    const folder = ctx.foldersById.get(folderId);
    if (folder) {
      const parentDir = ctx.directoriesByKey.get(folder.parent_id ?? '__ROOT__');
      if (parentDir) {
        parentDir.stale = true;
      }
    }
  }
}
