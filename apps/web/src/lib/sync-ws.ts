import { requestSyncWsTicket } from '@/lib/files-api';
import type {
  SyncInvalidationSignal,
  SyncWsTicketResponse,
} from '@/types/files';

export type RealtimeConnectionState = 'disconnected' | 'connecting' | 'connected';

export interface RealtimeSecurityRevocationEvent {
  kind:
    | 'user.suspended'
    | 'permission.revoke'
    | 'shared_link.revoke'
    | 'session.revoked'
    | 'tenant.sessions_revoked';
  scopeFolderIds: string[];
  seq: number | null;
}

export interface RealtimeSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export interface WorkspaceRealtimeClientDeps {
  requestTicket?: () => Promise<SyncWsTicketResponse>;
  createSocket?: (url: string) => RealtimeSocketLike;
  onSignal: (signal: SyncInvalidationSignal) => void | Promise<void>;
  onCatchup: () => void | Promise<void>;
  onStateChange?: (state: RealtimeConnectionState) => void;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  addWindowListener?: (type: string, fn: () => void) => () => void;
  addDocumentListener?: (type: string, fn: () => void) => () => void;
  getVisibilityState?: () => string;
  isOnline?: () => boolean;
}

const DEFAULT_BASE_RECONNECT_MS = 1000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 25_000;
const WS_OPEN_READY_STATE = 1;
const WS_CLOSED_SESSION_REVOKED = 4001;

export function computeReconnectDelayMs(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_RECONNECT_MS,
  maxDelayMs = DEFAULT_MAX_RECONNECT_MS,
  randomFn: () => number = () => Math.random()
): number {
  const safeAttempt = Math.max(0, Math.min(attempt, 10));
  const rawDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** safeAttempt);
  const jitterFactor = 0.85 + 0.3 * Math.min(1, Math.max(0, randomFn()));
  return Math.min(maxDelayMs, Math.max(100, Math.round(rawDelay * jitterFactor)));
}

export function normalizeSecurityRevocationEvent(
  signal: SyncInvalidationSignal
): RealtimeSecurityRevocationEvent | null {
  // Session events are more specific than the generic security-revoke type and
  // must be classified before the legacy `sync.security_revoke` branch.
  if (
    signal.eventKind === 'session.revoked' ||
    signal.eventKind === 'tenant.sessions_revoked'
  ) {
    return {
      kind: signal.eventKind,
      scopeFolderIds: signal.scopeFolderIds,
      seq: signal.seq,
    };
  }
  if (signal.type === 'sync.security_revoke' || signal.eventKind === 'user.suspended') {
    return {
      kind: 'user.suspended',
      scopeFolderIds: signal.scopeFolderIds,
      seq: signal.seq,
    };
  }
  if (
    signal.eventKind === 'permission.revoke' ||
    signal.eventKind === 'permission.revoked'
  ) {
    return {
      kind: 'permission.revoke',
      scopeFolderIds: signal.scopeFolderIds,
      seq: signal.seq,
    };
  }
  if (
    signal.eventKind === 'shared_link.revoke' ||
    signal.eventKind === 'shared_link.revoked'
  ) {
    return {
      kind: 'shared_link.revoke',
      scopeFolderIds: signal.scopeFolderIds,
      seq: signal.seq,
    };
  }
  return null;
}

function parseSignalPayload(raw: unknown): SyncInvalidationSignal | null {
  if (typeof raw !== 'string') return null;
  if (raw === 'pong' || raw === 'ping') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'sync.invalidate' && obj.type !== 'sync.security_revoke') {
    return null;
  }
  if (typeof obj.eventKind !== 'string' || obj.eventKind.length === 0) {
    return null;
  }
  const scopeFolderIds = Array.isArray(obj.scopeFolderIds)
    ? obj.scopeFolderIds.filter((id): id is string => typeof id === 'string')
    : [];
  const seq =
    typeof obj.seq === 'number' && Number.isFinite(obj.seq) ? obj.seq : null;

  return {
    type: obj.type,
    seq,
    scopeFolderIds,
    eventKind: obj.eventKind,
    revoked: Boolean(obj.revoked),
    ...(obj.metadata && typeof obj.metadata === 'object'
      ? { metadata: obj.metadata as Record<string, unknown> }
      : {}),
    timestamp:
      typeof obj.timestamp === 'string' ? obj.timestamp : new Date().toISOString(),
  };
}

function defaultAddWindowListener(type: string, fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(type, fn);
  return () => window.removeEventListener(type, fn);
}

function defaultAddDocumentListener(type: string, fn: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  document.addEventListener(type, fn);
  return () => document.removeEventListener(type, fn);
}

