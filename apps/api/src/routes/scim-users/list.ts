import { Hono } from 'hono';
import {
  getScimContext,
  parseScimPagination,
  scimError,
  scimJson,
  type ScimUserDbRow,
  toScimUserResource,
} from '../../services/scim-helpers';
import { parseScimFilterEq } from '../../services/scim-parser';
import {
  SCIM_LIST_RESPONSE_SCHEMA,
  type ScimHonoEnv,
  type ScimListResponse,
  type ScimUserResource,
} from '../../types/scim';
import {
  USER_SELECT_COLUMNS,
} from './shared';

export function registerScimUserListRoutes(routes: Hono<ScimHonoEnv>) {
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

    let whereSql = "tenant_id = ? AND user_type = 'member'";
    const bindings: unknown[] = [scim.tenantId];

    if (filter) {
      const attrLower = filter.attr.toLowerCase();
      if (attrLower === 'username' || attrLower === 'emails.value') {
        whereSql += ' AND email = ?';
        bindings.push(filter.value.toLowerCase());
      } else if (attrLower === 'externalid') {
        whereSql += ' AND idp_issuer = ? AND external_idp_id = ?';
        bindings.push(scim.idpIssuer, filter.value);
      } else if (attrLower === 'id') {
        whereSql += ' AND id = ?';
        bindings.push(filter.value);
      } else {
        return scimError(c, 400, `Unsupported filter attribute: ${filter.attr}`, 'invalidFilter');
      }
    }

    const countRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM users WHERE ${whereSql}`
    )
      .bind(...bindings)
      .first<{ total: number }>();

    const totalResults = countRow?.total ?? 0;
    const rows =
      limit > 0
        ? await c.env.DB.prepare(
            `SELECT ${USER_SELECT_COLUMNS}
               FROM users
              WHERE ${whereSql}
              ORDER BY created_at ASC, id ASC
              LIMIT ? OFFSET ?`
          )
            .bind(...bindings, limit, offset)
            .all<ScimUserDbRow>()
        : { results: [] as ScimUserDbRow[] };

    const body: ScimListResponse<ScimUserResource> = {
      schemas: [SCIM_LIST_RESPONSE_SCHEMA],
      totalResults,
      startIndex,
      itemsPerPage: rows.results.length,
      Resources: rows.results.map(toScimUserResource),
    };
    return scimJson(c, body);
  });

  routes.get('/:id', async (c) => {
    const scim = getScimContext(c);
    const userId = c.req.param('id');

    const row = await c.env.DB.prepare(
      `SELECT ${USER_SELECT_COLUMNS} FROM users
        WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
    )
      .bind(scim.tenantId, userId)
      .first<ScimUserDbRow>();

    if (!row) {
      return scimError(c, 404, `User ${userId} not found`);
    }
    return scimJson(c, toScimUserResource(row));
  });


}
