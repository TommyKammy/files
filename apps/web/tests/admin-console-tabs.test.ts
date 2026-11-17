import assert from 'node:assert/strict';
import test from 'node:test';
import { getAdminSectionFetchPlan } from '@/lib/admin-console-nav';
import type { AdminSectionFetchPlan } from '@/lib/admin-console-nav';
import {
  ADMIN_CONSOLE_TABS,
  buildAdminTabHref,
  getAdminTabDomId,
  getAdminTabFetchPlan,
  getAdminTabPanelDomId,
  getAdminTabsForSection,
  getVisibleAdminTabs,
  parseAdminTabQuery,
  resolveActiveAdminTab,
} from '@/lib/admin-console-tabs';
import type { AdminCapability, AuthUser } from '@/types/files';

type TabUser = Pick<
  AuthUser,
  'role' | 'userType' | 'adminCapabilities'
>;

const sysAdmin: TabUser = {
  role: 'sys_admin',
  userType: 'member',
  adminCapabilities: [],
};
const secAdmin: TabUser = {
  role: 'sec_admin',
  userType: 'member',
  adminCapabilities: [],
};
const plainMember: TabUser = {
  role: 'member',
  userType: 'member',
  adminCapabilities: [],
};
const guest: TabUser = {
  role: 'member',
  userType: 'guest',
  adminCapabilities: ['admin.insights.read'],
};

function coAdmin(capabilities: AdminCapability[]): TabUser {
  return {
    role: 'member',
    userType: 'member',
    adminCapabilities: capabilities,
  };
}

const helpdesk = coAdmin([
  'admin.users.read',
  'admin.users.suspend',
  'admin.content.unlock',
  'admin.trash.manage',
]);
const contentOperator = coAdmin([
  'admin.content.unlock',
  'admin.trash.manage',
  'admin.links.revoke',
]);
const auditor = coAdmin([
  'admin.insights.read',
  'admin.audit.read',
  'admin.reports.run',
  'admin.policies.read',
]);

function tabIds(section: Parameters<typeof getAdminTabsForSection>[0]): string[] {
  return getAdminTabsForSection(section).map((tab) => tab.id);
}

function expectedPlan(
  overrides: Partial<AdminSectionFetchPlan> = {}
): AdminSectionFetchPlan {
  return {
    insights: false,
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: false,
    inheritanceConflicts: false,
    settingsBundle: false,
    completesImmediately: false,
    ...overrides,
  };
}

test('ADMIN_CONSOLE_TABS defines every section and preserves id/label order', () => {
  assert.deepEqual(Object.keys(ADMIN_CONSOLE_TABS), [
    'all',
    'insights',
    'content',
    'users',
    'settings',
    'reports',
  ]);

  assert.deepEqual(
    ADMIN_CONSOLE_TABS.all.map((tab) => [tab.id, tab.label]),
    [
      ['overview', 'インサイト・概要'],
      ['content', 'コンテンツ'],
      ['users', 'ユーザーとグループ'],
      ['settings', 'Enterprise設定'],
      ['integrations', '統合'],
      ['reports', 'レポートと監査'],
    ]
  );
  assert.deepEqual(ADMIN_CONSOLE_TABS.insights, []);
  assert.deepEqual(tabIds('content'), [
    'manager',
    'root-folders',
    'trash',
    'file-requests',
    'ai-classification',
  ]);
  assert.deepEqual(
    ADMIN_CONSOLE_TABS.content.map((tab) => tab.label),
    [
      'コンテンツマネージャー',
      'ルートフォルダ管理',
      'ゴミ箱',
      'ファイルリクエスト',
      'AI 分類レビュー',
    ]
  );
  assert.deepEqual(tabIds('users'), [
    'members',
    'groups',
    'guests',
    'delegations',
  ]);
  assert.deepEqual(
    ADMIN_CONSOLE_TABS.users.map((tab) => tab.label),
    ['管理対象ユーザー', 'グループ', '外部コラボレーター', '共同管理者 (Co-Admin)']
  );
  assert.deepEqual(tabIds('settings'), [
    'sharing',
    'access',
    'security',
    'compliance',
    'integrations',
  ]);
  assert.deepEqual(
    ADMIN_CONSOLE_TABS.settings.map((tab) => tab.label),
    [
      'コンテンツと共有',
      'アクセス制御とフォルダ構成',
      'セキュリティとセッション',
      'カスタム設定・利用規約',
      '統合 (Integrations)',
    ]
  );
  assert.deepEqual(tabIds('reports'), ['audit-logs', 'permissions', 'jobs']);
  assert.deepEqual(
    ADMIN_CONSOLE_TABS.reports.map((tab) => tab.label),
    ['監査ログ', 'アクセス権監査', 'レポート出力・定期スケジュール']
  );

  for (const [section, tabs] of Object.entries(ADMIN_CONSOLE_TABS)) {
    for (const tab of tabs) {
      assert.equal(tab.section, section);
      assert.ok(tab.summary.length > 0);
      assert.ok(tab.capabilities.length > 0);
      assert.ok(tab.ownedApiPrefixes.length > 0);
    }
  }
});

