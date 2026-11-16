import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ariaSortForGuestColumn,
  buildAdminGuestQuery,
  buildGuestDetailExportHref,
  canManageGuestDomainPolicy,
  canManageGuestLifecycle,
  canSuspendGuest,
  canViewAdminGuests,
  createGuestIdempotencyKey,
  filterAdminGuests,
  formatGuestDomainSummary,
  formatGuestInviterSummary,
  guestLifecyclePermissionNotice,
  guestStatusLabel,
  guestStatusSummaryCards,
  sortAdminGuestRows,
  toggleAdminGuestSort,
} from '@/lib/admin-guests';
import {
  DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE,
  externalDomainExistingGuestModeLabel,
  findWildcardDomainInputs,
  guestDomainValidationMessage,
  normalizeExternalDomainExistingGuestMode,
  readExternalDomainExistingGuestMode,
  WILDCARD_DOMAIN_ERROR_MESSAGE,
} from '@/lib/guest-policy';
import {
  fetchAdminGuestDetail,
  fetchAdminGuests,
  offboardAdminGuest,
  resendAdminGuestInvite,
  resumeAdminGuest,
  suspendAdminGuest,
} from '@/lib/files-api';
import type {
  AdminGuestAggregations,
  AdminGuestRow,
  TenantPolicyRow,
} from '@/types/files';

