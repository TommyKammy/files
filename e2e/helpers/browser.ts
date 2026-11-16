import { randomUUID } from 'node:crypto';
import type { BrowserContext, Page } from '@playwright/test';

interface RealtimeProbeEntry {
  url: string;
  state: number;
}

/**
 * Installs a tiny WebSocket registry before any app code runs. The workspace
 * store is a module singleton, so E2E must observe the actual socket lifecycle
 * instead of guessing with sleeps.
 */
export async function installRealtimeProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type ProbeWindow = Window & {
      __e2eRealtimeProbe?: RealtimeProbeEntry[];
      __e2eRealtimeProbeInstalled?: boolean;
      WebSocket: typeof WebSocket;
    };
    interface RealtimeProbeEntry {
      url: string;
      state: number;
    }

    const probeWindow = window as ProbeWindow;
    if (probeWindow.__e2eRealtimeProbeInstalled) return;

    const NativeWebSocket = probeWindow.WebSocket;
    const records: RealtimeProbeEntry[] = [];
    probeWindow.__e2eRealtimeProbe = records;

    const WrappedWebSocket = function (
      url: string | URL,
      protocols?: string | string[]
    ) {
      const socket = new NativeWebSocket(url, protocols);
      const record: RealtimeProbeEntry = {
        url: String(url),
        state: socket.readyState,
      };
      records.push(record);
      socket.addEventListener('open', () => {
        record.state = 1;
      });
      socket.addEventListener('error', () => {
        record.state = 2;
      });
      socket.addEventListener('close', () => {
        record.state = 3;
      });
      return socket;
    } as unknown as typeof WebSocket;

    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
    Object.defineProperty(probeWindow, 'WebSocket', {
      configurable: true,
      writable: true,
      value: WrappedWebSocket,
    });
    probeWindow.__e2eRealtimeProbeInstalled = true;
  });
}

/**
 * Waits until the page has an OPEN `TenantSyncHub` WebSocket. Use this before
 * asserting cross-browser propagation so the test proves realtime delivery,
 * not an incidental API refresh.
 */
export async function waitForRealtimeConnected(
  page: Page,
  timeout = 20_000
): Promise<void> {
  await page.waitForFunction(
    () => {
      const probeWindow = window as Window & {
        __e2eRealtimeProbe?: RealtimeProbeEntry[];
      };
      const records = probeWindow.__e2eRealtimeProbe;
      return Boolean(
        records?.some(
          (entry) => entry.url.includes('/api/sync/ws') && entry.state === 1
        )
      );
    },
    undefined,
    { timeout }
  );
}

/**
 * Clears this origin's IndexedDB working set and session-scope hint. Call while
 * the app is not holding an active sync connection (for example on `/` before
 * opening /workspace), otherwise Chromium may report the delete as blocked.
 */
export async function resetIndexedDb(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await page.evaluate(async () => {
    window.sessionStorage.removeItem('files_sync_scope_v1');
    const databases = await window.indexedDB.databases();
    await Promise.all(
      databases.map(
        (database) =>
          new Promise<void>((resolve) => {
            if (!database.name) {
              resolve();
              return;
            }
            const request = window.indexedDB.deleteDatabase(database.name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          })
      )
    );
  });
}

export function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
