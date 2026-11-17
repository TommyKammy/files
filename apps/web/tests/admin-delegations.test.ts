import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_DELEGATION_PRESETS,
  ADMIN_DELEGATION_PRESET_IDS,
  ADMIN_CAPABILITY_LABELS,
  canAccessAdminSurface,
  canManageAdminDelegations,
  delegationPresetLabel,
  delegationScopeLabel,
  expandAdminDelegationPreset,
  hasAdminCapability,
  hasAnyAdminCapability,
  isDelegatedCoAdmin,
} from '@/lib/admin-delegations';
import {
  ADMIN_SECTION_OWNED_API_PREFIXES,
  getVisibleAdminNavItems,
  isAdminApiOwnedBySection,
} from '@/lib/admin-console-nav';
import {
  formatAuditActionLabel,
  isAdminDelegationAuditAction,
} from '@/lib/admin-audit';
import type { AuthUser } from '@/types/files';

function user(overrides: Partial<AuthUser>): AuthUser {
  return {
    id: 'u1',
    tenantId: 't1',
    email: 'u1@example.com',
    displayName: 'U1',
    role: 'member',
    ipAddress: '127.0.0.1',
    userType: 'member',
    ...overrides,
  };
}

const auditor = user({
  role: 'member',
  adminCapabilities: [
    'admin.insights.read',
    'admin.audit.read',
    'admin.reports.run',
    'admin.policies.read',
  ],
  adminScope: null,
});

const helpdesk = user({
  role: 'member',
  adminCapabilities: [
    'admin.users.read',
    'admin.users.suspend',
    'admin.content.unlock',
    'admin.trash.manage',
  ],
});

const groupManager = user({
  role: 'member',
  adminCapabilities: ['admin.users.read', 'admin.groups.manage'],
  adminScope: { groupId: 'g1', rootFolderId: null },
});

const contentOperator = user({
  role: 'member',
  adminCapabilities: [
    'admin.content.unlock',
    'admin.trash.manage',
    'admin.links.revoke',
  ],
  adminScope: { groupId: null, rootFolderId: 'root-1' },
});

test('Co-Admin presets expand in the documented API order', () => {
  assert.deepEqual(ADMIN_DELEGATION_PRESET_IDS, [
    'helpdesk',
    'auditor',
    'group_manager',
    'content_operator',
  ]);
  assert.deepEqual(expandAdminDelegationPreset('helpdesk'), [
    'admin.users.read',
    'admin.users.suspend',
    'admin.content.unlock',
    'admin.trash.manage',
  ]);
  assert.deepEqual(expandAdminDelegationPreset('auditor'), [
    'admin.insights.read',
    'admin.audit.read',
    'admin.reports.run',
    'admin.policies.read',
  ]);
  assert.deepEqual(expandAdminDelegationPreset('group_manager'), [
    'admin.users.read',
    'admin.groups.manage',
  ]);
  assert.deepEqual(expandAdminDelegationPreset('content_operator'), [
    'admin.content.unlock',
    'admin.trash.manage',
    'admin.links.revoke',
  ]);
  assert.equal(ADMIN_DELEGATION_PRESETS.auditor.length, 4);
});

test('nav visibility follows delegated capabilities while sys/sec keep all tabs', () => {
  assert.deepEqual(
    getVisibleAdminNavItems(user({ role: 'sys_admin' })).map(
      (item) => item.section
    ),
    ['all', 'insights', 'content', 'users', 'settings', 'reports']
  );
  assert.deepEqual(
    getVisibleAdminNavItems(user({ role: 'sec_admin' })).map(
      (item) => item.section
    ),
    ['all', 'insights', 'content', 'users', 'settings', 'reports']
  );
  assert.deepEqual(
    getVisibleAdminNavItems(auditor).map((item) => item.section),
    ['all', 'insights', 'reports']
  );
  assert.deepEqual(
    getVisibleAdminNavItems(helpdesk).map((item) => item.section),
    ['all', 'content', 'users']
  );
  assert.deepEqual(
    getVisibleAdminNavItems(groupManager).map((item) => item.section),
    ['all', 'users']
  );
  assert.deepEqual(
    getVisibleAdminNavItems(contentOperator).map((item) => item.section),
    ['all', 'content', 'settings']
  );
  assert.deepEqual(getVisibleAdminNavItems(user({ role: 'member' })), []);
  assert.deepEqual(
    getVisibleAdminNavItems(user({ role: 'member', userType: 'guest' })),
    []
  );
});

