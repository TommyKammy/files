import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canManageAuthControls,
  describeAuthControlError,
  IP_ALLOWLIST_MAX_ENTRIES,
  isIpAllowedByList,
  isValidIpOrCidr,
  normalizeSsoDomain,
  parseIpAllowlistEntry,
  readIpAllowlist,
  readIpAllowlistEnabled,
  readIpAllowlistScope,
  readRequireSsoLogin,
  readSsoAllowedDomains,
  validateIpAllowlistInput,
  validateSsoAllowedDomains,
} from '@/lib/admin-ip-sso';
import {
  formatAuditActionLabel,
  isSecurityAuditAction,
  SECURITY_AUDIT_ACTION_PREFIXES,
} from '@/lib/admin-audit';
import type { TenantPolicyRow } from '@/types/files';

function policy(overrides: Partial<TenantPolicyRow> = {}): TenantPolicyRow {
  return {
    tenant_id: 't1',
    enforce_company_only_links: 0,
    require_watermark_confidential: 1,
    max_link_expiration_days: 30,
    session_max_hours: 12,
    trash_retention_days: 30,
    ai_classification_mode: 'metadata_only',
    ai_auto_apply_threshold: null,
    updated_by: null,
    updated_at: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

test('validateIpAllowlistInput accepts IPv4/IPv6 single addresses and CIDRs', () => {
  const result = validateIpAllowlistInput([
    '203.0.113.10',
    '203.0.113.0/24',
    '2001:db8::1',
    '2001:db8::/32',
    '[2001:db8::1]',
    '::ffff:203.0.113.10',
    '203.0.113.10',
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.entries, [
    '203.0.113.10',
    '203.0.113.0/24',
    '2001:db8::1',
    '2001:db8::/32',
  ]);
});

test('validateIpAllowlistInput rejects malformed CIDRs and enforces the cap', () => {
  for (const entry of [
    '203.0.113.0/33',
    '203.0.113.0/024',
    '203.0.113',
    '203.0.113.256',
    '203.0.113.001',
    '2001:db8::/129',
    '2001:db8:::1',
    '*.example.com',
    '',
  ]) {
    assert.equal(isValidIpOrCidr(entry), false, entry);
  }
  assert.equal(parseIpAllowlistEntry('203.0.113.0/24')?.normalized, '203.0.113.0/24');
  assert.equal(parseIpAllowlistEntry('::1')?.normalized, '::1');
  assert.equal(parseIpAllowlistEntry('203.0.113.10/32')?.normalized, '203.0.113.10/32');
  assert.equal(
    parseIpAllowlistEntry('::ffff:203.0.113.0/120')?.normalized,
    '203.0.113.0/24'
  );

  const tooMany = Array.from(
    { length: IP_ALLOWLIST_MAX_ENTRIES + 1 },
    (_, index) => `10.0.${Math.floor(index / 250)}.${(index % 250) + 1}`
  );
  assert.equal(validateIpAllowlistInput(tooMany).ok, false);
});

test('isIpAllowedByList matches IPv4/IPv6 CIDR boundaries', () => {
  assert.equal(isIpAllowedByList('203.0.113.0', ['203.0.113.0/24']), true);
  assert.equal(isIpAllowedByList('203.0.113.255', ['203.0.113.0/24']), true);
  assert.equal(isIpAllowedByList('203.0.114.1', ['203.0.113.0/24']), false);
  assert.equal(isIpAllowedByList('2001:db8:ffff::1', ['2001:db8::/32']), true);
  assert.equal(isIpAllowedByList('2001:db9::1', ['2001:db8::/32']), false);
  assert.equal(isIpAllowedByList('::ffff:203.0.113.5', ['203.0.113.0/24']), true);
  assert.equal(isIpAllowedByList('not-an-ip', ['0.0.0.0/0']), false);
});

test('SSO domains normalize trim/lowercase/@ removal and dedupe', () => {
  assert.equal(normalizeSsoDomain('  @Example.COM '), 'example.com');
  assert.equal(normalizeSsoDomain('example.com.'), 'example.com');
  assert.equal(normalizeSsoDomain('*.example.com'), null);
  assert.equal(normalizeSsoDomain('https://example.com'), null);
  assert.equal(normalizeSsoDomain('example'), null);

  assert.deepEqual(
    validateSsoAllowedDomains([
      '@Example.COM',
      ' partner.example ',
      'example.com',
    ]),
    { ok: true, domains: ['example.com', 'partner.example'] }
  );
  assert.equal(validateSsoAllowedDomains(['*.example.com']).ok, false);
  assert.equal(validateSsoAllowedDomains(['not a domain']).ok, false);
});

test('auth-control RBAC is sys_admin-only', () => {
  assert.equal(canManageAuthControls('sys_admin'), true);
  assert.equal(canManageAuthControls('sec_admin'), false);
  assert.equal(canManageAuthControls('member'), false);
  assert.equal(canManageAuthControls(null), false);
});

test('policy readers normalize camelCase and raw snake_case rows', () => {
  assert.equal(readIpAllowlistEnabled(policy()), false);
  assert.equal(
    readIpAllowlistEnabled(policy({ ipAllowlistEnabled: true })),
    true
  );
  assert.equal(
    readIpAllowlistEnabled(policy({ ip_allowlist_enabled: 1 })),
    true
  );
  assert.equal(readIpAllowlistScope(policy()), 'admin_only');
  assert.equal(
    readIpAllowlistScope(policy({ ipAllowlistScope: 'all_access' })),
    'all_access'
  );
  assert.deepEqual(
    readIpAllowlist(
      policy({ ipAllowlist: ['203.0.113.0/24', '2001:db8::1'] })
    ),
    ['203.0.113.0/24', '2001:db8::1']
  );
  assert.deepEqual(
    readIpAllowlist(policy({ ip_allowlist_json: '["203.0.113.10"]' })),
    ['203.0.113.10']
  );
  assert.deepEqual(readIpAllowlist(policy({ ip_allowlist_json: '{bad' })), []);
  assert.equal(readRequireSsoLogin(policy({ require_sso_login: 1 })), true);
  assert.deepEqual(
    readSsoAllowedDomains(
      policy({ sso_allowed_domains_json: '["example.com"]' })
    ),
    ['example.com']
  );
});

test('self-lockout errors and security audit actions are human readable', () => {
  const message = describeAuthControlError(
    'SELF_IP_LOCKOUT_PREVENTED',
    'would lock out',
    { ip: '203.0.113.10' }
  );
  assert.match(message, /自己ロックアウト/);
  assert.match(message, /SELF_IP_LOCKOUT_PREVENTED/);
  assert.match(message, /203\.0\.113\.10/);

  assert.equal(
    formatAuditActionLabel('auth.ip_blocked'),
    'IP 許可リストによるアクセス遮断'
  );
  assert.equal(
    formatAuditActionLabel('auth.sso_required_blocked'),
    'SSO 必須ポリシーによるログイン遮断'
  );
  assert.equal(
    formatAuditActionLabel('auth.sso_domain_blocked'),
    'SSO 許可ドメイン外ログイン遮断'
  );
  assert.equal(isSecurityAuditAction('auth.ip_blocked'), true);
  assert.equal(isSecurityAuditAction('admin.policy_updated'), false);
  assert.deepEqual([...SECURITY_AUDIT_ACTION_PREFIXES], ['auth.']);
});
