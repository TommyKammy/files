import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_INTEGRATION_CATALOG,
  ADMIN_INTEGRATION_CATEGORY_LABELS,
  ADMIN_INTEGRATION_OFFICIAL_LABELS,
  ADMIN_INTEGRATION_STATUS_LABELS,
  filterAdminIntegrations,
  getRecommendedAdminIntegrations,
  hasActiveAdminIntegrationFilters,
  resolveAdminIntegrationStatuses,
} from '@/lib/admin-integrations';
import type {
  AdminIntegrationFilterState,
  AdminIntegrationSsoStatus,
} from '@/lib/admin-integrations';
import type {
  AdminSiemSettings,
  TenantPolicyRow,
} from '@/types/files';

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

function siem(overrides: Partial<AdminSiemSettings> = {}): AdminSiemSettings {
  return {
    enabled: false,
    url: null,
    secretConfigured: false,
    events: [],
    updatedAt: null,
    ...overrides,
  };
}

function ssoStatus(
  overrides: Partial<AdminIntegrationSsoStatus> = {}
): AdminIntegrationSsoStatus {
  return {
    providers: [],
    callbackUrl: 'https://files.example.com/auth/callback',
    environment: 'test',
    allowDevAuth: true,
    requireSsoLogin: false,
    ssoAllowedDomains: [],
    clientIp: '203.0.113.10',
    ...overrides,
  };
}

function filters(
  overrides: Partial<AdminIntegrationFilterState> = {}
): AdminIntegrationFilterState {
  return {
    query: '',
    official: 'all',
    category: 'all',
    status: 'all',
    featuredOnly: false,
    ...overrides,
  };
}

const activeStatuses = resolveAdminIntegrationStatuses({
  ssoStatus: ssoStatus({ oidcConfigured: true }),
  siem: siem({ enabled: true, url: 'https://siem.example.com/ingest' }),
});

test('ADMIN_INTEGRATION_CATALOG keeps the Box-compatible catalog order and metadata', () => {
  assert.deepEqual(
    ADMIN_INTEGRATION_CATALOG.map((item) => item.id),
    [
      'scim-provisioning',
      'oidc-sso',
      'siem-webhook',
      'collabora-wopi',
      'workers-ai-classification',
    ]
  );

  assert.deepEqual(
    ADMIN_INTEGRATION_CATALOG.map((item) => ({
      id: item.id,
      title: item.title,
      vendor: item.vendor,
      official: item.official,
      category: item.category,
      featured: item.featured,
      recommended: item.recommended,
    })),
    [
      {
        id: 'scim-provisioning',
        title: 'SCIM 2.0 ディレクトリ同期',
        vendor: 'Files Official / IdP (Okta, Entra ID, Google Workspace)',
        official: 'official',
        category: 'identity',
        featured: true,
        recommended: true,
      },
      {
        id: 'oidc-sso',
        title: 'OIDC シングルサインオン (SSO)',
        vendor: 'Files Official / OpenID Connect',
        official: 'official',
        category: 'identity',
        featured: true,
        recommended: true,
      },
      {
        id: 'siem-webhook',
        title: 'SIEM Webhook 監査ストリーム',
        vendor: 'Custom Webhook / Splunk, Datadog, Sentinel',
        official: 'custom',
        category: 'security',
        featured: true,
        recommended: true,
      },
      {
        id: 'collabora-wopi',
        title: 'Collabora Online (WOPI) 共同編集',
        vendor: 'Files Official / Collabora CODE & Enterprise',
        official: 'official',
        category: 'collaboration',
        featured: true,
        recommended: false,
      },
      {
        id: 'workers-ai-classification',
        title: 'Workers AI 機密区分自動分類',
        vendor: 'Files Official / Cloudflare Workers AI & Ollama',
        official: 'official',
        category: 'ai_governance',
        featured: false,
        recommended: false,
      },
    ]
  );

  for (const item of ADMIN_INTEGRATION_CATALOG) {
    assert.ok(item.summary.length > 0, `${item.id} summary`);
  }
  assert.equal(
    new Set(ADMIN_INTEGRATION_CATALOG.map((item) => item.summary)).size,
    ADMIN_INTEGRATION_CATALOG.length
  );
});

test('integration labels cover every category, official kind and status', () => {
  assert.deepEqual(ADMIN_INTEGRATION_CATEGORY_LABELS, {
    identity: 'ID 管理',
    security: 'セキュリティ',
    collaboration: 'コラボレーション',
    ai_governance: 'AI ガバナンス',
  });
  assert.deepEqual(ADMIN_INTEGRATION_OFFICIAL_LABELS, {
    official: '公式',
    custom: 'カスタム',
  });
  assert.deepEqual(ADMIN_INTEGRATION_STATUS_LABELS, {
    active: '有効',
    not_configured: '未設定',
  });
});

