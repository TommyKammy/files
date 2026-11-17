import { Hono, type Context } from 'hono';
import {
  AdminDelegationError,
  assertDelegatedTargetUserAllowed,
  getAdminScope,
  isDelegatedAdmin,
} from '../../services/admin-delegations';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  ADMIN_SESSION_DEFAULT_LIMIT,
  ADMIN_SESSION_MAX_LIMIT,
  AdminSessionError,
  decodeAdminSessionCursor,
  isAdminSessionUserTypeFilter,
  listAdminSessions,
  revokeAdminSession,
  revokeAdminUserSessions,
  revokeTenantAdminSessions,
  type AdminSessionFilters,
  type AdminSessionUserTypeFilter,
} from '../../services/admin-sessions';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';

const MAX_QUERY_LENGTH = 320;

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return ADMIN_SESSION_DEFAULT_LIMIT;
  return Math.min(Math.max(parsed, 1), ADMIN_SESSION_MAX_LIMIT);
}

function adminSessionErrorResponse(
  c: Context<OidcHonoEnv>,
  err: unknown
): Response {
  if (err instanceof AdminSessionError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof AdminDelegationError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

function readTrimmedQuery(
  c: Context<OidcHonoEnv>,
  name: string
): string | null {
  return c.req.query(name)?.trim() || null;
}

export function registerAdminSessionRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/admin/sessions — live sessions for the caller's tenant.
   * `sys_admin` and `sec_admin` only (the parent router already enforces
   * member/guest rejection); the tenant id always comes from the session.
   */
  routes.get('/sessions', async (c) => {
    const user = getAuthenticatedUser(c);

    const userTypeRaw = c.req.query('userType')?.trim() || 'all';
    if (!isAdminSessionUserTypeFilter(userTypeRaw)) {
      return c.json(
        {
          error: 'userType must be all, member, or guest',
          code: 'INVALID_SESSION_USER_TYPE_FILTER',
        },
        400
      );
    }
    const userType: AdminSessionUserTypeFilter = userTypeRaw;

    const cursorRaw = c.req.query('cursor')?.trim() || null;
    const cursor = cursorRaw ? decodeAdminSessionCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      return c.json(
        { error: 'Invalid pagination cursor', code: 'INVALID_CURSOR' },
        400
      );
    }

    const userId = readTrimmedQuery(c, 'userId');
    const ip = readTrimmedQuery(c, 'ip');
    const query = (c.req.query('q') ?? c.req.query('query') ?? '').trim() || null;
    for (const value of [userId, ip, query]) {
      if (value && value.length > MAX_QUERY_LENGTH) {
        return c.json(
          {
            error: `Session filters must be at most ${MAX_QUERY_LENGTH} characters`,
            code: 'INVALID_SESSION_FILTER',
          },
          400
        );
      }
    }

    const filters: AdminSessionFilters = {
      userId,
      userType,
      ip,
      query,
      limit: parseLimit(c.req.query('limit')),
      cursor,
    };

    const result = await listAdminSessions({
      db: c.env.DB,
      tenantId: user.tenantId,
      actorSessionId: user.sessionId ?? null,
      filters,
      scopeGroupId: getAdminScope(user)?.groupId ?? null,
    });
    return c.json(result);
  });

  /**
   * POST /api/admin/sessions/revoke-all — sys_admin-only emergency stop.
   * `keepCurrentSession` defaults to true so the acting admin is not locked out.
   */
  routes.post('/sessions/revoke-all', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role === 'member') {
      return c.json(
        {
          error: 'Tenant-wide session revocation is reserved for sys_admin',
          code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
        },
        403
      );
    }
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can revoke every tenant session',
          code: 'INSUFFICIENT_ADMIN_ROLE',
        },
        403
      );
    }

    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;

    try {
      const result = await revokeTenantAdminSessions({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        reason: body?.reason,
        keepCurrentSession: body?.keepCurrentSession,
      });

      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        eventKind: 'tenant.sessions_revoked',
        excludeSessionId: result.keepCurrentSession
          ? user.sessionId ?? null
          : null,
        revoked: true,
        metadata: { keepCurrentSession: result.keepCurrentSession },
      });

      return c.json(result);
    } catch (err) {
      return adminSessionErrorResponse(c, err);
    }
  });

  /** POST /api/admin/sessions/:id/revoke — single-session forced sign-out. */
  routes.post('/sessions/:id/revoke', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;

    try {
      if (isDelegatedAdmin(user)) {
        const sessionTarget = await c.env.DB.prepare(
          'SELECT user_id FROM sessions WHERE tenant_id = ? AND id = ?'
        )
          .bind(user.tenantId, c.req.param('id'))
          .first<{ user_id: string }>();
        if (sessionTarget) {
          await assertDelegatedTargetUserAllowed(
            c.env.DB,
            user.tenantId,
            user,
            sessionTarget.user_id
          );
        }
      }
      const result = await revokeAdminSession({
        db: c.env.DB,
        tenantId: user.tenantId,
        sessionId: c.req.param('id'),
        actor: user,
        reason: body?.reason,
      });

      if (!result.alreadyRevoked) {
        await emitTenantSyncSignal(c, {
          tenantId: user.tenantId,
          eventKind: 'session.revoked',
          targetUserId: result.userId,
          targetSessionId: result.sessionId,
          revoked: true,
          metadata: {
            sessionId: result.sessionId,
            userId: result.userId,
          },
        });
      }

      return c.json(result);
    } catch (err) {
      return adminSessionErrorResponse(c, err);
    }
  });

  /**
   * POST /api/admin/users/:id/revoke-sessions — user-scoped forced sign-out.
   * When an admin targets their own account, the acting session is kept by
   * default unless `keepCurrentSession: false` is explicit.
   */
  routes.post('/users/:id/revoke-sessions', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as
      | Record<string, unknown>
      | null;

    try {
      if (isDelegatedAdmin(user)) {
        await assertDelegatedTargetUserAllowed(
          c.env.DB,
          user.tenantId,
          user,
          c.req.param('id')
        );
      }
      const result = await revokeAdminUserSessions({
        db: c.env.DB,
        tenantId: user.tenantId,
        userId: c.req.param('id'),
        actor: user,
        reason: body?.reason,
        keepCurrentSession: body?.keepCurrentSession,
      });

      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        eventKind: 'session.revoked',
        targetUserId: result.userId,
        excludeSessionId:
          result.keepCurrentSession && user.sessionId
            ? user.sessionId
            : null,
        revoked: true,
        metadata: {
          userId: result.userId,
          allSessions: true,
        },
      });

      return c.json(result);
    } catch (err) {
      return adminSessionErrorResponse(c, err);
    }
  });
}
