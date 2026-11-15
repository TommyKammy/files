import type { SyncPublishRequest } from '../durable-objects/tenant-sync-hub';
import type { OidcEnv } from '../types/oidc';

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface NotificationExecutionContext {
  env: Pick<OidcEnv, 'SYNC_HUB'>;
  executionCtx?: WaitUntilContext;
}

export function extractLastSyncSeq(results: ReadonlyArray<D1Result>): number | null {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const rowId = results[i]?.meta?.last_row_id;
    if (typeof rowId === 'number' && Number.isFinite(rowId) && rowId > 0) {
      return rowId;
    }
  }
  return null;
}

export async function notifyTenantSyncHub(
  env: Pick<OidcEnv, 'SYNC_HUB'>,
  input: SyncPublishRequest
): Promise<{ skipped: boolean; recipientCount: number }> {
  if (!env.SYNC_HUB || !input.tenantId) {
    return { skipped: true, recipientCount: 0 };
  }

  try {
    const id = env.SYNC_HUB.idFromName(input.tenantId);
    const stub = env.SYNC_HUB.get(id);
    return await stub.publishSignal(input);
  } catch (err) {
    console.warn('[sync-notifier] Failed to notify TenantSyncHub:', err);
    return { skipped: true, recipientCount: 0 };
  }
}

export function tryGetExecutionContext(c: {
  executionCtx: WaitUntilContext;
}): WaitUntilContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * Fires TenantSyncHub invalidation without adding DO RPC latency to Worker HTTP responses
 * when an ExecutionContext is available, while awaiting cleanly in direct Hono `app.fetch()` tests.
 */
export async function emitTenantSyncSignal(
  ctxHolder: NotificationExecutionContext,
  input: SyncPublishRequest
): Promise<void> {
  if (!ctxHolder.env.SYNC_HUB) return;

  let executionCtx: WaitUntilContext | undefined;
  try {
    executionCtx = ctxHolder.executionCtx;
  } catch {
    executionCtx = undefined;
  }

  const promise = notifyTenantSyncHub(ctxHolder.env, input);
  if (executionCtx && typeof executionCtx.waitUntil === 'function') {
    executionCtx.waitUntil(promise);
    return;
  }
  await promise;
}
