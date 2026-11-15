'use client';

import { useSyncExternalStore } from 'react';
import { registerAuthPurgeHook } from '@/lib/files-api';
import type {
  WorkspaceClipboardItem,
  WorkspaceClipboardMode,
  WorkspaceClipboardState,
} from '@/types/files';

export const WORKSPACE_CLIPBOARD_STORAGE_KEY = 'files.workspace.clipboard.v1';
export const WORKSPACE_CLIPBOARD_CHANNEL_NAME = 'files-workspace-clipboard-v1';

interface ClipboardStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ClipboardBroadcastAdapter {
  postMessage(data: unknown): void;
  addEventListener?(type: 'message', listener: (ev: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (ev: { data: unknown }) => void): void;
  onmessage?: ((ev: { data: unknown }) => void) | null;
  close?: () => void;
}

export interface WorkspaceClipboardDeps {
  storage?: ClipboardStorageAdapter | null;
  createChannel?: (name: string) => ClipboardBroadcastAdapter | null;
  now?: () => number;
  registerPurgeHook?: (hook: () => void) => () => void;
}

function defaultStorageAdapter(): ClipboardStorageAdapter | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultCreateChannel(name: string): ClipboardBroadcastAdapter | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(name) as unknown as ClipboardBroadcastAdapter;
  } catch {
    return null;
  }
}

function isValidClipboardState(value: unknown): value is WorkspaceClipboardState {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    (obj.mode === 'copy' || obj.mode === 'cut') &&
    typeof obj.tenantId === 'string' &&
    typeof obj.userId === 'string' &&
    typeof obj.updatedAt === 'number' &&
    Array.isArray(obj.items)
  );
}

/**
 * Cross-tab synchronized virtual clipboard (`Copy` / `Cut`) scoped strictly
 * to the authenticated `(tenantId, userId)` tuple.
 */
export class WorkspaceClipboardStore {
  private readonly storage: ClipboardStorageAdapter | null;
  private readonly channel: ClipboardBroadcastAdapter | null;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  private scope: { tenantId: string; userId: string } | null = null;
  private state: WorkspaceClipboardState | null = null;
  private cutKeySet = new Set<string>();
  private storageListener: ((e: StorageEvent) => void) | null = null;
  private channelListener: ((ev: { data: unknown }) => void) | null = null;

  constructor(deps: WorkspaceClipboardDeps = {}) {
    this.storage =
      deps.storage !== undefined ? deps.storage : defaultStorageAdapter();
    this.channel =
      deps.createChannel !== undefined
        ? deps.createChannel(WORKSPACE_CLIPBOARD_CHANNEL_NAME)
        : defaultCreateChannel(WORKSPACE_CLIPBOARD_CHANNEL_NAME);
    this.now = deps.now ?? (() => Date.now());

    this.attachListeners();
    const registerHook = deps.registerPurgeHook ?? registerAuthPurgeHook;
    registerHook(() => this.purge());
  }

  private attachListeners(): void {
    if (this.channel) {
      const onMsg = (ev: { data: unknown }) => {
        const msg = ev?.data as
          | { type?: string; payload?: unknown; tenantId?: string; userId?: string }
          | undefined;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'clipboard.update') {
          if (isValidClipboardState(msg.payload)) {
            this.applyExternalState(msg.payload);
          }
        } else if (msg.type === 'clipboard.clear') {
          if (
            !this.scope ||
            (msg.tenantId === this.scope.tenantId && msg.userId === this.scope.userId)
          ) {
            this.applyExternalState(null);
          }
        }
      };
      this.channelListener = onMsg;
      if (this.channel.addEventListener) {
        this.channel.addEventListener('message', onMsg);
      } else {
        this.channel.onmessage = onMsg;
      }
    }

