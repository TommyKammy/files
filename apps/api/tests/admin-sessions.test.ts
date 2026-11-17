import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import {
  buildAdminSessionListQuery,
  type AdminSessionFilters,
} from '../src/services/admin-sessions';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-admin-sessions';
const OTHER_TENANT = 'tenant-admin-sessions-other';
const APP_ORIGIN = 'http://127.0.0.1:8787';

const SYS = 'as-sys';
const SEC = 'as-sec';
const SYS2 = 'as-sys-2';
const MEMBER = 'as-member';
const MEMBER_B = 'as-member-b';
const GUEST = 'as-guest';
const COOKIE_USER = 'as-cookie';
const WS_USER = 'as-ws';
const WS_OTHER = 'as-ws-other';
const OTHER_SYS = 'as-other-sys';

const SYS_CURRENT_SESSION = 'as-sys-current';
const SYS_OTHER_SESSION = 'as-sys-other';
const SEC_CURRENT_SESSION = 'as-sec-current';

type UserRole = 'sys_admin' | 'sec_admin' | 'member';
type UserType = 'member' | 'guest';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN,
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-proxy-secret',
    DEFAULT_TENANT_ID: TENANT,
    JOBS_QUEUE: { send: async () => undefined },
  } as unknown as OidcEnv;
}

function headers(
  userId: string,
  role: UserRole = 'member',
  options: {
    tenantId?: string;
    userType?: UserType;
    sessionId?: string;
  } = {}
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': options.tenantId ?? TENANT,
    'X-Dev-User-Email': `${userId}@example.com`,
    'X-Dev-User-Type': options.userType ?? 'member',
    ...(options.sessionId ? { 'X-Dev-Session-Id': options.sessionId } : {}),
    'Content-Type': 'application/json',
    Origin: APP_ORIGIN,
  };
}

async function call<T = Record<string, unknown>>(
  path: string,
  userId: string,
  options: {
    method?: string;
    body?: unknown;
    role?: UserRole;
    tenantId?: string;
    userType?: UserType;
    sessionId?: string;
  } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers: headers(userId, options.role ?? 'member', {
        tenantId: options.tenantId,
        userType: options.userType,
        sessionId: options.sessionId,
      }),
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }),
    buildTestEnv()
  );
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

async function rawFetch(
  path: string,
  requestHeaders: Record<string, string>
): Promise<Response> {
  return app.fetch(
    new Request(`${APP_ORIGIN}${path}`, { headers: requestHeaders }),
    buildTestEnv()
  );
}

interface WsHandle {
  ws: WebSocket;
  messages: string[];
  closeEvents: Array<{ code: number; reason: string }>;
  waitForMessages: (minCount: number, timeoutMs?: number) => Promise<string[]>;
  waitForClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
}

