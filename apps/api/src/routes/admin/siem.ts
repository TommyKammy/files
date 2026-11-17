import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  DEFAULT_SIEM_EVENTS_JSON,
  encryptSiemSecret,
  normalizeSiemEventList,
  parseSiemEventsJson,
  sendSiemTestEvent,
  validateSiemWebhookUrl,
  type TenantSiemRow,
} from '../../services/siem-webhook';
import type { OidcHonoEnv } from '../../types/oidc';

const SIEM_SECRET_MAX_LENGTH = 512;

interface SiemRowWithTimestamp extends TenantSiemRow {
  updated_at: string | null;
}

function projectSiem(row: SiemRowWithTimestamp | null) {
  return {
    enabled: row?.siem_webhook_enabled === 1,
    url: row?.siem_webhook_url ?? null,
    secretConfigured: Boolean(row?.siem_webhook_secret_encrypted),
    events: row ? parseSiemEventsJson(row.siem_events_json) : parseSiemEventsJson(DEFAULT_SIEM_EVENTS_JSON),
    updatedAt: row?.updated_at ?? null,
  };
}

async function loadSiemRow(
  db: D1Database,
  tenantId: string
): Promise<SiemRowWithTimestamp | null> {
  return db
    .prepare(
      `SELECT tenant_id, siem_webhook_enabled, siem_webhook_url,
              siem_webhook_secret_encrypted, siem_events_json, updated_at
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<SiemRowWithTimestamp>();
}

export async function loadAdminSiemPayload(
  db: D1Database,
  tenantId: string
) {
  const row = await loadSiemRow(db, tenantId);
  return { siem: projectSiem(row) };
}

export function registerAdminSiemRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/siem — never returns the stored secret. */
  routes.get('/siem', async (c) => {
    const user = getAuthenticatedUser(c);
    return c.json(await loadAdminSiemPayload(c.env.DB, user.tenantId));
  });

  /** PUT /api/admin/siem — sys_admin only. */
  routes.put('/siem', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can change the SIEM webhook settings',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }

    const body = (await c.req.json().catch(() => null)) as {
      enabled?: unknown;
      url?: unknown;
      secret?: unknown;
      clearSecret?: unknown;
      events?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return c.json(
        { error: 'JSON body required', code: 'INVALID_SIEM_SETTINGS' },
        400
      );
    }

    const existing = await loadSiemRow(c.env.DB, user.tenantId);
    let enabled = existing?.siem_webhook_enabled === 1;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json(
          { error: 'enabled must be a boolean', code: 'INVALID_SIEM_SETTINGS' },
          400
        );
      }
      enabled = body.enabled;
    }

    let url = existing?.siem_webhook_url ?? null;
    if (body.url !== undefined) {
      if (body.url === null || body.url === '') {
        url = null;
      } else {
        const validation = validateSiemWebhookUrl(body.url);
        if (!validation.ok || !validation.url) {
          return c.json(
            {
              error: validation.error ?? 'Invalid SIEM webhook URL',
              code: validation.code ?? 'INVALID_SIEM_WEBHOOK_URL',
            },
            400
          );
        }
        url = validation.url;
      }
    }

    if (enabled && !url) {
      return c.json(
        {
          error: 'A valid https:// SIEM webhook URL is required when enabled',
          code: 'SIEM_WEBHOOK_URL_REQUIRED',
        },
        400
      );
    }
    if (url) {
      const validation = validateSiemWebhookUrl(url);
      if (!validation.ok) {
        return c.json(
          {
            error: validation.error ?? 'Invalid SIEM webhook URL',
            code: validation.code ?? 'INVALID_SIEM_WEBHOOK_URL',
          },
          400
        );
      }
    }

    let eventsJson = existing?.siem_events_json ?? DEFAULT_SIEM_EVENTS_JSON;
    if (body.events !== undefined) {
      const events = normalizeSiemEventList(body.events);
      if (!events) {
        return c.json(
          {
            error:
              'events must be an array of event/category names (max 20, pattern [a-z0-9_.*:-])',
            code: 'INVALID_SIEM_EVENTS',
          },
          400
        );
      }
      eventsJson = JSON.stringify(events);
    }

    let secretEncrypted = existing?.siem_webhook_secret_encrypted ?? null;
    if (body.clearSecret !== undefined) {
      if (typeof body.clearSecret !== 'boolean') {
        return c.json(
          { error: 'clearSecret must be a boolean', code: 'INVALID_SIEM_SETTINGS' },
          400
        );
      }
      if (body.clearSecret) secretEncrypted = null;
    }
    if (body.secret !== undefined) {
      if (
        typeof body.secret !== 'string' ||
        !body.secret.trim() ||
        body.secret.length > SIEM_SECRET_MAX_LENGTH
      ) {
        return c.json(
          {
            error: `secret must be a non-empty string (<= ${SIEM_SECRET_MAX_LENGTH} chars)`,
            code: 'INVALID_SIEM_SECRET',
          },
          400
        );
      }
      secretEncrypted = await encryptSiemSecret(c.env, body.secret.trim());
    }
    if (enabled && !secretEncrypted) {
      return c.json(
        {
          error: 'A SIEM webhook secret is required when enabled',
          code: 'SIEM_WEBHOOK_SECRET_REQUIRED',
        },
        400
      );
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tenant_policies
            SET siem_webhook_enabled = ?,
                siem_webhook_url = ?,
                siem_webhook_secret_encrypted = ?,
                siem_events_json = ?,
                updated_by = ?,
                updated_at = ?
          WHERE tenant_id = ?`
      ).bind(
        enabled ? 1 : 0,
        url,
        secretEncrypted,
        eventsJson,
        user.id,
        nowIso,
        user.tenantId
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'admin.siem.updated',
        targetType: 'tenant_policy',
        targetId: user.tenantId,
        metadata: {
          enabled,
          url,
          secretConfigured: Boolean(secretEncrypted),
          events: parseSiemEventsJson(eventsJson),
        },
        nowIso,
      }),
    ]);

    const updated = await loadSiemRow(c.env.DB, user.tenantId);
    return c.json({ siem: projectSiem(updated) });
  });

  /** POST /api/admin/siem/test — signed test delivery plus audit entry. */
  routes.post('/siem/test', async (c) => {
    const user = getAuthenticatedUser(c);
    if (user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can send a SIEM test event',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }

    const row = await loadSiemRow(c.env.DB, user.tenantId);
    if (!row?.siem_webhook_url || !row.siem_webhook_secret_encrypted) {
      return c.json(
        {
          error: 'SIEM webhook URL and secret must be configured before testing',
          code: 'SIEM_NOT_CONFIGURED',
        },
        400
      );
    }

    const result = await sendSiemTestEvent(
      c.env,
      c.env.DB,
      user.tenantId,
      'admin.siem.test',
      { actorId: user.id, actorEmail: user.email }
    );
    const nowIso = new Date().toISOString();
    await buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.siem.tested',
      targetType: 'tenant_policy',
      targetId: user.tenantId,
      status: result.ok ? 'allowed' : 'blocked',
      metadata: {
        delivered: result.delivered,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      },
      nowIso,
    }).run();

    return c.json({
      ok: result.ok,
      delivered: result.delivered,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    });
  });
}