test('resolveAdminIntegrationStatuses treats SCIM, Collabora and Workers AI as active', () => {
  assert.deepEqual(resolveAdminIntegrationStatuses(), {
    'scim-provisioning': 'active',
    'oidc-sso': 'not_configured',
    'siem-webhook': 'not_configured',
    'collabora-wopi': 'active',
    'workers-ai-classification': 'active',
  });

  const statuses = resolveAdminIntegrationStatuses({
    ssoStatus: null,
    siem: null,
    policy: null,
  });
  assert.equal(statuses['scim-provisioning'], 'active');
  assert.equal(statuses['collabora-wopi'], 'active');
  assert.equal(statuses['workers-ai-classification'], 'active');
});

test('resolveAdminIntegrationStatuses resolves OIDC from status and policy projections', () => {
  assert.equal(
    resolveAdminIntegrationStatuses({
      ssoStatus: ssoStatus({ oidcConfigured: true }),
    })['oidc-sso'],
    'active'
  );
  assert.equal(
    resolveAdminIntegrationStatuses({
      ssoStatus: ssoStatus({ oidcConfigured: false }),
      policy: policy({ requireSsoLogin: true }),
    })['oidc-sso'],
    'active'
  );
  assert.equal(
    resolveAdminIntegrationStatuses({
      policy: policy({ require_sso_login: 1 }),
    })['oidc-sso'],
    'active'
  );
  assert.equal(
    resolveAdminIntegrationStatuses({
      ssoStatus: ssoStatus({ oidcConfigured: false }),
      policy: policy({ requireSsoLogin: false, require_sso_login: 0 }),
    })['oidc-sso'],
    'not_configured'
  );
});

test('resolveAdminIntegrationStatuses requires both an enabled SIEM flag and URL', () => {
  assert.equal(
    resolveAdminIntegrationStatuses({
      siem: siem({ enabled: true, url: 'https://siem.example.com/ingest' }),
    })['siem-webhook'],
    'active'
  );
  assert.equal(
    resolveAdminIntegrationStatuses({
      siem: siem({ enabled: false, url: 'https://siem.example.com/ingest' }),
    })['siem-webhook'],
    'not_configured'
  );
  assert.equal(
    resolveAdminIntegrationStatuses({
      siem: siem({ enabled: true, url: null }),
    })['siem-webhook'],
    'not_configured'
  );
  assert.equal(
    resolveAdminIntegrationStatuses({
      siem: siem({ enabled: true, url: '' }),
    })['siem-webhook'],
    'not_configured'
  );
});

test('hasActiveAdminIntegrationFilters detects every filter dimension', () => {
  assert.equal(hasActiveAdminIntegrationFilters(filters()), false);
  assert.equal(hasActiveAdminIntegrationFilters(filters({ query: '   ' })), false);
  for (const active of [
    filters({ query: 'scim' }),
    filters({ official: 'custom' }),
    filters({ category: 'identity' }),
    filters({ status: 'active' }),
    filters({ featuredOnly: true }),
  ]) {
    assert.equal(hasActiveAdminIntegrationFilters(active), true);
  }
});

test('filterAdminIntegrations searches title, vendor, summary and id case-insensitively', () => {
  const ids = (input: Partial<AdminIntegrationFilterState>) =>
    filterAdminIntegrations(
      ADMIN_INTEGRATION_CATALOG,
      activeStatuses,
      filters(input)
    ).map((item) => item.id);

  assert.deepEqual(ids({ query: 'SCIM 2.0' }), ['scim-provisioning']);
  assert.deepEqual(ids({ query: 'okta, entra id' }), ['scim-provisioning']);
  assert.deepEqual(ids({ query: 'HMAC-SHA256' }), ['siem-webhook']);
  assert.deepEqual(ids({ query: 'COLLABORA-WOPI' }), ['collabora-wopi']);
  assert.deepEqual(ids({ query: '  workers-ai  ' }), [
    'workers-ai-classification',
  ]);
  assert.deepEqual(ids({ query: '存在しない統合' }), []);
  assert.equal(ids({ query: '' }).length, ADMIN_INTEGRATION_CATALOG.length);
});