test('capability judgement mirrors the API role model', () => {
  const sys = user({ role: 'sys_admin' });
  const sec = user({ role: 'sec_admin' });

  assert.equal(hasAdminCapability(sys, 'admin.users.manage'), true);
  assert.equal(hasAdminCapability(sys, 'admin.policies.edit'), true);
  assert.equal(hasAdminCapability(sec, 'admin.users.manage'), false);
  assert.equal(hasAdminCapability(sec, 'admin.groups.manage'), false);
  assert.equal(hasAdminCapability(sec, 'admin.users.suspend'), true);
  assert.equal(hasAdminCapability(auditor, 'admin.audit.read'), true);
  assert.equal(hasAdminCapability(auditor, 'admin.content.unlock'), false);
  assert.equal(hasAdminCapability(helpdesk, 'admin.users.suspend'), true);
  assert.equal(
    hasAdminCapability(user({ role: 'member' }), 'admin.users.read'),
    false
  );
  assert.equal(
    hasAdminCapability(
      user({ role: 'member', userType: 'guest', adminCapabilities: ['admin.users.read'] }),
      'admin.users.read'
    ),
    false
  );

  assert.equal(hasAnyAdminCapability(sys), true);
  assert.equal(hasAnyAdminCapability(sec), true);
  assert.equal(hasAnyAdminCapability(auditor), true);
  assert.equal(hasAnyAdminCapability(user({ role: 'member' })), false);
  assert.equal(isDelegatedCoAdmin(auditor), true);
  assert.equal(isDelegatedCoAdmin(sys), false);
  assert.equal(canManageAdminDelegations(sys), true);
  assert.equal(canManageAdminDelegations(auditor), false);

  assert.equal(canAccessAdminSurface(auditor, 'insights'), true);
  assert.equal(canAccessAdminSurface(auditor, 'reports'), true);
  assert.equal(canAccessAdminSurface(auditor, 'users'), false);
  assert.equal(canAccessAdminSurface(auditor, 'settings'), false);
  assert.equal(canAccessAdminSurface(contentOperator, 'settings'), true);
  assert.equal(canAccessAdminSurface(contentOperator, 'content'), true);
  assert.equal(canAccessAdminSurface(contentOperator, 'insights'), false);
});

test('delegation labels and scope projection are deterministic', () => {
  assert.equal(delegationPresetLabel('auditor'), '監査専任');
  assert.equal(delegationPresetLabel(null), 'カスタム');
  assert.equal(delegationPresetLabel('unknown'), 'unknown');
  assert.equal(
    delegationScopeLabel({
      scopeGroupId: 'g1',
      scopeRootFolderId: 'root-1',
      groupName: '監査グループ',
      rootFolderName: '全社共有',
    }),
    'グループ: 監査グループ / ルート: 全社共有'
  );
  assert.equal(
    delegationScopeLabel({
      scopeGroupId: null,
      scopeRootFolderId: null,
      groupName: null,
      rootFolderName: null,
    }),
    'テナント全体'
  );
  assert.equal(
    ADMIN_CAPABILITY_LABELS['admin.policies.edit'],
    'ポリシー編集'
  );
});

test('delegation audit actions have labels and a dedicated prefix', () => {
  assert.equal(
    formatAuditActionLabel('admin.delegation.created'),
    '共同管理者委任の作成'
  );
  assert.equal(
    formatAuditActionLabel('admin.delegation.updated'),
    '共同管理者委任の更新'
  );
  assert.equal(
    formatAuditActionLabel('admin.delegation.deleted'),
    '共同管理者委任の削除'
  );
  assert.equal(isAdminDelegationAuditAction('admin.delegation.created'), true);
  assert.equal(isAdminDelegationAuditAction('admin.user.create'), false);
});

test('the users console section owns the delegation API contract', () => {
  assert.ok(
    ADMIN_SECTION_OWNED_API_PREFIXES.users.includes('/api/admin/delegations')
  );
  assert.equal(
    isAdminApiOwnedBySection('users', '/api/admin/delegations'),
    true
  );
  assert.equal(
    isAdminApiOwnedBySection('users', '/api/admin/delegations/abc'),
    true
  );
  assert.equal(
    isAdminApiOwnedBySection('reports', '/api/admin/delegations'),
    false
  );
  assert.ok(
    ADMIN_SECTION_OWNED_API_PREFIXES.reports.includes('/api/audit-logs')
  );
});
