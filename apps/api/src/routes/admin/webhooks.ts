import { Hono, type Context } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  deliverSingleWebhook,
  generateWebhookSecret,
  isSupportedWebhookEvent,
  projectWebhook,
  projectWebhookDelivery,
  sealWebhookSecret,
  validateWebhookUrl,
  WEBHOOK_EVENT_TYPES,
  type TenantWebhookRow,
  type WebhookDeliveryRow,
  type WebhookEventType,
} from '../../services/webhooks';
import type { OidcHonoEnv } from '../../types/oidc';

const MAX_WEBHOOK_NAME_LENGTH = 120;
const MAX_WEBHOOK_SECRET_LENGTH = 512;

function requireSysAdmin(c: Context<OidcHonoEnv>): Response | null {
  const user = getAuthenticatedUser(c);
  if (user.role !== 'sys_admin') {
    return c.json(
      {
        error: 'Only sys_admin can manage webhooks',
        code: 'SYS_ADMIN_REQUIRED',
      },
      403
    );
  }
  return null;
}

function normalizeWebhookName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_WEBHOOK_NAME_LENGTH) return null;
  return trimmed;
}

function normalizeWebhookEvents(raw: unknown): WebhookEventType[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const unique = new Set<WebhookEventType>();
  for (const item of raw) {
    if (!isSupportedWebhookEvent(item)) return null;
    unique.add(item);
  }
  return [...unique];
}

async function loadWebhookById(
  db: D1Database,
  tenantId: string,
  webhookId: string
): Promise<TenantWebhookRow | null> {
  return db
    .prepare(
      `SELECT id, tenant_id, name, url, secret_ciphertext, events_json,
              enabled, created_by, created_at, updated_at
         FROM tenant_webhooks
        WHERE id = ? AND tenant_id = ?`
    )
    .bind(webhookId, tenantId)
    .first<TenantWebhookRow>();
}

