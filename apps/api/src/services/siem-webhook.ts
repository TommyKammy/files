import type { Env } from '../types/api';
import { decryptCookiePayload, encryptCookiePayload, timingSafeEqual } from './crypto-utils';

/**
 * SIEM webhook delivery for TOM-72.
 *
 * Security properties:
 * - Only absolute `https:` URLs are accepted.
 * - Loopback/private/link-local IPv4, IPv6 ULA/link-local/loopback, mapped
 *   private IPv4, `localhost`, `*.local` and `*.internal` are rejected.
 * - Redirects are never followed (`redirect: 'manual'`), preventing a public
 *   endpoint from redirecting the Worker into a private address.
 * - Every request is HMAC-SHA256 signed over
 *   `${timestamp}.${event}.${rawBody}` and the shared secret never leaves D1
 *   in plaintext.
 */

export const SIEM_EVENT_CATEGORIES = [
  'security_blocked',
  'admin_mutation',
] as const;

export type SiemEventCategory = (typeof SIEM_EVENT_CATEGORIES)[number];

export const DEFAULT_SIEM_EVENTS_JSON = JSON.stringify([
  'security_blocked',
  'admin_mutation',
]);

export const SIEM_EVENT_MAX_COUNT = 20;
const SIEM_URL_MAX_LENGTH = 2048;
const SIEM_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_LOCAL_SIEM_SECRET_KEY = 'dev-siem-webhook-secret-change-in-prod';

type SiemEnv = Pick<
  Env,
  'ENVIRONMENT' | 'SIEM_WEBHOOK_SECRET_KEY' | 'OIDC_STATE_COOKIE_KEY' | 'LOCAL_PROXY_SECRET'
>;

export interface TenantSiemRow {
  tenant_id: string;
  siem_webhook_enabled: number;
  siem_webhook_url: string | null;
  siem_webhook_secret_encrypted: string | null;
  siem_events_json: string;
}

export interface SiemSettingsProjection {
  enabled: boolean;
  url: string | null;
  secretConfigured: boolean;
  events: string[];
  updatedAt?: string | null;
}

export interface SiemUrlValidationResult {
  ok: boolean;
  url?: string;
  code?: string;
  error?: string;
}

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function parseIpv6Groups(host: string): number[] | null {
  let value = host.toLowerCase();
  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  if (!value.includes(':')) return null;

  // Fold an embedded dotted-quad tail (e.g. `::ffff:127.0.0.1`) into hex.
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = parseIpv4(tail);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const doubleColonParts = value.split('::');
  if (doubleColonParts.length > 2) return null;
  const parseGroups = (segment: string): number[] | null => {
    if (!segment) return [];
    const groups = segment.split(':');
    const parsed: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      parsed.push(Number.parseInt(group, 16));
    }
    return parsed;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroups(value);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseGroups(doubleColonParts[0]);
  const right = parseGroups(doubleColonParts[1]);
  if (!left || !right) return null;
  if (left.length + right.length > 8) return null;
  const padding = new Array(8 - left.length - right.length).fill(0);
  return [...left, ...padding, ...right];
}

function ipv4FromGroups(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isForbiddenIpv6(groups: number[]): boolean {
  if (groups.every((group) => group === 0)) return true; // ::
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0 &&
    groups[6] === 0 &&
    groups[7] === 1
  ) {
    return true; // ::1
  }
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  const mapped =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff;
  const compatible =
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0;
  if (mapped || compatible) {
    return isPrivateIpv4(ipv4FromGroups(groups[6], groups[7]));
  }
  return false;
}

/** Strict SSRF-oriented validation for tenant-supplied SIEM endpoint URLs. */
export function validateSiemWebhookUrl(raw: unknown): SiemUrlValidationResult {
  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'SIEM webhook URL must be a string',
    };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > SIEM_URL_MAX_LENGTH) {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: `SIEM webhook URL must be 1..${SIEM_URL_MAX_LENGTH} characters`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'SIEM webhook URL is not a valid absolute URL',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'SIEM webhook URL must use https:',
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'SIEM webhook URL must not embed credentials',
    };
  }

  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  if (!host) {
    return {
      ok: false,
      code: 'INVALID_SIEM_WEBHOOK_URL',
      error: 'SIEM webhook URL must include a hostname',
    };
  }

  const forbiddenHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal');
  if (forbiddenHost) {
    return {
      ok: false,
      code: 'SIEM_WEBHOOK_URL_FORBIDDEN',
      error: 'SIEM webhook URL must not target localhost or an internal hostname',
    };
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    if (isPrivateIpv4(ipv4)) {
      return {
        ok: false,
        code: 'SIEM_WEBHOOK_URL_FORBIDDEN',
        error: 'SIEM webhook URL must not target a private, loopback or link-local address',
      };
    }
  } else if (host.includes(':')) {
    const groups = parseIpv6Groups(host);
    if (!groups) {
      return {
        ok: false,
        code: 'INVALID_SIEM_WEBHOOK_URL',
        error: 'SIEM webhook URL contains an invalid IPv6 address',
      };
    }
    if (isForbiddenIpv6(groups)) {
      return {
        ok: false,
        code: 'SIEM_WEBHOOK_URL_FORBIDDEN',
        error: 'SIEM webhook URL must not target a private, loopback or link-local address',
      };
    }
  }

  return { ok: true, url: parsed.toString() };
}

