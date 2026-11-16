import { Hono } from 'hono';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../../services/authorization';
import { can } from '../../../services/capabilities';
import type { OidcHonoEnv } from '../../../types/oidc';
import { SharedLinkRow, formatLinkSummary } from '../shared';

export function registerSharedLinkListRoute(routes: Hono<OidcHonoEnv>) {
  routes.get('/', async (c) => {
    const user = getAuthenticatedUser(c);
    const targetType = c.req.query('targetType');
    const targetId = c.req.query('targetId');

    if ((targetType !== 'file' && targetType !== 'folder') || !targetId) {
      return c.json({ error: 'targetType (file|folder) and targetId are required' }, 400);
    }

    const access = await resolveTargetAccess(c.env.DB, user, targetType, targetId);
    if (!access || access.deletedAt !== null) {
      return c.json({ error: 'Target not found' }, 404);
    }
    // Link inventory/management requires `share_link.manage` (editor+).
    if (!can(access.capabilities, 'share_link.manage') && user.role === 'member') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rows = await c.env.DB.prepare(
      `SELECT * FROM shared_links
       WHERE tenant_id = ? AND target_type = ? AND target_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC`
    )
      .bind(user.tenantId, targetType, targetId)
      .all<SharedLinkRow>();

    return c.json({
      links: rows.results.map(formatLinkSummary),
    });
  });


}
