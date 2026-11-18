import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTERPRISE_SETTING_GROUPS,
  ENTERPRISE_SETTING_TOPICS,
  filterEnterpriseSettingTopics,
  getEnterpriseTopicStatusBadge,
  getVisibleEnterpriseSettingTopics,
  parseEnterpriseTopicQuery,
  resolveEnterpriseSettingTopic,
  type EnterpriseSettingTopicId,
} from '@/lib/admin-enterprise-settings';
import type { AdminCapability, AuthUser, TenantPolicyRow } from '@/types/files';

type TopicUser = Pick<
  AuthUser,
  'role' | 'userType' | 'adminCapabilities'
>;

const sysAdmin: TopicUser = {
  role: 'sys_admin',
  userType: 'member',
  adminCapabilities: [],
};
const secAdmin: TopicUser = {
  role: 'sec_admin',
  userType: 'member',
  adminCapabilities: [],
};
const plainMember: TopicUser = {
  role: 'member',
  userType: 'member',
  adminCapabilities: [],
};

function coAdmin(capabilities: AdminCapability[]): TopicUser {
  return {
    role: 'member',
    userType: 'member',
    adminCapabilities: capabilities,
  };
}

const guest: TopicUser = {
  role: 'member',
  userType: 'guest',
  adminCapabilities: ['admin.policies.read'],
};

function topicIds(
  topics: ReturnType<typeof getVisibleEnterpriseSettingTopics>
): string[] {
  return topics.map((topic) => topic.id);
}

