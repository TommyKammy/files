import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_MEMBER_CSV_SAMPLE,
  ADMIN_MEMBER_ROLE_LABELS,
  ADMIN_MEMBER_STATUS_LABELS,
  ariaSortForMemberColumn,
  buildAdminMemberQuery,
  buildMemberAuditHref,
  bulkRowLabel,
  canAdministrateMembers,
  canManageMemberLifecycle,
  canViewAdminMembers,
  createMemberIdempotencyKey,
  departmentLabel,
  filterAdminMembers,
  formatBulkImportSummary,
  formatBytes,
  formatMemberUsage,
  memberCanBeResumed,
  memberCanBeSuspended,
  memberPermissionNotice,
  memberQuotaState,
  memberRoleBadgeClass,
  memberRoleSummaryCards,
  memberStatusBadgeClass,
  memberStatusSummaryCards,
  parseMemberQuotaInput,
  sortAdminMemberRows,
  toggleAdminMemberSort,
} from '@/lib/admin-users';
import { parseAdminAuditPreset } from '@/lib/admin-console-nav';
import {
  bulkImportAdminMembers,
  createAdminMember,
  fetchAdminMemberDetail,
  fetchAdminMembers,
  resumeAdminMember,
  suspendAdminMember,
  updateAdminMember,
} from '@/lib/files-api';
import type {
  AdminMemberAggregations,
  AdminMemberRow,
} from '@/types/files';

