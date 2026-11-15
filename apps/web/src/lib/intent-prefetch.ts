import type { WorkspaceSyncStore } from '@/lib/sync-store';

export const HOVER_PREFETCH_DELAY_MS = 80;
export const CURSOR_PREFETCH_DELAY_MS = 120;
export const PREFETCH_FRESH_TTL_MS = 30_000;
export const MAX_CONCURRENT_PREFETCH = 2;

interface ActivePrefetch {
  folderId: string;
  controller: AbortController;
  startedAt: number;
}

/**
 * Budgeted intent prefetcher protecting Workers/D1 quotas and audit log integrity:
 * - Only prefetches folder `children + breadcrumbs` after hover (80ms) or cursor dwell (120ms)
 * - Caps concurrency to 2 in-flight requests and respects 30s freshness TTL
 * - STRICTLY EXCLUDES `/api/files/:id/content-url` so hover/cursor never emits false `file.preview` audit logs
 */
export class IntentPrefetcher {
  private readonly store: Pick<
    WorkspaceSyncStore,
    'isDirectoryFresh' | 'ensureDirectoryLoaded'
  >;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Map<string, ActivePrefetch>();
  private pdfWorkerWarmed = false;
  private readonly warmPdfFn?: () => void;

  constructor(
    store: Pick<WorkspaceSyncStore, 'isDirectoryFresh' | 'ensureDirectoryLoaded'>,
    options?: { warmPdfFn?: () => void }
  ) {
    this.store = store;
    this.warmPdfFn = options?.warmPdfFn;
  }

  scheduleHoverPrefetch(folderId: string): void {
    this.schedule(folderId, HOVER_PREFETCH_DELAY_MS);
  }

  scheduleCursorPrefetch(folderId: string): void {
    this.schedule(folderId, CURSOR_PREFETCH_DELAY_MS);
  }

  /** Warm only the static `pdfjs-dist` worker chunk on PDF hover — NEVER call `/content-url`. */
  warmPdfPreviewRuntime(): void {
    if (this.pdfWorkerWarmed) return;
    this.pdfWorkerWarmed = true;
    if (this.warmPdfFn) {
      this.warmPdfFn();
      return;
    }
    if (typeof window === 'undefined') return;
    void import('pdfjs-dist').catch(() => undefined);
  }

  cancel(folderId?: string): void {
    if (folderId) {
      const timer = this.timers.get(folderId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(folderId);
      }
      const req = this.inFlight.get(folderId);
      if (req) {
        req.controller.abort();
        this.inFlight.delete(folderId);
      }
      return;
    }

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const req of this.inFlight.values()) {
      req.controller.abort();
    }
    this.inFlight.clear();
  }

  getInFlightCount(): number {
    return this.inFlight.size;
  }

  private schedule(folderId: string, delayMs: number): void {
    if (!folderId) return;
    if (this.inFlight.has(folderId)) return;
    if (this.store.isDirectoryFresh(folderId, PREFETCH_FRESH_TTL_MS)) return;

    const existing = this.timers.get(folderId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.timers.delete(folderId);
      void this.executePrefetch(folderId);
    }, delayMs);

    this.timers.set(folderId, timer);
  }

  private async executePrefetch(folderId: string): Promise<void> {
    if (this.inFlight.has(folderId)) return;
    if (this.store.isDirectoryFresh(folderId, PREFETCH_FRESH_TTL_MS)) return;

    // Evict oldest active prefetch if at concurrency cap
    while (this.inFlight.size >= MAX_CONCURRENT_PREFETCH) {
      let oldest: ActivePrefetch | null = null;
      for (const item of this.inFlight.values()) {
        if (!oldest || item.startedAt < oldest.startedAt) {
          oldest = item;
        }
      }
      if (!oldest) break;
      oldest.controller.abort();
      this.inFlight.delete(oldest.folderId);
    }

    const controller = new AbortController();
    const entry: ActivePrefetch = {
      folderId,
      controller,
      startedAt: Date.now(),
    };
    this.inFlight.set(folderId, entry);

    try {
      await this.store.ensureDirectoryLoaded(folderId, {
        signal: controller.signal,
        isPrefetch: true,
      });
    } catch {
      // ignore cancelled/transient prefetch errors
    } finally {
      if (this.inFlight.get(folderId) === entry) {
        this.inFlight.delete(folderId);
      }
    }
  }
}
