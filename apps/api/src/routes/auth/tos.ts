import { Hono } from 'hono';
import { sessionAuthMiddleware, verifyRequestOriginForCsrf } from '../../middleware/session-auth';
import { getAuthenticatedUser } from '../../services/authorization';
import { recordAuthAudit } from './shared';
import {
  loadTosStatus,
  loadTosStatusWithBranding,
} from '../../services/tos';
import type { OidcHonoEnv } from '../../types/oidc';

export function registerTosAuthRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/auth/tos — current policy, audience applicability and the caller's
   * acceptance state. Exempt from the TOS guard so the web client can always
   * fetch (and accept) the terms.
   */
  routes.get('/api/auth/tos', sessionAuthMiddleware({ required: true }), async (c) => {
    const user = getAuthenticatedUser(c);
    const payload = await loadTosStatusWithBranding(
      c.env.DB,
      user.tenantId,
      user.id,
      user.userType
    );
    return c.json(payload);
  });

  /** POST /api/auth/tos/accept — idempotent acceptance of the current version. */
  routes.post(
    '/api/auth/tos/accept',
    sessionAuthMiddleware({ required: true }),
    async (c) => {
      const csrfError = verifyRequestOriginForCsrf(c);
      if (csrfError) return csrfError;

      const user = getAuthenticatedUser(c);
      const body = (await c.req.json().catch(() => null)) as {
        version?: unknown;
      } | null;
      if (
        !body ||
        typeof body.version !== 'number' ||
        !Number.isInteger(body.version) ||
        body.version < 1
      ) {
        return c.json(
          {
            error: 'version must be a positive integer',
            code: 'INVALID_TOS_VERSION',
          },
          400
        );
      }

      const status = await loadTosStatus(
        c.env.DB,
        user.tenantId,
        user.id,
        user.userType
      );
      if (body.version !== status.version) {
        return c.json(
          {
            error: 'The terms of service have been revised. Reload and accept the current version.',
            code: 'TOS_VERSION_MISMATCH',
            currentVersion: status.version,
          },
          409
        );
      }

      if (status.enabled && status.applicable) {
        const nowIso = new Date().toISOString();
        const userAgent = c.req.header('User-Agent')?.slice(0, 512) ?? null;
        const inserted = await c.env.DB.prepare(
          `INSERT INTO user_tos_acceptances (
             id, tenant_id, user_id, version, accepted_at, ip_address, user_agent
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(tenant_id, user_id, version) DO NOTHING`
        )
          .bind(
            crypto.randomUUID(),
            user.tenantId,
            user.id,
            status.version,
            nowIso,
            user.ipAddress ?? null,
            userAgent
          )
          .run();

        if ((inserted.meta?.changes ?? 0) > 0) {
          await recordAuthAudit(c.env.DB, {
            tenantId: user.tenantId,
            actorId: user.id,
            actorEmail: user.email,
            actorIp: user.ipAddress,
            action: 'auth.tos_accepted',
            targetId: user.tenantId,
            status: 'allowed',
            metadata: {
              version: status.version,
              targetAudience: status.targetAudience,
              userAgent,
            },
          });
        }
      }

      const payload = await loadTosStatusWithBranding(
        c.env.DB,
        user.tenantId,
        user.id,
        user.userType
      );
      return c.json({ ok: true, ...payload });
    }
  );
}
