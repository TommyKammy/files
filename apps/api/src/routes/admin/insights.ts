import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  AdminInsightsError,
  getAdminInsights,
  parseAdminInsightsRangeDays,
} from '../../services/admin-insights';
import type { OidcHonoEnv } from '../../types/oidc';

function handleAdminInsightsError(
  c: { json: (body: unknown, status: 400) => Response },
  err: unknown
): Response {
  if (err instanceof AdminInsightsError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

export function registerAdminInsightsRoutes(routes: Hono<OidcHonoEnv>) {
  /**
   * GET /api/admin/insights?days=7|30 — tenant-scoped, pre-aggregated usage
   * and security insight. Every underlying query is an O(1) lookup or a
   * bounded index range (see `buildAdminInsightsQueries`).
   */
  routes.get('/insights', async (c) => {
    try {
      const user = getAuthenticatedUser(c);
      const rangeDays = parseAdminInsightsRangeDays(c.req.query('days'));
      const result = await getAdminInsights(c.env.DB, user.tenantId, rangeDays);
      return c.json(result);
    } catch (err) {
      return handleAdminInsightsError(c, err);
    }
  });
}
