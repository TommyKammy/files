import { ROLE_CAPABILITIES, canAccess } from '@/lib/capabilities';
import { isClassificationFloorViolated } from '@/lib/formatters';
import type {
  Capability,
  ClassificationLabel,
  FileItem,
  FolderSummary,
  OutboxMutationRecord,
  ResourceRole,
} from '@/types/files';

export const OUTBOX_COALESCE_WINDOW_MS = 100;
export const OUTBOX_MAX_RETRIES = 2;

export type GuardrailFailure = {
  ok: false;
  code:
    | 'FORBIDDEN_ROLE'
    | 'CLASSIFICATION_DOWNGRADE_FORBIDDEN'
    | 'NAME_CONFLICT';
  message: string;
};

export type GuardrailResult = { ok: true } | GuardrailFailure;

/**
 * Capability guard for optimistic mutations. The role fallback is expanded
 * through the shared capability matrix, never a linear rank.
 */
export function checkCapabilityGuard(
  effectiveRole: ResourceRole | undefined | null,
  requiredCapability: Capability,
  options?: { isPrivilegedAdmin?: boolean; allowAdminOverride?: boolean }
): GuardrailResult {
  if (options?.allowAdminOverride && options?.isPrivilegedAdmin) {
    return { ok: true };
  }
  if (!canAccess(effectiveRole, requiredCapability)) {
    return {
      ok: false,
      code: 'FORBIDDEN_ROLE',
      message: 'この操作に必要な権限がありません',
    };
  }
  return { ok: true };
}

/**
 * Compatibility helper for call sites that only know a required role.
 * Implemented as capability containment (all capabilities of the required
 * role), so orthogonal roles can never pass via a numeric rank.
 */
export function checkRoleGuard(
  effectiveRole: ResourceRole | undefined | null,
  requiredRole: ResourceRole,
  options?: { isPrivilegedAdmin?: boolean; allowAdminOverride?: boolean }
): GuardrailResult {
  if (options?.allowAdminOverride && options?.isPrivilegedAdmin) {
    return { ok: true };
  }
  for (const capability of ROLE_CAPABILITIES[requiredRole]) {
    if (!canAccess(effectiveRole, capability)) {
      return {
        ok: false,
        code: 'FORBIDDEN_ROLE',
        message: `この操作には ${requiredRole} 以上の権限が必要です`,
      };
    }
  }
  return { ok: true };
}

export function checkClassificationFloorGuard(
  ancestorLabels: ClassificationLabel[],
  targetLabel: ClassificationLabel
): GuardrailResult {
  if (isClassificationFloorViolated(ancestorLabels, targetLabel)) {
    return {
      ok: false,
      code: 'CLASSIFICATION_DOWNGRADE_FORBIDDEN',
      message: 'Confidential (極秘) 親フォルダ配下のため、機密区分を引き下げることはできません',
    };
  }
  return { ok: true };
}

export interface OutboxExecutionResult {
  folder?: FolderSummary;
  file?: FileItem;
  movedFolders?: FolderSummary[];
  movedFiles?: FileItem[];
  copiedFolders?: FolderSummary[];
  copiedFiles?: FileItem[];
  queued?: boolean;
  jobId?: string;
}

export interface OutboxOptions {
  coalesceWindowMs?: number;
  maxRetries?: number;
  retryDelayBaseMs?: number;
  execute: (item: OutboxMutationRecord) => Promise<OutboxExecutionResult | void>;
  onSuccess?: (item: OutboxMutationRecord, result: OutboxExecutionResult | void) => void;
  onRollback?: (
    item: OutboxMutationRecord,
    error: unknown,
    latestFromServer?: FolderSummary | FileItem
  ) => void;
  onQueueChange?: (pendingCount: number, items: OutboxMutationRecord[]) => void;
}

function getErrorStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function getLatestFromError(err: unknown): FolderSummary | FileItem | undefined {
  if (typeof err === 'object' && err !== null && 'details' in err) {
    const details = (err as { details?: Record<string, unknown> }).details;
    if (details && typeof details.latest === 'object' && details.latest !== null) {
      return details.latest as FolderSummary | FileItem;
    }
  }
  return undefined;
}

function entityKeyFor(entityType: 'folder' | 'file', entityId: string): string {
  return `${entityType}:${entityId}`;
}

function getItemEntityKeys(item: OutboxMutationRecord): string[] {
  const keys = new Set<string>([entityKeyFor(item.entityType, item.entityId)]);
  if (Array.isArray(item.involvedEntityKeys)) {
    for (const k of item.involvedEntityKeys) {
      keys.add(k);
    }
  }
  return Array.from(keys);
}

