import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPermissionAuditHref,
  buildPermissionAuditQueryString,
  buildPermissionExportHref,
  createBulkIdempotencyKey,
  formatAdminBulkSummary,
  formatGranteeStatusLabel,
  formatPermissionRoleLabel,
  formatPermissionSourceLabel,
  isPermissionAuditFilterActive,
  permissionRootWarnings,
  sortPermissionEntries,
  summarizePermissionRoots,
  togglePermissionSort,
} from '@/lib/admin-permission-audit';
import {
  formatAuditActionLabel,
  isPermissionAuditAction,
  PERMISSION_AUDIT_ACTION_PREFIXES,
} from '@/lib/admin-audit';
import {
  bulkArchiveAdminRootFolders,
  bulkGrantAdminRootFolderCoOwners,
  bulkRestoreAdminRootFolders,
  bulkTransferAdminRootFolderOwners,
  fetchAdminPermissionAudit,
  fetchAuditLogs,
} from '@/lib/files-api';
import type {
  AdminPermissionAuditEntry,
  AdminPermissionRootSummary,
} from '@/types/files';

function entry(
  overrides: Partial<AdminPermissionAuditEntry> = {}
): AdminPermissionAuditEntry {
  return {
    id: 'perm-1:folder:folder-1',
    permissionId: 'perm-1',
    targetType: 'folder',
    targetId: 'folder-1',
    targetName: 'Alpha',
    classification: 'internal',
    targetDeletedAt: null,
    rootFolderId: 'root-1',
    rootFolderName: 'Root',
    granteeType: 'user',
    granteeId: 'user-1',
    granteeName: 'Alice',
    granteeEmail: 'alice@example.com',
    granteeStatus: 'active',
    role: 'owner',
    source: 'direct',
    inheritedFromId: null,
    inheritedFromName: null,
    inheritedDepth: 0,
    grantedBy: 'admin-1',
    grantedByName: 'Admin',
    grantedByEmail: 'admin@example.com',
    createdAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

function root(
  overrides: Partial<AdminPermissionRootSummary> = {}
): AdminPermissionRootSummary {
  return {
    id: 'root-1',
    name: 'Root',
    classification: 'internal',
    archived: false,
    deletedAt: null,
    ownerCount: 1,
    activeOwnerCount: 1,
    coOwnerCount: 0,
    editorCount: 0,
    totalGrantCount: 1,
    ownerMissing: false,
    hasSuspendedOwner: false,
    hasDeletedOwner: false,
    ...overrides,
  };
}

test('bulk permission audit actions have Japanese labels and prefix membership', () => {
  const expected: Record<string, string> = {
    'admin.permission.bulk_grant': '権限の一括付与',
    'admin.root_folder.bulk_transfer': '所有者の一括移管',
    'admin.root_folder.bulk_archive': 'ルートフォルダの一括アーカイブ',
    'admin.root_folder.bulk_restore': 'ルートフォルダの一括復元',
  };
  for (const [action, label] of Object.entries(expected)) {
    assert.equal(formatAuditActionLabel(action), label);
    assert.equal(isPermissionAuditAction(action), true);
  }
  assert.equal(isPermissionAuditAction('folder.create'), false);
  assert.deepEqual(
    [...PERMISSION_AUDIT_ACTION_PREFIXES],
    ['permission.', 'admin.root_folder.', 'admin.permission.']
  );
});

test('query builders serialize every permission-audit filter and export mode', () => {
  const query = {
    targetType: 'file' as const,
    rootFolderId: 'root-1',
    includeInherited: true,
    grantee: ' alice ',
    granteeType: 'user' as const,
    role: ['owner', 'editor'] as Array<'owner' | 'editor'>,
    source: 'inherited' as const,
    inheritedFromId: 'folder-parent',
    grantedBy: 'admin@example.com',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T23:59:59.999Z',
    granteeStatus: 'suspended' as const,
    health: 'inactive_owner' as const,
    sortBy: 'granteeName' as const,
    sortDir: 'asc' as const,
    limit: 200,
    offset: 50,
  };
  const qs = new URLSearchParams(buildPermissionAuditQueryString(query));
  assert.equal(qs.get('targetType'), 'file');
  assert.equal(qs.get('rootFolderId'), 'root-1');
  assert.equal(qs.get('includeInherited'), '1');
  assert.equal(qs.get('grantee'), 'alice');
  assert.equal(qs.get('granteeType'), 'user');
  assert.equal(qs.get('role'), 'owner,editor');
  assert.equal(qs.get('source'), 'inherited');
  assert.equal(qs.get('inheritedFromId'), 'folder-parent');
  assert.equal(qs.get('grantedBy'), 'admin@example.com');
  assert.equal(qs.get('from'), '2026-01-01T00:00:00.000Z');
  assert.equal(qs.get('to'), '2026-01-31T23:59:59.999Z');
  assert.equal(qs.get('granteeStatus'), 'suspended');
  assert.equal(qs.get('health'), 'inactive_owner');
  assert.equal(qs.get('sortBy'), 'granteeName');
  assert.equal(qs.get('sortDir'), 'asc');
  assert.equal(qs.get('limit'), '200');
  assert.equal(qs.get('offset'), '50');

  assert.equal(
    buildPermissionAuditHref({ source: 'direct' }),
    '/api/admin/permissions?source=direct'
  );
  assert.equal(buildPermissionAuditHref({}), '/api/admin/permissions');
  const csv = buildPermissionExportHref({ targetType: 'folder' }, 'csv');
  assert.equal(
    csv,
    '/api/admin/permissions?targetType=folder&format=csv'
  );
  const json = buildPermissionExportHref({ targetType: 'folder' }, 'json');
  assert.equal(
    json,
    '/api/admin/permissions?targetType=folder&format=json&download=1'
  );
});

test('root summaries and warning badges drive the health overview', () => {
  const roots = [
    root(),
    root({
      id: 'root-2',
      ownerCount: 1,
      activeOwnerCount: 0,
      ownerMissing: true,
      hasSuspendedOwner: true,
    }),
    root({
      id: 'root-3',
      ownerCount: 0,
      activeOwnerCount: 0,
      ownerMissing: true,
      hasDeletedOwner: true,
      archived: true,
      totalGrantCount: 4,
    }),
  ];
  assert.deepEqual(summarizePermissionRoots(roots), {
    total: 3,
    ownerMissing: 2,
    suspendedOwner: 1,
    deletedOwner: 1,
    archived: 1,
    totalGrants: 1 + 1 + 4,
  });
  assert.deepEqual(permissionRootWarnings(roots[1]!), [
    '所有者不在',
    '停止済みオーナー',
  ]);
  assert.deepEqual(permissionRootWarnings(roots[2]!), [
    '所有者不在',
    '削除済みオーナー',
    'アーカイブ済み',
  ]);
  assert.deepEqual(permissionRootWarnings(roots[0]!), []);
});

test('permission entries sort deterministically by role, target, grantee and date', () => {
  const entries = [
    entry({
      id: 'c',
      role: 'editor',
      targetName: 'Beta',
      granteeName: 'Carol',
      createdAt: '2026-01-03T00:00:00.000Z',
    }),
    entry({
      id: 'a',
      role: 'owner',
      targetName: 'Alpha',
      granteeName: 'Alice',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    entry({
      id: 'b',
      role: 'viewer',
      targetName: 'Gamma',
      granteeName: 'Bob',
      createdAt: '2026-01-02T00:00:00.000Z',
    }),
  ];
  assert.deepEqual(
    sortPermissionEntries(entries, 'role', 'asc').map((item) => item.id),
    ['a', 'c', 'b']
  );
  assert.deepEqual(
    sortPermissionEntries(entries, 'role', 'desc').map((item) => item.id),
    ['b', 'c', 'a']
  );
  assert.deepEqual(
    sortPermissionEntries(entries, 'targetName', 'asc').map((item) => item.id),
    ['a', 'c', 'b']
  );
  assert.deepEqual(
    sortPermissionEntries(entries, 'granteeName', 'desc').map((item) => item.id),
    ['c', 'b', 'a']
  );
  assert.deepEqual(
    sortPermissionEntries(entries, 'createdAt', 'desc').map((item) => item.id),
    ['c', 'b', 'a']
  );
  assert.deepEqual(togglePermissionSort({ sortBy: 'role', sortDir: 'asc' }, 'role'), {
    sortBy: 'role',
    sortDir: 'desc',
  });
  assert.deepEqual(togglePermissionSort({ sortBy: 'role', sortDir: 'desc' }, 'createdAt'), {
    sortBy: 'createdAt',
    sortDir: 'asc',
  });
});

test('filter activity, labels and bulk summary formatting are stable', () => {
  assert.equal(isPermissionAuditFilterActive({}), false);
  assert.equal(
    isPermissionAuditFilterActive({ targetType: 'all', source: 'all', health: 'all' }),
    false
  );
  assert.equal(isPermissionAuditFilterActive({ source: 'inherited' }), true);
  assert.equal(isPermissionAuditFilterActive({ role: ['owner'] }), true);
  assert.equal(isPermissionAuditFilterActive({ granteeStatus: 'deleted' }), true);

  const inherited = entry({
    source: 'inherited',
    inheritedFromId: 'folder-parent',
    inheritedFromName: 'Parent Folder',
    inheritedDepth: 2,
  });
  assert.equal(formatPermissionSourceLabel(inherited), '継承元: Parent Folder');
  assert.equal(formatPermissionSourceLabel(entry()), '直接付与');
  assert.equal(formatGranteeStatusLabel('active'), '有効');
  assert.equal(formatGranteeStatusLabel('suspended'), '停止中');
  assert.equal(formatGranteeStatusLabel('deleted'), '削除済み');
  assert.equal(formatPermissionRoleLabel('co_owner'), '共同所有者');
  assert.equal(formatPermissionRoleLabel('previewer_uploader'), 'プレビュー + アップロード');
  assert.equal(
    formatAdminBulkSummary({
      requested: 5,
      succeeded: 2,
      skipped: 1,
      failed: 2,
      executable: 2,
    }),
    '対象 5 件 / 成功 2 件 / スキップ 1 件 / 失敗 2 件'
  );
  assert.match(createBulkIdempotencyKey('bulk'), /^bulk:/);
});

test('API client sends permission audit filters, bulk payloads and audit prefixes', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true, entries: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await fetchAdminPermissionAudit({
      targetType: 'folder',
      source: 'inherited',
      includeInherited: true,
      role: ['owner', 'co_owner'],
      health: 'owner_missing',
      sortBy: 'targetName',
      sortDir: 'asc',
      limit: 100,
      offset: 20,
    });
    const auditCall = new URL(calls[0]!.url, 'http://localhost');
    assert.equal(auditCall.pathname, '/api/admin/permissions');
    assert.equal(auditCall.searchParams.get('targetType'), 'folder');
    assert.equal(auditCall.searchParams.get('source'), 'inherited');
    assert.equal(auditCall.searchParams.get('includeInherited'), '1');
    assert.equal(auditCall.searchParams.get('role'), 'owner,co_owner');
    assert.equal(auditCall.searchParams.get('health'), 'owner_missing');
    assert.equal(auditCall.searchParams.get('sortBy'), 'targetName');
    assert.equal(auditCall.searchParams.get('sortDir'), 'asc');

    await bulkGrantAdminRootFolderCoOwners({
      folderIds: ['root-1'],
      groupIds: ['group-1'],
      dryRun: true,
      idempotencyKey: 'key-1',
    });
    const coOwnerCall = calls[1]!;
    assert.equal(coOwnerCall.url, '/api/admin/permissions/bulk-co-owner');
    assert.equal(coOwnerCall.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(coOwnerCall.init?.body)), {
      folderIds: ['root-1'],
      groupIds: ['group-1'],
      dryRun: true,
      idempotencyKey: 'key-1',
    });

    await bulkTransferAdminRootFolderOwners({
      folderIds: ['root-1', 'root-2'],
      newOwnerUserId: 'user-2',
      demotePreviousOwnersTo: 'editor',
      idempotencyKey: 'key-2',
    });
    const transferCall = calls[2]!;
    assert.equal(
      transferCall.url,
      '/api/admin/root-folders/bulk-transfer-owner'
    );
    assert.equal(transferCall.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(transferCall.init?.body)), {
      folderIds: ['root-1', 'root-2'],
      newOwnerUserId: 'user-2',
      demotePreviousOwnersTo: 'editor',
      idempotencyKey: 'key-2',
    });

    await bulkArchiveAdminRootFolders({
      folderIds: ['root-1'],
      dryRun: true,
    });
    assert.equal(calls[3]!.url, '/api/admin/root-folders/bulk-archive');
    await bulkRestoreAdminRootFolders({
      folderIds: ['root-1'],
      idempotencyKey: 'key-3',
    });
    assert.equal(calls[4]!.url, '/api/admin/root-folders/bulk-restore');

    await fetchAuditLogs({
      actionPrefixes: ['permission.', 'admin.root_folder.'],
      targetType: 'permission',
      limit: 50,
    });
    const auditLogCall = new URL(calls[5]!.url, 'http://localhost');
    assert.equal(auditLogCall.pathname, '/api/audit-logs');
    assert.equal(
      auditLogCall.searchParams.get('actionPrefixes'),
      'permission.,admin.root_folder.'
    );
    assert.equal(auditLogCall.searchParams.get('targetType'), 'permission');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
