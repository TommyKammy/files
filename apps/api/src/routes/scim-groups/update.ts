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
import {
  buildInsertMembersStmts,
  executeStatementsInChunks,
  loadGroupMembers,
  validateTenantUserIds,
} from './shared';
export function registerScimGroupUpdateRoutes(routes: Hono<ScimHonoEnv>) {
  routes.put('/:id', async (c) => {
    const scim = getScimContext(c);
    const groupId = c.req.param('id');

    const existing = await c.env.DB.prepare(
      `SELECT id, tenant_id, external_idp_id, name, created_at
         FROM groups
        WHERE tenant_id = ? AND id = ?`
    )
      .bind(scim.tenantId, groupId)
      .first<ScimGroupDbRow>();
    if (!existing) {
      return scimError(c, 404, `Group ${groupId} not found`);
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return scimError(c, 400, 'Invalid JSON body', 'invalidSyntax');
    }
    if (!isRecord(rawBody) || typeof rawBody.displayName !== 'string' || !rawBody.displayName.trim()) {
      return scimError(c, 400, 'Group displayName is required', 'invalidValue');
    }

    const displayName = rawBody.displayName.trim();
    const externalIdpId =
      typeof rawBody.externalId === 'string' && rawBody.externalId.trim()
        ? rawBody.externalId.trim()
        : existing.external_idp_id;
    const memberIds = extractGroupMemberIds(rawBody.members);

    const missingIds = await validateTenantUserIds(c.env.DB, scim.tenantId, memberIds);
    if (missingIds.length > 0) {
      return scimError(
        c,
        400,
        `Invalid or cross-tenant member IDs: ${missingIds.join(', ')}`,
        'invalidValue'
      );
    }

    const nowIso = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `UPDATE groups SET name = ?, external_idp_id = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(displayName, externalIdpId, scim.tenantId, groupId),
      c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId),
      ...buildInsertMembersStmts(c.env.DB, groupId, memberIds, nowIso),
      insertScimAuditStmt(c.env.DB, {
        scim,
        actorIp: getClientIp(c),
        action: 'scim.group_replace',
        targetType: 'group',
        targetId: groupId,
        metadata: { displayName, memberCount: memberIds.length },
        nowIso,
      }),
    ];

    try {
      await executeStatementsInChunks(c.env.DB, statements);
    } catch (err) {
      if (((err as Error).message ?? '').includes('UNIQUE constraint failed')) {
        return scimError(c, 409, 'Group name or externalId conflicts', 'uniqueness');
      }
      throw err;
    }

    const members = await loadGroupMembers(c.env.DB, scim.tenantId, groupId);
    return scimJson(
      c,
      toScimGroupResource(
        { ...existing, name: displayName, external_idp_id: externalIdpId },
        members
      )
    );
  });


}