/**
 * Durable, coalescing mutation outbox:
 * - Buffers rapid edits for `100ms` and merges compatible changes on the same entity
 * - Serializes per-entity HTTP execution while carrying forward returned server versions
 * - Immediately rolls back on 403/404/409 conflicts without retry loops
 */
export class MutationOutbox {
  private readonly coalesceWindowMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayBaseMs: number;
  private readonly executeFn: OutboxOptions['execute'];
  private readonly onSuccessFn?: OutboxOptions['onSuccess'];
  private readonly onRollbackFn?: OutboxOptions['onRollback'];
  private readonly onQueueChangeFn?: OutboxOptions['onQueueChange'];

  private queue: OutboxMutationRecord[] = [];
  private readonly activeEntityKeys = new Set<string>();
  private readonly inFlightPromises = new Set<Promise<void>>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly resolvedVersions = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: OutboxOptions) {
    this.coalesceWindowMs = options.coalesceWindowMs ?? OUTBOX_COALESCE_WINDOW_MS;
    this.maxRetries = options.maxRetries ?? OUTBOX_MAX_RETRIES;
    this.retryDelayBaseMs = options.retryDelayBaseMs ?? 400;
    this.executeFn = options.execute;
    this.onSuccessFn = options.onSuccess;
    this.onRollbackFn = options.onRollback;
    this.onQueueChangeFn = options.onQueueChange;
  }

  getPendingCount(): number {
    return this.queue.length + this.inFlightPromises.size;
  }

  getQueuedItems(): OutboxMutationRecord[] {
    return this.queue.map((item) => ({ ...item, payload: { ...item.payload } }));
  }

  /**
   * Records the authoritative server version for an entity, e.g. after a
   * conflict rollback, so subsequent queued mutations target that version.
   */
  setResolvedVersion(
    entityType: 'folder' | 'file',
    entityId: string,
    version: number
  ): void {
    if (!Number.isFinite(version)) return;
    this.resolvedVersions.set(entityKeyFor(entityType, entityId), version);
  }

  enqueue(next: OutboxMutationRecord): void {
    this.disposed = false;
    const coalesced = this.tryCoalesceIntoQueue(next);
    if (!coalesced) {
    this.queue.push(next);
    }
    this.notifyQueueChange();
    this.scheduleFlush();
  }

  cancelQueuedMutation(mutationId: string): boolean {
    const idx = this.queue.findIndex((item) => item.id === mutationId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    this.notifyQueueChange();
    return true;
  }

  restorePersistedItems(items: OutboxMutationRecord[]): void {
    if (items.length === 0) return;
    this.disposed = false;
    const existingIds = new Set(this.queue.map((q) => q.id));
    for (const item of items) {
      if (!existingIds.has(item.id)) {
        this.queue.push(item);
      }
    }
    this.notifyQueueChange();
    this.scheduleFlush();
  }

  clearAll(): void {
    this.disposed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.queue = [];
    this.activeEntityKeys.clear();
    this.resolvedVersions.clear();
    this.notifyQueueChange();
  }

  async flushAll(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.drainReadyItems();
    while (this.inFlightPromises.size > 0 || this.queue.length > 0) {
      if (this.inFlightPromises.size > 0) {
        await Promise.allSettled(Array.from(this.inFlightPromises));
      }
      if (this.disposed) break;
      this.drainReadyItems();
      if (this.inFlightPromises.size === 0 && this.queue.length > 0) {
        break;
      }
    }
  }

  private tryCoalesceIntoQueue(incoming: OutboxMutationRecord): boolean {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const existing = this.queue[i];
      if (
        existing.entityType !== incoming.entityType ||
        existing.entityId !== incoming.entityId
      ) {
        continue;
      }

      if (existing.kind === 'folder.create' && incoming.kind === 'folder.patch') {
        existing.payload = { ...existing.payload, ...incoming.payload };
        return true;
      }

      if (existing.kind === 'folder.create' && incoming.kind === 'folder.soft_delete') {
        this.queue.splice(i, 1);
        return true;
      }

      if (existing.kind === 'folder.patch' && incoming.kind === 'folder.patch') {
        existing.payload = { ...existing.payload, ...incoming.payload };
        return true;
      }

      if (existing.kind === 'file.patch' && incoming.kind === 'file.patch') {
        existing.payload = { ...existing.payload, ...incoming.payload };
        return true;
      }

      if (
        existing.kind === 'file.classification' &&
        incoming.kind === 'file.classification'
      ) {
        existing.payload = { ...incoming.payload };
        return true;
      }
    }
    return false;
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.drainReadyItems();
    }, this.coalesceWindowMs);
  }

  private drainReadyItems(): void {
    if (this.disposed) return;

    const remaining: OutboxMutationRecord[] = [];
    for (const item of this.queue) {
      const keys = getItemEntityKeys(item);
      if (keys.some((k) => this.activeEntityKeys.has(k))) {
        remaining.push(item);
        continue;
      }

      for (const k of keys) {
        this.activeEntityKeys.add(k);
      }
      const primaryKey = entityKeyFor(item.entityType, item.entityId);
      const knownVersion = this.resolvedVersions.get(primaryKey);
      if (knownVersion !== undefined) {
        item.expectedVersion = knownVersion;
      }

      const task = this.runSingleItem(primaryKey, item).finally(() => {
        this.inFlightPromises.delete(task);
        for (const k of keys) {
          this.activeEntityKeys.delete(k);
        }
        this.notifyQueueChange();
        if (!this.disposed && this.queue.length > 0) {
          this.drainReadyItems();
        }
      });
      this.inFlightPromises.add(task);
    }

    this.queue = remaining;
    this.notifyQueueChange();
  }

  private async runSingleItem(
    key: string,
    item: OutboxMutationRecord
  ): Promise<void> {
    try {
      const result = await this.executeFn(item);
      if (this.disposed) return;

      if (result?.folder) {
        this.resolvedVersions.set(
          entityKeyFor('folder', result.folder.id),
          result.folder.version
        );
      } else if (result?.file?.meta_version !== undefined) {
        this.resolvedVersions.set(
          entityKeyFor('file', result.file.id),
          result.file.meta_version
        );
      }
      if (result?.movedFolders) {
        for (const f of result.movedFolders) {
          this.resolvedVersions.set(entityKeyFor('folder', f.id), f.version);
        }
      }
      if (result?.movedFiles) {
        for (const fl of result.movedFiles) {
          if (fl.meta_version !== undefined) {
            this.resolvedVersions.set(entityKeyFor('file', fl.id), fl.meta_version);
          }
        }
      }
      if (result?.copiedFolders) {
        for (const f of result.copiedFolders) {
          this.resolvedVersions.set(entityKeyFor('folder', f.id), f.version);
        }
      }
      if (result?.copiedFiles) {
        for (const fl of result.copiedFiles) {
          if (fl.meta_version !== undefined) {
            this.resolvedVersions.set(entityKeyFor('file', fl.id), fl.meta_version);
          }
        }
      }

      this.onSuccessFn?.(item, result);
    } catch (err) {
      if (this.disposed) return;
      const status = getErrorStatus(err);

      // 401 session revocation is purged globally by apiFetch
      if (status === 401) {
        this.clearAll();
        return;
      }

      const isTransient = status === undefined || status === 0 || status >= 500;
      if (isTransient && item.retryCount < this.maxRetries) {
        const delayMs = this.retryDelayBaseMs * (item.retryCount + 1);
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          if (this.disposed) return;
          this.queue.unshift({
            ...item,
            retryCount: item.retryCount + 1,
          });
          this.notifyQueueChange();
          this.drainReadyItems();
        }, delayMs);
        this.retryTimers.add(timer);
        return;
      }

      const latest = status === 409 ? getLatestFromError(err) : undefined;
      this.onRollbackFn?.(item, err, latest);
    }
  }

  private notifyQueueChange(): void {
    this.onQueueChangeFn?.(this.getPendingCount(), this.queue);
  }
}

