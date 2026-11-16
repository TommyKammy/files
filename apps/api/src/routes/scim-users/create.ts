import { Hono } from 'hono';
import {
  getClientIp,
  getScimContext,
  insertScimAuditStmt,
  scimError,
  scimJson,
  type ScimUserDbRow,
  toScimUserResource,
} from '../../services/scim-helpers';
import { normalizeScimUserPayload } from '../../services/scim-parser';
import { type ScimHonoEnv } from '../../types/scim';
import {
  USER_SELECT_COLUMNS,
} from './shared';

export function registerScimUserCreateRoutes(routes: Hono<ScimHonoEnv>) {
  routes.post('/', async (c) => {
    const scim = getScimContext(c);
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return scimError(c, 400, 'Invalid JSON body', 'invalidSyntax');
    }

    let normalized;
    try {
      normalized = normalizeScimUserPayload(rawBody);
    } catch (err) {
      return scimError(c, 400, (err as Error).message, 'invalidValue');
    }

    // Enforce tenant-scoped uniqueness for both email and (idp_issuer, external_idp_id)
    const existingByEmail = await c.env.DB.prepare(
      'SELECT id FROM users WHERE tenant_id = ? AND email = ?'
    )
      .bind(scim.tenantId, normalized.email)
      .first<{ id: string }>();
    if (existingByEmail) {
      return scimError(c, 409, 'User with this userName/email already exists', 'uniqueness');
    }

    if (normalized.externalIdpId) {
      const existingByExternal = await c.env.DB.prepare(
        `SELECT id FROM users
          WHERE tenant_id = ? AND idp_issuer = ? AND external_idp_id = ?`
      )
        .bind(scim.tenantId, scim.idpIssuer, normalized.externalIdpId)
        .first<{ id: string }>();
      if (existingByExternal) {
        return scimError(c, 409, 'User with this externalId already exists', 'uniqueness');
      }
    }

    const userId = crypto.randomUUID();
    const status = normalized.active ? 'active' : 'suspended';
    const nowIso = new Date().toISOString();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users (
           id, tenant_id, idp_issuer, external_idp_id, email, display_name, department,
           role, status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'member', ?, ?, ?)`
      ).bind(
        userId,
        scim.tenantId,
        scim.idpIssuer,
        normalized.externalIdpId,
        normalized.email,
        normalized.displayName,
        normalized.department,
        status,
        nowIso,
        nowIso
      ),
      insertScimAuditStmt(c.env.DB, {
        scim,
        actorIp: getClientIp(c),
        action: 'scim.user_create',
        targetType: 'user',
        targetId: userId,
        metadata: {
          email: normalized.email,
          externalId: normalized.externalIdpId,
          active: normalized.active,
        },
        nowIso,
      }),
    ]);

    const created = await c.env.DB.prepare(
      `SELECT ${USER_SELECT_COLUMNS} FROM users WHERE tenant_id = ? AND id = ?`
    )
      .bind(scim.tenantId, userId)
      .first<ScimUserDbRow>();

    return scimJson(c, toScimUserResource(created!), 201);
  });


}
