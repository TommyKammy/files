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
  buildDeleteMembersStmts,
  buildInsertMembersStmts,
  executeStatementsInChunks,
  loadGroupMembers,
  validateTenantUserIds,
} from './shared';
export function registerScimGroupPatchRoutes(routes: Hono<ScimHonoEnv>) {
  routes.patch('/:id', async (c) => {
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

    let patch;
    try {
      patch = parseScimGroupPatch(rawBody);
    } catch (err) {
      return scimError(c, 400, (err as Error).message, 'invalidSyntax');
    }

    const idsToValidate = [
      ...(patch.replaceMembers ?? []),
      ...patch.addMemberIds,
    ];
    const missingIds = await validateTenantUserIds(
      c.env.DB,
      scim.tenantId,
      [...new Set(idsToValidate)]
    );
    if (missingIds.length > 0) {
      return scimError(
        c,
        400,
        `Invalid or cross-tenant member IDs: ${missingIds.join(', ')}`,
        'invalidValue'
      );
    }

    const nextName = patch.displayName ?? existing.name;
    const nextExternalId =
      patch.externalIdpId !== undefined ? patch.externalIdpId : existing.external_idp_id;
    const nowIso = new Date().toISOString();

    const statements: D1PreparedStatement[] = [];
    if (nextName !== existing.name || nextExternalId !== existing.external_idp_id) {
      statements.push(
        c.env.DB.prepare(
          'UPDATE groups SET name = ?, external_idp_id = ? WHERE tenant_id = ? AND id = ?'
        ).bind(nextName, nextExternalId, scim.tenantId, groupId)
      );
    }

    if (patch.replaceMembers !== undefined) {
      statements.push(
        c.env.DB.prepare('DELETE FROM group_members WHERE group_id = ?').bind(groupId)
      );
      statements.push(
        ...buildInsertMembersStmts(c.env.DB, groupId, patch.replaceMembers, nowIso)
      );
    } else {
      if (patch.removeMemberIds.length > 0) {
        statements.push(
          ...buildDeleteMembersStmts(c.env.DB, groupId, patch.removeMemberIds)
        );
      }
      if (patch.addMemberIds.length > 0) {
        statements.push(
          ...buildInsertMembersStmts(c.env.DB, groupId, patch.addMemberIds, nowIso)
        );
      }
    }

    statements.push(
      insertScimAuditStmt(c.env.DB, {
        scim,
        actorIp: getClientIp(c),
        action: 'scim.group_patch',
        targetType: 'group',
        targetId: groupId,
        metadata: {
          displayName: nextName,
          replaced: patch.replaceMembers !== undefined,
          addedCount: patch.addMemberIds.length,
          removedCount: patch.removeMemberIds.length,
        },
        nowIso,
      })
    );

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
        { ...existing, name: nextName, external_idp_id: nextExternalId },
        members
      )
    );
  });


}
