import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  countEffectiveOwners,
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
export function registerPrincipalSearchRoute(routes: Hono<OidcHonoEnv>) {
  /** GET /api/principals/search?q=... — SCIM-provisioned active users & groups search */
  routes.get('/principals/search', async (c) => {
    const user = getAuthenticatedUser(c);
    const rawQuery = (c.req.query('q') ?? '').trim();
    const pattern = `%${rawQuery.replace(/[%_\\]/g, '\\$&')}%`;

    const [usersRes, groupsRes] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, display_name, email, department
           FROM users
          WHERE tenant_id = ? AND status = 'active'
            AND (display_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
          ORDER BY display_name ASC
          LIMIT 15`
      )
        .bind(user.tenantId, pattern, pattern)
        .all<{
          id: string;
          display_name: string;
          email: string;
          department: string | null;
        }>(),
      c.env.DB.prepare(
        `SELECT id, name
           FROM groups
          WHERE tenant_id = ? AND name LIKE ? ESCAPE '\\'
          ORDER BY name ASC
          LIMIT 10`
      )
        .bind(user.tenantId, pattern)
        .all<{ id: string; name: string }>(),
    ]);

    return c.json({
      principals: [
        ...usersRes.results.map((u) => ({
          type: 'user' as const,
          id: u.id,
          displayName: u.display_name,
          email: u.email,
          department: u.department,
        })),
        ...groupsRes.results.map((g) => ({
          type: 'group' as const,
          id: g.id,
          displayName: g.name,
          email: null,
          department: null,
        })),
      ],
    });
  });
}
