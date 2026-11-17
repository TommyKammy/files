import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_AUDIT_PRESETS,
  ADMIN_CONSOLE_NAV_ITEMS,
  ADMIN_ROLE_BADGE_LABELS,
  adminSectionHasDashboardFetch,
  buildAdminAuditPresetHref,
  getAdminConsoleNavItem,
  getAdminConsoleNavItems,
  getAdminConsoleSectionFromPathname,
  getAdminSectionFetchPlan,
  parseAdminAuditPreset,
} from '@/lib/admin-console-nav';

test('admin console nav keeps the six destinations and their route contract', () => {
  assert.deepEqual(
    ADMIN_CONSOLE_NAV_ITEMS.map((item) => [item.section, item.href, item.label]),
    [
      ['all', '/admin', 'すべて（統合ビュー）'],
      ['insights', '/admin/insights', 'インサイト'],
      ['content', '/admin/content', 'コンテンツ'],
      ['users', '/admin/users', 'ユーザーとグループ'],
      ['settings', '/admin/settings', 'ガバナンスと設定'],
      ['reports', '/admin/reports', 'レポートと監査'],
    ]
  );

  const all = getAdminConsoleNavItem('all');
  assert.equal(all.heading, 'ガバナンス & セキュリティ統合ダッシュボード');
  assert.equal(all.href, '/admin');
  assert.equal(getAdminConsoleNavItem('reports').heading, 'レポートと監査');
});

test('role-aware nav projection only exposes the console to admins', () => {
  assert.deepEqual(
    getAdminConsoleNavItems('sys_admin').map((item) => item.section),
    ['all', 'insights', 'content', 'users', 'settings', 'reports']
  );
  assert.deepEqual(
    getAdminConsoleNavItems('sec_admin').map((item) => item.section),
    ['all', 'insights', 'content', 'users', 'settings', 'reports']
  );
  assert.deepEqual(getAdminConsoleNavItems('member'), []);
  assert.deepEqual(getAdminConsoleNavItems(null), []);
  assert.deepEqual(getAdminConsoleNavItems(undefined), []);

  assert.equal(
    ADMIN_ROLE_BADGE_LABELS.sys_admin,
    'システム管理者 (sys_admin)'
  );
  assert.equal(
    ADMIN_ROLE_BADGE_LABELS.sec_admin,
    'セキュリティ管理者 (sec_admin)'
  );
});

test('each focused route only fetches the APIs owned by its sections', () => {
  assert.deepEqual(getAdminSectionFetchPlan('insights'), {
    insights: true,
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: false,
    inheritanceConflicts: false,
    completesImmediately: false,
  });
  assert.deepEqual(getAdminSectionFetchPlan('content'), {
    insights: false,
    storageStats: false,
    aiSuggestions: true,
    sharedLinks: false,
    policies: false,
    auditLogs: false,
    inheritanceConflicts: false,
    completesImmediately: false,
  });
  assert.deepEqual(getAdminSectionFetchPlan('users'), {
    insights: false,
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: false,
    inheritanceConflicts: false,
    completesImmediately: true,
  });
  assert.deepEqual(getAdminSectionFetchPlan('settings'), {
    insights: false,
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: true,
    policies: true,
    auditLogs: false,
    inheritanceConflicts: true,
    completesImmediately: false,
  });
  assert.deepEqual(getAdminSectionFetchPlan('reports'), {
    insights: false,
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: true,
    inheritanceConflicts: false,
    completesImmediately: false,
  });

  const all = getAdminSectionFetchPlan('all');
  assert.equal(all.insights, true);
  assert.equal(all.storageStats, true);
  assert.equal(all.aiSuggestions, true);
  assert.equal(all.sharedLinks, true);
  assert.equal(all.policies, true);
  assert.equal(all.auditLogs, true);
  assert.equal(all.inheritanceConflicts, true);
  assert.equal(all.completesImmediately, false);

  assert.equal(adminSectionHasDashboardFetch('users'), false);
  for (const section of ['all', 'insights', 'content', 'settings', 'reports'] as const) {
    assert.equal(adminSectionHasDashboardFetch(section), true);
  }
});

test('pathnames resolve to their owning console section', () => {
  assert.equal(getAdminConsoleSectionFromPathname('/admin'), 'all');
  assert.equal(getAdminConsoleSectionFromPathname('/admin/'), 'all');
  assert.equal(getAdminConsoleSectionFromPathname('/admin/insights'), 'insights');
  assert.equal(getAdminConsoleSectionFromPathname('/admin/content/'), 'content');
  assert.equal(getAdminConsoleSectionFromPathname('/admin/users'), 'users');
  assert.equal(getAdminConsoleSectionFromPathname('/admin/settings'), 'settings');
  assert.equal(
    getAdminConsoleSectionFromPathname('/admin/reports?auditPreset=guest'),
    'reports'
  );
  assert.equal(getAdminConsoleSectionFromPathname('/workspace'), 'all');
  assert.equal(getAdminConsoleSectionFromPathname(null), 'all');
});

test('auditPreset query parsing is case/separator tolerant and null-safe', () => {
  assert.equal(parseAdminAuditPreset('rootFolder'), 'rootFolder');
  assert.equal(parseAdminAuditPreset('root-folder'), 'rootFolder');
  assert.equal(parseAdminAuditPreset('ROOT_FOLDER'), 'rootFolder');
  assert.equal(parseAdminAuditPreset('guest'), 'guest');
  assert.equal(parseAdminAuditPreset('permission'), 'permission');
  assert.equal(parseAdminAuditPreset('security'), 'security');
  assert.equal(parseAdminAuditPreset('SECURITY'), 'security');
  assert.equal(parseAdminAuditPreset(['rootFolder', 'guest']), 'rootFolder');
  assert.equal(parseAdminAuditPreset(''), null);
  assert.equal(parseAdminAuditPreset('unknown'), null);
  assert.equal(parseAdminAuditPreset(null), null);
  assert.equal(parseAdminAuditPreset(undefined), null);

  assert.deepEqual(ADMIN_AUDIT_PRESETS.rootFolder.actions, [
    'admin.root_folder.create',
    'admin.root_folder.owner_transfer',
    'admin.root_folder.co_owner_grant',
    'admin.root_folder.archive',
    'admin.root_folder.restore',
  ]);
  assert.deepEqual(ADMIN_AUDIT_PRESETS.guest.actionPrefixes, [
    'guest.',
    'admin.guest.',
  ]);
  assert.equal(ADMIN_AUDIT_PRESETS.guest.presetKind, 'guest');
  assert.deepEqual(ADMIN_AUDIT_PRESETS.permission.actionPrefixes, [
    'permission.',
    'admin.root_folder.',
    'admin.permission.',
  ]);
  assert.equal(ADMIN_AUDIT_PRESETS.permission.presetKind, 'permission');
  assert.equal(ADMIN_AUDIT_PRESETS.security.presetKind, 'security');
  assert.ok(
    ADMIN_AUDIT_PRESETS.security.actions.includes('auth.ip_blocked')
  );
  assert.ok(
    ADMIN_AUDIT_PRESETS.security.actions.includes('shared_link.password_failed')
  );
  assert.equal(ADMIN_AUDIT_PRESETS.security.actionPrefixes.length, 0);

  assert.equal(
    buildAdminAuditPresetHref('rootFolder'),
    '/admin/reports?auditPreset=rootFolder'
  );
  assert.equal(
    buildAdminAuditPresetHref('guest'),
    '/admin/reports?auditPreset=guest'
  );
});
