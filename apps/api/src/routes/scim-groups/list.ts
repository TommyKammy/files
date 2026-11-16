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
  loadGroupMembers,
} from './shared';
export function registerScimGroupListRoutes(routes: Hono<ScimHonoEnv>) {
  routes.get('/', async (c) => {
    const scim = getScimContext(c);
    const { startIndex, limit, offset } = parseScimPagination(
      c.req.query('startIndex'),
      c.req.query('count')
    );
    const rawFilter = c.req.query('filter');
    const filter = parseScimFilterEq(rawFilter);

    if (rawFilter && !filter) {
      return scimError(c, 400, 'Unsupported SCIM filter expression', 'invalidFilter');
    }

    let whereSql = 'tenant_id = ?';
    const bindings: unknown[] = [scim.tenantId];

    if (filter) {
      const attrLower = filter.attr.toLowerCase();
      if (attrLower === 'displayname') {
        whereSql += ' AND name = ?';
        bindings.push(filter.value);
      } else if (attrLower === 'externalid') {
        whereSql += ' AND external_idp_id = ?';
        bindings.push(filter.value);
      } else if (attrLower === 'id') {
        whereSql += ' AND id = ?';
        bindings.push(filter.value);
      } else {
        return scimError(c, 400, `Unsupported filter attribute: ${filter.attr}`, 'invalidFilter');
      }
    }

    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM groups WHERE ${whereSql}`
    )
      .bind(...bindings)
      .first<{ total: number }>();

    const totalResults = countRow?.total ?? 0;
    const rows =
      limit > 0
        ? await c.env.DB.prepare(
            `SELECT id, tenant_id, external_idp_id, name, created_at
               FROM groups
              WHERE ${whereSql}
              ORDER BY created_at ASC, id ASC
              LIMIT ? OFFSET ?`
          )
            .bind(...bindings, limit, offset)
            .all<ScimGroupDbRow>()
        : { results: [] as ScimGroupDbRow[] };

    const resources: ScimGroupResource[] = [];
    for (const group of rows.results) {
      const members = await loadGroupMembers(c.env.DB, scim.tenantId, group.id);
      resources.push(toScimGroupResource(group, members));
    }

    const body: ScimListResponse<ScimGroupResource> = {
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: resources.length,
      Resources: resources,
    };
    return scimJson(c, body);
  });

  routes.get('/:id', async (c) => {
    const scim = getScimContext(c);
    const groupId = c.req.param('id');

    const row = await c.env.DB.prepare(
      `SELECT id, tenant_id, external_idp_id, name, created_at
         FROM groups
        WHERE tenant_id = ? AND id = ?`
    )
      .bind(scim.tenantId, groupId)
      .first<ScimGroupDbRow>();
    if (!row) {
      return scimError(c, 404, `Group ${groupId} not found`);
    }

    const members = await loadGroupMembers(c.env.DB, scim.tenantId, row.id);
    return scimJson(c, toScimGroupResource(row, members));
  });


}
