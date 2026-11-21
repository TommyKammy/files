import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { sha256Hex } from '../src/services/crypto-utils';
import {
  dispatchTenantWebhookEvent,
  signWebhookPayload,
} from '../src/services/webhooks';
import type { OidcEnv } from '../src/types/oidc';

const TEST_TENANT = 'tenant-wh-test';
const TEST_ADMIN_ID = 'admin-wh-1';
const TEST_MEMBER_ID = 'member-wh-1';

function makeEnv(overrides: Partial<OidcEnv> = {}): OidcEnv {
  return {
    ...(env as unknown as OidcEnv),
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    LOCAL_PROXY_SECRET: 'test-local-proxy-secret-32chars!!',
    ...overrides,
  };
}

function adminHeaders(extra: Record<string, string> = {}) {
  return {
    'X-Dev-User-Id': TEST_ADMIN_ID,
    'X-Dev-Tenant-Id': TEST_TENANT,
    'X-Dev-User-Email': 'admin@wh.example.com',
    'X-Dev-User-Role': 'sys_admin',
    ...extra,
  };
}

function memberHeaders(extra: Record<string, string> = {}) {
  return {
    'X-Dev-User-Id': TEST_MEMBER_ID,
    'X-Dev-Tenant-Id': TEST_TENANT,
    'X-Dev-User-Email': 'member@wh.example.com',
    'X-Dev-User-Role': 'member',
    ...extra,
  };
}

