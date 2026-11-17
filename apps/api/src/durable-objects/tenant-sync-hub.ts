import { DurableObject } from 'cloudflare:workers';
import type { OidcEnv } from '../types/oidc';

export interface SyncInvalidationSignal {
  type: 'sync.invalidate' | 'sync.security_revoke';
  seq: number | null;
  scopeFolderIds: string[];
  eventKind: string;
  revoked?: boolean;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface SyncPublishRequest {
  tenantId: string;
  seq?: number | null;
  eventKind: string;
  scopeFolderIds?: Array<string | null | undefined>;
  targetUserId?: string | null;
  /** Revoke only this D1 session (`session:${id}` WebSocket tag). */
  targetSessionId?: string | null;
  /** Keep the operator's current session connected during bulk revocation. */
  excludeSessionId?: string | null;
  revoked?: boolean;
  metadata?: Record<string, unknown>;
}

const WS_TICKET_CLEANUP_BATCH = 50;
const SECURITY_REVOKE_EVENTS = new Set([
  'user.suspended',
  'session.revoked',
  'tenant.sessions_revoked',
]);
const SESSION_SCOPED_EVENTS = new Set([
  'session.revoked',
  'tenant.sessions_revoked',
]);

interface SocketAttachment {
  userId?: unknown;
  tenantId?: unknown;
  sessionId?: unknown;
  connectedAt?: unknown;
}

function sanitizeFolderIds(ids?: Array<string | null | undefined>): string[] {
  if (!ids || ids.length === 0) return [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === 'string' && id.trim()) {
      seen.add(id.trim());
    }
  }
  return Array.from(seen);
}

function isUserScopedRevocation(input: SyncPublishRequest): boolean {
  if (!input.targetUserId) return false;
  return (
    input.eventKind === 'user.suspended' ||
    input.eventKind === 'permission.revoke' ||
    input.eventKind === 'permission.revoked'
  );
}

function readSessionId(ws: WebSocket): string | null {
  try {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    return typeof attachment?.sessionId === 'string' ? attachment.sessionId : null;
  } catch {
    return null;
  }
}

/**
 * Per-tenant SQLite-backed Durable Object using WebSocket Hibernation API.
 * Broadcasts strictly lightweight, zero-secret invalidation signals ({ seq, scopeFolderIds, eventKind })
 * and pushes security revocations (`user.suspended` / `permission.revoke`) on user-scoped tags.
 */