export function parseSiemEventsJson(raw: string | null | undefined): string[] {
  if (!raw) return JSON.parse(DEFAULT_SIEM_EVENTS_JSON) as string[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return JSON.parse(DEFAULT_SIEM_EVENTS_JSON) as string[];
    const cleaned = parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return cleaned;
  } catch {
    return JSON.parse(DEFAULT_SIEM_EVENTS_JSON) as string[];
  }
}

export function normalizeSiemEventList(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length === 0) return [];
  if (input.length > SIEM_EVENT_MAX_COUNT) return null;
  const events: string[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (!/^[a-z0-9_.*:-]{1,64}$/i.test(trimmed)) return null;
    if (!events.includes(trimmed)) events.push(trimmed);
  }
  return events;
}

function getSiemEncryptionKey(env: SiemEnv): string {
  const configured =
    env.SIEM_WEBHOOK_SECRET_KEY?.trim() ||
    env.OIDC_STATE_COOKIE_KEY?.trim() ||
    env.LOCAL_PROXY_SECRET?.trim();
  if (configured) return configured;
  if (env.ENVIRONMENT === 'local' || !env.ENVIRONMENT) {
    return DEFAULT_LOCAL_SIEM_SECRET_KEY;
  }
  throw new Error('SIEM_WEBHOOK_SECRET_KEY must be configured outside local environment');
}

export async function encryptSiemSecret(env: SiemEnv, secret: string): Promise<string> {
  return encryptCookiePayload(getSiemEncryptionKey(env), {
    kind: 'siem_webhook_secret',
    secret,
  });
}

