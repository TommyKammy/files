import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  countEffectiveOwners,
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import { buildSyncChangeStmt } from '../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../services/sync-notifier';
import type { ResourceRole } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';

const VALID_TARGET_TYPES = new Set(['folder', 'file']);
const VALID_GRANTEE_TYPES = new Set(['user', 'group']);
const VALID_RESOURCE_ROLES = new Set<ResourceRole>([
  'owner',
  'co_owner',
  'editor',
  'viewer',
  'previewer',
]);

interface PermissionListRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  role: ResourceRole;
  granted_by: string;
  created_at: string;
  grantee_name: string | null;
  grantee_email: string | null;
  source_name: string | null;
  is_inherited: number;
}

export const permissionsRoutes = new Hono<OidcHonoEnv>();

permissionsRoutes.use('/permissions', sessionAuthMiddleware({ required: true }));
permissionsRoutes.use('/permissions/*', sessionAuthMiddleware({ required: true }));
permissionsRoutes.use('/principals/*', sessionAuthMiddleware({ required: true }));

/** GET /api/permissions?targetType=folder|file&targetId=... */
permissionsRoutes.get('/permissions', async (c) => {
  const user = getAuthenticatedUser(c);
  const targetType = c.req.query('targetType') as 'folder' | 'file' | undefined;
  const targetId = c.req.query('targetId');

  if (!targetType || !VALID_TARGET_TYPES.has(targetType) || !targetId) {
    return c.json({ error: 'targetType (folder|file) and targetId are required' }, 400);
  }

  const access = await resolveTargetAccess(c.env.DB, user, targetType, targetId);
  if (!access || access.deletedAt !== null) {
    return c.json({ error: 'Target resource not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'viewer')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  let sql: string;
  let bindings: unknown[];

  if (targetType === 'folder') {
    sql = `
      SELECT p.id,
             p.target_type,
             p.target_id,
             p.grantee_type,
             p.grantee_id,
             p.role,
             p.granted_by,
             p.created_at,
             COALESCE(u.display_name, g.name) AS grantee_name,
             u.email AS grantee_email,
             anc.name AS source_name,
             CASE WHEN p.target_id = ? THEN 0 ELSE 1 END AS is_inherited
        FROM folder_closures fc
        JOIN permissions p
          ON p.tenant_id = fc.tenant_id
         AND p.target_type = 'folder'
         AND p.target_id = fc.ancestor_id
        LEFT JOIN folders anc ON anc.id = p.target_id
        LEFT JOIN users u ON p.grantee_type = 'user' AND u.id = p.grantee_id
        LEFT JOIN groups g ON p.grantee_type = 'group' AND g.id = p.grantee_id
       WHERE fc.tenant_id = ? AND fc.descendant_id = ?
       ORDER BY is_inherited ASC, p.created_at ASC`;
    bindings = [targetId, user.tenantId, targetId];
  } else {
    sql = `
      SELECT p.id,
             p.target_type,
             p.target_id,
             p.grantee_type,
             p.grantee_id,
             p.role,
             p.granted_by,
             p.created_at,
             COALESCE(u.display_name, g.name) AS grantee_name,
             u.email AS grantee_email,
             CASE WHEN p.target_type = 'file' THEN NULL ELSE anc.name END AS source_name,
             CASE WHEN p.target_type = 'file' THEN 0 ELSE 1 END AS is_inherited
        FROM permissions p
        LEFT JOIN folders anc ON p.target_type = 'folder' AND anc.id = p.target_id
        LEFT JOIN users u ON p.grantee_type = 'user' AND u.id = p.grantee_id
        LEFT JOIN groups g ON p.grantee_type = 'group' AND g.id = p.grantee_id
       WHERE p.tenant_id = ?
         AND (
           (p.target_type = 'file' AND p.target_id = ?)
           OR (
             p.target_type = 'folder'
             AND ? IS NOT NULL
             AND p.target_id IN (
               SELECT fc.ancestor_id
                 FROM folder_closures fc
                WHERE fc.tenant_id = ? AND fc.descendant_id = ?
             )
           )
         )
       ORDER BY is_inherited ASC, p.created_at ASC`;
    bindings = [
      user.tenantId,
      targetId,
      access.folderId,
      user.tenantId,
      access.folderId ?? '',
    ];
  }

  const rows = await c.env.DB.prepare(sql)
    .bind(...bindings)
    .all<PermissionListRow>();

  return c.json({
    targetType,
    targetId,
    effectiveRole: access.effectiveRole,
    permissions: rows.results.map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      granteeType: r.grantee_type,
      granteeId: r.grantee_id,
      granteeName: r.grantee_name,
      granteeEmail: r.grantee_email,
      role: r.role,
      inherited: r.is_inherited === 1,
      sourceName: r.source_name,
      grantedBy: r.granted_by,
      createdAt: r.created_at,
    })),
  });
});