function basePolicy(
  overrides: Partial<TenantPolicyRow> = {}
): TenantPolicyRow {
  return {
    tenant_id: 'tenant-e2e',
    enforce_company_only_links: 0,
    require_watermark_confidential: 0,
    max_link_expiration_days: 30,
    session_max_hours: 12,
    trash_retention_days: 30,
    ai_classification_mode: 'metadata_only',
    ai_auto_apply_threshold: null,
    updated_by: null,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('Enterprise settings topics: 5 groups and 13 ordered topics', () => {
  assert.deepEqual(
    ENTERPRISE_SETTING_GROUPS.map((group) => group.id),
    ['sharing', 'access', 'security', 'compliance', 'integrations']
  );
  assert.equal(ENTERPRISE_SETTING_GROUPS.length, 5);

  assert.deepEqual(
    ENTERPRISE_SETTING_TOPICS.map((topic) => topic.id),
    [
      'shared-links',
      'guest-policy',
      'file-requests',
      'roles-and-invite',
      'folder-structure',
      'content-inspection',
      'ip-allowlist',
      'sso-oidc',
      'sessions',
      'tos',
      'retention-quota-ai',
      'branding',
      'integrations-catalog',
    ]
  );
  assert.equal(ENTERPRISE_SETTING_TOPICS.length, 13);
  assert.equal(
    new Set(ENTERPRISE_SETTING_TOPICS.map((topic) => topic.id)).size,
    ENTERPRISE_SETTING_TOPICS.length
  );

  for (const topic of ENTERPRISE_SETTING_TOPICS) {
    assert.ok(topic.label.length > 0);
    assert.ok(topic.summary.length > 0);
    assert.ok(topic.keywords.length > 0);
    assert.ok(topic.capabilities.length > 0);
  }
});

test('Enterprise settings topics: each group maps to its topics', () => {
  const groupTopics = (groupId: string) =>
    ENTERPRISE_SETTING_TOPICS.filter((topic) => topic.group === groupId).map(
      (topic) => topic.id
    );

  assert.deepEqual(groupTopics('sharing'), [
    'shared-links',
    'guest-policy',
    'file-requests',
  ]);
  assert.deepEqual(groupTopics('access'), [
    'roles-and-invite',
    'folder-structure',
    'content-inspection',
  ]);
  assert.deepEqual(groupTopics('security'), [
    'ip-allowlist',
    'sso-oidc',
    'sessions',
  ]);
  assert.deepEqual(groupTopics('compliance'), [
    'tos',
    'retention-quota-ai',
    'branding',
  ]);
  assert.deepEqual(groupTopics('integrations'), ['integrations-catalog']);

  for (const group of ENTERPRISE_SETTING_GROUPS) {
    assert.ok(
      ENTERPRISE_SETTING_TOPICS.some((topic) => topic.group === group.id),
      `${group.id} must own at least one topic`
    );
  }
});

test('getVisibleEnterpriseSettingTopics: sys_admin and sec_admin see every topic', () => {
  assert.equal(getVisibleEnterpriseSettingTopics(sysAdmin).length, 13);
  assert.equal(getVisibleEnterpriseSettingTopics(secAdmin).length, 13);
  assert.deepEqual(
    topicIds(getVisibleEnterpriseSettingTopics(secAdmin)),
    topicIds(getVisibleEnterpriseSettingTopics(sysAdmin))
  );
});

test('getVisibleEnterpriseSettingTopics: delegated Co-Admins only see granted topics', () => {
  assert.deepEqual(getVisibleEnterpriseSettingTopics(plainMember), []);
  assert.deepEqual(getVisibleEnterpriseSettingTopics(null), []);
  assert.deepEqual(getVisibleEnterpriseSettingTopics(guest), []);

  const policyReader = coAdmin(['admin.policies.read']);
  const policyTopics = topicIds(getVisibleEnterpriseSettingTopics(policyReader));
  assert.ok(policyTopics.includes('shared-links'));
  assert.ok(policyTopics.includes('roles-and-invite'));
  assert.ok(policyTopics.includes('ip-allowlist'));
  assert.ok(policyTopics.includes('tos'));
  // Sessions requires `admin.users.read`, not the policy capabilities.
  assert.ok(!policyTopics.includes('sessions'));
  // Integrations is reachable through `admin.policies.read`.
  assert.ok(policyTopics.includes('integrations-catalog'));
  assert.equal(policyTopics.length, 12);

  const guestManager = coAdmin(['admin.guests.manage']);
  assert.deepEqual(topicIds(getVisibleEnterpriseSettingTopics(guestManager)), [
    'guest-policy',
  ]);

  const helpdesk = coAdmin([
    'admin.users.read',
    'admin.users.suspend',
    'admin.content.unlock',
    'admin.trash.manage',
  ]);
  assert.deepEqual(topicIds(getVisibleEnterpriseSettingTopics(helpdesk)), [
    'sessions',
    'integrations-catalog',
  ]);

  const linkOperator = coAdmin(['admin.links.revoke']);
  assert.deepEqual(topicIds(getVisibleEnterpriseSettingTopics(linkOperator)), [
    'shared-links',
  ]);
});

test('filterEnterpriseSettingTopics: Japanese keyword search is instant', () => {
  const all = getVisibleEnterpriseSettingTopics(sysAdmin);
  const ids = (query: string) =>
    filterEnterpriseSettingTopics(all, query).map((topic) => topic.id);

  assert.deepEqual(ids('透かし'), ['shared-links']);
  assert.deepEqual(ids('ウォーターマーク'), ['shared-links']);
  assert.deepEqual(ids('共有リンク'), ['shared-links', 'branding']);
  assert.deepEqual(ids('ゲスト'), ['guest-policy']);
  assert.deepEqual(ids('IP'), ['ip-allowlist']);
  assert.deepEqual(ids('CIDR'), ['ip-allowlist']);
  assert.deepEqual(ids('ゴミ箱'), ['retention-quota-ai']);
  assert.deepEqual(ids('自動分類'), ['retention-quota-ai']);
  assert.deepEqual(ids('権限継承'), ['folder-structure']);
  assert.deepEqual(ids('コンテンツ検査'), ['content-inspection']);
  assert.deepEqual(ids('利用規約'), ['tos']);
});

test('filterEnterpriseSettingTopics: English keyword search is case-insensitive', () => {
  const all = getVisibleEnterpriseSettingTopics(sysAdmin);
  const ids = (query: string) =>
    filterEnterpriseSettingTopics(all, query).map((topic) => topic.id);

  assert.deepEqual(ids('SSO'), ['shared-links', 'sso-oidc', 'integrations-catalog']);
  assert.deepEqual(ids('sso'), ids('SSO'));
  assert.deepEqual(ids('ToS'), ['tos']);
  assert.deepEqual(ids('SCIM'), ['integrations-catalog']);
  assert.deepEqual(ids('SIEM'), ['integrations-catalog']);
  assert.deepEqual(ids('SCIM / SIEM'), ['integrations-catalog']);
  assert.deepEqual(ids('guest'), ['guest-policy']);
  assert.deepEqual(ids('watermark'), ['shared-links']);
  assert.deepEqual(ids('quota'), ['retention-quota-ai']);
  assert.deepEqual(ids('retention'), ['retention-quota-ai']);
  assert.deepEqual(ids('uploader'), ['roles-and-invite']);
  assert.deepEqual(ids('waterfall'), ['folder-structure']);
  assert.deepEqual(ids('allowlist'), ['ip-allowlist']);
  assert.deepEqual(ids('branding'), ['branding']);
  assert.deepEqual(ids('integrations'), ['integrations-catalog']);

  // Group label matches: "セキュリティと認証" owns IP / SSO / sessions.
  assert.deepEqual(ids('セキュリティと認証'), [
    'ip-allowlist',
    'sso-oidc',
    'sessions',
  ]);

  assert.deepEqual(ids('__no_match__'), []);
});

test('filterEnterpriseSettingTopics: empty query returns every topic', () => {
  const all = getVisibleEnterpriseSettingTopics(sysAdmin);
  assert.deepEqual(filterEnterpriseSettingTopics(all, '').length, 13);
  assert.deepEqual(filterEnterpriseSettingTopics(all, '   ').length, 13);
  assert.deepEqual(filterEnterpriseSettingTopics(all, null).length, 13);
  assert.deepEqual(filterEnterpriseSettingTopics(all, undefined).length, 13);

  const copy = filterEnterpriseSettingTopics(all, '');
  copy.pop();
  assert.equal(all.length, 13, 'filtering must not mutate the input array');
});

test('parseEnterpriseTopicQuery normalizes known ids only', () => {
  assert.equal(parseEnterpriseTopicQuery('shared-links'), 'shared-links');
  assert.equal(parseEnterpriseTopicQuery('  SSO-OIDC  '), 'sso-oidc');
  assert.equal(parseEnterpriseTopicQuery(['sessions', 'tos']), 'sessions');
  assert.equal(parseEnterpriseTopicQuery('sessions?x=1'), null);
  assert.equal(parseEnterpriseTopicQuery('unknown-topic'), null);
  assert.equal(parseEnterpriseTopicQuery(''), null);
  assert.equal(parseEnterpriseTopicQuery('   '), null);
  assert.equal(parseEnterpriseTopicQuery(null), null);
  assert.equal(parseEnterpriseTopicQuery(undefined), null);
});

test('resolveEnterpriseSettingTopic prefers visible ?topic= then tab group then first', () => {
  const all = getVisibleEnterpriseSettingTopics(sysAdmin);

  assert.equal(
    resolveEnterpriseSettingTopic('sharing', 'sso-oidc', all)?.id,
    'sso-oidc',
    'an explicit, visible topic wins even across groups'
  );
  assert.equal(
    resolveEnterpriseSettingTopic('security', null, all)?.id,
    'ip-allowlist'
  );
  assert.equal(
    resolveEnterpriseSettingTopic('compliance', 'branding', all)?.id,
    'branding'
  );
  assert.equal(
    resolveEnterpriseSettingTopic('compliance', 'does-not-exist', all)?.id,
    'tos'
  );
  assert.equal(
    resolveEnterpriseSettingTopic('settings', null, all)?.id,
    'shared-links',
    'the integrated settings tab is not a group, so the first visible topic wins'
  );
  assert.equal(
    resolveEnterpriseSettingTopic(null, 'nope', all)?.id,
    'shared-links'
  );

  const coAdminTopics = getVisibleEnterpriseSettingTopics(
    coAdmin(['admin.users.read'])
  );
  assert.deepEqual(topicIds(coAdminTopics), ['sessions', 'integrations-catalog']);
  assert.equal(
    resolveEnterpriseSettingTopic(
      'security',
      'tos',
      coAdminTopics
    )?.id,
    'sessions',
    'a non-visible ?topic= must fall back to the tab group'
  );
  assert.equal(
    resolveEnterpriseSettingTopic('sharing', 'tos', coAdminTopics)?.id,
    'sessions',
    'an empty tab group falls back to the first visible topic'
  );
  assert.equal(resolveEnterpriseSettingTopic('sharing', null, []), null);
});

test('getEnterpriseTopicStatusBadge renders live short values', () => {
  const policy = basePolicy({
    require_watermark_confidential: 1,
    max_link_expiration_days: 30,
    allow_external_collaborators: 1,
    allow_file_requests: 1,
    fileRequestMaxSizeBytes: 100 * 1024 * 1024,
    advanced_roles_enabled: 0,
    folder_structure_mode: 'open',
    permission_inheritance_mode: 'additive',
    admin_content_inspect_policy: 'watermark_confidential',
    ip_allowlist_enabled: 0,
    require_sso_login: 0,
    trash_retention_days: 30,
    quota_warn_threshold_pct: 80,
    quota_critical_threshold_pct: 90,
  });

  assert.equal(
    getEnterpriseTopicStatusBadge('shared-links', { policy }),
    '透かし: ON / 最大30日'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('guest-policy', { policy }),
    'ゲスト: 許可'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('file-requests', { policy }),
    'リクエスト: 許可 / 100MiB'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('roles-and-invite', { policy }),
    '8ロール: OFF'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('folder-structure', { policy }),
    'Open / Standard'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('content-inspection', { policy }),
    '検査: 透かし付きプレビュー'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('ip-allowlist', { policy }),
    'IP制限: OFF'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('sso-oidc', { policy }),
    'SSO必須: OFF'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('sessions', { activeSessionCount: 3 }),
    'セッション: 3件'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('tos', { tos: null }),
    'ToS: 無効'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('tos', {
      tos: { enabled: true, version: 3 },
    }),
    'ToS: 有効 (v3)'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('retention-quota-ai', { policy }),
    '保持: 30日 / 警告: 80%'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('branding', { policy }),
    'ブランド: 未設定'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('integrations-catalog', {
      scimTokenCount: 2,
      siemEnabled: false,
    }),
    'SCIM: ON / SIEM: OFF'
  );
});

test('getEnterpriseTopicStatusBadge reflects non-default policy values', () => {
  const closedPolicy = basePolicy({
    require_watermark_confidential: 0,
    max_link_expiration_days: 7,
    allow_external_collaborators: 0,
    allow_file_requests: 0,
    advanced_roles_enabled: 1,
    folder_structure_mode: 'closed',
    permission_inheritance_mode: 'waterfall',
    admin_content_inspect_policy: 'deny_confidential',
    ip_allowlist_enabled: 1,
    ip_allowlist_scope: 'all_access',
    require_sso_login: 1,
    trash_retention_days: 90,
    quota_warn_threshold_pct: 70,
    branding_org_name: '株式会社サンプル',
  });

  assert.equal(
    getEnterpriseTopicStatusBadge('shared-links', { policy: closedPolicy }),
    '透かし: OFF / 最大7日'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('guest-policy', { policy: closedPolicy }),
    'ゲスト: 拒否'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('file-requests', { policy: closedPolicy }),
    'リクエスト: 拒否'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('roles-and-invite', { policy: closedPolicy }),
    '8ロール: ON'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('folder-structure', { policy: closedPolicy }),
    'Closed / Waterfall'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('content-inspection', {
      policy: closedPolicy,
    }),
    '検査: 機密禁止'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('ip-allowlist', { policy: closedPolicy }),
    'IP制限: ON (全アクセス)'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('sso-oidc', { policy: closedPolicy }),
    'SSO必須: ON'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('retention-quota-ai', {
      policy: closedPolicy,
    }),
    '保持: 90日 / 警告: 70%'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('branding', { policy: closedPolicy }),
    'ブランド: 設定済み'
  );
  assert.equal(
    getEnterpriseTopicStatusBadge('integrations-catalog', {}),
    '統合: 未設定'
  );
  assert.equal(getEnterpriseTopicStatusBadge('sessions', {}), 'セッション: —');
});

test('getEnterpriseTopicStatusBadge tolerates missing policy data', () => {
  const topicIdsToCheck: EnterpriseSettingTopicId[] = ENTERPRISE_SETTING_TOPICS.map(
    (topic) => topic.id
  );
  for (const topicId of topicIdsToCheck) {
    const badge = getEnterpriseTopicStatusBadge(topicId, { policy: null });
    assert.equal(typeof badge, 'string');
    assert.ok(badge.length > 0, `${topicId} must render a badge`);
  }
});