/**
 * Real-time WebSocket client connecting directly to the TenantSyncHub Durable Object.
 * Uses single-use tickets, hibernatable 'ping'/'pong' heartbeats, exponential backoff,
 * visibility/online catchup, and fails closed without reconnecting on 4001/revocation.
 */
export class WorkspaceRealtimeClient {
  private readonly requestTicketFn: () => Promise<SyncWsTicketResponse>;
  private readonly createSocketFn: (url: string) => RealtimeSocketLike;
  private readonly onSignal: (signal: SyncInvalidationSignal) => void | Promise<void>;
  private readonly onCatchup: () => void | Promise<void>;
  private readonly onStateChange?: (state: RealtimeConnectionState) => void;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly addWindowListener: (type: string, fn: () => void) => () => void;
  private readonly addDocumentListener: (type: string, fn: () => void) => () => void;
  private readonly getVisibilityState: () => string;
  private readonly isOnline: () => boolean;

  private state: RealtimeConnectionState = 'disconnected';
  private started = false;
  private revokedPermanently = false;
  private wasEverConnected = false;
  private reconnectAttempt = 0;
  private lastDeliveredSeq = 0;
  private generation = 0;

  private socket: RealtimeSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private detachListeners: Array<() => void> = [];

  constructor(deps: WorkspaceRealtimeClientDeps) {
    this.requestTicketFn = deps.requestTicket ?? (() => requestSyncWsTicket());
    this.createSocketFn =
      deps.createSocket ??
      ((url: string) => new WebSocket(url) as unknown as RealtimeSocketLike);
    this.onSignal = deps.onSignal;
    this.onCatchup = deps.onCatchup;
    this.onStateChange = deps.onStateChange;
    this.baseReconnectDelayMs =
      deps.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_MS;
    this.maxReconnectDelayMs =
      deps.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? (() => Math.random());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
    this.addWindowListener = deps.addWindowListener ?? defaultAddWindowListener;
    this.addDocumentListener =
      deps.addDocumentListener ?? defaultAddDocumentListener;
    this.getVisibilityState =
      deps.getVisibilityState ??
      (() =>
        typeof document !== 'undefined' ? document.visibilityState : 'visible');
    this.isOnline =
      deps.isOnline ??
      (() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true));
  }

  getState(): RealtimeConnectionState {
    return this.state;
  }

  getReconnectAttempt(): number {
    return this.reconnectAttempt;
  }

  isRevoked(): boolean {
    return this.revokedPermanently;
  }

  start(): void {
    if (this.started && !this.revokedPermanently) return;
    this.started = true;
    this.revokedPermanently = false;
    this.reconnectAttempt = 0;
    this.lastDeliveredSeq = 0;
    this.attachEnvironmentListeners();
    void this.connectNow();
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.detachEnvironmentListeners();
    this.closeActiveSocket(1000, 'client_stop');
    this.setState('disconnected');
  }

  private setState(next: RealtimeConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChange?.(next);
  }

  private attachEnvironmentListeners(): void {
    if (this.detachListeners.length > 0) return;

    const handleVisibility = () => {
      if (!this.started || this.revokedPermanently) return;
      if (this.getVisibilityState() !== 'visible') return;
      void this.onCatchup();
      if (this.state === 'disconnected' && this.isOnline()) {
        this.clearReconnectTimer();
        this.reconnectAttempt = 0;
        void this.connectNow();
      }
    };

    const handleOnline = () => {
      if (!this.started || this.revokedPermanently) return;
      void this.onCatchup();
      if (this.state === 'disconnected') {
        this.clearReconnectTimer();
        this.reconnectAttempt = 0;
        void this.connectNow();
      }
    };

    this.detachListeners.push(
      this.addDocumentListener('visibilitychange', handleVisibility),
      this.addWindowListener('online', handleOnline)
    );
  }

  private detachEnvironmentListeners(): void {
    for (const unlisten of this.detachListeners) {
      unlisten();
    }
    this.detachListeners = [];
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      this.clearTimer(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleHeartbeat(socket: RealtimeSocketLike, gen: number): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = this.setTimer(() => {
      if (!this.started || this.revokedPermanently || this.generation !== gen) {
        return;
      }
      if (this.socket !== socket || socket.readyState !== WS_OPEN_READY_STATE) {
        return;
      }
      try {
        socket.send('ping');
      } catch {
        // Ignore send errors; close/error event will trigger reconnect
      }
      this.scheduleHeartbeat(socket, gen);
    }, this.heartbeatIntervalMs);
  }

  private scheduleReconnect(gen: number): void {
    if (!this.started || this.revokedPermanently || this.generation !== gen) {
      return;
    }
    if (!this.isOnline()) {
      // Wait for browser 'online' event rather than burning retries offline
      return;
    }
    this.clearReconnectTimer();
    const delayMs = computeReconnectDelayMs(
      this.reconnectAttempt,
      this.baseReconnectDelayMs,
      this.maxReconnectDelayMs,
      this.random
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.started && !this.revokedPermanently && this.generation === gen) {
        void this.connectNow();
      }
    }, delayMs);
  }

  private closeActiveSocket(code: number, reason: string): void {
    const active = this.socket;
    this.socket = null;
    if (!active) return;
    try {
      active.close(code, reason);
    } catch {
      // Socket already closing/closed
    }
  }

  private async connectNow(): Promise<void> {
    if (!this.started || this.revokedPermanently) return;
    if (this.state === 'connecting' || this.state === 'connected') return;

    this.clearReconnectTimer();
    const gen = (this.generation += 1);
    this.setState('connecting');

    let ticketRes: SyncWsTicketResponse;
    try {
      ticketRes = await this.requestTicketFn();
    } catch (err) {
      if (!this.started || this.generation !== gen) return;
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? (err as { status?: number }).status
          : undefined;
      if (status === 401 || status === 403) {
        this.revokedPermanently = true;
        this.setState('disconnected');
        void this.onSignal({
          type: 'sync.security_revoke',
          seq: null,
          scopeFolderIds: [],
          eventKind: 'user.suspended',
          revoked: true,
          timestamp: new Date(this.now()).toISOString(),
        });
        return;
      }
      this.setState('disconnected');
      this.scheduleReconnect(gen);
      return;
    }

    if (!this.started || this.revokedPermanently || this.generation !== gen) {
      this.setState('disconnected');
      return;
    }

    let ws: RealtimeSocketLike;
    try {
      ws = this.createSocketFn(ticketRes.wsUrl);
    } catch {
      this.setState('disconnected');
      this.scheduleReconnect(gen);
      return;
    }

    this.socket = ws;

    const handleOpen = () => {
      if (this.socket !== ws || !this.started || this.generation !== gen) return;
      const reconnecting = this.wasEverConnected;
      this.wasEverConnected = true;
      this.reconnectAttempt = 0;
      this.setState('connected');
      this.scheduleHeartbeat(ws, gen);
      if (reconnecting) {
        void this.onCatchup();
      }
    };

    const handleMessage = (event: unknown) => {
      if (this.socket !== ws || this.generation !== gen) return;
      const data =
        typeof event === 'object' && event !== null && 'data' in event
          ? (event as { data?: unknown }).data
          : undefined;
      const signal = parseSignalPayload(data);
      if (!signal) return;

      const isCriticalSecurity =
        signal.type === 'sync.security_revoke' ||
        signal.eventKind === 'user.suspended' ||
        Boolean(signal.revoked);

      if (signal.seq !== null) {
        if (!isCriticalSecurity && signal.seq <= this.lastDeliveredSeq) {
          return;
        }
        this.lastDeliveredSeq = Math.max(this.lastDeliveredSeq, signal.seq);
      }

      if (
        signal.type === 'sync.security_revoke' ||
        signal.eventKind === 'user.suspended'
      ) {
        this.revokedPermanently = true;
        this.clearHeartbeatTimer();
        this.clearReconnectTimer();
        this.closeActiveSocket(WS_CLOSED_SESSION_REVOKED, 'Session revoked');
        this.setState('disconnected');
      }

      void this.onSignal(signal);
    };

    const handleClose = (event: unknown) => {
      if (this.socket !== ws || this.generation !== gen) return;
      this.socket = null;
      this.clearHeartbeatTimer();
      this.setState('disconnected');

      const closeCode =
        typeof event === 'object' && event !== null && 'code' in event
          ? (event as { code?: number }).code
          : undefined;

      if (closeCode === WS_CLOSED_SESSION_REVOKED) {
        if (!this.revokedPermanently) {
          this.revokedPermanently = true;
          void this.onSignal({
            type: 'sync.security_revoke',
            seq: null,
            scopeFolderIds: [],
            eventKind: 'user.suspended',
            revoked: true,
            timestamp: new Date(this.now()).toISOString(),
          });
        }
        return;
      }

      this.scheduleReconnect(gen);
    };

    const handleError = () => {
      if (this.socket !== ws || this.generation !== gen) return;
      // Close event normally follows; ensure recovery if socket did not emit close
      if (ws.readyState !== WS_OPEN_READY_STATE) {
        this.clearHeartbeatTimer();
        this.setState('disconnected');
        this.scheduleReconnect(gen);
      }
    };

    ws.addEventListener('open', handleOpen);
    ws.addEventListener('message', handleMessage);
    ws.addEventListener('close', handleClose);
    ws.addEventListener('error', handleError);
  }
}
