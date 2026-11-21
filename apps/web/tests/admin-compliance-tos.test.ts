import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateQuotaBanner,
  formatTosAudienceLabel,
  isTosTargetAudience,
  parseTosMarkdownBlocks,
  readBranding,
  readFileRequestPolicy,
  readQuotaThresholds,
  readSiemEvents,
  TOS_AUDIENCE_LABELS,
  TOS_AUDIENCE_OPTIONS,
  validateQuotaThresholds,
  validateSiemUrlClient,
} from '@/lib/admin-compliance';
import {
  ADMIN_CONSOLE_NAV_ITEMS,
  getAdminSectionOwnedApiPrefixes,
  isAdminApiOwnedBySection,
} from '@/lib/admin-console-nav';
import { formatAuditActionLabel } from '@/lib/admin-audit';
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

test('quota thresholds validate ranges, ordering and banner severity', () => {
  assert.deepEqual(validateQuotaThresholds(80, 90), { ok: true });
  assert.equal(validateQuotaThresholds(50, 51).ok, true);
  assert.equal(validateQuotaThresholds(99, 100).ok, true);

  assert.equal(validateQuotaThresholds(49, 90).code, 'INVALID_QUOTA_THRESHOLDS');
  assert.equal(validateQuotaThresholds(80, 101).code, 'INVALID_QUOTA_THRESHOLDS');
  assert.equal(validateQuotaThresholds(90, 90).ok, false);
  assert.equal(validateQuotaThresholds(91, 90).ok, false);
  assert.equal(validateQuotaThresholds(80.5, 90).ok, false);

  assert.equal(evaluateQuotaBanner(79, { warn: 80, critical: 90 }).level, 'normal');
  assert.equal(evaluateQuotaBanner(80, { warn: 80, critical: 90 }).level, 'warning');
  assert.equal(evaluateQuotaBanner(89, { warn: 80, critical: 90 }).level, 'warning');
  assert.equal(evaluateQuotaBanner(90, { warn: 80, critical: 90 }).level, 'critical');
  assert.equal(evaluateQuotaBanner(120, { warn: 80, critical: 90 }).usedPct, 100);
});

test('quota threshold helpers read camelCase and snake_case policy projections', () => {
  assert.deepEqual(readQuotaThresholds(null), { warn: 80, critical: 90 });
  assert.deepEqual(
    readQuotaThresholds(
      policy({ quota_warn_threshold_pct: 70, quota_critical_threshold_pct: 95 })
    ),
    { warn: 70, critical: 95 }
  );
  assert.deepEqual(
    readQuotaThresholds(
      policy({ quotaWarnThresholdPct: 60, quotaCriticalThresholdPct: 75 })
    ),
    { warn: 60, critical: 75 }
  );
});

test('SIEM URL client validation rejects non-https and private targets', () => {
  assert.equal(validateSiemUrlClient('https://siem.example.com/ingest').ok, true);
  assert.equal(validateSiemUrlClient('https://198.51.100.10/ingest').ok, true);

  assert.equal(validateSiemUrlClient('http://siem.example.com').ok, false);
  assert.equal(validateSiemUrlClient('not-a-url').ok, false);
  assert.equal(validateSiemUrlClient('').ok, false);
  assert.equal(validateSiemUrlClient('https://localhost/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://collector.internal/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://siem.local/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://127.0.0.1/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://10.0.0.5/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://172.16.4.2/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://192.168.1.10/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://169.254.169.254/latest').ok, false);
  assert.equal(validateSiemUrlClient('https://100.64.0.2/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://[::1]/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://[fc00::1]/ingest').ok, false);
  assert.equal(validateSiemUrlClient('https://[fe80::1]/ingest').ok, false);
  assert.equal(
    validateSiemUrlClient('https://[::ffff:192.168.1.4]/ingest').ok,
    false
  );
});

test('ToS markdown parser emits safe text-only blocks', () => {
  const blocks = parseTosMarkdownBlocks(
    '# 見出し\n\n本文 <script>alert(1)</script>\n続き\n\n- 箇条書き\n1. 番号付き\n## 小見出し'
  );
  assert.deepEqual(blocks, [
    { kind: 'heading', level: 1, text: '見出し' },
    {
      kind: 'paragraph',
      text: '本文 <script>alert(1)</script>\n続き',
    },
    { kind: 'bullet', text: '箇条書き' },
    { kind: 'bullet', text: '番号付き' },
    { kind: 'heading', level: 2, text: '小見出し' },
  ]);
  assert.equal('html' in blocks[1]!, false);
  assert.equal(parseTosMarkdownBlocks('').length, 0);
});

