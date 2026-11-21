import { adminSessionRevocationMessage } from '@/lib/admin-sessions';
import type { getWorkspaceJob } from '@/lib/files-api';
import type { MutationOutbox } from '@/lib/mutation-outbox';
import type {
  SessionErrorInfo,
  SyncAuthStatus,
  SyncStoreCollections,
  SyncStoreMutableState,
  SyncStoreRuntimeFns,
} from '@/lib/sync-store/types';
import type { RealtimeSecurityRevocationEvent } from '@/lib/sync-ws';
import type { AuthUser, BootstrapResponse, WorkspaceToastItem } from '@/types/files';

const GUEST_SESSION_ERROR_CODES = new Set([
  'GUEST_ACCOUNT_EXPIRED',
  'GUEST_ACCOUNT_SUSPENDED',
  'GUEST_ACCOUNT_INACTIVE',
  'SESSION_EXPIRED_OR_REVOKED',
  'INVITATION_REVOKED',
  'INVITATION_EXPIRED',
  'INVITATION_NOT_ACCEPTED',
  'EXTERNAL_COLLABORATORS_DISABLED',
  'EXTERNAL_DOMAIN_NOT_ALLOWED',
]);

export function buildSessionErrorFromError(
  err: unknown,
  currentUser: AuthUser | null
): SessionErrorInfo | null {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : 0;
  if (status !== 401 && status !== 403) return null;

  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code ?? '')
      : '';
  if (status === 403 && !GUEST_SESSION_ERROR_CODES.has(code)) return null;

  const message =
    err instanceof Error ? err.message : 'セッションが失効しました';
  const inferredGuest =
    code.startsWith('GUEST_') ||
    code.startsWith('INVITATION_') ||
    code === 'EXTERNAL_COLLABORATORS_DISABLED' ||
    code === 'EXTERNAL_DOMAIN_NOT_ALLOWED';

  return {
    status,
    ...(code ? { code } : {}),
    message,
    userType: currentUser?.userType ?? (inferredGuest ? 'guest' : null),
  };
}

export function buildSessionErrorFromRevocation(
  event: RealtimeSecurityRevocationEvent,
  currentUser: AuthUser | null
): SessionErrorInfo | null {
  if (
    event.kind !== 'session.revoked' &&
    event.kind !== 'tenant.sessions_revoked'
  ) {
    return null;
  }
  return {
    status: 401,
    code: 'SESSION_REVOKED_BY_ADMIN',
    message: adminSessionRevocationMessage(event.kind),
    userType: currentUser?.userType ?? 'member',
  };
}

export interface SessionLifecycleContext {
  state: SyncStoreMutableState;
  collections: SyncStoreCollections;
  fns: SyncStoreRuntimeFns;
  outbox: MutationOutbox;
  emit: () => void;
  resetMemoryOnly: () => void;
  stopRealtime: () => void;
  clearToastsAndUndo: () => void;
  bootstrap: (options?: { force?: boolean }) => Promise<BootstrapResponse | null>;
}

export async function hydrateScopeFromHint(
  ctx: SessionLifecycleContext
): Promise<boolean> {
  const hint = ctx.fns.readHintFn();
  if (!hint) return false;
  const scopeKey = `${hint.tenantId}:${hint.userId}`;
  if (ctx.state.hydratedScopeKey === scopeKey && ctx.state.user) {
    return true;
  }
  if (ctx.state.hydratePromise) return ctx.state.hydratePromise;

  ctx.state.hydratePromise = (async () => {
    const snapshot = await ctx.fns.persistence.loadScope(hint.tenantId, hint.userId);
    if (!snapshot) return false;

    // Guard against race if session was revoked or changed while IDB opened
    if (ctx.state.authStatus === 'unauthenticated') return false;
    if (ctx.state.sessionError) return false;
    if (
      ctx.state.user &&
      (ctx.state.user.id !== snapshot.meta.user.id ||
        ctx.state.user.tenantId !== snapshot.meta.user.tenantId)
    ) {
      return false;
    }

    ctx.resetMemoryOnly();
    ctx.state.user = snapshot.meta.user;
    ctx.state.authStatus = 'authenticated';
    ctx.state.policy = snapshot.meta.policy;
    ctx.state.syncSeq = snapshot.meta.syncSeq;
    ctx.state.purgedBeforeSeq = snapshot.meta.purgedBeforeSeq;
    ctx.state.rootFolderIds = snapshot.meta.rootFolderIds;
    ctx.state.rootNextCursor = snapshot.meta.rootNextCursor;
    ctx.state.pinnedFolderIds = snapshot.meta.pinnedFolderIds;
    ctx.state.hydratedScopeKey = scopeKey;

    for (const folder of snapshot.folders) {
      ctx.collections.foldersById.set(folder.id, folder);
    }
    for (const file of snapshot.files) {
      ctx.collections.filesById.set(file.id, file);
    }
    for (const dir of snapshot.directories) {
      ctx.collections.directoriesByKey.set(dir.dirKey, dir);
    }

    ctx.emit();
    return true;
  })().finally(() => {
    ctx.state.hydratePromise = null;
  });

  return ctx.state.hydratePromise;
}