function guest(overrides: Partial<AdminGuestRow>): AdminGuestRow {
  return {
    id: 'guest-1',
    email: 'guest@partner.example',
    displayName: 'Guest',
    externalOrg: 'Partner',
    invitedBy: 'admin-1',
    invitedByName: 'Admin One',
    invitedByEmail: 'admin@example.com',
    expiresAt: '2026-12-30T00:00:00.000Z',
    lastLoginAt: '2026-11-01T00:00:00.000Z',
    accountStatus: 'active',
    status: 'active',
    offboardedAt: null,
    offboardedBy: null,
    domain: 'partner.example',
    allowedByPolicy: true,
    pendingInvitationCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function aggregations(
  overrides: Partial<AdminGuestAggregations> = {}
): AdminGuestAggregations {
  return {
    total: 4,
    byStatus: {
      all: 4,
      active: 1,
      suspended: 1,
      expired: 1,
      pending_invite: 1,
      offboarded: 0,
    },
    byDomain: [
      { domain: 'partner.example', count: 2, active: 1, suspended: 1, expired: 0, allowedByPolicy: true },
      { domain: 'removed.example', count: 2, active: 0, suspended: 0, expired: 2, allowedByPolicy: false },
    ],
    byInviter: [
      { inviterId: 'b', inviterName: 'Bravo', inviterEmail: 'b@example.com', count: 1, active: 1, suspended: 0, expired: 0 },
      { inviterId: 'a', inviterName: 'Alpha', inviterEmail: null, count: 3, active: 0, suspended: 1, expired: 2 },
    ],
    disallowedDomainGuestCount: 2,
    ...overrides,
  };
}

test('wildcard domains are rejected with an actionable Japanese message', () => {
  assert.deepEqual(findWildcardDomainInputs(['*.example.com', 'ok.example', '*']), [
    '*.example.com',
    '*',
  ]);
  assert.equal(
    guestDomainValidationMessage(['*.example.com']),
    WILDCARD_DOMAIN_ERROR_MESSAGE
  );
  assert.match(WILDCARD_DOMAIN_ERROR_MESSAGE, /ワイルドカード.*完全一致/);
  assert.match(
    guestDomainValidationMessage(['not a domain']) ?? '',
    /有効なドメイン/
  );
  assert.equal(guestDomainValidationMessage(['Partner.Example']), null);
});

test('existing guest mode conversion defaults safely and labels both modes', () => {
  assert.equal(
    normalizeExternalDomainExistingGuestMode('suspend_existing'),
    'suspend_existing'
  );
  assert.equal(
    normalizeExternalDomainExistingGuestMode('something-else'),
    DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE
  );
  const camel = {
    externalDomainExistingGuestMode: 'suspend_existing',
  } as TenantPolicyRow;
  const snake = {
    external_domain_existing_guest_mode: 'reject_new_only',
  } as TenantPolicyRow;
  assert.equal(readExternalDomainExistingGuestMode(camel), 'suspend_existing');
  assert.equal(readExternalDomainExistingGuestMode(snake), 'reject_new_only');
  assert.match(
    externalDomainExistingGuestModeLabel('suspend_existing'),
    /即時停止/
  );
  assert.match(
    externalDomainExistingGuestModeLabel('reject_new_only'),
    /新規招待/
  );
});

test('RBAC helpers allow sec_admin to view/audit/suspend only', () => {
  assert.equal(canViewAdminGuests('sys_admin'), true);
  assert.equal(canViewAdminGuests('sec_admin'), true);
  assert.equal(canViewAdminGuests('member'), false);
  assert.equal(canSuspendGuest('sec_admin'), true);
  assert.equal(canManageGuestLifecycle('sec_admin'), false);
  assert.equal(canManageGuestLifecycle('sys_admin'), true);
  assert.equal(canManageGuestDomainPolicy('sec_admin'), false);
  assert.equal(canManageGuestDomainPolicy('sys_admin'), true);
  assert.match(guestLifecyclePermissionNotice('sec_admin'), /停止のみ/);
  assert.match(guestLifecyclePermissionNotice('sys_admin'), /すべて実行/);
});

test('list query serialization maps filters, sorting, paging and date input', () => {
  const qs = buildAdminGuestQuery({
    query: ' partner ',
    status: 'suspended',
    domain: 'Partner.Example',
    invitedBy: 'admin@example.com',
    expiresBefore: '2026-12-01',
    sortBy: 'expiresAt',
    sortDir: 'asc',
    limit: 25,
    offset: 50,
  });
  const params = new URLSearchParams(qs);
  assert.equal(params.get('query'), 'partner');
  assert.equal(params.get('status'), 'suspended');
  assert.equal(params.get('domain'), 'partner.example');
  assert.equal(params.get('invitedBy'), 'admin@example.com');
  assert.equal(params.get('expiresBefore'), '2026-12-01T23:59:59.999Z');
  assert.equal(params.get('sortBy'), 'expiresAt');
  assert.equal(params.get('sortDir'), 'asc');
  assert.equal(params.get('limit'), '25');
  assert.equal(params.get('offset'), '50');

  assert.equal(buildAdminGuestQuery({ status: 'all' }), '');
  assert.match(buildAdminGuestQuery({ format: 'csv' }), /format=csv/);
});

test('sort toggling and aria-sort only expose the active column', () => {
  assert.deepEqual(
    toggleAdminGuestSort({ sortBy: 'createdAt', sortDir: 'desc' }, 'email'),
    { sortBy: 'email', sortDir: 'asc' }
  );
  assert.deepEqual(
    toggleAdminGuestSort({ sortBy: 'email', sortDir: 'asc' }, 'email'),
    { sortBy: 'email', sortDir: 'desc' }
  );
  assert.equal(ariaSortForGuestColumn('email', 'asc', 'email'), 'ascending');
  assert.equal(ariaSortForGuestColumn('email', 'asc', 'expiresAt'), undefined);
});

test('filter and sort helpers match admin list semantics', () => {
  const rows = [
    guest({ id: 'a', email: 'a@other.example', domain: 'other.example', status: 'expired', expiresAt: '2026-11-01T00:00:00.000Z', invitedByEmail: 'owner@x.example' }),
    guest({ id: 'b', email: 'b@partner.example', status: 'suspended', lastLoginAt: null }),
    guest({ id: 'c', email: 'c@partner.example', status: 'pending_invite', displayName: 'Charlie', externalOrg: 'Charlie Org', lastLoginAt: '2026-11-02T00:00:00.000Z' }),
  ];

  assert.deepEqual(
    filterAdminGuests(rows, { query: 'charlie' }).map((row) => row.id),
    ['c']
  );
  assert.deepEqual(
    filterAdminGuests(rows, { status: 'suspended' }).map((row) => row.id),
    ['b']
  );
  assert.deepEqual(
    filterAdminGuests(rows, { domain: 'other.example' }).map((row) => row.id),
    ['a']
  );
  assert.deepEqual(
    filterAdminGuests(rows, { invitedBy: 'owner@x.example' }).map((row) => row.id),
    ['a']
  );
  assert.deepEqual(
    filterAdminGuests(rows, { expiresBefore: '2026-11-15' }).map((row) => row.id),
    ['a']
  );

  assert.deepEqual(
    sortAdminGuestRows(rows, 'email', 'asc').map((row) => row.id),
    ['a', 'b', 'c']
  );
  // Null values always sort last, even for descending order.
  assert.deepEqual(
    sortAdminGuestRows(rows, 'lastLoginAt', 'desc').map((row) => row.id),
    ['c', 'a', 'b']
  );
});

test('summary shapers produce status cards, domain warnings and inviter rows', () => {
  const summary = aggregations();
  assert.deepEqual(
    guestStatusSummaryCards(summary).map((card) => [card.status, card.count]),
    [
      ['active', 1],
      ['pending_invite', 1],
      ['expired', 1],
      ['suspended', 1],
      ['offboarded', 0],
    ]
  );
  assert.equal(guestStatusLabel('offboarded'), 'オフボーディング済み');

  const domains = formatGuestDomainSummary(summary.byDomain);
  assert.equal(domains[0].domain, 'removed.example');
  assert.equal(domains[0].allowedByPolicy, false);
  assert.match(domains[0].warning ?? '', /許可リスト外/);
  assert.equal(domains[1].allowedByPolicy, true);

  const inviters = formatGuestInviterSummary(summary.byInviter);
  assert.equal(inviters[0].inviterId, 'a');
  assert.equal(inviters[0].displayName, 'Alpha');
  assert.equal(inviters[1].displayName, 'Bravo (b@example.com)');
});

test('export hrefs and idempotency keys are deterministic and safe', () => {
  assert.equal(
    buildGuestDetailExportHref('guest/with space', 'csv'),
    '/api/admin/guests/guest%2Fwith%20space?format=csv&export=permissions'
  );
  assert.equal(
    buildGuestDetailExportHref('guest-1', 'json'),
    '/api/admin/guests/guest-1?download=1'
  );
  const key = createGuestIdempotencyKey('suspend', 'guest-1');
  assert.match(key, /^admin-guest-suspend-guest-1-/);
  assert.notEqual(key, createGuestIdempotencyKey('suspend', 'guest-1'));
});

test('admin guest API client sends lifecycle requests with idempotency headers', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const method = init?.method ?? 'GET';
    const body =
      method === 'GET'
        ? {
            guests: [],
            total: 0,
            limit: 25,
            offset: 0,
            nextOffset: null,
            sort: { by: 'createdAt', dir: 'desc' },
            summary: aggregations({ total: 0 }),
            aggregations: aggregations({ total: 0 }),
          }
        : { ok: true, guest: { id: 'guest-1', status: 'suspended', offboardedAt: null } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await fetchAdminGuests({
      query: 'guest',
      status: 'active',
      sortBy: 'email',
      sortDir: 'asc',
    });
    assert.match(calls[0].url, /\/api\/admin\/guests\?/);
    assert.match(calls[0].url, /query=guest/);
    assert.match(calls[0].url, /status=active/);
    assert.match(calls[0].url, /sortBy=email/);

    await fetchAdminGuestDetail('guest-1');
    assert.equal(calls[1].url, '/api/admin/guests/guest-1');

    await suspendAdminGuest('guest-1', { idempotencyKey: 'key-s' });
    assert.equal(calls[2].init?.method, 'POST');
    assert.equal(calls[2].url, '/api/admin/guests/guest-1/suspend');
    assert.equal(
      new Headers(calls[2].init?.headers).get('Idempotency-Key'),
      'key-s'
    );

    await resumeAdminGuest('guest-1', {
      idempotencyKey: 'key-r',
      extendDays: 30,
    });
    assert.equal(calls[3].url, '/api/admin/guests/guest-1/resume');
    assert.deepEqual(JSON.parse(String(calls[3].init?.body)), {
      idempotencyKey: 'key-r',
      extendDays: 30,
    });

    await resendAdminGuestInvite('guest-1', {
      idempotencyKey: 'key-i',
      invitationId: 'inv-1',
    });
    assert.equal(calls[4].url, '/api/admin/guests/guest-1/resend-invite');
    assert.equal(
      new Headers(calls[4].init?.headers).get('Idempotency-Key'),
      'key-i'
    );

    await offboardAdminGuest('guest-1', { idempotencyKey: 'key-o' });
    assert.equal(calls[5].url, '/api/admin/guests/guest-1');
    assert.equal(calls[5].init?.method, 'DELETE');
    assert.equal(
      new Headers(calls[5].init?.headers).get('Idempotency-Key'),
      'key-o'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
