import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  requireSecOrSysAdmin,
} from '../../services/authorization';
import type { OidcHonoEnv } from '../../types/oidc';

const VALID_HOLD_TARGET_TYPES = new Set(['folder', 'file', 'user']);
const VALID_RETENTION_TARGET_TYPES = new Set(['folder', 'classification']);
const VALID_CLASSIFICATIONS = new Set([
  'public',
  'internal',
  'confidential',
  'restricted',
]);
const MAX_NAME_LENGTH = 200;
const MAX_REASON_LENGTH = 1000;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;

interface LegalHoldRow {
  id: string;
  tenant_id: string;
  name: string;
  reason: string | null;
  target_type: 'folder' | 'file' | 'user';
  target_id: string;
  status: 'active' | 'released';
  created_by: string;
  released_by: string | null;
  released_at: string | null;
  created_at: string;
}

interface RetentionPolicyRow {
  id: string;
  tenant_id: string;
  name: string;
  target_type: 'folder' | 'classification';
  target_value: string;
  retention_days: number;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function projectLegalHold(row: LegalHoldRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    reason: row.reason,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    createdBy: row.created_by,
    releasedBy: row.released_by,
    releasedAt: row.released_at,
    createdAt: row.created_at,
  };
}

function projectRetentionPolicy(row: RetentionPolicyRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    targetType: row.target_type,
    targetValue: row.target_value,
    retentionDays: row.retention_days,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseNonEmptyString(
  value: unknown,
  maxLength: number
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

export function registerAdminLegalHoldRoutes(routes: Hono<OidcHonoEnv>) {
  routes.use('/legal-holds', requireSecOrSysAdmin);
  routes.use('/legal-holds/*', requireSecOrSysAdmin);
  routes.use('/retention-policies', requireSecOrSysAdmin);
  routes.use('/retention-policies/*', requireSecOrSysAdmin);

  /** GET /api/admin/legal-holds — list legal holds for the tenant. */
  routes.get('/legal-holds', async (c) => {
    const user = getAuthenticatedUser(c);
    const statusFilter = c.req.query('status') ?? 'all';
    if (
      statusFilter !== 'all' &&
      statusFilter !== 'active' &&
      statusFilter !== 'released'
    ) {
      return c.json(
        { error: 'status must be all, active, or released', code: 'INVALID_STATUS' },
        400
      );
    }

    const sql =
      statusFilter === 'all'
        ? `SELECT * FROM legal_holds WHERE tenant_id = ? ORDER BY created_at DESC, id DESC`
        : `SELECT * FROM legal_holds WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC, id DESC`;
    const stmt =
      statusFilter === 'all'
        ? c.env.DB.prepare(sql).bind(user.tenantId)
        : c.env.DB.prepare(sql).bind(user.tenantId, statusFilter);
    const res = await stmt.all<LegalHoldRow>();

    return c.json({
      legalHolds: res.results.map(projectLegalHold),
    });
  });

  /** POST /api/admin/legal-holds — create an active legal hold. */
  routes.post('/legal-holds', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      reason?: unknown;
      targetType?: unknown;
      targetId?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required', code: 'INVALID_BODY' }, 400);
    }

    const name = parseNonEmptyString(body.name, MAX_NAME_LENGTH);
    if (!name) {
      return c.json(
        { error: 'name must be a non-empty string (max 200 chars)', code: 'INVALID_NAME' },
        400
      );
    }

    let reason: string | null = null;
    if (body.reason !== undefined && body.reason !== null) {
      if (typeof body.reason !== 'string' || body.reason.trim().length > MAX_REASON_LENGTH) {
        return c.json(
          { error: 'reason must be a string (max 1000 chars)', code: 'INVALID_REASON' },
          400
        );
      }
      const trimmedReason = body.reason.trim();
      reason = trimmedReason.length > 0 ? trimmedReason : null;
    }

    if (
      typeof body.targetType !== 'string' ||
      !VALID_HOLD_TARGET_TYPES.has(body.targetType)
    ) {
      return c.json(
        { error: 'targetType must be folder, file, or user', code: 'INVALID_TARGET_TYPE' },
        400
      );
    }
    const targetType = body.targetType as 'folder' | 'file' | 'user';

    const targetId = parseNonEmptyString(body.targetId, 200);
    if (!targetId) {
      return c.json(
        { error: 'targetId must be a non-empty string', code: 'INVALID_TARGET_ID' },
        400
      );
    }

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO legal_holds
           (id, tenant_id, name, reason, target_type, target_id, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).bind(id, user.tenantId, name, reason, targetType, targetId, user.id, nowIso),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'legal_hold.create',
        targetType: 'legal_hold',
        targetId: id,
        metadata: { name, reason, targetType, targetId },
        nowIso,
      }),
    ]);

    const created = await c.env.DB.prepare(
      'SELECT * FROM legal_holds WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<LegalHoldRow>();

    return c.json(
      { ok: true, legalHold: projectLegalHold(created!) },
      201
    );
  });

  /** POST /api/admin/legal-holds/:id/release — release an active legal hold. */
  routes.post('/legal-holds/:id/release', async (c) => {
    const user = getAuthenticatedUser(c);
    const id = c.req.param('id');

    const existing = await c.env.DB.prepare(
      'SELECT * FROM legal_holds WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<LegalHoldRow>();

    if (!existing) {
      return c.json({ error: 'Legal hold not found', code: 'NOT_FOUND' }, 404);
    }
    if (existing.status === 'released') {
      return c.json(
        { error: 'Legal hold is already released', code: 'ALREADY_RELEASED' },
        409
      );
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE legal_holds
            SET status = 'released',
                released_by = ?,
                released_at = ?
          WHERE tenant_id = ? AND id = ? AND status = 'active'`
      ).bind(user.id, nowIso, user.tenantId, id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'legal_hold.release',
        targetType: 'legal_hold',
        targetId: id,
        metadata: {
          name: existing.name,
          targetType: existing.target_type,
          targetId: existing.target_id,
        },
        nowIso,
      }),
    ]);

    const updated = await c.env.DB.prepare(
      'SELECT * FROM legal_holds WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<LegalHoldRow>();

    return c.json({ ok: true, legalHold: projectLegalHold(updated!) });
  });

  /** GET /api/admin/retention-policies — list retention policies for the tenant. */
  routes.get('/retention-policies', async (c) => {
    const user = getAuthenticatedUser(c);
    const res = await c.env.DB.prepare(
      'SELECT * FROM retention_policies WHERE tenant_id = ? ORDER BY created_at DESC, id DESC'
    )
      .bind(user.tenantId)
      .all<RetentionPolicyRow>();

    return c.json({
      retentionPolicies: res.results.map(projectRetentionPolicy),
    });
  });

  /** POST /api/admin/retention-policies — create a retention policy. */
  routes.post('/retention-policies', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      targetType?: unknown;
      targetValue?: unknown;
      retentionDays?: unknown;
      enabled?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required', code: 'INVALID_BODY' }, 400);
    }

    const name = parseNonEmptyString(body.name, MAX_NAME_LENGTH);
    if (!name) {
      return c.json(
        { error: 'name must be a non-empty string (max 200 chars)', code: 'INVALID_NAME' },
        400
      );
    }

    if (
      typeof body.targetType !== 'string' ||
      !VALID_RETENTION_TARGET_TYPES.has(body.targetType)
    ) {
      return c.json(
        { error: 'targetType must be folder or classification', code: 'INVALID_TARGET_TYPE' },
        400
      );
    }
    const targetType = body.targetType as 'folder' | 'classification';

    const targetValue = parseNonEmptyString(body.targetValue, 200);
    if (!targetValue) {
      return c.json(
        { error: 'targetValue must be a non-empty string', code: 'INVALID_TARGET_VALUE' },
        400
      );
    }
    if (
      targetType === 'classification' &&
      !VALID_CLASSIFICATIONS.has(targetValue)
    ) {
      return c.json(
        {
          error:
            'classification targetValue must be public, internal, confidential, or restricted',
          code: 'INVALID_CLASSIFICATION',
        },
        400
      );
    }

    if (
      typeof body.retentionDays !== 'number' ||
      !Number.isInteger(body.retentionDays) ||
      body.retentionDays < MIN_RETENTION_DAYS ||
      body.retentionDays > MAX_RETENTION_DAYS
    ) {
      return c.json(
        {
          error: `retentionDays must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
          code: 'INVALID_RETENTION_DAYS',
        },
        400
      );
    }

    let enabled = true;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json(
          { error: 'enabled must be a boolean', code: 'INVALID_ENABLED' },
          400
        );
      }
      enabled = body.enabled;
    }

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO retention_policies
           (id, tenant_id, name, target_type, target_value, retention_days, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        user.tenantId,
        name,
        targetType,
        targetValue,
        body.retentionDays,
        enabled ? 1 : 0,
        user.id,
        nowIso,
        nowIso
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'retention_policy.create',
        targetType: 'retention_policy',
        targetId: id,
        metadata: {
          name,
          targetType,
          targetValue,
          retentionDays: body.retentionDays,
          enabled,
        },
        nowIso,
      }),
    ]);

    const created = await c.env.DB.prepare(
      'SELECT * FROM retention_policies WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<RetentionPolicyRow>();

    return c.json(
      { ok: true, retentionPolicy: projectRetentionPolicy(created!) },
      201
    );
  });

  /** PATCH /api/admin/retention-policies/:id — update name, retentionDays, or enabled. */
  routes.patch('/retention-policies/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      retentionDays?: unknown;
      enabled?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required', code: 'INVALID_BODY' }, 400);
    }

    const existing = await c.env.DB.prepare(
      'SELECT * FROM retention_policies WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<RetentionPolicyRow>();

    if (!existing) {
      return c.json({ error: 'Retention policy not found', code: 'NOT_FOUND' }, 404);
    }

    let nextName = existing.name;
    if (body.name !== undefined) {
      const parsedName = parseNonEmptyString(body.name, MAX_NAME_LENGTH);
      if (!parsedName) {
        return c.json(
          { error: 'name must be a non-empty string (max 200 chars)', code: 'INVALID_NAME' },
          400
        );
      }
      nextName = parsedName;
    }

    let nextDays = existing.retention_days;
    if (body.retentionDays !== undefined) {
      if (
        typeof body.retentionDays !== 'number' ||
        !Number.isInteger(body.retentionDays) ||
        body.retentionDays < MIN_RETENTION_DAYS ||
        body.retentionDays > MAX_RETENTION_DAYS
      ) {
        return c.json(
          {
            error: `retentionDays must be an integer between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}`,
            code: 'INVALID_RETENTION_DAYS',
          },
          400
        );
      }
      nextDays = body.retentionDays;
    }

    let nextEnabled = existing.enabled === 1;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json(
          { error: 'enabled must be a boolean', code: 'INVALID_ENABLED' },
          400
        );
      }
      nextEnabled = body.enabled;
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE retention_policies
            SET name = ?,
                retention_days = ?,
                enabled = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(nextName, nextDays, nextEnabled ? 1 : 0, nowIso, user.tenantId, id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'retention_policy.update',
        targetType: 'retention_policy',
        targetId: id,
        metadata: {
          name: nextName,
          retentionDays: nextDays,
          enabled: nextEnabled,
        },
        nowIso,
      }),
    ]);

    const updated = await c.env.DB.prepare(
      'SELECT * FROM retention_policies WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<RetentionPolicyRow>();

    return c.json({ ok: true, retentionPolicy: projectRetentionPolicy(updated!) });
  });

  /** DELETE /api/admin/retention-policies/:id — delete a retention policy. */
  routes.delete('/retention-policies/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const id = c.req.param('id');

    const existing = await c.env.DB.prepare(
      'SELECT * FROM retention_policies WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<RetentionPolicyRow>();

    if (!existing) {
      return c.json({ error: 'Retention policy not found', code: 'NOT_FOUND' }, 404);
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM retention_policies WHERE tenant_id = ? AND id = ?'
      ).bind(user.tenantId, id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'retention_policy.delete',
        targetType: 'retention_policy',
        targetId: id,
        metadata: {
          name: existing.name,
          targetType: existing.target_type,
          targetValue: existing.target_value,
          retentionDays: existing.retention_days,
        },
        nowIso,
      }),
    ]);

    return c.json({ ok: true });
  });
}
