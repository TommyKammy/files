import { Hono } from 'hono';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import {
  getClientIp,
  getScimContext,
  insertScimAuditStmt,
  parseScimPagination,
  scimError,
  scimJson,
  type ScimGroupDbRow,
  toScimGroupResource,
} from '../../services/scim-helpers';
import {
  extractGroupMemberIds,
  isRecord,
  parseScimFilterEq,
  parseScimGroupPatch,
} from '../../services/scim-parser';
import {
  SCIM_LIST_RESPONSE_SCHEMA,
  type ScimGroupMemberRef,
  type ScimGroupResource,
  type ScimHonoEnv,
  type ScimListResponse,
} from '../../types/scim';

const D1_CHUNK_SIZE = 30;
export function registerScimGroupDeleteRoutes(routes: Hono<ScimHonoEnv>) {
  routes.delete('/:id', async (c) => {
    const scim = getScimContext(c);
    const groupId = c.req.param('id');

    const existing = await c.env.DB.prepare(
      'SELECT id, name FROM groups WHERE tenant_id = ? AND id = ?'
    )
      .bind(scim.tenantId, groupId)
      .first<{ id: string; name: string }>();
    if (!existing) {
      return scimError(c, 404, `Group ${groupId} not found`);
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId),
      c.env.DB.prepare('DELETE FROM groups WHERE tenant_id = ? AND id = ?').bind(
        scim.tenantId,
        groupId
      ),
      insertScimAuditStmt(c.env.DB, {
        scim,
        actorIp: getClientIp(c),
        action: 'scim.group_delete',
        targetType: 'group',
        targetId: groupId,
        metadata: { displayName: existing.name },
        nowIso,
      }),
    ]);

    return c.body(null, 204);
  });

}
