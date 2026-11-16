import { Hono } from 'hono';
import { isLocalDevBypassAllowed, verifyRequestOriginForCsrf } from '../../middleware/session-auth';
import type { UserRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  DEV_ACCOUNT_ROLES,
  DevAccountRow,
  issueSessionForUser,
  pickRepresentativeDevAccount,
} from './shared';

export function registerDevAuthRoutes(routes: Hono<OidcHonoEnv>) {
  routes.get('/auth/dev-accounts', async (c) => {
    if (!isLocalDevBypassAllowed(c)) {
      return c.json({ error: 'Not Found' }, 404);
    }

    const tenantId = (c.req.query('tenant') ?? c.env.DEFAULT_TENANT_ID ?? 'tenant-default').trim();
    const found = await Promise.all(
      DEV_ACCOUNT_ROLES.map((role) => pickRepresentativeDevAccount(c.env.DB, tenantId, role))
    );

    const accounts = found
      .filter((row): row is DevAccountRow => row !== null)
      .map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
      }));

    return c.json({ enabled: true, tenantId, accounts });
  });


  /** GET /auth/dev-login — redirect accidental browser GET navigation back to home quick-login */
  routes.get('/auth/dev-login', (c) => {
    if (!isLocalDevBypassAllowed(c)) {
      return c.json({ error: 'Not Found' }, 404);
    }
    return c.redirect('/', 302);
  });


  /** POST /auth/dev-login — issue a standard D1 session cookie for localhost dev testing only */
  routes.post('/auth/dev-login', async (c) => {
    if (!isLocalDevBypassAllowed(c)) {
      return c.json({ error: 'Not Found' }, 404);
    }

    const csrfError = verifyRequestOriginForCsrf(c);
    if (csrfError) return csrfError;

    const body = (await c.req.json().catch(() => null)) as {
      userId?: string;
      role?: UserRole;
      tenantId?: string;
    } | null;

    const tenantId = (body?.tenantId ?? c.env.DEFAULT_TENANT_ID ?? 'tenant-default').trim();
    let target: DevAccountRow | null = null;

    if (typeof body?.userId === 'string' && body.userId.trim()) {
      target = await c.env.DB.prepare(
        `SELECT id, tenant_id, email, display_name, role
           FROM users
          WHERE tenant_id = ? AND id = ? AND status = 'active'`
      )
        .bind(tenantId, body.userId.trim())
        .first<DevAccountRow>();
    } else if (body?.role && DEV_ACCOUNT_ROLES.includes(body.role)) {
      target = await pickRepresentativeDevAccount(c.env.DB, tenantId, body.role);
    } else {
      target = await pickRepresentativeDevAccount(c.env.DB, tenantId, 'sys_admin');
    }

    if (!target) {
      return c.json({ error: 'Active local development account not found' }, 404);
    }

    const ipAddress = c.req.header('CF-Connecting-IP') ?? '127.0.0.1';
    await issueSessionForUser(c, {
      tenantId: target.tenant_id,
      userId: target.id,
      email: target.email,
      ipAddress,
      auditAction: 'auth.dev_login',
      auditMetadata: { role: target.role, mode: 'local_dev_login' },
    });

    return c.json({
      ok: true,
      user: {
        id: target.id,
        tenantId: target.tenant_id,
        email: target.email,
        displayName: target.display_name,
        role: target.role,
        userType: 'member',
      },
    });
  });

}