    if (typeof window !== 'undefined') {
      this.storageListener = (event: StorageEvent) => {
        if (event.key !== WORKSPACE_CLIPBOARD_STORAGE_KEY) return;
        this.hydrateFromStorage();
      };
      window.addEventListener('storage', this.storageListener);
    }
  }

  dispose(): void {
    if (this.channel && this.channelListener) {
      this.channel.removeEventListener?.('message', this.channelListener);
      this.channel.onmessage = null;
    }
    this.channel?.close?.();
    if (typeof window !== 'undefined' && this.storageListener) {
      window.removeEventListener('storage', this.storageListener);
    }
  }

  setScope(user: { tenantId: string; id: string } | null): void {
    if (!user) {
      this.scope = null;
      this.updateLocalState(null);
      return;
    }
    const nextScope = { tenantId: user.tenantId, userId: user.id };
    const changed =
      this.scope?.tenantId !== nextScope.tenantId ||
      this.scope?.userId !== nextScope.userId;
    this.scope = nextScope;
    if (changed) {
      this.hydrateFromStorage();
    }
  }

  getState(): WorkspaceClipboardState | null {
    return this.state;
  }

  getItemCount(): number {
    return this.state?.items.length ?? 0;
  }

  isCutPending(type: 'file' | 'folder', id: string): boolean {
    return this.cutKeySet.has(`${type}:${id}`);
  }

  setClipboard(
    mode: WorkspaceClipboardMode,
    items: WorkspaceClipboardItem[],
    explicitScope?: { tenantId: string; userId: string }
  ): WorkspaceClipboardState | null {
    const scope = explicitScope ?? this.scope;
    if (!scope || items.length === 0) {
      return null;
    }
    this.scope = scope;

    const deduped = new Map<string, WorkspaceClipboardItem>();
    for (const item of items) {
      deduped.set(`${item.type}:${item.id}`, item);
    }

    const nextState: WorkspaceClipboardState = {
      mode,
      items: Array.from(deduped.values()),
      tenantId: scope.tenantId,
      userId: scope.userId,
      updatedAt: this.now(),
    };

    this.updateLocalState(nextState);
    this.persistToStorage(nextState);
    this.channel?.postMessage({ type: 'clipboard.update', payload: nextState });
    return nextState;
  }

  clear(): void {
    const prevScope = this.scope;
    this.updateLocalState(null);
    try {
      this.storage?.removeItem(WORKSPACE_CLIPBOARD_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
    if (prevScope) {
      this.channel?.postMessage({
        type: 'clipboard.clear',
        tenantId: prevScope.tenantId,
        userId: prevScope.userId,
      });
    }
  }

  purge(): void {
    this.scope = null;
    this.clear();
  }

  completePaste(): void {
    if (this.state?.mode === 'cut') {
      this.clear();
    }
  }

  hydrateFromStorage(): void {
    if (!this.scope || !this.storage) {
      this.updateLocalState(null);
      return;
    }
    try {
      const raw = this.storage.getItem(WORKSPACE_CLIPBOARD_STORAGE_KEY);
      if (!raw) {
        this.updateLocalState(null);
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (
        !isValidClipboardState(parsed) ||
        parsed.tenantId !== this.scope.tenantId ||
        parsed.userId !== this.scope.userId
      ) {
        this.updateLocalState(null);
        return;
      }
      this.updateLocalState(parsed);
    } catch {
      this.updateLocalState(null);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private applyExternalState(next: WorkspaceClipboardState | null): void {
    if (!next) {
      this.updateLocalState(null);
      return;
    }
    if (
      this.scope &&
      (next.tenantId !== this.scope.tenantId || next.userId !== this.scope.userId)
    ) {
      return;
    }
    if (!this.scope) {
      return;
    }
    this.updateLocalState(next);
  }

  private persistToStorage(state: WorkspaceClipboardState): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(WORKSPACE_CLIPBOARD_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota or restricted storage errors
    }
  }

  private updateLocalState(next: WorkspaceClipboardState | null): void {
    this.state = next && next.items.length > 0 ? next : null;
    const nextCutKeys = new Set<string>();
    if (this.state?.mode === 'cut') {
      for (const item of this.state.items) {
        nextCutKeys.add(`${item.type}:${item.id}`);
      }
    }
    this.cutKeySet = nextCutKeys;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

let singletonClipboardStore: WorkspaceClipboardStore | null = null;

export function getWorkspaceClipboardStore(): WorkspaceClipboardStore {
  if (!singletonClipboardStore) {
    singletonClipboardStore = new WorkspaceClipboardStore();
  }
  return singletonClipboardStore;
}

export function resetWorkspaceClipboardStoreForTests(): void {
  singletonClipboardStore?.dispose();
  singletonClipboardStore = null;
}

export function useWorkspaceClipboard(): WorkspaceClipboardState | null {
  const store = getWorkspaceClipboardStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => null
  );
}
