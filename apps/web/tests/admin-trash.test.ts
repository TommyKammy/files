import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_TRASH_ACTION_LABELS,
  ADMIN_TRASH_AUDIT_ACTIONS,
  ADMIN_TRASH_RETENTION_OPTIONS,
  ADMIN_TRASH_SORT_OPTIONS,
  buildAdminTrashAuditCsvHref,
  buildAdminTrashQueryString,
  buildAdminTrashRequestParams,
  canPurgeAdminTrash,
  canRestoreAdminTrash,
  DEFAULT_ADMIN_TRASH_FILTERS,
  formatAdminTrashAuditEntry,
  formatAdminTrashPermissionSummary,
  formatAdminTrashPerson,
  getAdminTrashEmptyState,
  isAdminTrashFilterActive,
  mergeAdminTrashItems,
  removeAdminTrashItems,
  retentionFilterToMaxDays,
} from '@/lib/admin-trash';
import type {
  AdminTrashItem,
  AdminTrashPermissionSummary,
  AuditLogEntry,
} from '@/types/files';

function auditLog(overrides: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: 'audit-1',
    actorId: 'admin-1',
    actorEmail: 'sec@example.com',
    actorIp: '127.0.0.1',
    action: 'admin.file.restore',
    targetType: 'file',
    targetId: 'file-1',
    classificationSnapshot: null,
    status: 'allowed',
    metadata: null,
    createdAt: '2026-11-15T13:57:10.281Z',
    ...overrides,
  };
}

function summary(
  overrides: Partial<AdminTrashPermissionSummary> = {}
): AdminTrashPermissionSummary {
  return {
    total: 4,
    direct: 1,
    inherited: 3,
    userCount: 3,
    groupCount: 1,
    roles: {
      owner: 1,
      co_owner: 0,
      editor: 2,
      viewer_uploader: 0,
      previewer_uploader: 0,
      viewer: 1,
      previewer: 0,
      uploader: 0,
    },
    sharedLinkCount: 1,
    ...overrides,
  };
}

function item(id: string, type: 'file' | 'folder' = 'file'): AdminTrashItem {
  return {
    type,
    id,
    name: `${id}.txt`,
    classification: 'internal',
    sizeBytes: 10,
    currentVersionNum: 1,
    parentFolder: null,
    owner: null,
    deletedBy: null,
    deletedAt: '2026-11-15T00:00:00.000Z',
    purgeAt: '2026-12-15T00:00:00.000Z',
    daysRemaining: 30,
    permissionSummary: summary(),
  };
}

test('restore is available to sec_admin and sys_admin while purge and empty stay sys_admin-only', () => {
  assert.equal(canRestoreAdminTrash('sys_admin'), true);
  assert.equal(canRestoreAdminTrash('sec_admin'), true);
  assert.equal(canRestoreAdminTrash('member'), false);
  assert.equal(canRestoreAdminTrash(null), false);
  assert.equal(canRestoreAdminTrash(undefined), false);

  assert.equal(canPurgeAdminTrash('sys_admin'), true);
  assert.equal(canPurgeAdminTrash('sec_admin'), false);
  assert.equal(canPurgeAdminTrash('member'), false);
  assert.equal(canPurgeAdminTrash(null), false);
});

