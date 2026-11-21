import { apiFetch } from './core';

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

export const API_TOKEN_SCOPES = [
  'files:read',
  'files:write',
  'folders:read',
  'folders:write',
  'search:read',
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export interface TenantWebhookItem {
  id: string;
  name: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookListResponse {
  webhooks: TenantWebhookItem[];
  supportedEvents: WebhookEventType[];
}

export interface WebhookMutationResponse {
  ok: true;
  secret?: string;
  webhook: TenantWebhookItem;
}

export interface WebhookDeliveryItem {
  id: string;
  webhookId: string;
  eventType: string;
  statusCode: number | null;
  ok: boolean;
  errorMessage: string | null;
  createdAt: string;
}

export interface WebhookDeliveriesResponse {
  webhookId: string;
  deliveries: WebhookDeliveryItem[];
}

export interface WebhookTestResponse {
  ok: boolean;
  delivery: WebhookDeliveryItem;
}

export interface ApiTokenItem {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'revoked' | 'expired';
}

export interface ApiTokenListResponse {
  tokens: ApiTokenItem[];
  supportedScopes: ApiTokenScope[];
}

export interface ApiTokenCreateResponse {
  ok: true;
  token: string;
  apiToken: ApiTokenItem;
}

export interface CreateWebhookInput {
  name: string;
  url: string;
  events: WebhookEventType[];
  enabled?: boolean;
  secret?: string;
}

export interface UpdateWebhookInput {
  name?: string;
  url?: string;
  events?: WebhookEventType[];
  enabled?: boolean;
  secret?: string;
}

export interface CreateApiTokenInput {
  name: string;
  scopes: ApiTokenScope[];
  expiresInDays?: number;
}

export function fetchAdminWebhooks(): Promise<WebhookListResponse> {
  return apiFetch('/api/admin/webhooks');
}

export function createAdminWebhook(
  input: CreateWebhookInput
): Promise<WebhookMutationResponse> {
  return apiFetch('/api/admin/webhooks', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminWebhook(
  webhookId: string,
  input: UpdateWebhookInput
): Promise<WebhookMutationResponse> {
  return apiFetch(`/api/admin/webhooks/${encodeURIComponent(webhookId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteAdminWebhook(
  webhookId: string
): Promise<{ ok: true; id: string }> {
  return apiFetch(`/api/admin/webhooks/${encodeURIComponent(webhookId)}`, {
    method: 'DELETE',
  });
}

export function fetchWebhookDeliveries(
  webhookId: string
): Promise<WebhookDeliveriesResponse> {
  return apiFetch(
    `/api/admin/webhooks/${encodeURIComponent(webhookId)}/deliveries`
  );
}

export function testAdminWebhook(
  webhookId: string
): Promise<WebhookTestResponse> {
  return apiFetch(
    `/api/admin/webhooks/${encodeURIComponent(webhookId)}/test`,
    { method: 'POST' }
  );
}

export function fetchApiTokens(): Promise<ApiTokenListResponse> {
  return apiFetch('/api/api-tokens');
}

export function createApiToken(
  input: CreateApiTokenInput
): Promise<ApiTokenCreateResponse> {
  return apiFetch('/api/api-tokens', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function revokeApiToken(
  tokenId: string
): Promise<{ ok: true; id: string; revokedAt: string }> {
  return apiFetch(`/api/api-tokens/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE',
  });
}

export function validateWebhookClientInput(input: {
  name: string;
  url: string;
  events: string[];
}): string | null {
  if (!input.name.trim()) {
    return 'Webhook 名を入力してください。';
  }
  const rawUrl = input.url.trim();
  if (!rawUrl) {
    return 'Webhook URL を入力してください。';
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
      return 'Webhook URL は https:// で始まる必要があります。';
    }
  } catch {
    return '有効な HTTPS URL を入力してください。';
  }
  if (input.events.length === 0) {
    return '少なくとも 1 つのイベントを選択してください。';
  }
  return null;
}