async function openWsWithSession(
  testEnv: OidcEnv,
  userId: string,
  sessionId: string,
  role: UserRole = 'member'
): Promise<WsHandle> {
  const ticketRes = await app.fetch(
    new Request(`${APP_ORIGIN}/api/sync/ws-ticket`, {
      method: 'POST',
      headers: headers(userId, role, { sessionId }),
    }),
    testEnv
  );
  expect(ticketRes.status).toBe(200);
  const ticketBody = (await ticketRes.json()) as {
    ticket: string;
    wsUrl: string;
  };

  const wsRes = await app.fetch(
    new Request(ticketBody.wsUrl.replace('ws://', 'http://'), {
      headers: { Upgrade: 'websocket', Origin: APP_ORIGIN },
    }),
    testEnv
  );
  expect(wsRes.status).toBe(101);
  const ws = wsRes.webSocket;
  expect(ws).toBeTruthy();

  const messages: string[] = [];
  const closeEvents: Array<{ code: number; reason: string }> = [];
  ws!.addEventListener('message', (event) => {
    messages.push(
      typeof event.data === 'string' ? event.data : String(event.data)
    );
  });
  ws!.addEventListener('close', (event) => {
    closeEvents.push({ code: event.code, reason: event.reason });
  });
  ws!.accept();

  const waitForMessages = async (
    minCount: number,
    timeoutMs = 2500
  ): Promise<string[]> => {
    const deadline = Date.now() + timeoutMs;
    while (messages.length < minCount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return messages;
  };

  const waitForClose = async (
    timeoutMs = 2500
  ): Promise<{ code: number; reason: string }> => {
    const deadline = Date.now() + timeoutMs;
    while (closeEvents.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect(closeEvents.length).toBeGreaterThan(0);
    return closeEvents[0];
  };

  return { ws: ws!, messages, closeEvents, waitForMessages, waitForClose };
}

async function closeWsQuietly(ws: WebSocket | undefined): Promise<void> {
  if (!ws) return;
  try {
    ws.close(1000, 'test_cleanup');
  } catch {
    // Already closed
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function activeSessionCount(tenantId = TENANT): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM sessions
      WHERE tenant_id = ? AND revoked_at IS NULL AND expires_at > ?`
  )
    .bind(tenantId, new Date().toISOString())
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function sessionFilters(
  overrides: Partial<AdminSessionFilters> = {}
): AdminSessionFilters {
  return {
    userId: null,
    userType: 'all',
    ip: null,
    query: null,
    limit: 50,
    cursor: null,
    ...overrides,
  };
}

describe('Admin active sessions & forced sign-out (P12-2 / TOM-71)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug)
         VALUES (?, 'Admin Sessions', 'admin-sessions'),
                (?, 'Admin Sessions Other', 'admin-sessions-other')`
      ).bind(TENANT, OTHER_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id)
         VALUES (?), (?)`
      ).bind(TENANT, OTHER_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (
           id, tenant_id, email, display_name, department, role, status,
           user_type, external_org
         ) VALUES
           (?, ?, 'as-sys@example.com', 'Sessions Sys', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'as-sec@example.com', 'Sessions Sec', 'Security', 'sec_admin', 'active', 'member', NULL),
           (?, ?, 'as-sys-2@example.com', 'Sessions Sys Two', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'as-member@example.com', 'Sessions Member', 'Engineering', 'member', 'active', 'member', NULL),
           (?, ?, 'as-member-b@example.com', 'Sessions Member B', 'Sales', 'member', 'active', 'member', NULL),
           (?, ?, 'as-guest@example.com', 'Sessions Guest', 'Partner', 'member', 'active', 'guest', 'Acme'),
           (?, ?, 'as-cookie@example.com', 'Sessions Cookie', 'Engineering', 'member', 'active', 'member', NULL),
           (?, ?, 'as-ws@example.com', 'Sessions Websocket', 'Engineering', 'member', 'active', 'member', NULL),
           (?, ?, 'as-ws-other@example.com', 'Sessions Websocket Other', 'Engineering', 'member', 'active', 'member', NULL),
           (?, ?, 'as-other-sys@example.com', 'Sessions Other Sys', 'IT', 'sys_admin', 'active', 'member', NULL)`
      ).bind(
        SYS,
        TENANT,
        SEC,
        TENANT,
        SYS2,
        TENANT,
        MEMBER,
        TENANT,
        MEMBER_B,
        TENANT,
        GUEST,
        TENANT,
        COOKIE_USER,
        TENANT,
        WS_USER,
        TENANT,
        WS_OTHER,
        TENANT,
        OTHER_SYS,
        OTHER_TENANT
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO sessions (
           id, tenant_id, user_id, token_hash, ip_address, user_agent,
           expires_at, revoked_at, created_at
         ) VALUES
           ('as-sys-current', ?, ?, 'as-token-sys-current', '198.51.100.1', 'Mozilla/5.0 Sys Current', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:10:00.000Z'),
           ('as-sys-other', ?, ?, 'as-token-sys-other', '198.51.100.2', 'Mozilla/5.0 Sys Other', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:09:00.000Z'),
           ('as-sec-current', ?, ?, 'as-token-sec-current', '198.51.100.3', 'Mozilla/5.0 Sec Current', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:08:00.000Z'),
           ('as-sys2-1', ?, ?, 'as-token-sys2-1', '198.51.100.4', 'Mozilla/5.0 Sys Two A', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:07:00.000Z'),
           ('as-sys2-2', ?, ?, 'as-token-sys2-2', '198.51.100.5', 'Mozilla/5.0 Sys Two B', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:06:00.000Z'),
           ('as-member-1', ?, ?, 'as-token-member-1', '203.0.113.10', 'Mozilla/5.0 Member A', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:05:00.000Z'),
           ('as-member-2', ?, ?, 'as-token-member-2', '203.0.113.11', 'Mozilla/5.0 Member B', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:04:00.000Z'),
           ('as-member-b-1', ?, ?, 'as-token-member-b-1', '203.0.113.12', 'Mozilla/5.0 Member B1', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:03:00.000Z'),
           ('as-member-b-2', ?, ?, 'as-token-member-b-2', '203.0.113.13', 'Mozilla/5.0 Member B2', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:02:00.000Z'),
           ('as-guest-1', ?, ?, 'as-token-guest-1', '203.0.113.20', 'Mozilla/5.0 Guest', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T10:01:00.000Z'),
           ('as-member-expired', ?, ?, 'as-token-member-expired', '203.0.113.14', 'Mozilla/5.0 Expired', '2000-01-01T00:00:00.000Z', NULL, '2026-11-17T10:00:00.000Z'),
           ('as-member-revoked', ?, ?, 'as-token-member-revoked', '203.0.113.15', 'Mozilla/5.0 Revoked', '2099-01-01T00:00:00.000Z', '2026-11-17T09:00:00.000Z', '2026-11-17T09:00:00.000Z'),
           ('as-ws-1', ?, ?, 'as-token-ws-1', '203.0.113.30', 'Mozilla/5.0 WebSocket One', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T09:59:00.000Z'),
           ('as-ws-2', ?, ?, 'as-token-ws-2', '203.0.113.31', 'Mozilla/5.0 WebSocket Two', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T09:58:00.000Z'),
           ('as-ws-other-1', ?, ?, 'as-token-ws-other-1', '203.0.113.32', 'Mozilla/5.0 WebSocket Other', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T09:57:00.000Z'),
           ('as-other-1', ?, ?, 'as-token-other-1', '203.0.113.40', 'Mozilla/5.0 Other Tenant', '2099-01-01T00:00:00.000Z', NULL, '2026-11-17T09:56:00.000Z')`
      ).bind(
        TENANT,
        SYS,
        TENANT,
        SYS,
        TENANT,
        SEC,
        TENANT,
        SYS2,
        TENANT,
        SYS2,
        TENANT,
        MEMBER,
        TENANT,
        MEMBER,
        TENANT,
        MEMBER_B,
        TENANT,
        MEMBER_B,
        TENANT,
        GUEST,
        TENANT,
        MEMBER,
        TENANT,
        MEMBER,
        TENANT,
        WS_USER,
        TENANT,
        WS_USER,
        TENANT,
        WS_OTHER,
        OTHER_TENANT,
        OTHER_SYS
      ),
    ]);
  });

  it('lists only live tenant sessions with filters, summary and keyset pagination', async () => {
    const list = await call<{
      sessions: Array<{
        id: string;
        userId: string;
        userEmail: string;
        userType: UserType;
        ipAddress: string | null;
        userAgent: string | null;
        isCurrent: boolean;
      }>;
      summary: {
        activeTotal: number;
        memberSessions: number;
        guestSessions: number;
        distinctUsers: number;
      };
      nextCursor: string | null;
      limit: number;
    }>('/api/admin/sessions?limit=50', SEC, {
      role: 'sec_admin',
      sessionId: SEC_CURRENT_SESSION,
    });

    expect(list.status).toBe(200);
    const ids = list.body.sessions.map((session) => session.id);
    expect(ids).not.toContain('as-member-expired');
    expect(ids).not.toContain('as-member-revoked');
    expect(ids).not.toContain('as-other-1');
    expect(ids).toContain('as-member-1');
    expect(ids).toContain('as-guest-1');
    expect(list.body.summary.activeTotal).toBe(13);
    expect(list.body.summary.memberSessions).toBe(12);
    expect(list.body.summary.guestSessions).toBe(1);
    expect(list.body.summary.distinctUsers).toBe(8);
    expect(
      list.body.sessions.find((session) => session.id === SEC_CURRENT_SESSION)
        ?.isCurrent
    ).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain('as-token-member-1');

    const memberOnly = await call<{
      sessions: Array<{ userId: string }>;
    }>('/api/admin/sessions?userId=as-member&limit=50', SYS, {
      role: 'sys_admin',
      sessionId: SYS_CURRENT_SESSION,
    });
    expect(memberOnly.status).toBe(200);
    expect(memberOnly.body.sessions).toHaveLength(2);
    expect(
      memberOnly.body.sessions.every((session) => session.userId === MEMBER)
    ).toBe(true);

    const guests = await call<{ sessions: Array<{ userType: string }> }>(
      '/api/admin/sessions?userType=guest',
      SEC,
      { role: 'sec_admin', sessionId: SEC_CURRENT_SESSION }
    );
    expect(guests.body.sessions).toHaveLength(1);
    expect(guests.body.sessions[0]?.userType).toBe('guest');

    const byIp = await call<{
      sessions: Array<{ id: string; ipAddress: string | null }>;
    }>(
      '/api/admin/sessions?ip=203.0.113.10',
      SEC,
      { role: 'sec_admin', sessionId: SEC_CURRENT_SESSION }
    );
    expect(byIp.body.sessions.map((session) => session.id)).toEqual([
      'as-member-1',
    ]);

    const byQuery = await call<{ sessions: Array<{ id: string }> }>(
      '/api/admin/sessions?q=WebSocket%20Two',
      SEC,
      { role: 'sec_admin', sessionId: SEC_CURRENT_SESSION }
    );
    expect(byQuery.body.sessions.map((session) => session.id)).toEqual([
      'as-ws-2',
    ]);

    const firstPage = await call<{
      sessions: Array<{ id: string }>;
      nextCursor: string | null;
    }>('/api/admin/sessions?limit=2', SEC, {
      role: 'sec_admin',
      sessionId: SEC_CURRENT_SESSION,
    });
    expect(firstPage.body.sessions).toHaveLength(2);
    expect(firstPage.body.nextCursor).toBeTruthy();
    const secondPage = await call<{
      sessions: Array<{ id: string }>;
    }>(
      `/api/admin/sessions?limit=2&cursor=${encodeURIComponent(
        firstPage.body.nextCursor!
      )}`,
      SEC,
      { role: 'sec_admin', sessionId: SEC_CURRENT_SESSION }
    );
    expect(secondPage.body.sessions).toHaveLength(2);
    expect(
      secondPage.body.sessions.some((session) =>
        firstPage.body.sessions.some((first) => first.id === session.id)
      )
    ).toBe(false);

    const invalidType = await call('/api/admin/sessions?userType=admin', SEC, {
      role: 'sec_admin',
    });
    expect(invalidType.status).toBe(400);
    expect(invalidType.body.code).toBe('INVALID_SESSION_USER_TYPE_FILTER');

    const invalidCursor = await call('/api/admin/sessions?cursor=not-a-cursor', SEC, {
      role: 'sec_admin',
    });
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.body.code).toBe('INVALID_CURSOR');

    const memberForbidden = await call('/api/admin/sessions', MEMBER, {
      role: 'member',
    });
    expect(memberForbidden.status).toBe(403);

    const guestForbidden = await call('/api/admin/sessions', GUEST, {
      role: 'member',
      userType: 'guest',
    });
    expect(guestForbidden.status).toBe(403);
    expect(guestForbidden.body.code).toBe('GUEST_FORBIDDEN');
  });

  it('revokes one session idempotently, validates reason, and protects sys_admin from sec_admin', async () => {
    const denied = await call(
      '/api/admin/sessions/as-sys-other/revoke',
      SEC,
      {
        method: 'POST',
        role: 'sec_admin',
        sessionId: SEC_CURRENT_SESSION,
        body: { reason: 'attempt' },
      }
    );
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('FORBIDDEN_TARGET_ROLE');

    const crossTenant = await call(
      '/api/admin/sessions/as-other-1/revoke',
      SYS,
      { method: 'POST', role: 'sys_admin', sessionId: SYS_CURRENT_SESSION }
    );
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.code).toBe('SESSION_NOT_FOUND');

    const tooLong = await call(
      '/api/admin/sessions/as-member-1/revoke',
      SYS,
      {
        method: 'POST',
        role: 'sys_admin',
        sessionId: SYS_CURRENT_SESSION,
        body: { reason: 'x'.repeat(301) },
      }
    );
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('INVALID_SESSION_REASON');

    const empty = await call(
      '/api/admin/sessions/as-member-1/revoke',
      SYS,
      {
        method: 'POST',
        role: 'sys_admin',
        sessionId: SYS_CURRENT_SESSION,
        body: { reason: '   ' },
      }
    );
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('INVALID_SESSION_REASON');

    const revoked = await call<{
      sessionId: string;
      alreadyRevoked: boolean;
      revokedAt: string;
    }>('/api/admin/sessions/as-member-1/revoke', SYS, {
      method: 'POST',
      role: 'sys_admin',
      sessionId: SYS_CURRENT_SESSION,
      body: { reason: '端末紛失の報告' },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.sessionId).toBe('as-member-1');
    expect(revoked.body.alreadyRevoked).toBe(false);
    expect(JSON.stringify(revoked.body)).not.toContain('as-token-member-1');

    const row = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE id = 'as-member-1'`
    ).first<{ revoked_at: string | null }>();
    expect(row?.revoked_at).toBeTruthy();

    const audit = await env.DB.prepare(
      `SELECT action, target_type, target_id, metadata_json
         FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.session.revoke'
          AND target_id = 'as-member-1'`
    )
      .bind(TENANT)
      .first<{
        action: string;
        target_type: string;
        target_id: string;
        metadata_json: string;
      }>();
    expect(audit).toMatchObject({
      action: 'admin.session.revoke',
      target_type: 'session',
      target_id: 'as-member-1',
    });
    expect(audit?.metadata_json).toContain('端末紛失の報告');

    const repeated = await call<{ alreadyRevoked: boolean }>(
      '/api/admin/sessions/as-member-1/revoke',
      SYS,
      { method: 'POST', role: 'sys_admin', sessionId: SYS_CURRENT_SESSION }
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body.alreadyRevoked).toBe(true);

    // sec_admin may revoke a guest session.
    const guestRevoked = await call(
      '/api/admin/sessions/as-guest-1/revoke',
      SEC,
      {
        method: 'POST',
        role: 'sec_admin',
        sessionId: SEC_CURRENT_SESSION,
        body: { reason: 'ゲスト端末の紛失' },
      }
    );
    expect(guestRevoked.status).toBe(200);
  });

  it('revokes every session of a user and honours keepCurrentSession', async () => {
    const bySec = await call<{
      revokedCount: number;
      keepCurrentSession: boolean;
    }>('/api/admin/users/as-member-b/revoke-sessions', SEC, {
      method: 'POST',
      role: 'sec_admin',
      sessionId: SEC_CURRENT_SESSION,
      body: { reason: 'アカウント乗っ取り疑い' },
    });
    expect(bySec.status).toBe(200);
    expect(bySec.body.revokedCount).toBe(2);
    expect(bySec.body.keepCurrentSession).toBe(false);

    const memberAudit = await env.DB.prepare(
      `SELECT target_type, target_id, metadata_json
         FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.session.revoke_user'
          AND target_id = ?`
    )
      .bind(TENANT, MEMBER_B)
      .first<{
        target_type: string;
        target_id: string;
        metadata_json: string;
      }>();
    expect(memberAudit?.target_type).toBe('user');
    expect(memberAudit?.metadata_json).toContain('アカウント乗っ取り疑い');

    const missing = await call(
      '/api/admin/users/as-does-not-exist/revoke-sessions',
      SYS,
      { method: 'POST', role: 'sys_admin', sessionId: SYS_CURRENT_SESSION }
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('USER_NOT_FOUND');

    const crossTenantUser = await call(
      '/api/admin/users/as-other-sys/revoke-sessions',
      SYS,
      { method: 'POST', role: 'sys_admin', sessionId: SYS_CURRENT_SESSION }
    );
    expect(crossTenantUser.status).toBe(404);
    expect(crossTenantUser.body.code).toBe('USER_NOT_FOUND');

    // Self-targeted revocation defaults to keeping the acting session.
    const kept = await call<{
      revokedCount: number;
      keepCurrentSession: boolean;
    }>('/api/admin/users/as-sys-2/revoke-sessions', SYS2, {
      method: 'POST',
      role: 'sys_admin',
      sessionId: 'as-sys2-1',
    });
    expect(kept.status).toBe(200);
    expect(kept.body.keepCurrentSession).toBe(true);
    expect(kept.body.revokedCount).toBe(1);

    const currentStillActive = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE id = 'as-sys2-1'`
    ).first<{ revoked_at: string | null }>();
    expect(currentStillActive?.revoked_at).toBeNull();
    const otherRevoked = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE id = 'as-sys2-2'`
    ).first<{ revoked_at: string | null }>();
    expect(otherRevoked?.revoked_at).toBeTruthy();

    const forcedSelf = await call<{
      revokedCount: number;
      keepCurrentSession: boolean;
    }>('/api/admin/users/as-sys-2/revoke-sessions', SYS2, {
      method: 'POST',
      role: 'sys_admin',
      sessionId: 'as-sys2-1',
      body: { keepCurrentSession: false },
    });
    expect(forcedSelf.status).toBe(200);
    expect(forcedSelf.body.keepCurrentSession).toBe(false);
    expect(forcedSelf.body.revokedCount).toBe(1);

    const currentRevoked = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE id = 'as-sys2-1'`
    ).first<{ revoked_at: string | null }>();
    expect(currentRevoked?.revoked_at).toBeTruthy();
  });

  it('rejects the real cookie session on /api/sync/bootstrap immediately after revocation', async () => {
    const login = await app.fetch(
      new Request(`${APP_ORIGIN}/auth/dev-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: APP_ORIGIN,
        },
        body: JSON.stringify({ userId: COOKIE_USER, tenantId: TENANT }),
      }),
      buildTestEnv()
    );
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    const cookieMatch = /files_session_local=([^;]+)/.exec(setCookie);
    expect(cookieMatch?.[1]).toBeTruthy();
    const cookie = `files_session_local=${cookieMatch![1]}`;

    const before = await rawFetch('/api/sync/bootstrap', { Cookie: cookie });
    expect(before.status).toBe(200);

    const cookieSessions = await call<{
      sessions: Array<{ id: string; userEmail: string }>;
    }>(`/api/admin/sessions?userId=${COOKIE_USER}`, SYS, {
      role: 'sys_admin',
      sessionId: SYS_CURRENT_SESSION,
    });
    expect(cookieSessions.status).toBe(200);
    expect(cookieSessions.body.sessions).toHaveLength(1);
    const sessionId = cookieSessions.body.sessions[0]!.id;

    const revoke = await call(`/api/admin/sessions/${sessionId}/revoke`, SYS, {
      method: 'POST',
      role: 'sys_admin',
      sessionId: SYS_CURRENT_SESSION,
      body: { reason: 'インシデント初動' },
    });
    expect(revoke.status).toBe(200);

    const after = await rawFetch('/api/sync/bootstrap', { Cookie: cookie });
    expect(after.status).toBe(401);
    const afterBody = (await after.json()) as { code?: string };
    expect(afterBody.code).toBe('SESSION_EXPIRED_OR_REVOKED');
  });

  it('allows only sys_admin to revoke the tenant and keeps the current session by default', async () => {
    const secDenied = await call(
      '/api/admin/sessions/revoke-all',
      SEC,
      {
        method: 'POST',
        role: 'sec_admin',
        sessionId: SEC_CURRENT_SESSION,
        body: { reason: 'test' },
      }
    );
    expect(secDenied.status).toBe(403);
    expect(secDenied.body.code).toBe('INSUFFICIENT_ADMIN_ROLE');

    const activeBefore = await activeSessionCount();
    const result = await call<{
      revokedCount: number;
      keepCurrentSession: boolean;
    }>('/api/admin/sessions/revoke-all', SYS, {
      method: 'POST',
      role: 'sys_admin',
      sessionId: SYS_CURRENT_SESSION,
      body: { reason: '全社インシデント初動' },
    });
    expect(result.status).toBe(200);
    expect(result.body.keepCurrentSession).toBe(true);
    expect(result.body.revokedCount).toBe(activeBefore - 1);

    const current = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE id = 'as-sys-current'`
    ).first<{ revoked_at: string | null }>();
    expect(current?.revoked_at).toBeNull();
    const sec = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE id = 'as-sec-current'`
    ).first<{ revoked_at: string | null }>();
    expect(sec?.revoked_at).toBeTruthy();
    const memberRemaining = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE id = 'as-member-2'`
    ).first<{ revoked_at: string | null }>();
    expect(memberRemaining?.revoked_at).toBeTruthy();

    const audit = await env.DB.prepare(
      `SELECT target_type, target_id FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.session.revoke_all'`
    )
      .bind(TENANT)
      .first<{ target_type: string; target_id: string }>();
    expect(audit).toEqual({ target_type: 'tenant', target_id: TENANT });

    // Explicit opt-out also revokes the acting admin's current session.
    const forced = await call<{
      revokedCount: number;
      keepCurrentSession: boolean;
    }>('/api/admin/sessions/revoke-all', SYS, {
      method: 'POST',
      role: 'sys_admin',
      sessionId: SYS_CURRENT_SESSION,
      body: { keepCurrentSession: false },
    });
    expect(forced.status).toBe(200);
    expect(forced.body.keepCurrentSession).toBe(false);
    expect(forced.body.revokedCount).toBeGreaterThanOrEqual(1);
    const currentAfterForced = await env.DB.prepare(
      `SELECT revoked_at FROM sessions WHERE id = 'as-sys-current'`
    ).first<{ revoked_at: string | null }>();
    expect(currentAfterForced?.revoked_at).toBeTruthy();
  });

  it('pushes session.revoked / tenant.sessions_revoked to the targeted sockets and closes 4001', async () => {
    const testEnv = buildTestEnv();
    // The dedicated revoke-all test runs before this socket test; restore the
    // WebSocket fixtures so the API revocations under test are not no-ops.
    await env.DB.prepare(
      `UPDATE sessions SET revoked_at = NULL
        WHERE tenant_id = ? AND id IN ('as-ws-1', 'as-ws-2', 'as-ws-other-1')`
    )
      .bind(TENANT)
      .run();
    const ws1 = await openWsWithSession(testEnv, WS_USER, 'as-ws-1');
    const ws2 = await openWsWithSession(testEnv, WS_USER, 'as-ws-2');
    const otherWs = await openWsWithSession(
      testEnv,
      WS_OTHER,
      'as-ws-other-1'
    );
    const sysCurrentWs = await openWsWithSession(
      testEnv,
      SYS,
      SYS_CURRENT_SESSION,
      'sys_admin'
    );
    const sysOtherWs = await openWsWithSession(
      testEnv,
      SYS,
      SYS_OTHER_SESSION,
      'sys_admin'
    );

    try {
      const single = await call('/api/admin/sessions/as-ws-1/revoke', SYS, {
        method: 'POST',
        role: 'sys_admin',
        sessionId: SYS_CURRENT_SESSION,
        body: { reason: '対象端末のみ失効' },
      });
      expect(single.status).toBe(200);

      const singleMessages = await ws1.waitForMessages(1);
      const singleFrame = JSON.parse(singleMessages[0]!) as {
        type: string;
        eventKind: string;
        revoked?: boolean;
      };
      expect(singleFrame.type).toBe('sync.security_revoke');
      expect(singleFrame.eventKind).toBe('session.revoked');
      expect(singleFrame.revoked).toBe(true);
      expect((await ws1.waitForClose()).code).toBe(4001);
      expect(ws2.messages).toHaveLength(0);
      expect(otherWs.messages).toHaveLength(0);

      const userRevoke = await call(
        '/api/admin/users/as-ws/revoke-sessions',
        SYS,
        {
          method: 'POST',
          role: 'sys_admin',
          sessionId: SYS_CURRENT_SESSION,
        }
      );
      expect(userRevoke.status).toBe(200);
      await ws2.waitForMessages(1);
      expect(
        (JSON.parse(ws2.messages[0]!) as { eventKind: string }).eventKind
      ).toBe('session.revoked');
      expect((await ws2.waitForClose()).code).toBe(4001);
      expect(otherWs.messages).toHaveLength(0);

      // Tenant-wide socket fan-out: every live socket except the acting
      // session's socket receives tenant.sessions_revoked and closes 4001.
      const stub = testEnv.SYNC_HUB!.get(
        testEnv.SYNC_HUB!.idFromName(TENANT)
      );
      const all = await stub.publishSignal({
        tenantId: TENANT,
        eventKind: 'tenant.sessions_revoked',
        excludeSessionId: SYS_CURRENT_SESSION,
        revoked: true,
      });
      expect(all.recipientCount).toBeGreaterThanOrEqual(2);

      await sysOtherWs.waitForMessages(1);
      expect(
        (JSON.parse(sysOtherWs.messages[0]!) as { eventKind: string })
          .eventKind
      ).toBe('tenant.sessions_revoked');
      expect((await sysOtherWs.waitForClose()).code).toBe(4001);
      await otherWs.waitForMessages(1);
      expect((await otherWs.waitForClose()).code).toBe(4001);

      // The acting admin's current socket is excluded by keepCurrentSession.
      expect(sysCurrentWs.messages).toHaveLength(0);
      expect(sysCurrentWs.closeEvents).toHaveLength(0);

      // The API route itself emits tenant.sessions_revoked (not only the
      // direct Durable Object call above) with the same exclusion semantics.
      const apiAllWs = await openWsWithSession(
        testEnv,
        WS_OTHER,
        'as-ws-other-1'
      );
      try {
        const apiAll = await call('/api/admin/sessions/revoke-all', SYS, {
          method: 'POST',
          role: 'sys_admin',
          sessionId: SYS_CURRENT_SESSION,
        });
        expect(apiAll.status).toBe(200);
        await apiAllWs.waitForMessages(1);
        expect(
          (JSON.parse(apiAllWs.messages[0]!) as { eventKind: string }).eventKind
        ).toBe('tenant.sessions_revoked');
        expect((await apiAllWs.waitForClose()).code).toBe(4001);
        expect(sysCurrentWs.messages).toHaveLength(0);
      } finally {
        await closeWsQuietly(apiAllWs.ws);
      }
    } finally {
      await Promise.all([
        closeWsQuietly(ws1.ws),
        closeWsQuietly(ws2.ws),
        closeWsQuietly(otherWs.ws),
        closeWsQuietly(sysCurrentWs.ws),
        closeWsQuietly(sysOtherWs.ws),
      ]);
    }
  });

  it('keeps the active-session list off full sessions scans (EXPLAIN QUERY PLAN)', async () => {
    const testEnv = buildTestEnv();
    const nowIso = '2026-11-17T12:00:00.000Z';
    const plans = await Promise.all(
      [
        sessionFilters(),
        sessionFilters({ userId: MEMBER }),
        sessionFilters({ userType: 'guest' }),
        sessionFilters({ query: 'member' }),
      ].map(async (filters) => {
        const query = buildAdminSessionListQuery({
          tenantId: TENANT,
          nowIso,
          filters,
        });
        const plan = await testEnv.DB.prepare(
          `EXPLAIN QUERY PLAN ${query.sql}`
        )
          .bind(...query.binds)
          .all<{ detail: string }>();
        return plan.results.map((row) => row.detail).join(' | ');
      })
    );

    for (const plan of plans) {
      expect(plan).toContain('idx_sessions_tenant_active');
      expect(plan).not.toMatch(/SCAN s\b(?! USING)/);
    }
  });
});