export async function decryptSiemSecret(
  env: SiemEnv,
  sealed: string | null
): Promise<string | null> {
  if (!sealed) return null;
  const payload = await decryptCookiePayload<{ kind?: string; secret?: string }>(
    getSiemEncryptionKey(env),
    sealed
  );
  if (!payload || payload.kind !== 'siem_webhook_secret') return null;
  return typeof payload.secret === 'string' && payload.secret ? payload.secret : null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * HMAC-SHA256 signature over `${timestamp}.${event}.${rawBody}`. The wire
 * header is `X-Files-Signature-256: sha256=<hex>`.
 */
export async function computeSiemSignature(
  secret: string,
  timestamp: string,
  event: string,
  rawBody: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${event}.${rawBody}`)
  );
  return toHex(new Uint8Array(signature));
}

export async function verifySiemSignature(
  secret: string,
  timestamp: string,
  event: string,
  rawBody: string,
  signatureHeader: string
): Promise<boolean> {
  const expected = await computeSiemSignature(secret, timestamp, event, rawBody);
  const received = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;
  return timingSafeEqual(received, expected);
}

export interface SiemSendResult {
  ok: boolean;
  delivered: boolean;
  status: number | null;
  error?: string;
  timestamp: string;
  body: string;
  signature: string;
}

const PASS_THROUGH_EVENTS = new Set([
  'admin.siem.test',
  'security.blocked.test',
]);

/** Send one signed webhook request. Redirects are rejected, never followed. */
export async function sendSiemWebhook(
  url: string,
  secret: string,
  event: string,
  payload: Record<string, unknown>
): Promise<SiemSendResult> {
  const validation = validateSiemWebhookUrl(url);
  if (!validation.ok || !validation.url) {
    return {
      ok: false,
      delivered: false,
      status: null,
      error: validation.error ?? 'Invalid SIEM webhook URL',
      timestamp: '',
      body: '',
      signature: '',
    };
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify(payload);
  const signature = await computeSiemSignature(secret, timestamp, event, body);

  try {
    const response = await fetch(validation.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Files-SIEM-Webhook/1.0',
        'X-Files-Signature-256': `sha256=${signature}`,
        'X-Files-Timestamp': timestamp,
        'X-Files-Event': event,
      },
      body,
      signal:
        typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
          ? AbortSignal.timeout(SIEM_REQUEST_TIMEOUT_MS)
          : undefined,
    });
    if (response.status >= 300 && response.status < 400) {
      return {
        ok: false,
        delivered: false,
        status: response.status,
        error: 'SIEM webhook redirects are not followed',
        timestamp,
        body,
        signature,
      };
    }
    return {
      ok: response.ok,
      delivered: response.ok,
      status: response.status,
      ...(response.ok ? {} : { error: `SIEM webhook responded with HTTP ${response.status}` }),
      timestamp,
      body,
      signature,
    };
  } catch (err) {
    return {
      ok: false,
      delivered: false,
      status: null,
      error: err instanceof Error ? err.message : 'SIEM webhook delivery failed',
      timestamp,
      body,
      signature,
    };
  }
}

export interface SiemDispatchSpec {
  event: string;
  category: SiemEventCategory;
  data: Record<string, unknown>;
}

export interface SiemDispatchResult {
  delivered: boolean;
  skipped?:
    | 'disabled'
    | 'not_subscribed'
    | 'missing_secret'
    | 'invalid_url'
    | 'decrypt_failed';
  status?: number | null;
  error?: string;
}

function isEventSubscribed(events: string[], spec: SiemDispatchSpec): boolean {
  return (
    events.includes('*') ||
    events.includes(spec.event) ||
    events.includes(spec.category)
  );
}

/** Load tenant settings, enforce subscription, and deliver one event. */
export async function dispatchSiemEvent(
  env: SiemEnv,
  db: D1Database,
  tenantId: string,
  spec: SiemDispatchSpec
): Promise<SiemDispatchResult> {
  const row = await db
    .prepare(
      `SELECT tenant_id, siem_webhook_enabled, siem_webhook_url,
              siem_webhook_secret_encrypted, siem_events_json
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<TenantSiemRow>();

  if (!row || row.siem_webhook_enabled !== 1) return { delivered: false, skipped: 'disabled' };
  const events = parseSiemEventsJson(row.siem_events_json);
  if (!isEventSubscribed(events, spec)) {
    return { delivered: false, skipped: 'not_subscribed' };
  }
  if (!row.siem_webhook_url) return { delivered: false, skipped: 'invalid_url' };
  const validation = validateSiemWebhookUrl(row.siem_webhook_url);
  if (!validation.ok || !validation.url) {
    return { delivered: false, skipped: 'invalid_url', error: validation.error };
  }
  if (!row.siem_webhook_secret_encrypted) {
    return { delivered: false, skipped: 'missing_secret' };
  }
  const secret = await decryptSiemSecret(env, row.siem_webhook_secret_encrypted);
  if (!secret) return { delivered: false, skipped: 'decrypt_failed' };

  const result = await sendSiemWebhook(validation.url, secret, spec.event, {
    event: spec.event,
    category: spec.category,
    tenantId,
    occurredAt: new Date().toISOString(),
    data: spec.data,
  });
  return {
    delivered: result.delivered,
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  };
}

interface WaitUntilContext {
  executionCtx?: { waitUntil: (promise: Promise<unknown>) => void };
}

/**
 * Fire-and-forget dispatcher for request handlers. `waitUntil` keeps the
 * Worker alive for the delivery without delaying the API response. Environments
 * without an execution context (unit tests) simply start the promise.
 */
export function queueSiemEvent(
  c: WaitUntilContext,
  env: SiemEnv,
  db: D1Database,
  tenantId: string,
  spec: SiemDispatchSpec
): void {
  const task = dispatchSiemEvent(env, db, tenantId, spec).catch(() => undefined);
  try {
    if (c.executionCtx) {
      c.executionCtx.waitUntil(task);
      return;
    }
  } catch {
    // Fall through to the detached promise.
  }
  void task.catch(() => undefined);
}

/** Test delivery ignores the event subscription but still signs the payload. */
export async function sendSiemTestEvent(
  env: SiemEnv,
  db: D1Database,
  tenantId: string,
  eventName = 'admin.siem.test',
  payload: Record<string, unknown> = {}
): Promise<SiemSendResult> {
  const row = await db
    .prepare(
      `SELECT tenant_id, siem_webhook_enabled, siem_webhook_url,
              siem_webhook_secret_encrypted, siem_events_json
         FROM tenant_policies WHERE tenant_id = ?`
    )
    .bind(tenantId)
    .first<TenantSiemRow>();
  if (!row?.siem_webhook_url) {
    return {
      ok: false,
      delivered: false,
      status: null,
      error: 'SIEM webhook URL is not configured',
      timestamp: '',
      body: '',
      signature: '',
    };
  }
  const validation = validateSiemWebhookUrl(row.siem_webhook_url);
  if (!validation.ok || !validation.url) {
    return {
      ok: false,
      delivered: false,
      status: null,
      error: validation.error ?? 'Invalid SIEM webhook URL',
      timestamp: '',
      body: '',
      signature: '',
    };
  }
  const secret = await decryptSiemSecret(env, row.siem_webhook_secret_encrypted);
  if (!secret) {
    return {
      ok: false,
      delivered: false,
      status: null,
      error: 'SIEM webhook secret is not configured',
      timestamp: '',
      body: '',
      signature: '',
    };
  }
  return sendSiemWebhook(validation.url, secret, PASS_THROUGH_EVENTS.has(eventName) ? eventName : 'admin.siem.test', {
    event: eventName,
    category: 'admin_mutation',
    tenantId,
    occurredAt: new Date().toISOString(),
    test: true,
    data: payload,
  });
}