test('tab definitions keep their capability and API ownership contract', () => {
  const overview = ADMIN_CONSOLE_TABS.all[0]!;
  assert.deepEqual(overview.capabilities, ['admin.insights.read']);
  assert.deepEqual(overview.ownedApiPrefixes, [
    '/api/admin/insights',
    '/api/admin/storage-stats',
  ]);

  const allContent = ADMIN_CONSOLE_TABS.all[1]!;
  assert.deepEqual(allContent.capabilities, [
    'admin.content.unlock',
    'admin.root_folders.read',
    'admin.trash.manage',
  ]);
  assert.deepEqual(allContent.ownedApiPrefixes, [
    '/api/admin/content',
    '/api/admin/root-folders',
    '/api/admin/trash',
    '/api/admin/file-requests',
    '/api/admin/ai-suggestions',
  ]);

  assert.deepEqual(ADMIN_CONSOLE_TABS.all[2]!.capabilities, [
    'admin.users.read',
    'admin.users.suspend',
    'admin.users.manage',
    'admin.groups.manage',
    'admin.guests.manage',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.all[2]!.ownedApiPrefixes, [
    '/api/admin/users',
    '/api/admin/groups',
    '/api/admin/guests',
    '/api/admin/delegations',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.all[3]!.capabilities, [
    'admin.policies.edit',
    'admin.policies.read',
    'admin.links.revoke',
    'admin.guests.manage',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.all[3]!.ownedApiPrefixes, [
    '/api/admin/settings-bundle',
    '/api/admin/policies',
    '/api/admin/shared-links',
    '/api/admin/tos',
    '/api/admin/sessions',
    '/api/admin/sso',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.all[4]!.capabilities, [
    'admin.policies.read',
    'admin.policies.edit',
    'admin.users.read',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.all[4]!.ownedApiPrefixes, [
    '/api/admin/settings-bundle',
    '/api/admin/scim-tokens',
    '/api/admin/siem',
    '/api/admin/sso',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.all[5]!.capabilities, [
    'admin.audit.read',
    'admin.permissions.audit',
    'admin.reports.run',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.all[5]!.ownedApiPrefixes, [
    '/api/audit-logs',
    '/api/admin/permissions',
    '/api/admin/reports',
  ]);

  assert.deepEqual(ADMIN_CONSOLE_TABS.content[0]!.capabilities, [
    'admin.content.unlock',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.content[1]!.capabilities, [
    'admin.root_folders.read',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.content[2]!.ownedApiPrefixes, [
    '/api/admin/trash',
    '/api/audit-logs',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.content[3]!.ownedApiPrefixes, [
    '/api/admin/file-requests',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.content[4]!.ownedApiPrefixes, [
    '/api/admin/ai-suggestions',
  ]);

  assert.deepEqual(ADMIN_CONSOLE_TABS.users[0]!.ownedApiPrefixes, [
    '/api/admin/users',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.users[1]!.ownedApiPrefixes, [
    '/api/admin/groups',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.users[2]!.ownedApiPrefixes, [
    '/api/admin/guests',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.users[3]!.ownedApiPrefixes, [
    '/api/admin/delegations',
  ]);

  assert.deepEqual(ADMIN_CONSOLE_TABS.settings[0]!.ownedApiPrefixes, [
    '/api/admin/settings-bundle',
    '/api/admin/shared-links',
    '/api/admin/policies',
    '/api/admin/guests',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.settings[1]!.ownedApiPrefixes, [
    '/api/admin/settings-bundle',
    '/api/admin/policies',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.settings[2]!.ownedApiPrefixes, [
    '/api/admin/settings-bundle',
    '/api/admin/policies',
    '/api/admin/sso',
    '/api/admin/sessions',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.settings[3]!.ownedApiPrefixes, [
    '/api/admin/settings-bundle',
    '/api/admin/tos',
    '/api/admin/policies',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.settings[4]!.ownedApiPrefixes, [
    '/api/admin/settings-bundle',
    '/api/admin/scim-tokens',
    '/api/admin/siem',
    '/api/admin/sso',
  ]);

  assert.deepEqual(ADMIN_CONSOLE_TABS.reports[0]!.ownedApiPrefixes, [
    '/api/audit-logs',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.reports[1]!.ownedApiPrefixes, [
    '/api/admin/permissions',
  ]);
  assert.deepEqual(ADMIN_CONSOLE_TABS.reports[2]!.ownedApiPrefixes, [
    '/api/admin/reports',
  ]);
});

test('getAdminTabsForSection exposes the single dashboard without sub-tabs', () => {
  assert.deepEqual(getAdminTabsForSection('insights'), []);
  assert.deepEqual(tabIds('all'), [
    'overview',
    'content',
    'users',
    'settings',
    'integrations',
    'reports',
  ]);
  assert.equal(getAdminTabsForSection('all')[0]!.id, 'overview');
});

test('getVisibleAdminTabs denies anonymous, guest and non-delegated members', () => {
  for (const section of [
    'all',
    'insights',
    'content',
    'users',
    'settings',
    'reports',
  ] as const) {
    assert.deepEqual(getVisibleAdminTabs(null, section), []);
    assert.deepEqual(getVisibleAdminTabs(undefined, section), []);
    assert.deepEqual(getVisibleAdminTabs(plainMember, section), []);
    assert.deepEqual(getVisibleAdminTabs(guest, section), []);
  }
});

test('getVisibleAdminTabs gives sys_admin and sec_admin the full section', () => {
  for (const section of [
    'all',
    'insights',
    'content',
    'users',
    'settings',
    'reports',
  ] as const) {
    assert.deepEqual(
      getVisibleAdminTabs(sysAdmin, section).map((tab) => tab.id),
      tabIds(section)
    );
    assert.deepEqual(
      getVisibleAdminTabs(secAdmin, section).map((tab) => tab.id),
      tabIds(section)
    );
  }
  // sec_admin still sees the tablist even though management capabilities are
  // projected away by `hasAdminCapability`.
  assert.deepEqual(
    getVisibleAdminTabs(secAdmin, 'users').map((tab) => tab.id),
    ['members', 'groups', 'guests', 'delegations']
  );
});

test('Co-Admin tabs require at least one delegated capability', () => {
  assert.deepEqual(
    getVisibleAdminTabs(contentOperator, 'content').map((tab) => tab.id),
    ['manager', 'trash', 'file-requests', 'ai-classification']
  );
  assert.deepEqual(
    getVisibleAdminTabs(contentOperator, 'settings').map((tab) => tab.id),
    ['sharing']
  );
  assert.deepEqual(
    getVisibleAdminTabs(contentOperator, 'all').map((tab) => tab.id),
    ['content', 'settings']
  );
  assert.deepEqual(getVisibleAdminTabs(contentOperator, 'reports'), []);

  assert.deepEqual(
    getVisibleAdminTabs(helpdesk, 'content').map((tab) => tab.id),
    ['manager', 'trash', 'file-requests', 'ai-classification']
  );
  assert.deepEqual(
    getVisibleAdminTabs(helpdesk, 'users').map((tab) => tab.id),
    ['members', 'groups', 'delegations']
  );
  assert.deepEqual(
    getVisibleAdminTabs(helpdesk, 'settings').map((tab) => tab.id),
    ['security', 'integrations']
  );

  assert.deepEqual(
    getVisibleAdminTabs(auditor, 'all').map((tab) => tab.id),
    ['overview', 'settings', 'integrations', 'reports']
  );
  assert.deepEqual(
    getVisibleAdminTabs(auditor, 'reports').map((tab) => tab.id),
    ['audit-logs', 'jobs']
  );
  assert.deepEqual(
    getVisibleAdminTabs(auditor, 'settings').map((tab) => tab.id),
    ['sharing', 'access', 'security', 'compliance', 'integrations']
  );
  assert.deepEqual(getVisibleAdminTabs(auditor, 'users'), []);
});

test('parseAdminTabQuery trims, lowercases and takes the first array entry', () => {
  assert.equal(parseAdminTabQuery(' TRASH '), 'trash');
  assert.equal(parseAdminTabQuery('Audit-Logs'), 'audit-logs');
  assert.equal(parseAdminTabQuery(['MANAGER', 'trash']), 'manager');
  assert.equal(parseAdminTabQuery([]), null);
  assert.equal(parseAdminTabQuery(''), null);
  assert.equal(parseAdminTabQuery('   '), null);
  assert.equal(parseAdminTabQuery(null), null);
  assert.equal(parseAdminTabQuery(undefined), null);
});

test('resolveActiveAdminTab falls back to the first visible tab', () => {
  assert.equal(resolveActiveAdminTab(null, 'all', 'overview'), null);
  assert.equal(resolveActiveAdminTab(undefined, 'content', 'trash'), null);
  assert.equal(resolveActiveAdminTab(plainMember, 'all', 'overview'), null);
  assert.equal(resolveActiveAdminTab(sysAdmin, 'insights', 'overview'), null);

  assert.equal(resolveActiveAdminTab(sysAdmin, 'all')?.id, 'overview');
  assert.equal(resolveActiveAdminTab(sysAdmin, 'content')?.id, 'manager');
  assert.equal(resolveActiveAdminTab(sysAdmin, 'users')?.id, 'members');
  assert.equal(resolveActiveAdminTab(sysAdmin, 'settings')?.id, 'sharing');
  assert.equal(resolveActiveAdminTab(sysAdmin, 'reports')?.id, 'audit-logs');
  assert.equal(
    resolveActiveAdminTab(contentOperator, 'content')?.id,
    'manager'
  );
});

test('resolveActiveAdminTab honors valid ?tab= values and ignores unknown ones', () => {
  assert.equal(resolveActiveAdminTab(sysAdmin, 'content', 'trash')?.id, 'trash');
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'content', ' ROOT-FOLDERS ')?.id,
    'root-folders'
  );
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'reports', ['permissions', 'jobs'])?.id,
    'permissions'
  );
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'content', 'not-a-tab')?.id,
    'manager'
  );
  // A tab the Co-Admin cannot use must not be selected even when requested.
  assert.equal(
    resolveActiveAdminTab(contentOperator, 'content', 'root-folders')?.id,
    'manager'
  );
  assert.equal(
    resolveActiveAdminTab(contentOperator, 'users', 'guests'),
    null
  );
});

test('resolveActiveAdminTab maps ?auditPreset= to the reports audit tab', () => {
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'reports', null, {
      auditPreset: 'guest',
    })?.id,
    'audit-logs'
  );
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'reports', null, {
      auditPreset: ['permission'],
    })?.id,
    'audit-logs'
  );
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'reports', ' ALIAS ', {
      auditPreset: 'security',
    })?.id,
    'audit-logs'
  );
  // An unknown preset must not change the default selection.
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'reports', null, {
      auditPreset: 'not-a-preset',
    })?.id,
    'audit-logs'
  );
  // Only the reports section reacts to the audit preset.
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'all', null, {
      auditPreset: 'guest',
    })?.id,
    'overview'
  );
  // Explicit tab id wins over the preset.
  assert.equal(
    resolveActiveAdminTab(sysAdmin, 'reports', 'jobs', {
      auditPreset: 'guest',
    })?.id,
    'jobs'
  );
  // A Co-Admin without audit.read cannot be forced onto audit-logs.
  const reportsRunner = coAdmin(['admin.reports.run']);
  assert.deepEqual(
    getVisibleAdminTabs(reportsRunner, 'reports').map((tab) => tab.id),
    ['jobs']
  );
  assert.equal(
    resolveActiveAdminTab(reportsRunner, 'reports', null, {
      auditPreset: 'guest',
    })?.id,
    'jobs'
  );
});

test('buildAdminTabHref keeps the section route and optional params', () => {
  assert.equal(buildAdminTabHref('all', 'overview'), '/admin?tab=overview');
  assert.equal(
    buildAdminTabHref('content', 'trash'),
    '/admin/content?tab=trash'
  );
  assert.equal(
    buildAdminTabHref('users', 'delegations', { auditPreset: null }),
    '/admin/users?tab=delegations'
  );
  assert.equal(
    buildAdminTabHref('reports', 'audit-logs', {
      auditPreset: 'guest',
      missing: undefined,
      blank: null,
    }),
    '/admin/reports?tab=audit-logs&auditPreset=guest'
  );
  assert.equal(
    buildAdminTabHref('reports', 'audit-logs', { q: 'a b' }),
    '/admin/reports?tab=audit-logs&q=a+b'
  );
});

test('tab DOM ids are stable and unique per section', () => {
  assert.equal(getAdminTabDomId('content', 'trash'), 'admin-tab-content-trash');
  assert.equal(
    getAdminTabPanelDomId('content', 'trash'),
    'admin-tabpanel-content-trash'
  );
  assert.notEqual(
    getAdminTabDomId('all', 'content'),
    getAdminTabDomId('content', 'manager')
  );
  assert.equal(
    getAdminTabDomId('settings', 'integrations'),
    'admin-tab-settings-integrations'
  );
});

test('getAdminTabFetchPlan fetches only the active integrated-view tab', () => {
  assert.deepEqual(
    getAdminTabFetchPlan('all', 'overview'),
    expectedPlan({ insights: true, storageStats: true })
  );
  assert.deepEqual(
    getAdminTabFetchPlan('all', 'content'),
    expectedPlan({ aiSuggestions: true })
  );
  assert.deepEqual(
    getAdminTabFetchPlan('all', 'users'),
    expectedPlan({ completesImmediately: true })
  );
  assert.deepEqual(
    getAdminTabFetchPlan('all', 'settings'),
    expectedPlan({ settingsBundle: true })
  );
  assert.deepEqual(
    getAdminTabFetchPlan('all', 'integrations'),
    expectedPlan({ settingsBundle: true })
  );
  assert.deepEqual(
    getAdminTabFetchPlan('all', 'reports'),
    expectedPlan({ auditLogs: true })
  );
});

test('getAdminTabFetchPlan lets content child sections self-fetch', () => {
  for (const tabId of ['manager', 'root-folders', 'trash', 'file-requests']) {
    assert.deepEqual(
      getAdminTabFetchPlan('content', tabId),
      expectedPlan({ completesImmediately: true }),
      tabId
    );
  }
  assert.deepEqual(
    getAdminTabFetchPlan('content', 'ai-classification'),
    expectedPlan({ aiSuggestions: true })
  );
});

test('getAdminTabFetchPlan marks every users tab as self-fetching', () => {
  for (const tabId of ['members', 'groups', 'guests', 'delegations']) {
    assert.deepEqual(
      getAdminTabFetchPlan('users', tabId),
      expectedPlan({ completesImmediately: true }),
      tabId
    );
  }
});

test('getAdminTabFetchPlan hydrates settings tabs from the bundle', () => {
  for (const tabId of [
    'sharing',
    'access',
    'security',
    'compliance',
    'integrations',
  ]) {
    assert.deepEqual(
      getAdminTabFetchPlan('settings', tabId),
      expectedPlan({ settingsBundle: true }),
      tabId
    );
  }
});

test('getAdminTabFetchPlan scopes reports tabs', () => {
  assert.deepEqual(
    getAdminTabFetchPlan('reports', 'audit-logs'),
    expectedPlan({ auditLogs: true })
  );
  assert.deepEqual(
    getAdminTabFetchPlan('reports', 'permissions'),
    expectedPlan({ completesImmediately: true })
  );
  assert.deepEqual(
    getAdminTabFetchPlan('reports', 'jobs'),
    expectedPlan({ completesImmediately: true })
  );
});

test('getAdminTabFetchPlan falls back to the section plan before resolution', () => {
  for (const section of [
    'all',
    'insights',
    'content',
    'users',
    'settings',
    'reports',
  ] as const) {
    assert.deepEqual(
      getAdminTabFetchPlan(section, null),
      getAdminSectionFetchPlan(section),
      `${section}/null`
    );
    assert.deepEqual(
      getAdminTabFetchPlan(section, 'unknown-tab'),
      getAdminSectionFetchPlan(section),
      `${section}/unknown`
    );
  }
  assert.deepEqual(
    getAdminTabFetchPlan('insights', undefined),
    getAdminSectionFetchPlan('insights')
  );
});
