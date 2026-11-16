import { Hono } from 'hono';
import {
  getClientIp,
  getScimContext,
  insertScimAuditStmt,
  parseScimPagination,
  scimError,
  scimJson,
  type ScimUserDbRow,
  toScimUserResource,
} from '../../services/scim-helpers';
import {
  normalizeScimUserPayload,
  parseScimFilterEq,
  parseScimUserPatch,
} from '../../services/scim-parser';
import {
  SCIM_LIST_RESPONSE_SCHEMA,
  type ScimHonoEnv,
  type ScimListResponse,
  type ScimUserResource,
} from '../../types/scim';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import {
  USER_SELECT_COLUMNS,
} from './shared';
export function registerScimUserDeleteRoutes(routes: Hono<ScimHonoEnv>) {
  routes.delete('/:id', async (c) => {
    const scim = getScimContext(c);
    const userId = c.req.param('id');

    const existing = await c.env.DB.prepare(
      `SELECT ${USER_SELECT_COLUMNS} FROM users WHERE tenant_id = ? AND id = ?`
    )
      .bind(scim.tenantId, userId)
      .first<ScimUserDbRow>();
    if (!existing) {
      return scimError(c, 404, `User ${userId} not found`);
    }

    const nowIso = new Date().toISOString();
    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE users SET status = 'suspended', updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(nowIso, scim.tenantId, userId),
      c.env.DB.prepare(
        `UPDATE sessions SET revoked_at = ?
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
      ).bind(nowIso, scim.tenantId, userId),
      insertScimAuditStmt(c.env.DB, {
        scim,
        actorIp: getClientIp(c),
        action: 'scim.user_delete',
        targetType: 'user',
        targetId: userId,
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: scim.tenantId,
        entityType: 'user',
        entityId: userId,
        targetUserId: userId,
        action: 'user.suspended',
        payload: {
          previousStatus: existing.status,
          status: 'suspended',
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: scim.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'user.suspended',
      targetUserId: userId,
      revoked: true,
    });

    return c.body(null, 204);
  });

}