export class TenantSyncHub extends DurableObject<OidcEnv> {
  constructor(ctx: DurableObjectState, env: OidcEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS ws_tickets (
          ticket_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          session_id TEXT,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ws_tickets_expires_at
          ON ws_tickets(expires_at);
      `);
      // Existing deployments predate the `session_id` column; SQLite has no
      // `ADD COLUMN IF NOT EXISTS`, so probe the schema once at boot.
      const ticketColumns = ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(ws_tickets)')
        .toArray();
      if (!ticketColumns.some((column) => column.name === 'session_id')) {
        ctx.storage.sql.exec(
          'ALTER TABLE ws_tickets ADD COLUMN session_id TEXT'
        );
      }
      // Handle lightweight heartbeat pings while hibernating without waking JS isolate
      ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair('ping', 'pong')
      );
    });
  }

  async issueTicket(
    userId: string,
    tenantId: string,
    ticketHash: string,
    ttlSeconds = 30,
    sessionId: string | null = null
  ): Promise<{ expiresAt: number }> {
    const now = Date.now();
    const expiresAt = now + Math.max(5, Math.min(ttlSeconds, 120)) * 1000;
    this.ctx.storage.sql.exec(
      `DELETE FROM ws_tickets WHERE rowid IN (
         SELECT rowid FROM ws_tickets WHERE expires_at <= ? LIMIT ?
       )`,
      now,
      WS_TICKET_CLEANUP_BATCH
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO ws_tickets (ticket_hash, user_id, tenant_id, session_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      ticketHash,
      userId,
      tenantId,
      sessionId,
      expiresAt
    );
    return { expiresAt };
  }

  async consumeTicket(
    ticketHash: string,
    tenantId: string
  ): Promise<
    { ok: true; userId: string; sessionId: string | null } | { ok: false }
  > {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<{ user_id: string; session_id: string | null; expires_at: number }>(
        `SELECT user_id, session_id, expires_at
           FROM ws_tickets
          WHERE ticket_hash = ? AND tenant_id = ?
          LIMIT 1`,
        ticketHash,
        tenantId
      )
      .toArray();

    const row = rows[0];
    this.ctx.storage.sql.exec(
      'DELETE FROM ws_tickets WHERE ticket_hash = ?',
      ticketHash
    );

    if (!row || row.expires_at <= now) {
      return { ok: false };
    }
    return { ok: true, userId: row.user_id, sessionId: row.session_id ?? null };
  }

  async getStats(): Promise<{ connectedSockets: number }> {
    return { connectedSockets: this.ctx.getWebSockets().length };
  }

  async publishSignal(
    input: SyncPublishRequest
  ): Promise<{ skipped: boolean; recipientCount: number }> {
    const allSockets = this.ctx.getWebSockets();
    if (allSockets.length === 0) {
      return { skipped: true, recipientCount: 0 };
    }

    const targets = this.selectTargets(input, allSockets);
    if (targets.length === 0) {
      return { skipped: true, recipientCount: 0 };
    }

    const isRevocation =
      Boolean(input.revoked) ||
      input.eventKind === 'user.suspended' ||
      input.eventKind === 'permission.revoke' ||
      input.eventKind === 'permission.revoked' ||
      input.eventKind === 'shared_link.revoke' ||
      input.eventKind === 'shared_link.revoked' ||
      SESSION_SCOPED_EVENTS.has(input.eventKind);

    const payload: SyncInvalidationSignal = {
      type: SECURITY_REVOKE_EVENTS.has(input.eventKind)
        ? 'sync.security_revoke'
        : 'sync.invalidate',
      seq:
        typeof input.seq === 'number' && Number.isFinite(input.seq)
          ? input.seq
          : null,
      scopeFolderIds: sanitizeFolderIds(input.scopeFolderIds),
      eventKind: String(input.eventKind),
      ...(isRevocation ? { revoked: true } : {}),
      // Only lock-state notifications attach metadata (ids/reason); folder and
      // file mutation signals never carry names, titles, or payload content.
      ...(input.metadata ? { metadata: input.metadata } : {}),
      timestamp: new Date().toISOString(),
    };

    const encoded = JSON.stringify(payload);
    let delivered = 0;

    for (const ws of targets) {
      try {
        ws.send(encoded);
        delivered += 1;
        if (SECURITY_REVOKE_EVENTS.has(input.eventKind)) {
          ws.close(4001, 'Session revoked');
        }
      } catch {
        try {
          ws.close(1011, 'Delivery failed');
        } catch {
          // Socket already closed
        }
      }
    }

    return { skipped: delivered === 0, recipientCount: delivered };
  }

  /**
   * Session revocations target a single socket; user revocations target every
   * socket of one user; tenant-wide revocations exclude the operator's current
   * session so `keepCurrentSession` never disconnects the acting admin.
   */
  private selectTargets(
    input: SyncPublishRequest,
    allSockets: WebSocket[]
  ): WebSocket[] {
    let targets: WebSocket[];
    if (input.eventKind === 'session.revoked' && input.targetSessionId) {
      targets = this.ctx.getWebSockets(`session:${input.targetSessionId}`);
    } else if (input.eventKind === 'tenant.sessions_revoked') {
      targets = allSockets;
    } else if (input.eventKind === 'session.revoked') {
      targets = input.targetUserId
        ? this.ctx.getWebSockets(`user:${input.targetUserId}`)
        : allSockets;
    } else if (isUserScopedRevocation(input)) {
      targets = this.ctx.getWebSockets(`user:${input.targetUserId}`);
    } else {
      targets = allSockets;
    }

    if (!input.excludeSessionId) return targets;
    return targets.filter((ws) => readSessionId(ws) !== input.excludeSessionId);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }
      const tenantId = url.searchParams.get('tenantId');
      const userId = url.searchParams.get('userId');
      const sessionId = url.searchParams.get('sessionId');
      if (!tenantId || !userId) {
        return new Response('Missing tenantId or userId', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      const tags = [`tenant:${tenantId}`, `user:${userId}`];
      if (sessionId) tags.push(`session:${sessionId}`);
      this.ctx.acceptWebSocket(server, tags);
      server.serializeAttachment({
        userId,
        tenantId,
        sessionId: sessionId ?? null,
        connectedAt: Date.now(),
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/stats') {
      return Response.json(await this.getStats());
    }

    if (url.pathname === '/notify' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as SyncPublishRequest | null;
      if (!body || !body.tenantId || !body.eventKind) {
        return Response.json({ error: 'Invalid signal payload' }, { status: 400 });
      }
      return Response.json(await this.publishSignal(body));
    }

    return new Response('Not Found', { status: 404 });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== 'string') return;
    if (message === 'ping') {
      ws.send('pong');
      return;
    }
    try {
      const parsed = JSON.parse(message) as { type?: unknown };
      if (parsed?.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch {
      // Ignore malformed client frames cleanly
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Ignore already-closed WebSocket
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'WebSocket error');
    } catch {
      // Ignore closed WebSocket
    }
  }
}
