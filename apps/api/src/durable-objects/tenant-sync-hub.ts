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
  revoked?: boolean;
  metadata?: Record<string, unknown>;
}

const WS_TICKET_CLEANUP_BATCH = 50;

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
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ws_tickets_expires_at
          ON ws_tickets(expires_at);
      `);
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
    ttlSeconds = 30
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
      `INSERT OR REPLACE INTO ws_tickets (ticket_hash, user_id, tenant_id, expires_at)
       VALUES (?, ?, ?, ?)`,
      ticketHash,
      userId,
      tenantId,
      expiresAt
    );
    return { expiresAt };
  }

  async consumeTicket(
    ticketHash: string,
    tenantId: string
  ): Promise<{ ok: true; userId: string } | { ok: false }> {
    const now = Date.now();
    const rows = this.ctx.storage.sql
      .exec<{ user_id: string; expires_at: number }>(
        `SELECT user_id, expires_at
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
    return { ok: true, userId: row.user_id };
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

    const targets = isUserScopedRevocation(input)
      ? this.ctx.getWebSockets(`user:${input.targetUserId}`)
      : allSockets;

    if (targets.length === 0) {
      return { skipped: true, recipientCount: 0 };
    }

    const isRevocation =
      Boolean(input.revoked) ||
      input.eventKind === 'user.suspended' ||
      input.eventKind === 'permission.revoke' ||
      input.eventKind === 'permission.revoked' ||
      input.eventKind === 'shared_link.revoke' ||
      input.eventKind === 'shared_link.revoked';

    const payload: SyncInvalidationSignal = {
      type:
        input.eventKind === 'user.suspended'
          ? 'sync.security_revoke'
          : 'sync.invalidate',
      seq:
        typeof input.seq === 'number' && Number.isFinite(input.seq)
          ? input.seq
          : null,
      scopeFolderIds: sanitizeFolderIds(input.scopeFolderIds),
      eventKind: String(input.eventKind),
      ...(isRevocation ? { revoked: true } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      timestamp: new Date().toISOString(),
    };

    const encoded = JSON.stringify(payload);
    let delivered = 0;

    for (const ws of targets) {
      try {
        ws.send(encoded);
        delivered += 1;
        if (input.eventKind === 'user.suspended') {
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected Upgrade: websocket', { status: 426 });
      }
      const tenantId = url.searchParams.get('tenantId');
      const userId = url.searchParams.get('userId');
      if (!tenantId || !userId) {
        return new Response('Missing tenantId or userId', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server, [`tenant:${tenantId}`, `user:${userId}`]);
      server.serializeAttachment({
        userId,
        tenantId,
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