test('ToS audience options and labels are exhaustive', () => {
  assert.deepEqual(TOS_AUDIENCE_OPTIONS, [
    'all_users',
    'guests_only',
    'members_only',
  ]);
  for (const audience of TOS_AUDIENCE_OPTIONS) {
    assert.equal(isTosTargetAudience(audience), true);
    assert.equal(typeof TOS_AUDIENCE_LABELS[audience], 'string');
  }
  assert.equal(isTosTargetAudience('everyone'), false);
  assert.equal(formatTosAudienceLabel('guests_only'), '外部ゲストのみ');
  assert.equal(formatTosAudienceLabel('members_only'), '社内メンバーのみ');
  assert.equal(formatTosAudienceLabel('all_users'), 'すべてのユーザー');
});

test('file-request governance and branding helpers project defaults', () => {
  assert.deepEqual(readFileRequestPolicy(null), {
    allowFileRequests: true,
    fileRequestMaxSizeBytes: 104857600,
    fileRequestEnforceAllowedExtensions: false,
  });
  assert.deepEqual(
    readFileRequestPolicy(
      policy({
        allowFileRequests: false,
        fileRequestMaxSizeBytes: 1048576,
        fileRequestEnforceAllowedExtensions: true,
      })
    ),
    {
      allowFileRequests: false,
      fileRequestMaxSizeBytes: 1048576,
      fileRequestEnforceAllowedExtensions: true,
    }
  );
  assert.deepEqual(readBranding(null), {
    orgName: null,
    contactInfo: null,
    footerNote: null,
    logoUrl: null,
    accentColor: null,
  });
  assert.deepEqual(
    readBranding(
      policy({
        brandingOrgName: ' サンプル株式会社 ',
        branding_contact_info: 'security@example.com',
        brandingFooterNote: '法務注記',
      })
    ),
    {
      orgName: 'サンプル株式会社',
      contactInfo: 'security@example.com',
      footerNote: '法務注記',
      logoUrl: null,
      accentColor: null,
    }
  );
  assert.deepEqual(readSiemEvents(null), ['security_blocked', 'admin_mutation']);
  assert.deepEqual(readSiemEvents([]), []);
  assert.deepEqual(readSiemEvents(['admin_mutation']), ['admin_mutation']);
});

test('admin nav assigns compliance APIs to settings and file requests to content', () => {
  assert.deepEqual(
    ADMIN_CONSOLE_NAV_ITEMS.map((item) => item.section),
    ['all', 'insights', 'content', 'users', 'settings', 'reports']
  );

  assert.equal(isAdminApiOwnedBySection('settings', '/api/admin/tos'), true);
  assert.equal(isAdminApiOwnedBySection('settings', '/api/admin/siem'), true);
  assert.equal(isAdminApiOwnedBySection('settings', '/api/admin/siem/test'), true);
  assert.equal(isAdminApiOwnedBySection('settings', '/api/admin/policies'), true);
  assert.equal(
    isAdminApiOwnedBySection('settings', '/api/admin/settings-bundle'),
    true
  );
  assert.equal(
    isAdminApiOwnedBySection('settings', '/api/admin/file-requests'),
    false
  );

  assert.equal(
    isAdminApiOwnedBySection('content', '/api/admin/file-requests'),
    true
  );
  assert.equal(
    isAdminApiOwnedBySection('content', '/api/admin/file-requests/abc/disable'),
    true
  );
  assert.equal(isAdminApiOwnedBySection('content', '/api/admin/tos'), false);
  assert.equal(isAdminApiOwnedBySection('content', '/api/admin/siem'), false);
  assert.equal(
    isAdminApiOwnedBySection('insights', '/api/admin/policies'),
    false
  );
  assert.ok(
    getAdminSectionOwnedApiPrefixes('content').includes(
      '/api/admin/file-requests'
    )
  );
});

test('TOM-72 audit labels are registered', () => {
  assert.equal(
    formatAuditActionLabel('auth.tos_accepted'),
    'カスタム利用規約への同意'
  );
  assert.equal(
    formatAuditActionLabel('admin.tos.updated'),
    'カスタム利用規約の更新'
  );
  assert.equal(
    formatAuditActionLabel('admin.file_request.disabled'),
    'ファイルリクエストの緊急停止'
  );
  assert.equal(
    formatAuditActionLabel('admin.siem.updated'),
    'SIEM Webhook 設定更新'
  );
  assert.equal(
    formatAuditActionLabel('admin.siem.tested'),
    'SIEM Webhook テスト送信'
  );
});
