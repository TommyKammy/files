import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import {
  getAuthenticatedUser,
  requireMemberUser,
  requireSecOrSysAdmin,
} from '../../services/authorization';
import type { OidcHonoEnv } from '../../types/oidc';
import type { AuditLogRow } from './shared';

export const auditLogsRoutes = new Hono<OidcHonoEnv>();
auditLogsRoutes.use(
  '*',
  sessionAuthMiddleware({ required: true }),
  requireMemberUser,
  requireSecOrSysAdmin
);

const MAX_AUDIT_ACTION_FILTERS = 20;
const MAX_AUDIT_ACTION_LENGTH = 120;

type ActionFilterResult =
  | { ok: true; actions: string[] }
  | { ok: false; error: string };
type ActionPrefixFilterResult =
  | { ok: true; prefixes: string[] }
  | { ok: false; error: string };

/** Escape LIKE metacharacters so a prefix is always a literal prefix match. */
function escapeLikePrefix(prefix: string): string {
  return prefix
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Parse `actionPrefix` and the additive `actionPrefixes` filter. Both accept
 * comma-separated values and repeated query keys; the same 20-item / 120-char
 * bounds as exact actions keep the generated `LIKE ... OR ...` bounded.
 */
function parseAuditActionPrefixFilters(c: {
  req: {
    query: (name: string) => string | undefined;
    queries: (name: string) => string[] | undefined;
  };
}): ActionPrefixFilterResult {
  const prefixes: string[] = [];
  const seen = new Set<string>();
  let sawPrefixesParam = false;

  const single = c.req.query('actionPrefix');
  if (single !== undefined) {
    for (const part of single.split(',')) {
      const prefix = part.trim();
      if (!prefix) continue;
      if (prefix.length > MAX_AUDIT_ACTION_LENGTH) {
        return {
          ok: false,
          error: `Each action prefix must be at most ${MAX_AUDIT_ACTION_LENGTH} characters`,
        };
      }
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      prefixes.push(prefix);
    }
  }

  const repeated = c.req.queries('actionPrefixes');
  if (repeated && repeated.length > 0) {
    sawPrefixesParam = true;
    for (const raw of repeated) {
      for (const part of raw.split(',')) {
        const prefix = part.trim();
        if (!prefix) continue;
        if (prefix.length > MAX_AUDIT_ACTION_LENGTH) {
          return {
            ok: false,
            error: `Each action prefix must be at most ${MAX_AUDIT_ACTION_LENGTH} characters`,
          };
        }
        if (seen.has(prefix)) continue;
        seen.add(prefix);
        prefixes.push(prefix);
      }
    }
  }

  if (sawPrefixesParam && prefixes.length === 0) {
    return {
      ok: false,
      error: 'actionPrefixes must contain at least one prefix',
    };
  }
  if (prefixes.length > MAX_AUDIT_ACTION_FILTERS) {
    return {
      ok: false,
      error: `At most ${MAX_AUDIT_ACTION_FILTERS} action prefixes are allowed`,
    };
  }
  return { ok: true, prefixes };
}

/**
 * Parse the legacy single `action` filter and the additive `actions` filter.
 * `actions` accepts comma-separated values and repeated query keys; duplicates
 * collapse in first-seen order and an explicit upper bound prevents unbounded
 * `IN (...)` SQL.
 */
function parseAuditActionFilters(c: {
  req: {
    query: (name: string) => string | undefined;
    queries: (name: string) => string[] | undefined;
  };
}): ActionFilterResult {
  const actions: string[] = [];
  const seen = new Set<string>();
  let sawActionsParam = false;

  const single = c.req.query('action')?.trim();
  if (single) {
    seen.add(single);
    actions.push(single);
  }

  const repeated = c.req.queries('actions');
  if (repeated && repeated.length > 0) {
    sawActionsParam = true;
    for (const raw of repeated) {
      for (const part of raw.split(',')) {
        const action = part.trim();
        if (!action) continue;
        if (action.length > MAX_AUDIT_ACTION_LENGTH) {
          return {
            ok: false,
            error: `Each action filter must be at most ${MAX_AUDIT_ACTION_LENGTH} characters`,
          };
        }
        if (seen.has(action)) continue;
        seen.add(action);
        actions.push(action);
      }
    }
  }

  if (sawActionsParam && actions.length === 0) {
    return { ok: false, error: 'actions must contain at least one action' };
  }
  if (actions.length > MAX_AUDIT_ACTION_FILTERS) {
    return {
      ok: false,
      error: `At most ${MAX_AUDIT_ACTION_FILTERS} action filters are allowed`,
    };
  }

  return { ok: true, actions };
}

auditLogsRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const conditions = ['tenant_id = ?'];
  const binds: unknown[] = [user.tenantId];

  const actionFilters = parseAuditActionFilters(c);
  if (!actionFilters.ok) {
    return c.json(
      { error: actionFilters.error, code: 'INVALID_ACTION_FILTER' },
      400
    );
  }
  if (actionFilters.actions.length > 0) {
    const placeholders = actionFilters.actions.map(() => '?').join(', ');
    conditions.push(`action IN (${placeholders})`);
    binds.push(...actionFilters.actions);
  }

  const prefixFilters = parseAuditActionPrefixFilters(c);
  if (!prefixFilters.ok) {
    return c.json(
      { error: prefixFilters.error, code: 'INVALID_ACTION_FILTER' },
      400
    );
  }
  if (prefixFilters.prefixes.length > 0) {
    conditions.push(
      `(${prefixFilters.prefixes
        .map(() => `action LIKE ? ESCAPE '\\'`)
        .join(' OR ')})`
    );
    binds.push(
      ...prefixFilters.prefixes.map(
        (prefix) => `${escapeLikePrefix(prefix)}%`
      )
    );
  }

  const targetType = c.req.query('targetType')?.trim();
  if (targetType) {
    conditions.push('target_type = ?');
    binds.push(targetType);
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
