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
} from '../services/scim-helpers';
import {
  normalizeScimUserPayload,
  parseScimFilterEq,
  parseScimUserPatch,
} from '../services/scim-parser';
import {
  SCIM_LIST_RESPONSE_SCHEMA,
  type ScimHonoEnv,
  type ScimListResponse,
  type ScimUserResource,
} from '../types/scim';
import { buildSyncChangeStmt } from '../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../services/sync-notifier';

const USER_SELECT_COLUMNS =
  'id, tenant_id, idp_issuer, external_idp_id, email, display_name, department, status, created_at, updated_at';

export const scimUsersRoutes = new Hono<ScimHonoEnv>();

scimUsersRoutes.get('/', async (c) => {
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

scimUsersRoutes.get('/:id', async (c) => {
  const scim = getScimContext(c);
  const userId = c.req.param('id');

  const row = await c.env.DB.prepare(
    `SELECT ${USER_SELECT_COLUMNS} FROM users WHERE tenant_id = ? AND id = ?`
  )
    .bind(scim.tenantId, userId)
    .first<ScimUserDbRow>();

  if (!row) {
    return scimError(c, 404, `User ${userId} not found`);
  }
  return scimJson(c, toScimUserResource(row));
});

scimUsersRoutes.post('/', async (c) => {
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

async function applyUserUpdate(
  db: D1Database,
  existing: ScimUserDbRow,
  updates: {
    externalIdpId?: string | null;
    email?: string;
    displayName?: string;
    department?: string | null;
    active?: boolean;
  },
  scim: ReturnType<typeof getScimContext>,
  actorIp: string
): Promise<{ user: ScimUserDbRow; syncSeq: number | null }> {
  const nextEmail = updates.email ?? existing.email;
  const nextDisplayName = updates.displayName ?? existing.display_name;
  const nextDepartment =
    updates.department !== undefined ? updates.department : existing.department;
  const nextExternalId =
    updates.externalIdpId !== undefined ? updates.externalIdpId : existing.external_idp_id;
  const nextStatus: 'active' | 'suspended' =
    updates.active === undefined
      ? existing.status
      : updates.active
        ? 'active'
        : 'suspended';

  const nowIso = new Date().toISOString();
  const isSuspending = nextStatus === 'suspended';

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE users
            SET idp_issuer = COALESCE(idp_issuer, ?),
                external_idp_id = ?,
                email = ?,
                display_name = ?,
                department = ?,
                status = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .bind(
        scim.idpIssuer,
        nextExternalId,
        nextEmail,
        nextDisplayName,
        nextDepartment,
        nextStatus,
        nowIso,
        scim.tenantId,
        existing.id
      ),
  ];

  // Immediately revoke all active sessions whenever active=false / suspended is applied
  if (isSuspending) {
    statements.push(
      db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, scim.tenantId, existing.id)
    );
    if (existing.status !== 'suspended') {
      statements.push(
        buildSyncChangeStmt(db, {
          tenantId: scim.tenantId,
          entityType: 'user',
          entityId: existing.id,
          targetUserId: existing.id,
          action: 'user.suspended',
          payload: {
            previousStatus: existing.status,
            status: 'suspended',
            updatedAt: nowIso,
          },
          nowIso,
        })
      );
    }
  }

  statements.push(
    insertScimAuditStmt(db, {
      scim,
      actorIp,
      action:
        isSuspending && existing.status !== 'suspended'
          ? 'scim.user_suspend'
          : 'scim.user_update',
      targetType: 'user',
      targetId: existing.id,
      metadata: {
        previousStatus: existing.status,
        nextStatus,
        email: nextEmail,
      },
      nowIso,
    })
  );

  const batchResults = await db.batch(statements);

  return {
    user: {
      ...existing,
      idp_issuer: existing.idp_issuer ?? scim.idpIssuer,
      external_idp_id: nextExternalId,
      email: nextEmail,
      display_name: nextDisplayName,
      department: nextDepartment,
      status: nextStatus,
      updated_at: nowIso,
    },
    syncSeq: extractLastSyncSeq(batchResults),
  };
}

scimUsersRoutes.put('/:id', async (c) => {
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

  try {
    const { user: updated, syncSeq } = await applyUserUpdate(
      c.env.DB,
      existing,
      normalized,
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

scimUsersRoutes.patch('/:id', async (c) => {
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

scimUsersRoutes.delete('/:id', async (c) => {
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
