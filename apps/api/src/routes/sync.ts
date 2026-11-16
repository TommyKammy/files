import { Hono } from 'hono';
import {
  getAuthenticatedUser,
  GRANTEE_MATCH_SQL,
} from '../services/authorization';
import {
  parseRoleList,
  synthesizeEffectiveAccess,
} from '../services/capabilities';
import {
  isLocalDevBypassAllowed,
  isOriginAllowed,
  readSessionTokenFromRequest,
  sessionAuthMiddleware,
} from '../middleware/session-auth';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  generateRandomToken,
  sha256Hex,
} from '../services/crypto-utils';
import type { FolderRow } from '../services/folder-closure-service';
import { listAuthorizedSyncDeltas } from '../services/sync-changes';
import type { OidcHonoEnv } from '../types/oidc';

const BOOTSTRAP_ROOT_LIMIT = 100;
const BOOTSTRAP_PINNED_LIMIT = 50;
const WS_TICKET_TTL_SECONDS = 30;

const FOLDER_ALIAS_COLS =
  'f.id, f.tenant_id, f.parent_id, f.name, f.depth, f.version, f.classification, f.is_pinned, f.created_by, f.deleted_at, f.created_at, f.updated_at';

export const syncRoutes = new Hono<OidcHonoEnv>();

syncRoutes.use('/bootstrap', sessionAuthMiddleware({ required: true }));
syncRoutes.use('/delta', sessionAuthMiddleware({ required: true }));
syncRoutes.use('/ws-ticket', sessionAuthMiddleware({ required: true }));

/**
 * GET /api/sync/bootstrap — Single D1.batch() boot payload replacing waterfall calls
 * (`me` + `tenant_policies` + accessible `rootFolders` + `pinnedFolders` + `sync_seq`).
 */
syncRoutes.get('/bootstrap', async (c) => {
  const user = getAuthenticatedUser(c);

  const [policyRes, rootsRes, pinnedRes, horizonRes, maxSeqRes] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?').bind(user.tenantId),
    c.env.DB.prepare(
      `SELECT ${FOLDER_ALIAS_COLS},
              GROUP_CONCAT(DISTINCT p.role) AS role_list
         FROM folders f
         JOIN permissions p
           ON p.tenant_id = f.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = f.id
        WHERE f.tenant_id = ?
          AND f.parent_id IS NULL
          AND f.deleted_at IS NULL
          AND ${GRANTEE_MATCH_SQL}
        GROUP BY f.id
        ORDER BY f.is_pinned DESC, f.name ASC, f.id ASC
        LIMIT ?`
    ).bind(user.tenantId, user.id, user.id, BOOTSTRAP_ROOT_LIMIT),
    c.env.DB.prepare(
      `SELECT ${FOLDER_ALIAS_COLS},
              GROUP_CONCAT(DISTINCT p.role) AS role_list
         FROM folders f
         JOIN folder_closures fc
           ON fc.tenant_id = f.tenant_id
          AND fc.descendant_id = f.id
         JOIN permissions p
           ON p.tenant_id = fc.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = fc.ancestor_id
        WHERE f.tenant_id = ?
          AND f.is_pinned = 1
          AND f.deleted_at IS NULL
          AND ${GRANTEE_MATCH_SQL}
        GROUP BY f.id
        ORDER BY f.name ASC, f.id ASC
        LIMIT ?`
    ).bind(user.tenantId, user.id, user.id, BOOTSTRAP_PINNED_LIMIT),
    c.env.DB.prepare('SELECT purged_before_seq FROM tenant_sync_horizons WHERE tenant_id = ?').bind(
      user.tenantId
    ),
    c.env.DB.prepare('SELECT MAX(seq) AS max_seq FROM sync_changes WHERE tenant_id = ?').bind(
      user.tenantId
    ),
  ]);

  const policy = (policyRes.results[0] as Record<string, unknown> | undefined) ?? null;
  // Non-linear composition: a folder carrying both `viewer` and `uploader`
  // grants must bootstrap as `viewer_uploader`, not `viewer` (MAX rank loss).
  const mapFolder = (row: FolderRow & { role_list: string | null }) => {
    const { role_list, ...folder } = row;
    const access = synthesizeEffectiveAccess(parseRoleList(role_list));
    return {
      ...folder,
      effectiveRole: access.effectiveRole,
      capabilities: access.capabilities,
    };
  };

  const rootFolders = (
    rootsRes.results as Array<FolderRow & { role_list: string | null }>
  ).map(mapFolder);
  const pinnedFolders = (
    pinnedRes.results as Array<FolderRow & { role_list: string | null }>
  ).map(mapFolder);

  const horizonRow = horizonRes.results[0] as { purged_before_seq?: number } | undefined;
  const maxRow = maxSeqRes.results[0] as { max_seq?: number | null } | undefined;
  const purgedBeforeSeq = horizonRow?.purged_before_seq ?? 0;
  const currentSeq = Math.max(purgedBeforeSeq, maxRow?.max_seq ?? 0);

  return c.json({
    user,
    policy,
    rootFolders,
    pinnedFolders,
    currentSeq,
    purgedBeforeSeq,
  });
});

/** GET /api/sync/delta?sinceSeq=N&limit=200 — RBAC-filtered incremental delta feed */
syncRoutes.get('/delta', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawSince = c.req.query('sinceSeq');
  const sinceSeq = rawSince === undefined ? 0 : Number.parseInt(rawSince, 10);
  if (!Number.isFinite(sinceSeq) || sinceSeq < 0) {
    return c.json({ error: 'sinceSeq must be a non-negative integer' }, 400);
  }

  const rawLimit = Number.parseInt(c.req.query('limit') ?? '100', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 100;

  const delta = await listAuthorizedSyncDeltas(c.env.DB, user, { sinceSeq, limit });
  return c.json(delta);
});

