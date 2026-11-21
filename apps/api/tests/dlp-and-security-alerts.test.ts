import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import {
  detectDownloadAnomaly,
  evaluateDlpRulesForFile,
  luhnValid,
  myNumberValid,
  scanText,
  validateCustomPattern,
} from '../src/services/dlp-scanner';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-dlp';
const APP_ORIGIN = 'http://127.0.0.1:8787';
const SYS = 'dlp-sys';
const MEMBER = 'dlp-member';
const FILE_ID = 'dlp-file-1';

const VALID_CARD = '4111 1111 1111 1111';
const INVALID_CARD = '4111 1111 1111 1112';
// 12-digit My Number with valid Mod-11 check digit (computed: 12345678901 + check 8).
const VALID_MYNUMBER = '123456789018';
const INVALID_MYNUMBER = '123456789019';

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN,
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-dlp-secret',
    DEFAULT_TENANT_ID: TENANT,
  } as unknown as OidcEnv;
}

async function call<T = Record<string, any>>(
  path: string,
  options: { method?: string; userId?: string; role?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
  const userId = options.userId ?? SYS;
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'X-Dev-User-Id': userId,
        'X-Dev-User-Role': options.role ?? 'sys_admin',
        'X-Dev-Tenant-Id': TENANT,
        'X-Dev-User-Email': `${userId}@example.com`,
        'X-Dev-User-Type': 'member',
        'Content-Type': 'application/json',
        Origin: APP_ORIGIN,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    }),
    buildTestEnv()
  );
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function createRule(body: Record<string, unknown>) {
  const res = await call<{ rule: { id: string } }>('/api/admin/dlp-rules', {
    method: 'POST',
    body,
  });
  return res;
}

