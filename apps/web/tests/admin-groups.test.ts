import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_GROUP_SOURCE_LABELS,
  ADMIN_SCIM_TOKEN_STATUS_LABELS,
  SCIM_MANAGED_GROUP_REASON,
  buildAdminGroupQuery,
  buildScimEndpointUrl,
  canEditAdminGroup,
  canManageAdminGroups,
  canManageScimTokens,
  canRevokeScimToken,
  canRotateScimToken,
  canViewAdminGroups,
  canViewScimTokens,
  filterAdminGroups,
  groupPermissionNotice,
  groupReadOnlyReason,
  groupSourceBadgeClass,
  groupSourceLabel,
  groupSourceSummaryCards,
  isScimManagedGroup,
  scimTokenPermissionNotice,
  scimTokenStatusBadgeClass,
  scimTokenStatusLabel,
  scimTokenUsageLabel,
  selectableGroupMembers,
  sortAdminGroupRows,
} from '@/lib/admin-groups';
import type {
  AdminGroupRow,
  AdminMemberRow,
  AdminScimTokenRow,
} from '@/types/files';

function group(overrides: Partial<AdminGroupRow> = {}): AdminGroupRow {
  return {
    id: 'group-1',
    name: 'Engineering',
    source: 'manual',
    externalIdpId: null,
    memberCount: 3,
    permissionCount: 2,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function member(overrides: Partial<AdminMemberRow> = {}): AdminMemberRow {
  return {
    id: 'member-1',
    email: 'alpha@example.com',
    displayName: 'Alpha',
    department: 'Engineering',
    role: 'member',
    status: 'active',
    storageQuotaBytes: null,
    usedBytes: 0,
    fileCount: 0,
    lastLoginAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function token(overrides: Partial<AdminScimTokenRow> = {}): AdminScimTokenRow {
  return {
    id: 'token-1',
    name: 'Okta Production',
    idpIssuer: 'https://idp.example.com',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

test('group RBAC separates viewing from mutation and explains sec_admin limits', () => {
  assert.equal(canViewAdminGroups('sys_admin'), true);
  assert.equal(canViewAdminGroups('sec_admin'), true);
  assert.equal(canViewAdminGroups('member'), false);
  assert.equal(canViewAdminGroups(null), false);

  assert.equal(canManageAdminGroups('sys_admin'), true);
  assert.equal(canManageAdminGroups('sec_admin'), false);
  assert.equal(canManageAdminGroups(null), false);

  assert.match(groupPermissionNotice('sec_admin'), /閲覧できます/);
  assert.match(groupPermissionNotice('sec_admin'), /sys_admin 専用/);
  assert.match(groupPermissionNotice('sys_admin'), /SCIM 同期グループ/);
});

test('source labels, badges and summary cards stay aligned with the API contract', () => {
  assert.deepEqual(ADMIN_GROUP_SOURCE_LABELS, {
    all: 'すべて',
    manual: '手動',
    scim: 'SCIM 同期',
  });
  assert.equal(groupSourceLabel('manual'), '手動');
  assert.equal(groupSourceLabel('scim'), 'SCIM 同期');
  assert.match(groupSourceBadgeClass('scim'), /indigo/);
  assert.match(groupSourceBadgeClass('manual'), /slate/);

  assert.deepEqual(groupSourceSummaryCards(null), [
    { key: 'all', label: '全グループ', count: 0 },
    { key: 'manual', label: '手動グループ', count: 0 },
    { key: 'scim', label: 'SCIM 同期', count: 0 },
  ]);
  assert.deepEqual(
    groupSourceSummaryCards({ total: 7, manualCount: 6, scimCount: 1 }),
    [
      { key: 'all', label: '全グループ', count: 7 },
      { key: 'manual', label: '手動グループ', count: 6 },
      { key: 'scim', label: 'SCIM 同期', count: 1 },
    ]
  );
});

test('group query serialization omits empty/default filters', () => {
  assert.equal(buildAdminGroupQuery(), '');
  assert.equal(buildAdminGroupQuery({ source: 'all' }), '');
  assert.equal(buildAdminGroupQuery({ query: '  ' }), '');
  assert.equal(
    buildAdminGroupQuery({ query: '  Eng  ', source: 'scim' }),
    '?query=Eng&source=scim'
  );
  assert.equal(
    buildAdminGroupQuery({ query: 'Ops', source: 'manual', limit: 200 }),
    '?query=Ops&source=manual&limit=200'
  );
});

test('group filtering matches name, id, IdP id and source', () => {
  const rows = [
    group({ id: 'g-1', name: 'Engineering' }),
    group({
      id: 'g-2',
      name: 'Sales',
      source: 'scim',
      externalIdpId: 'idp-sales-1',
    }),
    group({ id: 'g-3', name: 'Owners' }),
  ];

  assert.deepEqual(
    filterAdminGroups(rows, { query: 'sales' }).map((row) => row.id),
    ['g-2']
  );
  assert.deepEqual(
    filterAdminGroups(rows, { query: 'idp-sales' }).map((row) => row.id),
    ['g-2']
  );
  assert.deepEqual(
    filterAdminGroups(rows, { query: 'g-3' }).map((row) => row.id),
    ['g-3']
  );
  assert.deepEqual(
    filterAdminGroups(rows, { source: 'manual' }).map((row) => row.id),
    ['g-1', 'g-3']
  );
  assert.deepEqual(
    filterAdminGroups(rows, { source: 'scim', query: 'nope' }).map(
      (row) => row.id
    ),
    []
  );

  assert.deepEqual(
    sortAdminGroupRows([
      group({ id: 'b', name: 'Beta' }),
      group({ id: 'a', name: 'Alpha' }),
    ]).map((row) => row.id),
    ['a', 'b']
  );
});

test('SCIM-managed groups are read-only and explain the IdP ownership', () => {
  const manual = group();
  const scim = group({ source: 'scim', externalIdpId: 'idp-group-1' });

  assert.equal(isScimManagedGroup(manual), false);
  assert.equal(isScimManagedGroup(scim), true);
  // externalIdpId alone is enough even if a stale source field says manual.
  assert.equal(
    isScimManagedGroup(group({ source: 'manual', externalIdpId: 'idp-1' })),
    true
  );

  assert.equal(canEditAdminGroup('sys_admin', manual), true);
  assert.equal(canEditAdminGroup('sec_admin', manual), false);
  assert.equal(canEditAdminGroup('sys_admin', scim), false);

  assert.equal(groupReadOnlyReason('sys_admin', manual), null);
  assert.match(groupReadOnlyReason('sec_admin', manual) ?? '', /閲覧のみ/);
  assert.equal(groupReadOnlyReason('sys_admin', scim), SCIM_MANAGED_GROUP_REASON);
  assert.equal(groupReadOnlyReason('sec_admin', scim), SCIM_MANAGED_GROUP_REASON);
});

test('member selector excludes existing and inactive members', () => {
  const rows = [
    member({ id: 'm-1', displayName: 'Alpha' }),
    member({ id: 'm-2', displayName: 'Bravo' }),
    member({ id: 'm-3', displayName: 'Charlie', status: 'suspended' }),
  ];
  assert.deepEqual(
    selectableGroupMembers(rows, ['m-1']).map((row) => row.id),
    ['m-2']
  );
  assert.deepEqual(
    selectableGroupMembers(rows, ['m-1', 'm-2', 'm-3']),
    []
  );
});

test('SCIM token RBAC, status labels, badges and action gates', () => {
  assert.equal(canViewScimTokens('sys_admin'), true);
  assert.equal(canViewScimTokens('sec_admin'), true);
  assert.equal(canViewScimTokens('member'), false);
  assert.equal(canManageScimTokens('sys_admin'), true);
  assert.equal(canManageScimTokens('sec_admin'), false);

  assert.match(scimTokenPermissionNotice('sec_admin'), /閲覧できます/);
  assert.match(scimTokenPermissionNotice('sec_admin'), /sys_admin 専用/);
  assert.match(scimTokenPermissionNotice('sys_admin'), /1 回だけ/);

  assert.deepEqual(ADMIN_SCIM_TOKEN_STATUS_LABELS, {
    active: '有効',
    revoked: '失効済み',
  });
  assert.equal(scimTokenStatusLabel('active'), '有効');
  assert.equal(scimTokenStatusLabel('revoked'), '失効済み');
  assert.match(scimTokenStatusBadgeClass('active'), /emerald/);
  assert.match(scimTokenStatusBadgeClass('revoked'), /red/);

  const active = token();
  const revoked = token({ status: 'revoked', revokedAt: '2026-11-02T00:00:00.000Z' });
  assert.equal(canRotateScimToken('sys_admin', active), true);
  assert.equal(canRotateScimToken('sec_admin', active), false);
  assert.equal(canRotateScimToken('sys_admin', revoked), false);
  assert.equal(canRevokeScimToken('sys_admin', active), true);
  assert.equal(canRevokeScimToken('sec_admin', active), false);
  assert.equal(canRevokeScimToken('sys_admin', revoked), false);
});

test('SCIM endpoint and usage labels are stable for copy/display', () => {
  assert.equal(buildScimEndpointUrl(null), '/scim/v2');
  assert.equal(buildScimEndpointUrl(''), '/scim/v2');
  assert.equal(
    buildScimEndpointUrl('https://files.example.com'),
    'https://files.example.com/scim/v2'
  );
  assert.equal(
    buildScimEndpointUrl('https://files.example.com/'),
    'https://files.example.com/scim/v2'
  );
  assert.equal(
    buildScimEndpointUrl('  https://files.example.com///  '),
    'https://files.example.com/scim/v2'
  );
  assert.equal(scimTokenUsageLabel(null), '未使用');
  assert.equal(
    scimTokenUsageLabel('2026-11-02T00:00:00.000Z'),
    '利用あり'
  );
});
