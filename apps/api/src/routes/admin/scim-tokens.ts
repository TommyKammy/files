import { Hono, type Context } from 'hono';
import {
  AdminScimTokenError,
  createAdminScimToken,
  listAdminScimTokens,
  revokeAdminScimToken,
  rotateAdminScimToken,
} from '../../services/admin-scim-tokens';
import { getAuthenticatedUser } from '../../services/authorization';
import type { OidcHonoEnv } from '../../types/oidc';

function scimTokenErrorResponse(
  c: Context<OidcHonoEnv>,
  err: unknown
): Response {
  if (err instanceof AdminScimTokenError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

function requireSysAdmin(c: Context<OidcHonoEnv>): Response | null {
  const user = getAuthenticatedUser(c);
  if (user.role !== 'sys_admin') {
    return c.json(
      {
        error: 'Only sys_admin can manage SCIM tokens',
        code: 'SYS_ADMIN_REQUIRED',
      },
      403
    );
  }
  return null;
}

async function readJsonBody(
  c: Context<OidcHonoEnv>
): Promise<Record<string, unknown>> {
  const body = (await c.req.json().catch(() => null)) as
    | Record<string, unknown>
    | null;
  if (!body) {
    throw new AdminScimTokenError(400, 'INVALID_BODY', 'JSON body required');
  }
  return body;
}

export function registerAdminScimTokenRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/scim-tokens — token metadata only; hashes never leave D1. */
  routes.get('/scim-tokens', async (c) => {
    const user = getAuthenticatedUser(c);
    return c.json(await listAdminScimTokens(c.env.DB, user.tenantId));
  });

  /** POST /api/admin/scim-tokens — issue a token and return it once. */
  routes.post('/scim-tokens', async (c) => {
    const forbidden = requireSysAdmin(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    try {
      const body = await readJsonBody(c);
      const result = await createAdminScimToken({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        name: body.name,
        idpIssuer: body.idpIssuer ?? body.idp_issuer,
      });
      return c.json(result, 201);
    } catch (err) {
      return scimTokenErrorResponse(c, err);
    }
  });

  /** POST /api/admin/scim-tokens/:id/rotate — revoke old and issue new atomically. */
  routes.post('/scim-tokens/:id/rotate', async (c) => {
    const forbidden = requireSysAdmin(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    try {
      const result = await rotateAdminScimToken({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        tokenId: c.req.param('id'),
      });
      return c.json(result);
    } catch (err) {
      return scimTokenErrorResponse(c, err);
    }
  });

  /** POST /api/admin/scim-tokens/:id/revoke — idempotent revocation. */
  routes.post('/scim-tokens/:id/revoke', async (c) => {
    const forbidden = requireSysAdmin(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    try {
      const result = await revokeAdminScimToken({
        db: c.env.DB,
        tenantId: user.tenantId,
        actor: user,
        tokenId: c.req.param('id'),
      });
      return c.json(result);
    } catch (err) {
      return scimTokenErrorResponse(c, err);
    }
  });
}
