import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-vb';
const APP_ORIGIN = 'http://127.0.0.1:8787';
const SYS = 'vb-sys';
const SEC = 'vb-sec';
const MEMBER = 'vb-member';

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01,
]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN,
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-vb-secret',
    DEFAULT_TENANT_ID: TENANT,
  } as unknown as OidcEnv;
}

function devHeaders(
  userId: string,
  role: 'sys_admin' | 'sec_admin' | 'member',
  extra: Record<string, string> = {}
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': TENANT,
    'X-Dev-User-Email': `${userId}@example.com`,
    'X-Dev-User-Type': 'member',
    'CF-Connecting-IP': '198.51.100.30',
    Origin: APP_ORIGIN,
    ...extra,
  };
}

describe('visual branding API', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, ?, ?, 1000000)`
      ).bind(TENANT, 'Visual Branding Tenant', 'vb-tenant'),
      env.DB.prepare(
        'INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, user_type) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(SYS, TENANT, `${SYS}@example.com`, 'Sys Admin', 'sys_admin', 'member'),
      env.DB.prepare(
        'INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, user_type) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(SEC, TENANT, `${SEC}@example.com`, 'Sec Admin', 'sec_admin', 'member'),
      env.DB.prepare(
        'INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, user_type) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(MEMBER, TENANT, `${MEMBER}@example.com`, 'Member', 'member', 'member'),
      env.DB.prepare(
        'INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)'
      ).bind(TENANT),
      env.DB.prepare(
        `UPDATE tenant_policies
            SET branding_logo_r2_key = NULL,
                branding_accent_color = NULL
          WHERE tenant_id = ?`
      ).bind(TENANT),
    ]);
    await env.BUCKET.delete(`branding/${TENANT}/logo`).catch(() => {});
  });

  it('allows valid PNG upload, public GET with nosniff + cache, and DELETE', async () => {
    const testEnv = buildTestEnv();

    // Unset logo returns 404
    const initialGet = await app.fetch(
      new Request(`${APP_ORIGIN}/api/branding/${TENANT}/logo`),
      testEnv
    );
    expect(initialGet.status).toBe(404);

    // Upload PNG via binary body
    const uploadRes = await app.fetch(
      new Request(`${APP_ORIGIN}/api/admin/branding/logo`, {
        method: 'POST',
        headers: {
          ...devHeaders(SYS, 'sys_admin'),
          'Content-Type': 'image/png',
        },
        body: PNG_BYTES,
      }),
      testEnv
    );
    expect(uploadRes.status).toBe(200);
    const uploadJson = (await uploadRes.json()) as {
      ok: boolean;
      logoUrl: string;
      contentType: string;
    };
    expect(uploadJson.ok).toBe(true);
    expect(uploadJson.logoUrl).toBe(`/api/branding/${TENANT}/logo`);
    expect(uploadJson.contentType).toBe('image/png');

    // Public GET returns PNG with security & cache headers
    const getRes = await app.fetch(
      new Request(`${APP_ORIGIN}/api/branding/${TENANT}/logo`),
      testEnv
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('image/png');
    expect(getRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(getRes.headers.get('Cache-Control')).toBe('public, max-age=300');
    const fetchedBytes = new Uint8Array(await getRes.arrayBuffer());
    expect(fetchedBytes).toEqual(PNG_BYTES);

    // Audit log recorded
    const auditRow = await env.DB.prepare(
      `SELECT action FROM audit_logs WHERE tenant_id = ? AND action = 'branding.logo_upload' LIMIT 1`
    )
      .bind(TENANT)
      .first<{ action: string }>();
    expect(auditRow?.action).toBe('branding.logo_upload');

    // DELETE removes from R2 and clears DB column
    const delRes = await app.fetch(
      new Request(`${APP_ORIGIN}/api/admin/branding/logo`, {
        method: 'DELETE',
        headers: devHeaders(SEC, 'sec_admin'),
      }),
      testEnv
    );
    expect(delRes.status).toBe(200);
    expect(await env.BUCKET.head(`branding/${TENANT}/logo`)).toBeNull();

    const afterDelGet = await app.fetch(
      new Request(`${APP_ORIGIN}/api/branding/${TENANT}/logo`),
      testEnv
    );
    expect(afterDelGet.status).toBe(404);
  });

  it('supports multipart/form-data upload for JPEG and WebP', async () => {
    const testEnv = buildTestEnv();
    for (const [bytes, expectedMime] of [
      [JPEG_BYTES, 'image/jpeg'],
      [WEBP_BYTES, 'image/webp'],
    ] as const) {
      const form = new FormData();
      form.append('logo', new File([bytes], 'logo.bin', { type: expectedMime }));
      const res = await app.fetch(
        new Request(`${APP_ORIGIN}/api/admin/branding/logo`, {
          method: 'POST',
          headers: devHeaders(SYS, 'sys_admin'),
          body: form,
        }),
        testEnv
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { contentType: string };
      expect(body.contentType).toBe(expectedMime);
    }
  });

  it('rejects SVG, HTML, and unknown magic bytes to prevent XSS', async () => {
    const testEnv = buildTestEnv();
    const payloads = [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<html><body><script>alert(1)</script></body></html>',
      'GIF89a\x01\x00\x01\x00\x80\x00\x00',
      'plain text not an image',
    ];
    for (const payload of payloads) {
      const res = await app.fetch(
        new Request(`${APP_ORIGIN}/api/admin/branding/logo`, {
          method: 'POST',
          headers: {
            ...devHeaders(SYS, 'sys_admin'),
            'Content-Type': 'image/svg+xml',
          },
          body: new TextEncoder().encode(payload),
        }),
        testEnv
      );
      expect(res.status).toBe(400);
    }
  });

  it('rejects logos larger than 512 KiB and enforces admin RBAC', async () => {
    const testEnv = buildTestEnv();
    const oversized = new Uint8Array(512 * 1024 + 1);
    oversized.set(PNG_BYTES, 0);

    const tooLargeRes = await app.fetch(
      new Request(`${APP_ORIGIN}/api/admin/branding/logo`, {
        method: 'POST',
        headers: {
          ...devHeaders(SYS, 'sys_admin'),
          'Content-Type': 'image/png',
        },
        body: oversized,
      }),
      testEnv
    );
    expect(tooLargeRes.status).toBe(413);

    const memberRes = await app.fetch(
      new Request(`${APP_ORIGIN}/api/admin/branding/logo`, {
        method: 'POST',
        headers: {
          ...devHeaders(MEMBER, 'member'),
          'Content-Type': 'image/png',
        },
        body: PNG_BYTES,
      }),
      testEnv
    );
    expect(memberRes.status).toBe(403);
  });

  it('validates brandingAccentColor as strict #RRGGBB or null', async () => {
    const testEnv = buildTestEnv();

    for (const invalid of ['red', '#fff', '#12345g', '123456', 'rgb(0,0,0)', 123]) {
      const badRes = await app.fetch(
        new Request(`${APP_ORIGIN}/api/admin/policies`, {
          method: 'PATCH',
          headers: {
            ...devHeaders(SYS, 'sys_admin'),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ brandingAccentColor: invalid }),
        }),
        testEnv
      );
      expect(badRes.status).toBe(400);
    }

    const okRes = await app.fetch(
      new Request(`${APP_ORIGIN}/api/admin/policies`, {
        method: 'PATCH',
        headers: {
          ...devHeaders(SYS, 'sys_admin'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ brandingAccentColor: '#2563EB' }),
      }),
      testEnv
    );
    expect(okRes.status).toBe(200);
    const okJson = (await okRes.json()) as {
      policy: { brandingAccentColor: string | null };
    };
    expect(okJson.policy.brandingAccentColor).toBe('#2563eb');

    const clearRes = await app.fetch(
      new Request(`${APP_ORIGIN}/api/admin/policies`, {
        method: 'PATCH',
        headers: {
          ...devHeaders(SYS, 'sys_admin'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ brandingAccentColor: null }),
      }),
      testEnv
    );
    expect(clearRes.status).toBe(200);
    const clearJson = (await clearRes.json()) as {
      policy: { brandingAccentColor: string | null };
    };
    expect(clearJson.policy.brandingAccentColor).toBeNull();
  });
});
