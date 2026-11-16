import { Hono } from 'hono';
import { getClientIp, getScimContext, scimError, scimJson, type ScimUserDbRow, toScimUserResource } from '../../services/scim-helpers';
import { parseScimUserPatch } from '../../services/scim-parser';
import { type ScimHonoEnv } from '../../types/scim';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import {
  USER_SELECT_COLUMNS,
  applyUserUpdate,
} from './shared';

export function registerScimUserPatchRoutes(routes: Hono<ScimHonoEnv>) {
  routes.patch('/:id', async (c) => {
    const scim = getScimContext(c);
    const userId = c.req.param('id');

    const existing = await c.env.DB.prepare(
      `SELECT ${USER_SELECT_COLUMNS} FROM users
        WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
    )
      .bind(scim.tenantId, userId)
      .first<ScimUserDbRow>();
    if (!existing) {
      return scimError(c, 404, `User ${userId} not found`);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return scimError(c, 400, 'Invalid JSON body', 'invalidSyntax');
    }

    let updates;
    try {
      updates = parseScimUserPatch(rawBody);
    } catch (err) {
      return scimError(c, 400, (err as Error).message, 'invalidSyntax');
    }

    try {
      const { user: updated, syncSeq } = await applyUserUpdate(
        c.env.DB,
        existing,
        updates,
        scim,
        getClientIp(c)
      );
      if (updated.status === 'suspended' && existing.status !== 'suspended') {
        await emitTenantSyncSignal(c, {
          tenantId: scim.tenantId,
          seq: syncSeq,
          eventKind: 'user.suspended',
          targetUserId: updated.id,
          revoked: true,
        });
      }
      return scimJson(c, toScimUserResource(updated));
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('UNIQUE constraint failed')) {
        return scimError(c, 409, 'Email or externalId conflicts with another user', 'uniqueness');
      }
      throw err;
    }
  });


}
