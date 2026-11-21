import assert from 'node:assert/strict';
import test from 'node:test';
import {
  API_TOKEN_SCOPES,
  WEBHOOK_EVENT_TYPES,
  createAdminWebhook,
  createApiToken,
  deleteAdminWebhook,
  fetchAdminWebhooks,
  fetchApiTokens,
  fetchWebhookDeliveries,
  revokeApiToken,
  testAdminWebhook,
  updateAdminWebhook,
  validateWebhookClientInput,
} from '@/lib/files-api/webhooks-tokens';

test('WEBHOOK_EVENT_TYPES and API_TOKEN_SCOPES match expected contracts', () => {
  assert.deepEqual([...WEBHOOK_EVENT_TYPES], [
    'file.uploaded',
    'file.deleted',
    'file.updated',
    'folder.created',
    'folder.deleted',
    'permission.granted',
    'shared_link.created',
    'webhook.test',
  ]);
  assert.deepEqual([...API_TOKEN_SCOPES], [
    'files:read',
    'files:write',
    'folders:read',
    'folders:write',
    'search:read',
  ]);
});

test('validateWebhookClientInput enforces name, https URL, and non-empty events', () => {
  assert.ok(
    validateWebhookClientInput({
      name: '',
      url: 'https://hooks.example.com/wh',
      events: ['file.uploaded'],
    })
  );
  assert.ok(
    validateWebhookClientInput({
      name: 'Test',
      url: 'http://hooks.example.com/wh',
      events: ['file.uploaded'],
    })
  );
  assert.ok(
    validateWebhookClientInput({
      name: 'Test',
      url: 'https://hooks.example.com/wh',
      events: [],
    })
  );
  assert.equal(
    validateWebhookClientInput({
      name: 'Test',
      url: 'https://hooks.example.com/wh',
      events: ['file.uploaded'],
    }),
    null
  );
});

test('webhooks and API tokens client functions hit expected endpoints', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  try {
    await fetchAdminWebhooks();
    await createAdminWebhook({
      name: 'Audit',
      url: 'https://hooks.example.com/audit',
      events: ['file.uploaded'],
    });
    await updateAdminWebhook('wh-1', { enabled: false });
    await fetchWebhookDeliveries('wh-1');
    await testAdminWebhook('wh-1');
    await deleteAdminWebhook('wh-1');

    await fetchApiTokens();
    await createApiToken({
      name: 'CLI',
      scopes: ['files:read', 'search:read'],
      expiresInDays: 30,
    });
    await revokeApiToken('tok-1');

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        'GET /api/admin/webhooks',
        'POST /api/admin/webhooks',
        'PATCH /api/admin/webhooks/wh-1',
        'GET /api/admin/webhooks/wh-1/deliveries',
        'POST /api/admin/webhooks/wh-1/test',
        'DELETE /api/admin/webhooks/wh-1',
        'GET /api/api-tokens',
        'POST /api/api-tokens',
        'DELETE /api/api-tokens/tok-1',
      ]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