export async function adoptAuthenticatedUserSession(
  ctx: SessionLifecycleContext,
  nextUser: AuthUser
): Promise<void> {
  const previous = ctx.state.user;
  ctx.state.sessionError = null;
  if (
    previous &&
    (previous.id !== nextUser.id || previous.tenantId !== nextUser.tenantId)
  ) {
    ctx.stopRealtime();
    await ctx.fns.persistence.purgeScope(previous.tenantId, previous.id);
    ctx.resetMemoryOnly();
  }
  ctx.state.user = nextUser;
  ctx.state.authStatus = 'authenticated';
  ctx.state.hydratedScopeKey = `${nextUser.tenantId}:${nextUser.id}`;
  ctx.fns.writeHintFn(nextUser);
  ctx.emit();
  await ctx.bootstrap({ force: true });
}

export async function purgeCurrentScopeSession(
  ctx: SessionLifecycleContext
): Promise<void> {
  ctx.stopRealtime();
  if (ctx.state.persistTimer) {
    clearTimeout(ctx.state.persistTimer);
    ctx.state.persistTimer = null;
  }

  ctx.outbox.clearAll();
  ctx.clearToastsAndUndo();
  ctx.collections.idAliasMap.clear();
  ctx.state.outboxLoadedScopeKey = null;

  const curUser = ctx.state.user;
  const hint = ctx.fns.readHintFn();
  ctx.resetMemoryOnly();
  ctx.state.authStatus = 'unauthenticated';
  ctx.state.bootstrapDone = true;
  ctx.fns.writeHintFn(null);
  ctx.emit();

  const tasks: Array<Promise<void>> = [ctx.fns.persistence.purgeAllScopes()];
  if (curUser) {
    tasks.push(ctx.fns.persistence.purgeScope(curUser.tenantId, curUser.id));
  }
  if (hint) {
    tasks.push(ctx.fns.persistence.purgeScope(hint.tenantId, hint.userId));
  }
  await Promise.allSettled(tasks);
}

export interface AsyncCopyJobPollContext {
  getAuthStatus: () => SyncAuthStatus;
  getWorkspaceJobFn: typeof getWorkspaceJob;
  jobPollTimers: Set<ReturnType<typeof setTimeout>>;
  pushToast: (toast: Omit<WorkspaceToastItem, 'id'>, ttlMs?: number) => string;
  ensureDirectoryLoadedForce: (folderId: string | null) => void;
  syncDelta: () => void;
}

export function scheduleAsyncCopyJobPoll(
  ctx: AsyncCopyJobPollContext,
  jobId: string,
  refreshFolderIds: Array<string | null>,
  totalItems: number,
  attempt = 0
): void {
  if (attempt === 0) {
    ctx.pushToast({
      kind: 'info',
      message: `大容量フォルダ（${totalItems} 件）をバックグラウンドでコピー中...`,
    });
  }
  if (attempt >= 45 || ctx.getAuthStatus() !== 'authenticated') {
    return;
  }
  const timer = setTimeout(async () => {
    ctx.jobPollTimers.delete(timer);
    if (ctx.getAuthStatus() !== 'authenticated') return;
    try {
      const res = await ctx.getWorkspaceJobFn(jobId);
      if (res.job.status === 'completed') {
        ctx.pushToast({
          kind: 'info',
          message: `${res.job.processedItems} 件のバックグラウンドコピーが完了しました`,
        });
        for (const dirId of refreshFolderIds) {
          ctx.ensureDirectoryLoadedForce(dirId);
        }
        ctx.syncDelta();
        return;
      }
      if (res.job.status === 'failed') {
        ctx.pushToast({
          kind: 'error',
          message: res.job.errorMessage ?? 'バックグラウンドコピーに失敗しました',
        });
        return;
      }
      scheduleAsyncCopyJobPoll(
        ctx,
        jobId,
        refreshFolderIds,
        totalItems,
        attempt + 1
      );
    } catch {
      scheduleAsyncCopyJobPoll(
        ctx,
        jobId,
        refreshFolderIds,
        totalItems,
        attempt + 1
      );
    }
  }, 600);
  ctx.jobPollTimers.add(timer);
}
