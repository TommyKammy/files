import type { Env } from '../types/api';

/**
 * Transactional mail abstraction for P10-1 external guests.
 *
 * - Production / staging: `HttpMailProvider` posts to `MAIL_WEBHOOK_URL`.
 *   A missing webhook is a hard configuration error; tokens are never returned
 *   from an API response.
 * - Local development / Vitest: `DevMailSinkProvider` captures messages in
 *   memory and (when a D1 binding is available) in `guest_mail_sink`. The
 *   `/auth/dev-guest-mails` reader is protected by `isLocalDevBypassAllowed`.
 */

export type MailKind = 'guest_invitation' | 'guest_otp' | 'notification';

export interface MailMessage {
  tenantId: string;
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
  token?: string;
  otpCode?: string;
  acceptUrl?: string;
}

export interface MailProvider {
  send(message: MailMessage): Promise<void>;
}

export class MailProviderConfigurationError extends Error {
  constructor(message = 'Mail provider is not configured') {
    super(message);
    this.name = 'MailProviderConfigurationError';
  }
}

export class MailDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

const MEMORY_MAIL_SINK: MailMessage[] = [];
const MEMORY_MAIL_SINK_LIMIT = 200;

export function getMemoryMailSink(): readonly MailMessage[] {
  return MEMORY_MAIL_SINK;
}

export function clearMemoryMailSinkForTests(): void {
  MEMORY_MAIL_SINK.length = 0;
}

export class DevMailSinkProvider implements MailProvider {
  private readonly db?: D1Database;

  constructor(db?: D1Database) {
    this.db = db;
  }

  async send(message: MailMessage): Promise<void> {
    MEMORY_MAIL_SINK.push(message);
    if (MEMORY_MAIL_SINK.length > MEMORY_MAIL_SINK_LIMIT) {
      MEMORY_MAIL_SINK.splice(0, MEMORY_MAIL_SINK.length - MEMORY_MAIL_SINK_LIMIT);
    }
    if (!this.db) return;

    await this.db
      .prepare(
        `INSERT INTO guest_mail_sink (
           id, tenant_id, kind, to_email, subject, body_text, token, otp_code,
           accept_url, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        message.tenantId,
        message.kind,
        message.to,
        message.subject,
        message.text,
        message.token ?? null,
        message.otpCode ?? null,
        message.acceptUrl ?? null,
        new Date().toISOString()
      )
      .run();
  }
}

export class HttpMailProvider implements MailProvider {
  private readonly webhookUrl: string;
  private readonly apiKey?: string;
  private readonly from?: string;

  constructor(webhookUrl: string, apiKey?: string, from?: string) {
    this.webhookUrl = webhookUrl;
    this.apiKey = apiKey;
    this.from = from;
  }

  async send(message: MailMessage): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: this.from ?? 'no-reply@files.invalid',
        to: message.to,
        subject: message.subject,
        text: message.text,
        kind: message.kind,
        metadata: {
          tenantId: message.tenantId,
        },
      }),
    });

    if (!response.ok) {
      throw new MailDeliveryError(
        `Mail webhook rejected the message with HTTP ${response.status}`
      );
    }
  }
}

export function resolveMailProvider(env: Pick<Env, 'DB' | 'ENVIRONMENT' | 'MAIL_WEBHOOK_URL' | 'MAIL_API_KEY' | 'MAIL_FROM'>): MailProvider {
  const webhookUrl = env.MAIL_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    return new HttpMailProvider(webhookUrl, env.MAIL_API_KEY, env.MAIL_FROM);
  }

  if (env.ENVIRONMENT === 'local') {
    return new DevMailSinkProvider(env.DB);
  }

  throw new MailProviderConfigurationError(
    'MAIL_WEBHOOK_URL is required outside local development'
  );
}

export const createMailProvider = resolveMailProvider;

export interface DevMailSinkRow {
  id: string;
  tenant_id: string;
  kind: MailKind;
  to_email: string;
  subject: string;
  body_text: string;
  token: string | null;
  otp_code: string | null;
  accept_url: string | null;
  created_at: string;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 1);
  return `${visible}${'*'.repeat(Math.max(3, Math.min(local.length - 1, 8)))}@${domain}`;
}