test('filterAdminIntegrations applies official, category, status and featured filters', () => {
  const ids = (input: Partial<AdminIntegrationFilterState>) =>
    filterAdminIntegrations(
      ADMIN_INTEGRATION_CATALOG,
      activeStatuses,
      filters(input)
    ).map((item) => item.id);

  assert.deepEqual(ids({ official: 'official' }), [
    'scim-provisioning',
    'oidc-sso',
    'collabora-wopi',
    'workers-ai-classification',
  ]);
  assert.deepEqual(ids({ official: 'custom' }), ['siem-webhook']);

  assert.deepEqual(ids({ category: 'identity' }), [
    'scim-provisioning',
    'oidc-sso',
  ]);
  assert.deepEqual(ids({ category: 'security' }), ['siem-webhook']);
  assert.deepEqual(ids({ category: 'collaboration' }), ['collabora-wopi']);
  assert.deepEqual(ids({ category: 'ai_governance' }), [
    'workers-ai-classification',
  ]);

  assert.deepEqual(ids({ featuredOnly: true }), [
    'scim-provisioning',
    'oidc-sso',
    'siem-webhook',
    'collabora-wopi',
  ]);

  const mixed = resolveAdminIntegrationStatuses({
    siem: siem({ enabled: true, url: 'https://siem.example.com/ingest' }),
  });
  assert.deepEqual(
    filterAdminIntegrations(
      ADMIN_INTEGRATION_CATALOG,
      mixed,
      filters({ status: 'not_configured' })
    ).map((item) => item.id),
    ['oidc-sso']
  );
  assert.deepEqual(
    filterAdminIntegrations(
      ADMIN_INTEGRATION_CATALOG,
      mixed,
      filters({ status: 'active' })
    ).map((item) => item.id),
    [
      'scim-provisioning',
      'siem-webhook',
      'collabora-wopi',
      'workers-ai-classification',
    ]
  );
});

test('filterAdminIntegrations combines every filter without mutating the catalog', () => {
  const before = ADMIN_INTEGRATION_CATALOG.map((item) => item.id);

  assert.deepEqual(
    filterAdminIntegrations(
      ADMIN_INTEGRATION_CATALOG,
      activeStatuses,
      filters({
        query: 'webhook',
        official: 'custom',
        category: 'security',
        status: 'active',
        featuredOnly: true,
      })
    ).map((item) => item.id),
    ['siem-webhook']
  );

  assert.deepEqual(
    filterAdminIntegrations(
      ADMIN_INTEGRATION_CATALOG,
      activeStatuses,
      filters({ official: 'official', featuredOnly: true })
    ).map((item) => item.id),
    ['scim-provisioning', 'oidc-sso', 'collabora-wopi']
  );

  assert.deepEqual(
    filterAdminIntegrations(
      ADMIN_INTEGRATION_CATALOG,
      activeStatuses,
      filters({ official: 'custom', category: 'identity' })
    ),
    []
  );

  assert.deepEqual(
    ADMIN_INTEGRATION_CATALOG.map((item) => item.id),
    before
  );
});

test('filterAdminIntegrations tolerates a partial status record', () => {
  const partial = {
    'oidc-sso': 'active',
    'siem-webhook': 'active',
  } as unknown as Parameters<typeof filterAdminIntegrations>[1];

  assert.deepEqual(
    filterAdminIntegrations(
      ADMIN_INTEGRATION_CATALOG,
      partial,
      filters({ status: 'not_configured' })
    ).map((item) => item.id),
    [
      'scim-provisioning',
      'collabora-wopi',
      'workers-ai-classification',
    ]
  );
});

test('getRecommendedAdminIntegrations returns recommended items with status in catalog order', () => {
  const recommended = getRecommendedAdminIntegrations(
    ADMIN_INTEGRATION_CATALOG,
    activeStatuses
  );

  assert.deepEqual(
    recommended.map((item) => item.id),
    ['scim-provisioning', 'oidc-sso', 'siem-webhook']
  );
  assert.deepEqual(
    recommended.map((item) => item.status),
    ['active', 'active', 'active']
  );
  assert.equal(recommended.every((item) => item.recommended), true);

  const mixed = getRecommendedAdminIntegrations(
    ADMIN_INTEGRATION_CATALOG,
    resolveAdminIntegrationStatuses()
  );
  assert.deepEqual(
    mixed.map((item) => [item.id, item.status]),
    [
      ['scim-provisioning', 'active'],
      ['oidc-sso', 'not_configured'],
      ['siem-webhook', 'not_configured'],
    ]
  );
});

test('getRecommendedAdminIntegrations does not mutate the catalog entries', () => {
  const recommended = getRecommendedAdminIntegrations(
    ADMIN_INTEGRATION_CATALOG,
    activeStatuses
  );
  recommended[0]!.title = 'mutated';

  assert.equal(
    ADMIN_INTEGRATION_CATALOG[0]!.title,
    'SCIM 2.0 ディレクトリ同期'
  );
});
