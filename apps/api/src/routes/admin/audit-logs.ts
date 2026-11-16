import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import {
  getAuthenticatedUser,
  requireSecOrSysAdmin,
} from '../../services/authorization';
import type { OidcHonoEnv } from '../../types/oidc';
import type { AuditLogRow } from './shared';

export const auditLogsRoutes = new Hono<OidcHonoEnv>();
auditLogsRoutes.use('*', sessionAuthMiddleware({ required: true }), requireSecOrSysAdmin);

auditLogsRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const conditions = ['tenant_id = ?'];
  const binds: unknown[] = [user.tenantId];

  const action = c.req.query('action')?.trim();
  if (action) {
    conditions.push('action = ?');
    binds.push(action);
  }

  const status = c.req.query('status')?.trim();
  if (status === 'allowed' || status === 'blocked') {
    conditions.push('status = ?');
    binds.push(status);
  }

  const actorEmail = c.req.query('actorEmail')?.trim();
  if (actorEmail) {
    conditions.push('actor_email = ?');
    binds.push(actorEmail);
  }

  const targetId = c.req.query('targetId')?.trim();
  if (targetId) {
    conditions.push('target_id = ?');
    binds.push(targetId);
  }

  const fromIso = c.req.query('from')?.trim();
  if (fromIso) {
    conditions.push('created_at >= ?');
    binds.push(fromIso);
  }

  const toIso = c.req.query('to')?.trim();
  if (toIso) {
    conditions.push('created_at <= ?');
    binds.push(toIso);
  }

  const cursorCreatedAt = c.req.query('cursorCreatedAt')?.trim();
  const cursorId = c.req.query('cursorId')?.trim();
  if (cursorCreatedAt && cursorId) {
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    binds.push(cursorCreatedAt, cursorCreatedAt, cursorId);
  }

  binds.push(limit + 1);

  const rows = await c.env.DB.prepare(
    `SELECT id, tenant_id, actor_id, actor_email, actor_ip, action,
            target_type, target_id, classification_snapshot, status,
            metadata_json, created_at
     FROM audit_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  )
    .bind(...binds)
    .all<AuditLogRow>();

  const hasMore = rows.results.length > limit;
  const page = hasMore ? rows.results.slice(0, limit) : rows.results;
  const last = page[page.length - 1];

  if (c.req.query('format') === 'csv') {
    const csvEscape = (v: string | null | undefined) => {
      const s = v ?? '';
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = 'id,created_at,action,status,actor_email,actor_ip,target_type,target_id,classification,metadata_json';
    const lines = page.map((r) =>
      [
        r.id,
        r.created_at,
        r.action,
        r.status,
        r.actor_email,
        r.actor_ip,
        r.target_type,
        r.target_id,
        r.classification_snapshot,
        r.metadata_json,
      ]
        .map(csvEscape)
        .join(',')
    );
    return new Response([header, ...lines].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="files-audit-logs.csv"',
      },
    });
  }

  return c.json({
    logs: page.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorEmail: r.actor_email,
      actorIp: r.actor_ip,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      classificationSnapshot: r.classification_snapshot,
      status: r.status,
      metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
      createdAt: r.created_at,
    })),
    nextCursor:
      hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  });
});