describe('General CRUD Webhooks & Scoped API Tokens', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, 'WH Tenant', 'wh-tenant')"
      ).bind(TEST_TENANT),
      env.DB.prepare(
        'INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)'
      ).bind(TEST_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, user_type)
         VALUES (?, ?, 'admin@wh.example.com', 'WH Admin', 'sys_admin', 'active', 'member')`
      ).bind(TEST_ADMIN_ID, TEST_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, user_type)
         VALUES (?, ?, 'member@wh.example.com', 'WH Member', 'member', 'active', 'member')`
      ).bind(TEST_MEMBER_ID, TEST_TENANT),
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects SSRF webhook URLs (http, localhost, private/loopback/metadata IPs)', async () => {
    const testEnv = makeEnv();
    const badUrls = [
      'http://hooks.example.com/events',
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/internal',
      'https://192.168.1.10/hook',
      'https://[::1]/hook',
      'https://metadata.internal/hook',
    ];

    for (const url of badUrls) {
      const res = await app.request(
        '/api/admin/webhooks',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...adminHeaders(),
          },
          body: JSON.stringify({
            name: 'SSRF Test',
            url,
            events: ['file.uploaded'],
          }),
        },
        testEnv
      );
      expect(res.status, `Expected 400 for URL: ${url}`).toBe(400);
    }
  });

  it('supports webhook CRUD, HMAC-SHA256 signing, test ping, and delivery logs', async () => {
    const testEnv = makeEnv();
    const capturedRequests: Array<{
      url: string;
      headers: Headers;
      body: string;
    }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedRequests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return new Response(JSON.stringify({ received: true }), { status: 202 });
      })
    );

    // 1. Create webhook
    const createRes = await app.request(
      '/api/admin/webhooks',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...adminHeaders(),
        },
        body: JSON.stringify({
          name: 'Files Events',
          url: 'https://hooks.example.com/files',
          events: ['file.uploaded', 'file.deleted'],
        }),
      },
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      ok: boolean;
      secret: string;
      webhook: { id: string; name: string; url: string; events: string[]; enabled: boolean };
    };
    expect(created.ok).toBe(true);
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.webhook.events).toEqual(['file.uploaded', 'file.deleted']);
    const webhookId = created.webhook.id;

    // 2. List webhooks (never exposes secret)
    const listRes = await app.request(
      '/api/admin/webhooks',
      { headers: adminHeaders() },
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      webhooks: Array<Record<string, unknown>>;
    };
    const found = listJson.webhooks.find((w) => w.id === webhookId);
    expect(found).toBeTruthy();
    expect(found?.secret).toBeUndefined();
    expect(found?.secret_ciphertext).toBeUndefined();

    // 3. Test ping
    const testRes = await app.request(
      `/api/admin/webhooks/${webhookId}/test`,
      {
        method: 'POST',
        headers: adminHeaders(),
      },
      testEnv
    );
    expect(testRes.status).toBe(200);
    const testJson = (await testRes.json()) as {
      ok: boolean;
      delivery: { id: string; eventType: string; statusCode: number; ok: boolean };
    };
    expect(testJson.ok).toBe(true);
    expect(testJson.delivery.eventType).toBe('webhook.test');
    expect(testJson.delivery.statusCode).toBe(202);

    // Verify HMAC signature on captured request
    expect(capturedRequests.length).toBe(1);
    const pingReq = capturedRequests[0];
    expect(pingReq.headers.get('X-Files-Event')).toBe('webhook.test');
    expect(pingReq.headers.get('X-Files-Delivery-Id')).toBe(testJson.delivery.id);
    const expectedSig = await signWebhookPayload(created.secret, pingReq.body);
    expect(pingReq.headers.get('X-Files-Signature-256')).toBe(expectedSig);

    // 4. Dispatch tenant webhook event for subscribed & unsubscribed events
    const unsubDeliveries = await dispatchTenantWebhookEvent(
      testEnv,
      TEST_TENANT,
      'folder.created',
      { folderId: 'fld-1' }
    );
    expect(unsubDeliveries.length).toBe(0);

    const subDeliveries = await dispatchTenantWebhookEvent(
      testEnv,
      TEST_TENANT,
      'file.uploaded',
      { fileId: 'file-123', name: 'report.pdf' }
    );
    expect(subDeliveries.length).toBe(1);
    expect(subDeliveries[0].ok).toBe(true);
    expect(capturedRequests.length).toBe(2);
    const fileSig = await signWebhookPayload(
      created.secret,
      capturedRequests[1].body
    );
    expect(capturedRequests[1].headers.get('X-Files-Signature-256')).toBe(fileSig);

    // 5. Delivery logs endpoint
    const logsRes = await app.request(
      `/api/admin/webhooks/${webhookId}/deliveries`,
      { headers: adminHeaders() },
      testEnv
    );
    expect(logsRes.status).toBe(200);
    const logsJson = (await logsRes.json()) as {
      deliveries: Array<{ eventType: string; ok: boolean; statusCode: number }>;
    };
    expect(logsJson.deliveries.length).toBe(2);
    expect(logsJson.deliveries[0].eventType).toBe('file.uploaded');
    expect(logsJson.deliveries[1].eventType).toBe('webhook.test');

    // 6. Patch webhook (disable) & Delete
    const patchRes = await app.request(
      `/api/admin/webhooks/${webhookId}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...adminHeaders(),
        },
        body: JSON.stringify({ enabled: false }),
      },
      testEnv
    );
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as {
      webhook: { enabled: boolean };
    };
    expect(patchJson.webhook.enabled).toBe(false);

    const delRes = await app.request(
      `/api/admin/webhooks/${webhookId}`,
      {
        method: 'DELETE',
        headers: adminHeaders(),
      },
      testEnv
    );
    expect(delRes.status).toBe(200);
  });

  it('creates, authenticates with Bearer fls_..., expires, and revokes scoped API tokens', async () => {
    const testEnv = makeEnv();

    // 1. Create API token as member
    const createRes = await app.request(
      '/api/api-tokens',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...memberHeaders(),
        },
        body: JSON.stringify({
          name: 'CI Sync Token',
          scopes: ['files:read', 'search:read'],
          expiresInDays: 30,
        }),
      },
      testEnv
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      ok: boolean;
      token: string;
      apiToken: {
        id: string;
        name: string;
        tokenPrefix: string;
        scopes: string[];
        expiresAt: string | null;
        status: string;
      };
    };
    expect(created.ok).toBe(true);
    expect(created.token).toMatch(/^fls_/);
    expect(created.apiToken.tokenPrefix).toBe(created.token.slice(0, 12));
    expect(created.apiToken.scopes).toEqual(['files:read', 'search:read']);
    expect(created.apiToken.status).toBe('active');

    // 2. List tokens never returns plaintext or hash
    const listRes = await app.request(
      '/api/api-tokens',
      { headers: memberHeaders() },
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    const listed = listJson.tokens.find((t) => t.id === created.apiToken.id);
    expect(listed).toBeTruthy();
    expect(listed?.token).toBeUndefined();
    expect(listed?.token_hash).toBeUndefined();
    expect(listed?.tokenHash).toBeUndefined();

    // 3. Authenticate using Authorization: Bearer fls_...
    const bearerRes = await app.request(
      '/api/api-tokens',
      {
        headers: {
          Authorization: `Bearer ${created.token}`,
        },
      },
      testEnv
    );
    expect(bearerRes.status).toBe(200);

    // Verify last_used_at was updated
    const tokenHash = await sha256Hex(created.token);
    const dbRow = await env.DB.prepare(
      'SELECT last_used_at FROM api_tokens WHERE token_hash = ?'
    )
      .bind(tokenHash)
      .first<{ last_used_at: string | null }>();
    expect(dbRow?.last_used_at).toBeTruthy();

    // 4. Revoke token and confirm Bearer auth is rejected with 401
    const revokeRes = await app.request(
      `/api/api-tokens/${created.apiToken.id}`,
      {
        method: 'DELETE',
        headers: memberHeaders(),
      },
      testEnv
    );
    expect(revokeRes.status).toBe(200);

    const rejectedAfterRevoke = await app.request(
      '/api/api-tokens',
      {
        headers: {
          Authorization: `Bearer ${created.token}`,
        },
      },
      testEnv
    );
    expect(rejectedAfterRevoke.status).toBe(401);
    const revokedErr = (await rejectedAfterRevoke.json()) as { code: string };
    expect(revokedErr.code).toBe('API_TOKEN_REVOKED');

    // 5. Expired token is rejected with 401 API_TOKEN_EXPIRED
    const expiredRaw = 'fls_expired_token_for_unit_test_123456';
    const expiredHash = await sha256Hex(expiredRaw);
    await env.DB.prepare(
      `INSERT INTO api_tokens (id, tenant_id, user_id, name, token_prefix, token_hash, scopes_json, expires_at)
       VALUES (?, ?, ?, 'Expired', 'fls_expired_', ?, '["files:read"]', '2020-01-01T00:00:00.000Z')`
    )
      .bind('tok-expired-1', TEST_TENANT, TEST_MEMBER_ID, expiredHash)
      .run();

    const expiredRes = await app.request(
      '/api/api-tokens',
      {
        headers: {
          Authorization: `Bearer ${expiredRaw}`,
        },
      },
      testEnv
    );
    expect(expiredRes.status).toBe(401);
    const expiredErr = (await expiredRes.json()) as { code: string };
    expect(expiredErr.code).toBe('API_TOKEN_EXPIRED');
  });
});