/**
 * POST /api/sync/ws-ticket — Issue a 30s single-use WebSocket handshake ticket stored in DO SQLite
 * (zero D1 write cost, enables local cross-port ws://127.0.0.1:8787 without Next.js WS proxy).
 */
syncRoutes.post('/ws-ticket', async (c) => {
  const user = getAuthenticatedUser(c);
  if (!c.env.SYNC_HUB) {
    return c.json({ error: 'Realtime sync hub unavailable' }, 503);
  }

  const nonce = generateRandomToken(24);
  const tenantEncoded = bytesToBase64Url(new TextEncoder().encode(user.tenantId));
  const ticket = `${tenantEncoded}.${nonce}`;
  const ticketHash = await sha256Hex(ticket);

  const hubId = c.env.SYNC_HUB.idFromName(user.tenantId);
  const stub = c.env.SYNC_HUB.get(hubId);
  const { expiresAt } = await stub.issueTicket(
    user.id,
    user.tenantId,
    ticketHash,
    WS_TICKET_TTL_SECONDS
  );

  const reqUrl = new URL(c.req.url);
  const wsTargetBase =
    c.env.ENVIRONMENT !== 'local' && c.env.APP_ORIGIN
      ? new URL(c.env.APP_ORIGIN)
      : reqUrl;
  const wsProtocol = wsTargetBase.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${wsTargetBase.host}/api/sync/ws?ticket=${encodeURIComponent(ticket)}`;

  return c.json({
    ticket,
    wsUrl,
    expiresInSeconds: WS_TICKET_TTL_SECONDS,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

/**
 * GET /api/sync/ws — WebSocket Upgrade endpoint routed to TenantSyncHub Durable Object.
 * Defends against CSWSH with strict Origin verification and single-use ticket / session cookie auth.
 */
syncRoutes.get('/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected Upgrade: websocket' }, 426);
  }
  if (!c.env.SYNC_HUB) {
    return c.json({ error: 'Realtime sync hub unavailable' }, 503);
  }

  const origin = c.req.header('Origin');
  const reqOrigin = new URL(c.req.url).origin;
  if (c.env.ENVIRONMENT !== 'local') {
    if (
      !origin ||
      (c.env.APP_ORIGIN ? !isOriginAllowed(c.env, origin) : origin !== reqOrigin)
    ) {
      return c.json({ error: 'Invalid WebSocket origin' }, 403);
    }
  } else if (origin && origin !== reqOrigin && !isOriginAllowed(c.env, origin)) {
    return c.json({ error: 'Invalid WebSocket origin' }, 403);
  }

  let verifiedUser: { tenantId: string; userId: string } | null = null;
  const rawTicket = c.req.query('ticket');

  if (rawTicket) {
    const dotIdx = rawTicket.indexOf('.');
    if (dotIdx > 0 && dotIdx < rawTicket.length - 1) {
      try {
        const tenantId = new TextDecoder().decode(
          base64UrlToBytes(rawTicket.slice(0, dotIdx))
        );
        if (tenantId) {
          const stub = c.env.SYNC_HUB.get(c.env.SYNC_HUB.idFromName(tenantId));
          const consumed = await stub.consumeTicket(await sha256Hex(rawTicket), tenantId);
          if (consumed.ok) {
            const dbUser = await c.env.DB.prepare(
              'SELECT status FROM users WHERE tenant_id = ? AND id = ?'
            )
              .bind(tenantId, consumed.userId)
              .first<{ status: 'active' | 'suspended' }>();
            if (!dbUser || dbUser.status === 'active') {
              verifiedUser = { tenantId, userId: consumed.userId };
            }
          }
        }
      } catch {
        verifiedUser = null;
      }
    }
  } else if (isLocalDevBypassAllowed(c)) {
    const devUserId = c.req.header('X-Dev-User-Id');
    if (devUserId) {
      const tenantId =
        c.req.header('X-Dev-Tenant-Id') ?? c.env.DEFAULT_TENANT_ID ?? 'tenant-default';
      const dbUser = await c.env.DB.prepare(
        'SELECT status FROM users WHERE tenant_id = ? AND id = ?'
      )
        .bind(tenantId, devUserId)
        .first<{ status: 'active' | 'suspended' }>();
      if (!dbUser || dbUser.status === 'active') {
        verifiedUser = { tenantId, userId: devUserId };
      }
    }
  }

  if (!verifiedUser) {
    const sessionToken = readSessionTokenFromRequest(c);
    if (sessionToken) {
      const sessionRow = await c.env.DB.prepare(
        `SELECT s.expires_at, u.id, u.tenant_id, u.status
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.revoked_at IS NULL`
      )
        .bind(await sha256Hex(sessionToken))
        .first<{
          expires_at: string;
          id: string;
          tenant_id: string;
          status: 'active' | 'suspended';
        }>();

      if (
        sessionRow &&
        sessionRow.status === 'active' &&
        sessionRow.expires_at > new Date().toISOString()
      ) {
        verifiedUser = { tenantId: sessionRow.tenant_id, userId: sessionRow.id };
      }
    }
  }

  if (!verifiedUser) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const stub = c.env.SYNC_HUB.get(c.env.SYNC_HUB.idFromName(verifiedUser.tenantId));
  const connectUrl = new URL('https://sync-hub.internal/connect');
  connectUrl.searchParams.set('tenantId', verifiedUser.tenantId);
  connectUrl.searchParams.set('userId', verifiedUser.userId);

  return stub.fetch(new Request(connectUrl.toString(), c.req.raw));
});