export interface AdminAiBatchItem {
  fileId: string;
  label?: Exclude<ClassificationLabel, 'unset'>;
}

/**
 * 100ms coalescing batcher for admin AI suggestion approvals/overrides.
 * Rapid sequential clicks compress into one `POST /api/admin/ai-suggestions/bulk-approve`.
 */
export class AdminAiBatchCoalescer {
  private readonly windowMs: number;
  private readonly submitFn: (items: AdminAiBatchItem[]) => Promise<void>;
  private readonly onErrorFn: (items: AdminAiBatchItem[], err: unknown) => void;
  private pending = new Map<string, AdminAiBatchItem>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    windowMs?: number;
    submit: (items: AdminAiBatchItem[]) => Promise<void>;
    onError: (items: AdminAiBatchItem[], err: unknown) => void;
  }) {
    this.windowMs = options.windowMs ?? OUTBOX_COALESCE_WINDOW_MS;
    this.submitFn = options.submit;
    this.onErrorFn = options.onError;
  }

  enqueue(items: AdminAiBatchItem[]): void {
    for (const item of items) {
      this.pending.set(item.fileId, item);
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.windowMs);
    }
  }

  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const items = Array.from(this.pending.values());
    this.pending.clear();
    if (items.length === 0) return;

    // Respect backend MAX_BULK_APPROVE_ITEMS = 50 per request
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50);
      try {
        await this.submitFn(chunk);
      } catch (err) {
        this.onErrorFn(chunk, err);
      }
    }
  }
}
