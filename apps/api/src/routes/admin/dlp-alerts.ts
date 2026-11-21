import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  DLP_ACTIONS,
  DLP_MAX_SCAN_CHARS,
  DLP_PATTERN_TYPES,
  scanText,
  validateCustomPattern,
  type DlpAction,
  type DlpPatternType,
} from '../../services/dlp-scanner';
import type { OidcHonoEnv } from '../../types/oidc';

interface DlpRuleRow {
  id: string;
  name: string;
  pattern_type: DlpPatternType;
  custom_pattern: string | null;
  action: DlpAction;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface SecurityAlertRow {
  id: string;
  alert_type: string;
  severity: string;
  title: string;
  details_json: string;
  target_type: string | null;
  target_id: string | null;
  actor_id: string | null;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

const NAME_MAX = 80;

function projectRule(row: DlpRuleRow) {
  return {
    id: row.id,
    name: row.name,
    patternType: row.pattern_type,
    customPattern: row.custom_pattern,
    action: row.action,
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectAlert(row: SecurityAlertRow) {
  let details: unknown = {};
  try {
    details = JSON.parse(row.details_json);
  } catch {
    details = {};
  }
  return {
    id: row.id,
    alertType: row.alert_type,
    severity: row.severity,
    title: row.title,
    details,
    targetType: row.target_type,
    targetId: row.target_id,
    actorId: row.actor_id,
    status: row.status,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

function isPatternType(v: unknown): v is DlpPatternType {
  return typeof v === 'string' && (DLP_PATTERN_TYPES as readonly string[]).includes(v);
}
function isAction(v: unknown): v is DlpAction {
  return typeof v === 'string' && (DLP_ACTIONS as readonly string[]).includes(v);
}

export function registerAdminDlpAlertRoutes(routes: Hono<OidcHonoEnv>) {
  routes.get('/dlp-rules', async (c) => {
    const user = getAuthenticatedUser(c);
    const rows = await c.env.DB.prepare(
      'SELECT * FROM dlp_rules WHERE tenant_id = ? ORDER BY created_at DESC, id'
    )
      .bind(user.tenantId)
      .all<DlpRuleRow>();
    return c.json({ rules: rows.results.map(projectRule) });
  });

  // Registered before `/dlp-rules/:id` routes; dry-run, never persists.
  routes.post('/dlp-rules/test', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      patternType?: unknown;
      customPattern?: unknown;
      sampleText?: unknown;
    } | null;
    if (!body || !isPatternType(body.patternType) || typeof body.sampleText !== 'string') {
      return c.json({ error: 'patternType and sampleText are required', code: 'INVALID_DLP_TEST' }, 400);
    }
    if (body.patternType === 'custom_regex') {
      const err = validateCustomPattern(body.customPattern);
      if (err) return c.json({ error: err, code: 'INVALID_DLP_PATTERN' }, 400);
    }
    const result = scanText(
      body.patternType,
      typeof body.customPattern === 'string' ? body.customPattern : null,
      body.sampleText.slice(0, DLP_MAX_SCAN_CHARS)
    );
    return c.json({ matched: result.matched, matchCount: result.matchCount });
  });

  routes.post('/dlp-rules', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      patternType?: unknown;
      customPattern?: unknown;
      action?: unknown;
      enabled?: unknown;
    } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!body || !name || name.length > NAME_MAX || !isPatternType(body.patternType)) {
      return c.json({ error: 'Valid name and patternType are required', code: 'INVALID_DLP_RULE' }, 400);
    }
    if (body.action !== undefined && !isAction(body.action)) {
      return c.json({ error: 'Invalid action', code: 'INVALID_DLP_RULE' }, 400);
    }
    let customPattern: string | null = null;
    if (body.patternType === 'custom_regex') {
      const err = validateCustomPattern(body.customPattern);
      if (err) return c.json({ error: err, code: 'INVALID_DLP_PATTERN' }, 400);
      customPattern = body.customPattern as string;
    }
    const id = crypto.randomUUID();
    const action: DlpAction = (body.action as DlpAction | undefined) ?? 'alert';
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO dlp_rules (id, tenant_id, name, pattern_type, custom_pattern, action, enabled, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        user.tenantId,
        name,
        body.patternType,
        customPattern,
        action,
        body.enabled === false ? 0 : 1,
        user.id
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: c.req.header('CF-Connecting-IP') ?? null,
        action: 'admin.dlp_rule.created',
        targetType: 'dlp_rule',
        targetId: id,
        metadata: { name, patternType: body.patternType, action },
      }),
    ]);
    const row = await c.env.DB.prepare('SELECT * FROM dlp_rules WHERE id = ?')
      .bind(id)
      .first<DlpRuleRow>();
    return c.json({ rule: projectRule(row!) }, 201);
  });

  routes.patch('/dlp-rules/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare(
      'SELECT * FROM dlp_rules WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<DlpRuleRow>();
    if (!existing) return c.json({ error: 'DLP rule not found', code: 'DLP_RULE_NOT_FOUND' }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      customPattern?: unknown;
      action?: unknown;
      enabled?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required', code: 'INVALID_DLP_RULE' }, 400);
    }
    let name = existing.name;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > NAME_MAX) {
        return c.json({ error: 'Invalid name', code: 'INVALID_DLP_RULE' }, 400);
      }
      name = body.name.trim();
    }
    let action = existing.action;
    if (body.action !== undefined) {
      if (!isAction(body.action)) return c.json({ error: 'Invalid action', code: 'INVALID_DLP_RULE' }, 400);
      action = body.action;
    }
    let customPattern = existing.custom_pattern;
    if (body.customPattern !== undefined) {
      if (existing.pattern_type !== 'custom_regex') {
        return c.json({ error: 'customPattern only applies to custom_regex', code: 'INVALID_DLP_RULE' }, 400);
      }
      const err = validateCustomPattern(body.customPattern);
      if (err) return c.json({ error: err, code: 'INVALID_DLP_PATTERN' }, 400);
      customPattern = body.customPattern as string;
    }
    let enabled = existing.enabled;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json({ error: 'enabled must be boolean', code: 'INVALID_DLP_RULE' }, 400);
      }
      enabled = body.enabled ? 1 : 0;
    }
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE dlp_rules SET name = ?, custom_pattern = ?, action = ?, enabled = ?, updated_at = datetime('now')
          WHERE tenant_id = ? AND id = ?`
      ).bind(name, customPattern, action, enabled, user.tenantId, id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: c.req.header('CF-Connecting-IP') ?? null,
        action: 'admin.dlp_rule.updated',
        targetType: 'dlp_rule',
        targetId: id,
        metadata: { name, action, enabled: enabled === 1 },
      }),
    ]);
    const row = await c.env.DB.prepare('SELECT * FROM dlp_rules WHERE id = ?')
      .bind(id)
      .first<DlpRuleRow>();
    return c.json({ rule: projectRule(row!) });
  });

  routes.delete('/dlp-rules/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const id = c.req.param('id');
    const existing = await c.env.DB.prepare(
      'SELECT id, name FROM dlp_rules WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first<{ id: string; name: string }>();
    if (!existing) return c.json({ error: 'DLP rule not found', code: 'DLP_RULE_NOT_FOUND' }, 404);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM dlp_rules WHERE tenant_id = ? AND id = ?').bind(user.tenantId, id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: c.req.header('CF-Connecting-IP') ?? null,
        action: 'admin.dlp_rule.deleted',
        targetType: 'dlp_rule',
        targetId: id,
        metadata: { name: existing.name },
      }),
    ]);
    return c.json({ ok: true });
  });

  routes.get('/security-alerts', async (c) => {
    const user = getAuthenticatedUser(c);
    const statusParam = c.req.query('status') ?? 'open';
    if (!['open', 'all', 'acknowledged', 'resolved'].includes(statusParam)) {
      return c.json({ error: 'Invalid status filter', code: 'INVALID_ALERT_STATUS' }, 400);
    }
    const rows =
      statusParam === 'all'
        ? await c.env.DB.prepare(
            `SELECT * FROM security_alerts WHERE tenant_id = ? ORDER BY created_at DESC, id LIMIT 200`
          )
            .bind(user.tenantId)
            .all<SecurityAlertRow>()
        : await c.env.DB.prepare(
            `SELECT * FROM security_alerts WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC, id LIMIT 200`
          )
            .bind(user.tenantId, statusParam)
            .all<SecurityAlertRow>();
    return c.json({ alerts: rows.results.map(projectAlert) });
  });

  routes.patch('/security-alerts/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
    if (
      !body ||
      (body.status !== 'acknowledged' && body.status !== 'resolved' && body.status !== 'open')
    ) {
      return c.json({ error: 'status must be acknowledged, resolved or open', code: 'INVALID_ALERT_STATUS' }, 400);
    }
    const existing = await c.env.DB.prepare(
      'SELECT id FROM security_alerts WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, id)
      .first();
    if (!existing) return c.json({ error: 'Alert not found', code: 'ALERT_NOT_FOUND' }, 404);
    const resolving = body.status === 'resolved';
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE security_alerts
            SET status = ?, resolved_by = ?, resolved_at = ${resolving ? "datetime('now')" : 'NULL'}
          WHERE tenant_id = ? AND id = ?`
      ).bind(body.status, resolving ? user.id : null, user.tenantId, id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: c.req.header('CF-Connecting-IP') ?? null,
        action: 'admin.security_alert.updated',
        targetType: 'security_alert',
        targetId: id,
        metadata: { status: body.status },
      }),
    ]);
    const row = await c.env.DB.prepare('SELECT * FROM security_alerts WHERE id = ?')
      .bind(id)
      .first<SecurityAlertRow>();
    return c.json({ alert: projectAlert(row!) });
  });
}
