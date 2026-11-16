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
export function registerScimGroupCreateRoutes(routes: Hono<ScimHonoEnv>) {
  routes.post('/', async (c) => {
    const scim = getScimContext(c);
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
        : null;
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

    const groupId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO groups (id, tenant_id, external_idp_id, name, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(groupId, scim.tenantId, externalIdpId, displayName, nowIso),
      ...buildInsertMembersStmts(c.env.DB, groupId, memberIds, nowIso),
      insertScimAuditStmt(c.env.DB, {
        scim,
        actorIp: getClientIp(c),
        action: 'scim.group_create',
        targetType: 'group',
        targetId: groupId,
        metadata: { displayName, externalId: externalIdpId, memberCount: memberIds.length },
        nowIso,
      }),
    ];

    try {
      await executeStatementsInChunks(c.env.DB, statements);
    } catch (err) {
      if (((err as Error).message ?? '').includes('UNIQUE constraint failed')) {
        return scimError(c, 409, 'Group with this displayName or externalId already exists', 'uniqueness');
      }
      throw err;
    }

    const created: ScimGroupDbRow = {
      id: groupId,
      tenant_id: scim.tenantId,
      external_idp_id: externalIdpId,
      name: displayName,
      created_at: nowIso,
    };
    const members = await loadGroupMembers(c.env.DB, scim.tenantId, groupId);
    return scimJson(c, toScimGroupResource(created, members), 201);
  });


}
