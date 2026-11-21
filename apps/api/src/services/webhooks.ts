import type { Env } from '../types/api';
import {
  generateRandomToken,
  sealRecoverableToken,
  unsealRecoverableToken,
} from './crypto-utils';
import { validateSiemWebhookUrl } from './siem-webhook';

/**
 * General CRUD Webhooks service (HMAC-SHA256 signed + delivery logs).
 *
 * Security properties:
 * - Reuses the strict SSRF validator from `siem-webhook.ts` (HTTPS only,
 *   rejects localhost, private/loopback/link-local/metadata IPv4 & IPv6).
 * - Signing secrets are sealed at rest using `sealRecoverableToken` /
 *   `unsealRecoverableToken` and never leave D1 in plaintext after creation.
 * - Outbound requests use `redirect: 'manual'` and a 5s abort timeout.
 */

export const WEBHOOK_EVENT_TYPES = [
  'file.uploaded',
  'file.deleted',
  'file.updated',
  'folder.created',
  'folder.deleted',
  'permission.granted',
  'shared_link.created',
  'webhook.test',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const WEBHOOK_EVENT_SET = new Set<string>(WEBHOOK_EVENT_TYPES);
const WEBHOOK_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_LOCAL_WEBHOOK_SEAL_KEY = 'dev-webhook-seal-secret-change-in-prod';
const textEncoder = new TextEncoder();

export type WebhookEnv = Pick<
  Env,
  'DB' | 'ENVIRONMENT' | 'LOCAL_PROXY_SECRET'
> & {
  SESSION_SECRET?: string;
};

export interface TenantWebhookRow {
  id: string;
  tenant_id: string;
  name: string;
  url: string;
  secret_ciphertext: string;
  events_json: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookProjection {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryRow {
  id: string;
  tenant_id: string;
  webhook_id: string;
  event_type: string;
  status_code: number | null;
  ok: number;
  error_message: string | null;
  created_at: string;
}

export interface WebhookDeliveryProjection {
  id: string;
  webhookId: string;
  eventType: string;
  statusCode: number | null;
  ok: boolean;
  errorMessage: string | null;
  createdAt: string;
}

export function isSupportedWebhookEvent(value: unknown): value is WebhookEventType {
  return typeof value === 'string' && WEBHOOK_EVENT_SET.has(value);
}

export function parseWebhookEventsJson(raw: string | null | undefined): WebhookEventType[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<WebhookEventType>();
    for (const item of parsed) {
      if (isSupportedWebhookEvent(item)) {
        seen.add(item);
      }
    }
    return [...seen];
  } catch {
    return [];
  }
}

export function projectWebhook(row: TenantWebhookRow): WebhookProjection {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: parseWebhookEventsJson(row.events_json),
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function projectWebhookDelivery(
  row: WebhookDeliveryRow
): WebhookDeliveryProjection {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventType: row.event_type,
    statusCode: row.status_code,
    ok: row.ok === 1,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  };
}

export function validateWebhookUrl(raw: unknown) {
  const result = validateSiemWebhookUrl(raw);
  if (!result.ok) {
    return {
      ok: false as const,
      code:
        result.code === 'SIEM_WEBHOOK_URL_FORBIDDEN'
          ? 'WEBHOOK_URL_FORBIDDEN'
          : 'INVALID_WEBHOOK_URL',
      error: (result.error ?? 'Invalid webhook URL').replace(/^SIEM /, ''),
    };
  }
  return { ok: true as const, url: result.url! };
}

type SealEnvInput = Pick<Env, 'ENVIRONMENT' | 'LOCAL_PROXY_SECRET'> & {
  SESSION_SECRET?: string;
};

function resolveSealEnv(
  env: SealEnvInput
): { SESSION_SECRET?: string; LOCAL_PROXY_SECRET?: string } {
  if (env.SESSION_SECRET || env.LOCAL_PROXY_SECRET) {
    return {
      SESSION_SECRET: env.SESSION_SECRET,
      LOCAL_PROXY_SECRET: env.LOCAL_PROXY_SECRET,
    };
  }
  if (env.ENVIRONMENT === 'local' || !env.ENVIRONMENT) {
    return { LOCAL_PROXY_SECRET: DEFAULT_LOCAL_WEBHOOK_SEAL_KEY };
  }
  return {};
}

export async function sealWebhookSecret(
  env: SealEnvInput,
  rawSecret: string
): Promise<string | null> {
  return sealRecoverableToken(resolveSealEnv(env), rawSecret);
}

export async function unsealWebhookSecret(
  env: SealEnvInput,
  ciphertext: string | null | undefined
): Promise<string | null> {
  return unsealRecoverableToken(resolveSealEnv(env), ciphertext);
}

export function generateWebhookSecret(): string {
  return `whsec_${generateRandomToken(32)}`;
}

export async function signWebhookPayload(
  secret: string,
  rawBody: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, textEncoder.encode(rawBody));
  const hex = [...new Uint8Array(sigBuf)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

async function recordWebhookDelivery(
  db: D1Database,
  entry: {
    id: string;
    tenantId: string;
    webhookId: string;
    eventType: string;
    statusCode: number | null;
    ok: boolean;
    errorMessage: string | null;
  }
): Promise<WebhookDeliveryProjection> {
  const createdAt = new Date().toISOString();
  const truncatedError = entry.errorMessage
    ? entry.errorMessage.slice(0, 500)
    : null;
  await db
    .prepare(
      `INSERT INTO webhook_deliveries
         (id, tenant_id, webhook_id, event_type, status_code, ok, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.id,
      entry.tenantId,
      entry.webhookId,
      entry.eventType,
      entry.statusCode,
      entry.ok ? 1 : 0,
      truncatedError,
      createdAt
    )
    .run();

  return {
    id: entry.id,
    webhookId: entry.webhookId,
    eventType: entry.eventType,
    statusCode: entry.statusCode,
    ok: entry.ok,
    errorMessage: truncatedError,
    createdAt,
  };
}

export async function deliverSingleWebhook(
  env: WebhookEnv,
  webhook: TenantWebhookRow,
  eventType: WebhookEventType,
  payload: unknown
): Promise<WebhookDeliveryProjection> {
  const deliveryId = crypto.randomUUID();
  let statusCode: number | null = null;
  let ok = false;
  let errorMessage: string | null = null;

  try {
    const urlCheck = validateWebhookUrl(webhook.url);
    if (!urlCheck.ok) {
      errorMessage = urlCheck.error;
    } else {
      const secret = await unsealWebhookSecret(env, webhook.secret_ciphertext);
      if (!secret) {
        errorMessage = 'Webhook signing secret could not be unsealed';
      } else {
        const rawBody = JSON.stringify({
          id: deliveryId,
          event: eventType,
          tenantId: webhook.tenant_id,
          createdAt: new Date().toISOString(),
          data: payload,
        });
        const signature = await signWebhookPayload(secret, rawBody);

        const response = await fetch(urlCheck.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(WEBHOOK_REQUEST_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'X-Files-Signature-256': signature,
            'X-Files-Event': eventType,
            'X-Files-Delivery-Id': deliveryId,
          },
          body: rawBody,
        });
        statusCode = response.status;
        ok = response.ok;
        if (!ok) {
          errorMessage = `HTTP ${response.status}`;
        }
      }
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : 'Webhook delivery failed';
  }

  try {
    return await recordWebhookDelivery(env.DB, {
      id: deliveryId,
      tenantId: webhook.tenant_id,
      webhookId: webhook.id,
      eventType,
      statusCode,
      ok,
      errorMessage,
    });
  } catch {
    return {
      id: deliveryId,
      webhookId: webhook.id,
      eventType,
      statusCode,
      ok,
      errorMessage,
      createdAt: new Date().toISOString(),
    };
  }
}

/**
 * Dispatches an event to all enabled tenant webhooks subscribed to `eventType`.
 * Records every attempt in `webhook_deliveries` and never throws.
 */
export async function dispatchTenantWebhookEvent(
  env: WebhookEnv,
  tenantId: string,
  eventType: WebhookEventType,
  payload: unknown
): Promise<WebhookDeliveryProjection[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, tenant_id, name, url, secret_ciphertext, events_json,
              enabled, created_by, created_at, updated_at
         FROM tenant_webhooks
        WHERE tenant_id = ? AND enabled = 1`
    )
      .bind(tenantId)
      .all<TenantWebhookRow>();

    const matching = rows.results.filter((row) =>
      parseWebhookEventsJson(row.events_json).includes(eventType)
    );
    if (matching.length === 0) return [];

    return await Promise.all(
      matching.map((webhook) =>
        deliverSingleWebhook(env, webhook, eventType, payload)
      )
    );
  } catch {
    return [];
  }
}