test('admin Trash request parameters preserve filters, retention mapping and sort', () => {
  const filters = {
    ...DEFAULT_ADMIN_TRASH_FILTERS,
    query: '  report_100%  ',
    type: 'file' as const,
    ownerId: 'user-owner',
    deletedById: 'unknown',
    retention: '7' as const,
    sort: 'name_asc' as const,
  };

  const params = buildAdminTrashRequestParams(filters, { limit: 25 });
  assert.deepEqual(params, {
    limit: 25,
    cursor: null,
    query: 'report_100%',
    type: 'file',
    ownerId: 'user-owner',
    deletedById: 'unknown',
    daysRemainingMax: 7,
    sort: 'name_asc',
  });

  const qs = new URLSearchParams(buildAdminTrashQueryString(params));
  assert.equal(qs.get('limit'), '25');
  assert.equal(qs.get('query'), 'report_100%');
  assert.equal(qs.get('type'), 'file');
  assert.equal(qs.get('ownerId'), 'user-owner');
  assert.equal(qs.get('deletedById'), 'unknown');
  assert.equal(qs.get('daysRemainingMax'), '7');
  assert.equal(qs.get('sort'), 'name_asc');
  assert.equal(qs.get('cursor'), null);

  const all = buildAdminTrashRequestParams(
    { ...DEFAULT_ADMIN_TRASH_FILTERS, retention: 'all' },
    { cursor: 'next-page' }
  );
  assert.equal(all.daysRemainingMax, null);
  assert.equal(
    new URLSearchParams(buildAdminTrashQueryString(all)).get('type'),
    null
  );
  assert.equal(
    new URLSearchParams(buildAdminTrashQueryString(all)).get('cursor'),
    'next-page'
  );

  assert.equal(retentionFilterToMaxDays('all'), null);
  assert.equal(retentionFilterToMaxDays('7'), 7);
  assert.equal(retentionFilterToMaxDays('1'), 1);
  assert.deepEqual(
    ADMIN_TRASH_RETENTION_OPTIONS.map((option) => option.value),
    ['all', '7', '1']
  );
  assert.deepEqual(
    ADMIN_TRASH_SORT_OPTIONS.map((option) => option.value),
    ['deletedAt_desc', 'deletedAt_asc', 'name_asc', 'name_desc']
  );
});

test('admin Trash merge/remove helpers keep cursor pages stable', () => {
  const folder = item('folder-1', 'folder');
  const file = item('file-1');
  const duplicate = item('file-1');
  const merged = mergeAdminTrashItems([folder], [file, duplicate]);
  assert.deepEqual(
    merged.map((row) => `${row.type}:${row.id}`),
    ['folder:folder-1', 'file:file-1']
  );
  assert.deepEqual(
    removeAdminTrashItems(merged, [{ type: 'file', id: 'file-1' }]).map(
      (row) => row.id
    ),
    ['folder-1']
  );

  assert.equal(getAdminTrashEmptyState(DEFAULT_ADMIN_TRASH_FILTERS, 0), 'empty');
  assert.equal(getAdminTrashEmptyState(DEFAULT_ADMIN_TRASH_FILTERS, 2), 'list');
  assert.equal(
    getAdminTrashEmptyState(
      { ...DEFAULT_ADMIN_TRASH_FILTERS, query: 'missing' },
      0
    ),
    'filtered-empty'
  );
  assert.equal(isAdminTrashFilterActive(DEFAULT_ADMIN_TRASH_FILTERS), false);
  assert.equal(
    isAdminTrashFilterActive({
      ...DEFAULT_ADMIN_TRASH_FILTERS,
      retention: '7',
    }),
    true
  );
});

test('permission summary and people formatting stay compact and null-safe', () => {
  assert.equal(
    formatAdminTrashPermissionSummary(summary()),
    '4 件 · 継承 3 · Owner 1 / Editor 2 / Viewer 1 · 共有リンク 1'
  );
  assert.equal(
    formatAdminTrashPermissionSummary(summary({ total: 0, inherited: 0 })),
    '権限なし'
  );
  assert.equal(formatAdminTrashPermissionSummary(null), '権限なし');
  assert.equal(
    formatAdminTrashPerson({
      id: 'user-1',
      name: 'Dev Member',
      email: 'dev-member@example.com',
    }),
    'Dev Member (dev-member@example.com)'
  );
  assert.equal(
    formatAdminTrashPerson({ id: 'user-1', name: 'Dev Member', email: null }),
    'Dev Member'
  );
  assert.equal(formatAdminTrashPerson(null), '不明');
});

test('all seven restore/purge audit actions have labels and a matching CSV filter', () => {
  assert.deepEqual(ADMIN_TRASH_AUDIT_ACTIONS, [
    'file.restore',
    'folder.restore',
    'file.purge',
    'folder.purge',
    'admin.file.restore',
    'admin.folder.restore',
    'admin.trash.empty',
  ]);
  assert.equal(Object.keys(ADMIN_TRASH_ACTION_LABELS).length, 7);
  for (const action of ADMIN_TRASH_AUDIT_ACTIONS) {
    assert.equal(typeof ADMIN_TRASH_ACTION_LABELS[action], 'string');
    assert.ok(ADMIN_TRASH_ACTION_LABELS[action].length > 0);
  }

  const csv = new URL(buildAdminTrashAuditCsvHref(), 'http://localhost');
  assert.equal(csv.pathname, '/api/audit-logs');
  assert.equal(csv.searchParams.get('format'), 'csv');
  assert.equal(csv.searchParams.get('limit'), '200');
  assert.deepEqual(
    csv.searchParams.get('actions')?.split(','),
    [...ADMIN_TRASH_AUDIT_ACTIONS]
  );
});