describe('DLP scanner & security alerts (Phase 4 Task 7)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'DLP Tenant', 'dlp-tenant', 1000000)`
      ).bind(TENANT),
      env.DB.prepare('INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)').bind(TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, user_type)
         VALUES (?, ?, 'dlp-sys@example.com', 'DLP Sys', 'sys_admin', 'active', 'member'),
                (?, ?, 'dlp-member@example.com', 'DLP Member', 'member', 'active', 'member')`
      ).bind(SYS, TENANT, MEMBER, TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES ('dlp-folder', ?, NULL, 'DLP', 0, 1, 'unset', ?)`
      ).bind(TENANT, SYS),
    ]);
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM dlp_rules WHERE tenant_id = ?').bind(TENANT),
      env.DB.prepare('DELETE FROM security_alerts WHERE tenant_id = ?').bind(TENANT),
      env.DB.prepare('DELETE FROM audit_logs WHERE tenant_id = ?').bind(TENANT),
      env.DB.prepare('DELETE FROM files WHERE tenant_id = ?').bind(TENANT),
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, current_version_id, current_version_num, classification, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, 'dlp-folder', 'notes.txt', 'txt', 'text/plain', 10, 'active', 'dlp-v1', 1, 'unset', ?, ?, ?, ?)`
      ).bind(FILE_ID, TENANT, SYS, SYS, new Date().toISOString(), new Date().toISOString()),
    ]);
  });

  it('validates credit cards with Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(scanText('builtin_credit_card', null, `card ${VALID_CARD}`)).toEqual({
      matched: true,
      matchCount: 1,
    });
    expect(scanText('builtin_credit_card', null, `card ${INVALID_CARD}`).matched).toBe(false);
    expect(scanText('builtin_credit_card', null, 'card 4111-1111-1111-1111 ok').matched).toBe(true);
  });

  it('validates My Number Mod-11 check digit', () => {
    expect(myNumberValid(VALID_MYNUMBER)).toBe(true);
    expect(myNumberValid(INVALID_MYNUMBER)).toBe(false);
    expect(scanText('builtin_mynumber', null, `id ${VALID_MYNUMBER}`).matched).toBe(true);
    expect(scanText('builtin_mynumber', null, `id ${INVALID_MYNUMBER}`).matched).toBe(false);
  });

  it('detects bulk emails only at >= 5 distinct addresses', () => {
    const four = 'a@x.com b@x.com c@x.com d@x.com a@x.com';
    expect(scanText('builtin_email_bulk', null, four).matched).toBe(false);
    expect(scanText('builtin_email_bulk', null, `${four} e@x.com`)).toEqual({
      matched: true,
      matchCount: 5,
    });
  });

  it('rejects ReDoS-prone custom regexes', async () => {
    expect(validateCustomPattern('(a+)+$')).not.toBeNull();
    expect(validateCustomPattern('(.*)*x')).not.toBeNull();
    expect(validateCustomPattern('a'.repeat(121))).not.toBeNull();
    expect(validateCustomPattern('PROJ-\\d{4}')).toBeNull();
    const res = await createRule({ name: 'bad', patternType: 'custom_regex', customPattern: '(a+)+' });
    expect(res.status).toBe(400);
    const test = await call('/api/admin/dlp-rules/test', {
      method: 'POST',
      body: { patternType: 'custom_regex', customPattern: '(a+)+', sampleText: 'aaaa' },
    });
    expect(test.status).toBe(400);
  });

  it('dry-run test does not persist anything', async () => {
    const res = await call<{ matched: boolean; matchCount: number }>('/api/admin/dlp-rules/test', {
      method: 'POST',
      body: { patternType: 'builtin_credit_card', sampleText: VALID_CARD },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matched: true, matchCount: 1 });
    const rules = await env.DB.prepare('SELECT COUNT(*) AS c FROM dlp_rules').first<{ c: number }>();
    expect(rules?.c).toBe(0);
  });

  it('escalate_confidential upgrades classification without leaking raw PII', async () => {
    const created = await createRule({
      name: 'Cards',
      patternType: 'builtin_credit_card',
      action: 'escalate_confidential',
    });
    expect(created.status).toBe(201);
    const result = await evaluateDlpRulesForFile(env.DB, TENANT, {
      fileId: FILE_ID,
      fileName: 'notes.txt',
      excerpt: `payment ${VALID_CARD} and my number ${VALID_MYNUMBER}`,
      actorId: null,
    });
    expect(result.escalated).toBe(true);
    const file = await env.DB.prepare('SELECT classification FROM files WHERE id = ?')
      .bind(FILE_ID)
      .first<{ classification: string }>();
    expect(file?.classification).toBe('confidential');

    const alerts = await env.DB.prepare(
      'SELECT details_json, title FROM security_alerts WHERE tenant_id = ?'
    )
      .bind(TENANT)
      .all<{ details_json: string; title: string }>();
    expect(alerts.results).toHaveLength(1);
    const blob = JSON.stringify(alerts.results);
    expect(blob).not.toContain('4111');
    expect(blob).not.toContain(VALID_MYNUMBER);
    expect(JSON.parse(alerts.results[0].details_json).matchCount).toBe(1);

    const audits = await env.DB.prepare(
      `SELECT action, metadata_json FROM audit_logs WHERE tenant_id = ? AND action = 'dlp.rule_matched'`
    )
      .bind(TENANT)
      .all<{ action: string; metadata_json: string }>();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0].metadata_json).not.toContain('4111');
  });

  it('alert-only rule leaves classification untouched; disabled rules are skipped', async () => {
    const created = await createRule({ name: 'Cards', patternType: 'builtin_credit_card' });
    await evaluateDlpRulesForFile(env.DB, TENANT, {
      fileId: FILE_ID,
      fileName: 'x.txt',
      excerpt: VALID_CARD,
      actorId: null,
    });
    const file = await env.DB.prepare('SELECT classification FROM files WHERE id = ?')
      .bind(FILE_ID)
      .first<{ classification: string }>();
    expect(file?.classification).toBe('unset');

    await call(`/api/admin/dlp-rules/${created.body.rule.id}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    const again = await evaluateDlpRulesForFile(env.DB, TENANT, {
      fileId: FILE_ID,
      fileName: 'x.txt',
      excerpt: VALID_CARD,
      actorId: null,
    });
    expect(again.matchedRuleIds).toHaveLength(0);
  });

  it('acknowledges and resolves alerts via the API; members are denied', async () => {
    await createRule({ name: 'Cards', patternType: 'builtin_credit_card' });
    await evaluateDlpRulesForFile(env.DB, TENANT, {
      fileId: FILE_ID,
      fileName: 'x.txt',
      excerpt: VALID_CARD,
      actorId: null,
    });
    const list = await call<{ alerts: Array<{ id: string; status: string }> }>(
      '/api/admin/security-alerts?status=open'
    );
    expect(list.body.alerts).toHaveLength(1);
    const id = list.body.alerts[0].id;

    const denied = await call(`/api/admin/security-alerts/${id}`, {
      method: 'PATCH',
      userId: MEMBER,
      role: 'member',
      body: { status: 'resolved' },
    });
    expect(denied.status).toBe(403);

    const ack = await call<{ alert: { status: string } }>(`/api/admin/security-alerts/${id}`, {
      method: 'PATCH',
      body: { status: 'acknowledged' },
    });
    expect(ack.body.alert.status).toBe('acknowledged');
    const resolved = await call<{ alert: { status: string; resolvedBy: string | null } }>(
      `/api/admin/security-alerts/${id}`,
      { method: 'PATCH', body: { status: 'resolved' } }
    );
    expect(resolved.body.alert.status).toBe('resolved');
    expect(resolved.body.alert.resolvedBy).toBe(SYS);

    const open = await call<{ alerts: unknown[] }>('/api/admin/security-alerts?status=open');
    expect(open.body.alerts).toHaveLength(0);
    const all = await call<{ alerts: unknown[] }>('/api/admin/security-alerts?status=all');
    expect(all.body.alerts).toHaveLength(1);
  });

  it('detects bulk download anomalies once per hour', async () => {
    const below = await detectDownloadAnomaly(env.DB, TENANT, MEMBER);
    expect(below.alerted).toBe(false);
    const stmts = Array.from({ length: 30 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO audit_logs (id, tenant_id, actor_id, action, target_type, target_id, status, created_at)
         VALUES (?, ?, ?, 'file.download', 'file', ?, 'allowed', ?)`
      ).bind(`dl-${i}`, TENANT, MEMBER, `f-${i}`, new Date().toISOString())
    );
    await env.DB.batch(stmts);
    const first = await detectDownloadAnomaly(env.DB, TENANT, MEMBER);
    expect(first.alerted).toBe(true);
    const second = await detectDownloadAnomaly(env.DB, TENANT, MEMBER);
    expect(second.alerted).toBe(false);
    const rows = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM security_alerts WHERE tenant_id = ? AND alert_type = 'bulk_download_anomaly'`
    )
      .bind(TENANT)
      .first<{ c: number }>();
    expect(rows?.c).toBe(1);
  });
});