function member(overrides: Partial<AdminMemberRow> = {}): AdminMemberRow {
  return {
    id: 'm-1',
    email: 'alpha@example.com',
    displayName: 'Alpha',
    department: 'Engineering',
    role: 'member',
    status: 'active',
    storageQuotaBytes: 10_000,
    usedBytes: 2_500,
    fileCount: 3,
    lastLoginAt: '2026-11-01T00:00:00.000Z',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function aggregations(
  overrides: Partial<AdminMemberAggregations> = {}
): AdminMemberAggregations {
  return {
    total: 5,
    byStatus: { all: 5, active: 4, suspended: 1 },
    byRole: { sys_admin: 1, sec_admin: 1, member: 3 },
    departments: [
      { department: 'Engineering', count: 3 },
      { department: null, count: 1 },
    ],
    ...overrides,
  };
}

test('member RBAC separates viewing, lifecycle and administration', () => {
  assert.equal(canViewAdminMembers('sys_admin'), true);
  assert.equal(canViewAdminMembers('sec_admin'), true);
  assert.equal(canViewAdminMembers('member'), false);
  assert.equal(canViewAdminMembers(null), false);

  assert.equal(canManageMemberLifecycle('sys_admin'), true);
  assert.equal(canManageMemberLifecycle('sec_admin'), true);
  assert.equal(canManageMemberLifecycle('member'), false);

  assert.equal(canAdministrateMembers('sys_admin'), true);
  assert.equal(canAdministrateMembers('sec_admin'), false);
  assert.equal(canAdministrateMembers(null), false);

  assert.match(memberPermissionNotice('sec_admin'), /一般メンバーの停止・再開/);
  assert.match(memberPermissionNotice('sec_admin'), /sys_admin 専用/);
  assert.match(memberPermissionNotice('sys_admin'), /すべて実行できます/);
});

test('suspend/resume eligibility blocks self, elevated targets and sec_admin escalation', () => {
  const activeMember = member();
  const suspendedMember = member({ id: 'm-2', status: 'suspended' });
  const secAdmin = member({ id: 's-1', role: 'sec_admin' });
  const sysAdmin = member({ id: 's-2', role: 'sys_admin' });

  assert.equal(memberCanBeSuspended('sys_admin', 'admin', activeMember), true);
  assert.equal(memberCanBeSuspended('sys_admin', 'm-1', activeMember), false);
  assert.equal(memberCanBeSuspended('sec_admin', 'admin', activeMember), true);
  assert.equal(memberCanBeSuspended('sec_admin', 'admin', secAdmin), false);
  assert.equal(memberCanBeSuspended('sec_admin', 'admin', sysAdmin), false);
  assert.equal(memberCanBeSuspended('member', 'admin', activeMember), false);
  assert.equal(
    memberCanBeSuspended('sys_admin', 'admin', suspendedMember),
    false
  );

  assert.equal(memberCanBeResumed('sec_admin', 'admin', suspendedMember), true);
  assert.equal(
    memberCanBeResumed('sec_admin', 'admin', { ...suspendedMember, role: 'sec_admin' }),
    false
  );
  assert.equal(memberCanBeResumed('sys_admin', 'm-2', suspendedMember), true);
  assert.equal(memberCanBeResumed('sys_admin', 'admin', activeMember), false);
});

test('status/role labels and badges stay aligned with the API contract', () => {
  assert.deepEqual(ADMIN_MEMBER_STATUS_LABELS, {
    all: 'すべて',
    active: '有効',
    suspended: '停止中',
  });
  assert.deepEqual(ADMIN_MEMBER_ROLE_LABELS, {
    sys_admin: 'システム管理者',
    sec_admin: 'セキュリティ管理者',
    member: 'メンバー',
  });
  assert.match(memberStatusBadgeClass('active'), /emerald/);
  assert.match(memberStatusBadgeClass('suspended'), /red/);
  assert.match(memberRoleBadgeClass('sys_admin'), /indigo/);
  assert.match(memberRoleBadgeClass('sec_admin'), /cyan/);
  assert.equal(departmentLabel(null), '部署未設定');
  assert.equal(departmentLabel('Sales'), 'Sales');
});

test('query serialization, sorting and client-side filters round-trip', () => {
  const query = buildAdminMemberQuery({
    query: ' alpha ',
    role: 'sec_admin',
    status: 'suspended',
    department: ' Engineering ',
    sortBy: 'usedBytes',
    sortDir: 'desc',
    limit: 25,
    offset: 50,
    format: 'csv',
  });
  const params = new URLSearchParams(query);
  assert.equal(params.get('query'), 'alpha');
  assert.equal(params.get('role'), 'sec_admin');
  assert.equal(params.get('status'), 'suspended');
  assert.equal(params.get('department'), 'Engineering');
  assert.equal(params.get('sortBy'), 'usedBytes');
  assert.equal(params.get('sortDir'), 'desc');
  assert.equal(params.get('limit'), '25');
  assert.equal(params.get('offset'), '50');
  assert.equal(params.get('format'), 'csv');

  assert.equal(buildAdminMemberQuery({ role: 'all', status: 'all' }), '');
  assert.deepEqual(
    toggleAdminMemberSort(
      { sortBy: 'email', sortDir: 'asc' },
      'email'
    ),
    { sortBy: 'email', sortDir: 'desc' }
  );
  assert.deepEqual(
    toggleAdminMemberSort(
      { sortBy: 'email', sortDir: 'desc' },
      'usedBytes'
    ),
    { sortBy: 'usedBytes', sortDir: 'asc' }
  );
  assert.equal(ariaSortForMemberColumn('email', 'asc', 'email'), 'ascending');
  assert.equal(ariaSortForMemberColumn('email', 'asc', 'role'), undefined);

  const rows = [
    member({ id: 'a', email: 'a@example.com', department: 'Sales', usedBytes: 100 }),
    member({
      id: 'b',
      email: 'b@example.com',
      department: null,
      role: 'sec_admin',
      status: 'suspended',
      usedBytes: 900,
    }),
    member({ id: 'c', email: 'c@example.com', displayName: 'Charlie', department: 'Engineering', usedBytes: 500 }),
  ];
  assert.deepEqual(
    filterAdminMembers(rows, { query: 'charlie' }).map((row) => row.id),
    ['c']
  );
  assert.deepEqual(
    filterAdminMembers(rows, { role: 'sec_admin' }).map((row) => row.id),
    ['b']
  );
  assert.deepEqual(
    filterAdminMembers(rows, { status: 'suspended' }).map((row) => row.id),
    ['b']
  );
  assert.deepEqual(
    filterAdminMembers(rows, { department: 'Sales' }).map((row) => row.id),
    ['a']
  );

  assert.deepEqual(
    sortAdminMemberRows(rows, 'email', 'asc').map((row) => row.id),
    ['a', 'b', 'c']
  );
  assert.deepEqual(
    sortAdminMemberRows(rows, 'usedBytes', 'desc').map((row) => row.id),
    ['b', 'c', 'a']
  );
  // Null departments always sort last, even descending.
  assert.deepEqual(
    sortAdminMemberRows(rows, 'department', 'desc').map((row) => row.id),
    ['a', 'c', 'b']
  );
});

test('summary cards, byte formatting and quota parsing are deterministic', () => {
  const summary = aggregations();
  assert.deepEqual(
    memberStatusSummaryCards(summary).map((card) => [card.status, card.count]),
    [
      ['active', 4],
      ['suspended', 1],
    ]
  );
  assert.deepEqual(
    memberRoleSummaryCards(summary).map((card) => [card.role, card.count]),
    [
      ['sys_admin', 1],
      ['sec_admin', 1],
      ['member', 3],
    ]
  );

  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KiB');
  assert.equal(formatBytes(1024 * 1024), '1.00 MiB');
  assert.equal(formatBytes(10 * 1024 * 1024 * 1024), '10.0 GiB');
  assert.equal(formatBytes(-1), '—');

  assert.equal(
    formatMemberUsage({ usedBytes: 1024, storageQuotaBytes: 4096 }),
    '1.00 KiB / 4.00 KiB (25%)'
  );
  assert.equal(
    formatMemberUsage({ usedBytes: 1024, storageQuotaBytes: null }),
    '1.00 KiB / 上限なし'
  );
  assert.equal(memberQuotaState({ usedBytes: 90, storageQuotaBytes: 100 }), 'warning');
  assert.equal(memberQuotaState({ usedBytes: 100, storageQuotaBytes: 100 }), 'over');
  assert.equal(memberQuotaState({ usedBytes: 10, storageQuotaBytes: 100 }), 'ok');
  assert.equal(memberQuotaState({ usedBytes: 10, storageQuotaBytes: null }), 'unlimited');

  assert.deepEqual(parseMemberQuotaInput(''), { ok: true, value: null });
  assert.deepEqual(parseMemberQuotaInput('  '), { ok: true, value: null });
  assert.deepEqual(parseMemberQuotaInput('4096'), { ok: true, value: 4096 });
  assert.equal(parseMemberQuotaInput('0').ok, false);
  assert.equal(parseMemberQuotaInput('-1').ok, false);
  assert.equal(parseMemberQuotaInput('1.5').ok, false);
  assert.equal(parseMemberQuotaInput('abc').ok, false);
  assert.equal(parseMemberQuotaInput('9999999999999999').ok, false);
});

test('CSV sample, audit preset and idempotency keys are safe and stable', () => {
  const lines = ADMIN_MEMBER_CSV_SAMPLE.split('\n');
  assert.equal(lines[0], 'email,displayName,department,role,storageQuotaBytes');
  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /@example\.com/);
  assert.equal(parseAdminAuditPreset('user'), 'user');
  assert.equal(buildMemberAuditHref(), '/admin/reports?auditPreset=user');

  const key = createMemberIdempotencyKey('suspend', 'm-1');
  assert.match(key, /^admin-member-suspend-m-1-/);
  assert.notEqual(key, createMemberIdempotencyKey('suspend', 'm-1'));
  assert.match(createMemberIdempotencyKey('bulk-import'), /^admin-member-bulk-import-bulk-/);
});

test('bulk result helpers explain dryRun, replays and row codes', () => {
  const summary = {
    dryRun: true,
    createdCount: 1,
    updatedCount: 2,
    unchangedCount: 3,
    errorCount: 1,
  };
  assert.equal(
    formatBulkImportSummary(summary),
    'プレビュー: 作成 1 件 / 更新 2 件 / 変更なし 3 件 / エラー 1 件'
  );
  assert.match(
    formatBulkImportSummary({ ...summary, dryRun: false }),
    /^実行結果/
  );
  assert.equal(
    bulkRowLabel({
      rowNumber: 1,
      email: 'a@example.com',
      action: 'error',
      displayName: null,
      department: null,
      role: null,
      storageQuotaBytes: null,
      code: 'INVALID_EMAIL',
    }),
    'エラー (INVALID_EMAIL)'
  );
  assert.equal(
    bulkRowLabel({
      rowNumber: 1,
      email: 'a@example.com',
      action: 'create',
      displayName: 'A',
      department: null,
      role: 'member',
      storageQuotaBytes: null,
    }),
    '作成'
  );
});

test('admin member API client sends filters, mutations and idempotency headers', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const method = init?.method ?? 'GET';
    const body =
      method === 'GET'
        ? {
            users: [],
            total: 0,
            limit: 25,
            offset: 0,
            nextOffset: null,
            sort: { by: 'createdAt', dir: 'desc' },
            summary: aggregations({ total: 0 }),
            aggregations: aggregations({ total: 0 }),
          }
        : {
            ok: true,
            dryRun: false,
            replayed: false,
            createdCount: 0,
            updatedCount: 0,
            unchangedCount: 0,
            errorCount: 0,
            totalRows: 0,
            results: [],
            syncSeq: null,
            notice: 'ok',
            user: member(),
          };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await fetchAdminMembers({
      query: 'alpha',
      role: 'member',
      status: 'active',
      department: 'Engineering',
      sortBy: 'email',
      sortDir: 'asc',
    });
    assert.match(calls[0]!.url, /^\/api\/admin\/users\?/);
    const firstQuery = new URLSearchParams(calls[0]!.url.split('?')[1]);
    assert.equal(firstQuery.get('query'), 'alpha');
    assert.equal(firstQuery.get('role'), 'member');
    assert.equal(firstQuery.get('department'), 'Engineering');

    await fetchAdminMemberDetail('m/with space');
    assert.equal(calls[1]!.url, '/api/admin/users/m%2Fwith%20space');

    await createAdminMember({
      email: 'new@example.com',
      displayName: 'New',
      role: 'member',
      storageQuotaBytes: 1024,
    });
    assert.equal(calls[2]!.init?.method, 'POST');
    assert.equal(calls[2]!.url, '/api/admin/users');
    assert.equal(
      new Headers(calls[2]!.init?.headers).get('Content-Type'),
      'application/json'
    );

    await updateAdminMember('m-1', {
      department: 'Sales',
      storageQuotaBytes: null,
    });
    assert.equal(calls[3]!.init?.method, 'PATCH');
    assert.equal(calls[3]!.url, '/api/admin/users/m-1');
    assert.deepEqual(
      JSON.parse(String(calls[3]!.init?.body)),
      { department: 'Sales', storageQuotaBytes: null }
    );

    await suspendAdminMember('m-1', { idempotencyKey: 'key-s' });
    assert.equal(calls[4]!.init?.method, 'POST');
    assert.equal(calls[4]!.url, '/api/admin/users/m-1/suspend');
    assert.equal(
      new Headers(calls[4]!.init?.headers).get('Idempotency-Key'),
      'key-s'
    );

    await resumeAdminMember('m-1', { idempotencyKey: 'key-r' });
    assert.equal(calls[5]!.url, '/api/admin/users/m-1/resume');
    assert.equal(
      new Headers(calls[5]!.init?.headers).get('Idempotency-Key'),
      'key-r'
    );

    await bulkImportAdminMembers({
      csv: 'email,displayName\na@example.com,A',
      dryRun: true,
      idempotencyKey: 'key-b',
    });
    assert.equal(calls[6]!.init?.method, 'POST');
    assert.equal(calls[6]!.url, '/api/admin/users/bulk-import');
    assert.equal(
      new Headers(calls[6]!.init?.headers).get('Idempotency-Key'),
      'key-b'
    );
    assert.deepEqual(JSON.parse(String(calls[6]!.init?.body)), {
      csv: 'email,displayName\na@example.com,A',
      dryRun: true,
      idempotencyKey: 'key-b',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