export function registerAdminWebhookRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/webhooks — never returns secret_ciphertext or plaintext secret. */
  routes.get('/webhooks', async (c) => {
    const user = getAuthenticatedUser(c);
    const rows = await c.env.DB.prepare(
      `SELECT id, tenant_id, name, url, secret_ciphertext, events_json,
              enabled, created_by, created_at, updated_at
         FROM tenant_webhooks
        WHERE tenant_id = ?
        ORDER BY created_at DESC`
    )
      .bind(user.tenantId)
      .all<TenantWebhookRow>();

    return c.json({
      webhooks: rows.results.map(projectWebhook),
      supportedEvents: WEBHOOK_EVENT_TYPES,
    });
  });

  /** POST /api/admin/webhooks — create a new webhook, returning signing secret once. */
  routes.post('/webhooks', async (c) => {
    const forbidden = requireSysAdmin(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);

    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required', code: 'INVALID_BODY' }, 400);
    }

    const name = normalizeWebhookName(body.name);
    if (!name) {
      return c.json(
        {
          error: `name must be a non-empty string (max ${MAX_WEBHOOK_NAME_LENGTH} chars)`,
          code: 'INVALID_WEBHOOK_NAME',
        },
        400
      );
    }

    const urlCheck = validateWebhookUrl(body.url);
    if (!urlCheck.ok) {
      return c.json({ error: urlCheck.error, code: urlCheck.code }, 400);
    }

    const events = normalizeWebhookEvents(body.events);
    if (!events) {
      return c.json(
        {
          error: 'events must be a non-empty array of supported webhook event types',
          code: 'INVALID_WEBHOOK_EVENTS',
        },
        400
      );
    }

    let enabled = true;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json(
          { error: 'enabled must be a boolean', code: 'INVALID_WEBHOOK_ENABLED' },
          400
        );
      }
      enabled = body.enabled;
    }

    let rawSecret: string;
    if (body.secret !== undefined && body.secret !== null && body.secret !== '') {
      if (
        typeof body.secret !== 'string' ||
        body.secret.trim().length < 8 ||
        body.secret.length > MAX_WEBHOOK_SECRET_LENGTH
      ) {
        return c.json(
          {
            error: `secret must be 8..${MAX_WEBHOOK_SECRET_LENGTH} characters`,
            code: 'INVALID_WEBHOOK_SECRET',
          },
          400
        );
      }
      rawSecret = body.secret;
    } else {
      rawSecret = generateWebhookSecret();
    }

    const secretCiphertext = await sealWebhookSecret(c.env, rawSecret);
    if (!secretCiphertext) {
      return c.json(
        {
          error: 'Webhook secret encryption key is not configured',
          code: 'WEBHOOK_ENCRYPTION_UNAVAILABLE',
        },
        500
      );
    }

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const eventsJson = JSON.stringify(events);

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO tenant_webhooks
           (id, tenant_id, name, url, secret_ciphertext, events_json, enabled, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        user.tenantId,
        name,
        urlCheck.url,
        secretCiphertext,
        eventsJson,
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
        action: 'admin.webhook.created',
        targetType: 'webhook',
        targetId: id,
        metadata: { name, url: urlCheck.url, events, enabled },
      }),
    ]);

    return c.json(
      {
        ok: true,
        secret: rawSecret,
        webhook: {
          id,
          name,
          url: urlCheck.url,
          events,
          enabled,
          createdBy: user.id,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      },
      201
    );
  });

  /** PATCH /api/admin/webhooks/:id — update webhook fields / rotate secret. */
  routes.patch('/webhooks/:id', async (c) => {
    const forbidden = requireSysAdmin(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    const webhookId = c.req.param('id');

    const existing = await loadWebhookById(c.env.DB, user.tenantId, webhookId);
    if (!existing) {
      return c.json(
        { error: 'Webhook not found', code: 'WEBHOOK_NOT_FOUND' },
        404
      );
    }

    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required', code: 'INVALID_BODY' }, 400);
    }

    let name = existing.name;
    if (body.name !== undefined) {
      const normalized = normalizeWebhookName(body.name);
      if (!normalized) {
        return c.json(
          { error: 'Invalid webhook name', code: 'INVALID_WEBHOOK_NAME' },
          400
        );
      }
      name = normalized;
    }

    let url = existing.url;
    if (body.url !== undefined) {
      const urlCheck = validateWebhookUrl(body.url);
      if (!urlCheck.ok) {
        return c.json({ error: urlCheck.error, code: urlCheck.code }, 400);
      }
      url = urlCheck.url;
    }

    let eventsJson = existing.events_json;
    if (body.events !== undefined) {
      const events = normalizeWebhookEvents(body.events);
      if (!events) {
        return c.json(
          {
            error: 'events must be a non-empty array of supported webhook event types',
            code: 'INVALID_WEBHOOK_EVENTS',
          },
          400
        );
      }
      eventsJson = JSON.stringify(events);
    }

    let enabled = existing.enabled === 1;
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        return c.json(
          { error: 'enabled must be a boolean', code: 'INVALID_WEBHOOK_ENABLED' },
          400
        );
      }
      enabled = body.enabled;
    }

    let secretCiphertext = existing.secret_ciphertext;
    let rotatedSecret: string | undefined;
    if (body.secret !== undefined && body.secret !== null && body.secret !== '') {
      if (
        typeof body.secret !== 'string' ||
        body.secret.trim().length < 8 ||
        body.secret.length > MAX_WEBHOOK_SECRET_LENGTH
      ) {
        return c.json(
          {
            error: `secret must be 8..${MAX_WEBHOOK_SECRET_LENGTH} characters`,
            code: 'INVALID_WEBHOOK_SECRET',
          },
          400
        );
      }
      const sealed = await sealWebhookSecret(c.env, body.secret);
      if (!sealed) {
        return c.json(
          {
            error: 'Webhook secret encryption key is not configured',
            code: 'WEBHOOK_ENCRYPTION_UNAVAILABLE',
          },
          500
        );
      }
      secretCiphertext = sealed;
      rotatedSecret = body.secret;
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tenant_webhooks
            SET name = ?, url = ?, secret_ciphertext = ?, events_json = ?,
                enabled = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`
      ).bind(
        name,
        url,
        secretCiphertext,
        eventsJson,
        enabled ? 1 : 0,
        nowIso,
        webhookId,
        user.tenantId
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'admin.webhook.updated',
        targetType: 'webhook',
        targetId: webhookId,
        metadata: { name, url, enabled, secretRotated: Boolean(rotatedSecret) },
      }),
    ]);

    const updated = await loadWebhookById(c.env.DB, user.tenantId, webhookId);
    return c.json({
      ok: true,
      ...(rotatedSecret ? { secret: rotatedSecret } : {}),
      webhook: updated ? projectWebhook(updated) : null,
    });
  });

  /** DELETE /api/admin/webhooks/:id — delete webhook and its delivery logs. */
  routes.delete('/webhooks/:id', async (c) => {
    const forbidden = requireSysAdmin(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    const webhookId = c.req.param('id');

    const existing = await loadWebhookById(c.env.DB, user.tenantId, webhookId);
    if (!existing) {
      return c.json(
        { error: 'Webhook not found', code: 'WEBHOOK_NOT_FOUND' },
        404
      );
    }

    await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM webhook_deliveries WHERE webhook_id = ? AND tenant_id = ?'
      ).bind(webhookId, user.tenantId),
      c.env.DB.prepare(
        'DELETE FROM tenant_webhooks WHERE id = ? AND tenant_id = ?'
      ).bind(webhookId, user.tenantId),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'admin.webhook.deleted',
        targetType: 'webhook',
        targetId: webhookId,
        metadata: { name: existing.name, url: existing.url },
      }),
    ]);

    return c.json({ ok: true, id: webhookId });
  });

  /** GET /api/admin/webhooks/:id/deliveries — latest 50 delivery logs. */
  routes.get('/webhooks/:id/deliveries', async (c) => {
    const user = getAuthenticatedUser(c);
    const webhookId = c.req.param('id');

    const existing = await loadWebhookById(c.env.DB, user.tenantId, webhookId);
    if (!existing) {
      return c.json(
        { error: 'Webhook not found', code: 'WEBHOOK_NOT_FOUND' },
        404
      );
    }

    const rows = await c.env.DB.prepare(
      `SELECT id, tenant_id, webhook_id, event_type, status_code, ok, error_message, created_at
         FROM webhook_deliveries
        WHERE tenant_id = ? AND webhook_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT 50`
    )
      .bind(user.tenantId, webhookId)
      .all<WebhookDeliveryRow>();

    return c.json({
      webhookId,
      deliveries: rows.results.map(projectWebhookDelivery),
    });
  });

  /** POST /api/admin/webhooks/:id/test — sends webhook.test ping and returns delivery result. */
  routes.post('/webhooks/:id/test', async (c) => {
    const forbidden = requireSysAdmin(c);
    if (forbidden) return forbidden;
    const user = getAuthenticatedUser(c);
    const webhookId = c.req.param('id');

    const existing = await loadWebhookById(c.env.DB, user.tenantId, webhookId);
    if (!existing) {
      return c.json(
        { error: 'Webhook not found', code: 'WEBHOOK_NOT_FOUND' },
        404
      );
    }

    const delivery = await deliverSingleWebhook(c.env, existing, 'webhook.test', {
      triggeredBy: user.email,
      webhookId: existing.id,
      webhookName: existing.name,
    });

    return c.json({
      ok: delivery.ok,
      delivery,
    });
  });
}
