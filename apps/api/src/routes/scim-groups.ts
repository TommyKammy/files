import { Hono } from 'hono';
import { chunkArray, executeBatchChunks } from '../utils/batch';
import {
  getClientIp,
  getScimContext,
  insertScimAuditStmt,
  parseScimPagination,
  scimError,
  scimJson,
  type ScimGroupDbRow,
  toScimGroupResource,
} from '../services/scim-helpers';
import {
  extractGroupMemberIds,
  isRecord,
  parseScimFilterEq,
  parseScimGroupPatch,
} from '../services/scim-parser';
import {
  SCIM_LIST_RESPONSE_SCHEMA,
  type ScimGroupMemberRef,
  type ScimGroupResource,
  type ScimHonoEnv,
  type ScimListResponse,
} from '../types/scim';

const D1_CHUNK_SIZE = 30;

export const scimGroupsRoutes = new Hono<ScimHonoEnv>();

async function loadGroupMembers(
  db: D1Database,
  tenantId: string,
  groupId: string
): Promise<ScimGroupMemberRef[]> {
  const rows = await db
    .prepare(
      `SELECT gm.user_id AS value, u.display_name AS display
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND u.tenant_id = ?
        ORDER BY gm.user_id ASC`
    )
    .bind(groupId, tenantId)
    .all<{ value: string; display: string }>();

  return rows.results.map((r) => ({ value: r.value, display: r.display }));
}

async function validateTenantUserIds(
  db: D1Database,
  tenantId: string,
  userIds: string[]
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const validIds = new Set<string>();
  for (const chunk of chunkArray(userIds, D1_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(`SELECT id FROM users WHERE tenant_id = ? AND id IN (${placeholders})`)
      .bind(tenantId, ...chunk)
      .all<{ id: string }>();
    for (const row of rows.results) {
      validIds.add(row.id);
    }
  }
  return userIds.filter((id) => !validIds.has(id));
}

function buildInsertMembersStmts(
  db: D1Database,
  groupId: string,
  userIds: string[],
  nowIso: string
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const chunk of chunkArray(userIds, D1_CHUNK_SIZE)) {
    for (const userId of chunk) {
      stmts.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO group_members (group_id, user_id, created_at) VALUES (?, ?, ?)'
          )
          .bind(groupId, userId, nowIso)
      );
    }
  }
  return stmts;
}

function buildDeleteMembersStmts(
  db: D1Database,
  groupId: string,
  userIds: string[]
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const chunk of chunkArray(userIds, D1_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    stmts.push(
      db
        .prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id IN (${placeholders})`)
        .bind(groupId, ...chunk)
    );
  }
  return stmts;
}

const executeStatementsInChunks = (db: D1Database, statements: D1PreparedStatement[]) =>
  executeBatchChunks(db, statements, D1_CHUNK_SIZE);

scimGroupsRoutes.get('/', async (c) => {
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

scimGroupsRoutes.get('/:id', async (c) => {
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

scimGroupsRoutes.post('/', async (c) => {
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

scimGroupsRoutes.put('/:id', async (c) => {
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

scimGroupsRoutes.patch('/:id', async (c) => {
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

scimGroupsRoutes.delete('/:id', async (c) => {
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