/** POST /api/permissions — grant or update a direct RBAC role (UPSERT) */
permissionsRoutes.post('/permissions', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    targetType?: string;
    targetId?: string;
    granteeType?: string;
    granteeId?: string;
    role?: string;
  } | null;

  if (
    !body ||
    !body.targetType ||
    !VALID_TARGET_TYPES.has(body.targetType) ||
    !body.targetId ||
    !body.granteeType ||
    !VALID_GRANTEE_TYPES.has(body.granteeType) ||
    !body.granteeId ||
    !body.role ||
    !VALID_RESOURCE_ROLES.has(body.role as ResourceRole)
  ) {
    return c.json({ error: 'Invalid permission payload' }, 400);
  }

  const targetType = body.targetType as 'folder' | 'file';
  const targetId = body.targetId;
  const granteeType = body.granteeType as 'user' | 'group';
  const granteeId = body.granteeId;
  const requestedRole = body.role as ResourceRole;

  const access = await resolveTargetAccess(c.env.DB, user, targetType, targetId);
  if (!access || access.deletedAt !== null) {
    return c.json({ error: 'Target resource not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'co_owner')) {
    return c.json({ error: 'Forbidden: co_owner or owner required to manage permissions' }, 403);
  }

  // Guardrail 1: co_owner cannot grant owner role
  if (requestedRole === 'owner' && access.effectiveRole !== 'owner') {
    return c.json(
      { error: 'Forbidden: only an owner can grant the owner role', code: 'OWNER_ESCALATION_BLOCKED' },
      403
    );
  }

  // Validate grantee exists in same tenant and is not suspended
  if (granteeType === 'user') {
    const granteeUser = await c.env.DB.prepare(
      'SELECT id, status FROM users WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, granteeId)
      .first<{ id: string; status: 'active' | 'suspended' }>();
    if (!granteeUser) {
      return c.json({ error: 'Target user not found in tenant' }, 404);
    }
    if (granteeUser.status !== 'active') {
      return c.json(
        { error: 'Cannot grant permissions to a suspended user', code: 'SUSPENDED_USER_BLOCKED' },
        400
      );
    }
  } else {
    const granteeGroup = await c.env.DB.prepare(
      'SELECT id FROM groups WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, granteeId)
      .first<{ id: string }>();
    if (!granteeGroup) {
      return c.json({ error: 'Target group not found in tenant' }, 404);
    }
  }

  const existing = await c.env.DB.prepare(
    `SELECT id, role
       FROM permissions
      WHERE tenant_id = ? AND target_type = ? AND target_id = ?
        AND grantee_type = ? AND grantee_id = ?`
  )
    .bind(user.tenantId, targetType, targetId, granteeType, granteeId)
    .first<{ id: string; role: ResourceRole }>();

  // Guardrail 2: co_owner cannot modify/demote an existing owner
  if (existing?.role === 'owner' && access.effectiveRole !== 'owner') {
    return c.json(
      { error: 'Forbidden: co_owner cannot modify an existing owner permission' },
      403
    );
  }

  // Guardrail 3: prevent demoting the last remaining owner
  if (existing?.role === 'owner' && requestedRole !== 'owner') {
    const ownerCount = await countEffectiveOwners(
      c.env.DB,
      user.tenantId,
      targetType,
      targetId,
      access.folderId
    );
    if (ownerCount <= 1) {
      return c.json(
        {
          error: 'Cannot demote the last owner of this resource',
          code: 'LAST_OWNER_LOCKOUT',
        },
        409
      );
    }
  }

  const nowIso = new Date().toISOString();
  const permissionId = existing?.id ?? crypto.randomUUID();
  const syncFolderId = targetType === 'folder' ? targetId : access.folderId;

  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO permissions (
         id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
       DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by`
    ).bind(
      permissionId,
      user.tenantId,
      targetType,
      targetId,
      granteeType,
      granteeId,
      requestedRole,
      user.id,
      nowIso
    ),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: existing ? 'permission.update' : 'permission.grant',
      targetType,
      targetId,
      classificationSnapshot: access.classification,
      metadata: {
        permissionId,
        granteeType,
        granteeId,
        previousRole: existing?.role ?? null,
        role: requestedRole,
      },
      nowIso,
    }),
    buildSyncChangeStmt(c.env.DB, {
      tenantId: user.tenantId,
      entityType: 'permission',
      entityId: permissionId,
      folderId: syncFolderId,
      targetUserId: granteeType === 'user' ? granteeId : null,
      action: existing ? 'permission.update' : 'permission.grant',
      payload: {
        permissionId,
        targetType,
        targetId,
        granteeType,
        granteeId,
        previousRole: existing?.role ?? null,
        role: requestedRole,
        updatedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: existing ? 'permission.update' : 'permission.grant',
    scopeFolderIds: [syncFolderId],
    targetUserId: granteeType === 'user' ? granteeId : null,
  });

  return c.json(
    {
      permission: {
        id: permissionId,
        targetType,
        targetId,
        granteeType,
        granteeId,
        role: requestedRole,
        grantedBy: user.id,
      },
    },
    existing ? 200 : 201
  );
});

/** DELETE /api/permissions/:id — revoke a direct permission with last-owner protection */
permissionsRoutes.delete('/permissions/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const permissionId = c.req.param('id');

  const perm = await c.env.DB.prepare(
    `SELECT id, target_type, target_id, grantee_type, grantee_id, role
       FROM permissions
      WHERE tenant_id = ? AND id = ?`
  )
    .bind(user.tenantId, permissionId)
    .first<{
      id: string;
      target_type: 'folder' | 'file';
      target_id: string;
      grantee_type: 'user' | 'group';
      grantee_id: string;
      role: ResourceRole;
    }>();

  if (!perm) {
    return c.json({ error: 'Permission not found' }, 404);
  }

  const access = await resolveTargetAccess(
    c.env.DB,
    user,
    perm.target_type,
    perm.target_id
  );
  if (!access || access.deletedAt !== null) {
    return c.json({ error: 'Target resource not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'co_owner')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (perm.role === 'owner') {
    if (access.effectiveRole !== 'owner') {
      return c.json(
        { error: 'Forbidden: co_owner cannot revoke an owner permission' },
        403
      );
    }
    const ownerCount = await countEffectiveOwners(
      c.env.DB,
      user.tenantId,
      perm.target_type,
      perm.target_id,
      access.folderId
    );
    if (ownerCount <= 1) {
      return c.json(
        {
          error: 'Cannot remove the last owner of this resource',
          code: 'LAST_OWNER_LOCKOUT',
        },
        409
      );
    }
  }

  const nowIso = new Date().toISOString();
  const syncFolderId = perm.target_type === 'folder' ? perm.target_id : access.folderId;

  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM permissions WHERE tenant_id = ? AND id = ?').bind(
      user.tenantId,
      permissionId
    ),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'permission.revoke',
      targetType: perm.target_type,
      targetId: perm.target_id,
      classificationSnapshot: access.classification,
      metadata: {
        permissionId,
        granteeType: perm.grantee_type,
        granteeId: perm.grantee_id,
        revokedRole: perm.role,
      },
      nowIso,
    }),
    buildSyncChangeStmt(c.env.DB, {
      tenantId: user.tenantId,
      entityType: 'permission',
      entityId: permissionId,
      folderId: syncFolderId,
      targetUserId: perm.grantee_type === 'user' ? perm.grantee_id : null,
      action: 'permission.revoke',
      payload: {
        permissionId,
        targetType: perm.target_type,
        targetId: perm.target_id,
        granteeType: perm.grantee_type,
        granteeId: perm.grantee_id,
        revokedRole: perm.role,
        updatedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: 'permission.revoke',
    scopeFolderIds: [syncFolderId],
    targetUserId: perm.grantee_type === 'user' ? perm.grantee_id : null,
    revoked: true,
  });

  return c.json({ ok: true, id: permissionId });
});

/** GET /api/principals/search?q=... — SCIM-provisioned active users & groups search */
permissionsRoutes.get('/principals/search', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawQuery = (c.req.query('q') ?? '').trim();
  const pattern = `%${rawQuery.replace(/[%_\\]/g, '\\$&')}%`;

  const [usersRes, groupsRes] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, display_name, email, department
         FROM users
        WHERE tenant_id = ? AND status = 'active'
          AND (display_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
        ORDER BY display_name ASC
        LIMIT 15`
    )
      .bind(user.tenantId, pattern, pattern)
      .all<{
        id: string;
        display_name: string;
        email: string;
        department: string | null;
      }>(),
    c.env.DB.prepare(
      `SELECT id, name
         FROM groups
        WHERE tenant_id = ? AND name LIKE ? ESCAPE '\\'
        ORDER BY name ASC
        LIMIT 10`
    )
      .bind(user.tenantId, pattern)
      .all<{ id: string; name: string }>(),
  ]);

  return c.json({
    principals: [
      ...usersRes.results.map((u) => ({
        type: 'user' as const,
        id: u.id,
        displayName: u.display_name,
        email: u.email,
        department: u.department,
      })),
      ...groupsRes.results.map((g) => ({
        type: 'group' as const,
        id: g.id,
        displayName: g.name,
        email: null,
        department: null,
      })),
    ],
  });
});