test('admin audit timeline formats on-behalf restore metadata for every action label', () => {
  const restored = formatAdminTrashAuditEntry(
    auditLog({
      action: 'admin.file.restore',
      metadata: {
        targetName: 'quarterly-report.txt',
        sourceVersion: 7,
        restoredTo: {
          id: 'folder-1',
          name: 'Finance',
          path: '全社共有 / Finance',
        },
        ownerName: 'Dev Member',
        ownerEmail: 'dev-member@example.com',
        onBehalfOfUserId: 'dev-member-001',
      },
    })
  );
  assert.deepEqual(restored, {
    action: 'admin.file.restore',
    actionLabel: '管理者代理: ファイル復元',
    targetName: 'quarterly-report.txt',
    sourceVersion: 'v7',
    restoredTo: '全社共有 / Finance',
    actorEmail: 'sec@example.com',
    onBehalfOf: 'Dev Member (dev-member@example.com)',
    dateLabel: '2026/11/15 22:57 JST',
    detail: '—',
  });

  const folderRestore = formatAdminTrashAuditEntry(
    auditLog({
      action: 'admin.folder.restore',
      metadata: {
        targetName: 'Finance',
        sourceVersion: 3,
        restoredTo: '全社共有 / Finance',
        ownerName: 'Dev Member',
      },
    })
  );
  assert.equal(folderRestore.actionLabel, '管理者代理: フォルダ復元');
  assert.equal(folderRestore.restoredTo, '全社共有 / Finance');
  assert.equal(folderRestore.sourceVersion, 'v3');

  const empty = formatAdminTrashAuditEntry(
    auditLog({
      action: 'admin.trash.empty',
      targetType: 'tenant',
      targetId: 'tenant-default',
      metadata: {
        deletedCount: 5,
        skippedCount: 1,
        failedCount: 2,
      },
    })
  );
  assert.equal(empty.actionLabel, 'テナントゴミ箱を空にする');
  assert.equal(empty.targetName, 'テナント全体のゴミ箱');
  assert.equal(empty.sourceVersion, '—');
  assert.equal(empty.restoredTo, '—');
  assert.equal(empty.onBehalfOf, '—');
  assert.equal(empty.detail, '削除 5 / スキップ 1 / 失敗 2');

  for (const action of ADMIN_TRASH_AUDIT_ACTIONS) {
    const display = formatAdminTrashAuditEntry(auditLog({ action }));
    assert.equal(display.actionLabel, ADMIN_TRASH_ACTION_LABELS[action]);
  }
});

test('admin audit timeline degrades unknown or malformed metadata without throwing', () => {
  const missing = formatAdminTrashAuditEntry(
    auditLog({ action: 'file.purge', metadata: null, targetId: null })
  );
  assert.equal(missing.targetName, '—');
  assert.equal(missing.sourceVersion, '—');
  assert.equal(missing.restoredTo, '—');
  assert.equal(missing.onBehalfOf, '—');
  assert.equal(missing.actorEmail, 'sec@example.com');

  const malformed = formatAdminTrashAuditEntry(
    auditLog({
      action: 'folder.purge',
      actorEmail: null,
      metadata: {
        targetName: 42,
        sourceVersion: { value: 3 },
        restoredTo: { unknown: true },
        ownerName: '',
      },
    })
  );
  assert.equal(malformed.targetName, 'file-1');
  assert.equal(malformed.sourceVersion, '—');
  assert.equal(malformed.restoredTo, '—');
  assert.equal(malformed.onBehalfOf, '—');
  assert.equal(malformed.actorEmail, '不明');
  assert.equal(malformed.actionLabel, 'フォルダ完全削除');
});
