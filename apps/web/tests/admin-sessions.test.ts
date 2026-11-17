import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_SESSION_USER_TYPE_LABELS,
  adminSessionRevocationMessage,
  adminSessionTargetGuardReason,
  buildAdminSessionQuery,
  canRevokeAdminSession,
  canRevokeAllAdminSessions,
  canViewAdminSessions,
  isAdminSessionRevocationKind,
  shortAdminSessionId,
  validateAdminSessionReasonInput,
} from '@/lib/admin-sessions';
import {
  formatAuditActionLabel,
  isSessionAuditAction,
  SESSION_AUDIT_ACTION_PREFIXES,
} from '@/lib/admin-audit';
import { handleRealtimeSignal, type RealtimeContext } from '@/lib/sync-store/realtime';
import { normalizeSecurityRevocationEvent } from '@/lib/sync-ws';
import type { AuthUser, SyncInvalidationSignal } from '@/types/files';

function signal(
  overrides: Partial<SyncInvalidationSignal> = {}
): SyncInvalidationSignal {
  return {
    type: 'sync.security_revoke',
    seq: null,
    scopeFolderIds: [],
    eventKind: 'session.revoked',
    revoked: true,
    timestamp: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'u1',
    tenantId: 't1',
    email: 'member@example.com',
    displayName: 'Member',
    role: 'member',
    ipAddress: '127.0.0.1',
    userType: 'member',
    ...overrides,
  };
}

function makeContext(overrides: Partial<RealtimeContext> = {}): {
  ctx: RealtimeContext;
  purgeCalls: string[];
  reported: string[];
  revocations: string[];
  deltaCalls: string[];
} {
  const purgeCalls: string[] = [];
  const reported: string[] = [];
  const revocations: string[] = [];
  const deltaCalls: string[] = [];
  const securityListeners = new Set<
    (event: { kind: string }) => void
  >();
  securityListeners.add((event) => revocations.push(event.kind));

  const ctx = {
    authStatus: 'authenticated',
    user: makeUser(),
    realtimeClient: null,
    realtimeState: 'connected',
    emit: () => undefined,
    setRealtimeClient: () => undefined,
    setRealtimeState: () => undefined,
    realtimeSignalListeners: new Set(),
    securityRevocationListeners: securityListeners,
    reportSessionRevocation: (event: { kind: string }) => {
      reported.push(event.kind);
    },
    directoriesByKey: new Map(),
    foldersById: new Map(),
    activeDirKey: '__ROOT__',
    syncSeq: 1,
    syncDelta: async () => {
      deltaCalls.push('delta');
    },
    purgeCurrentScope: async () => {
      purgeCalls.push('purge');
    },
    invalidateAllCachedDirectories: () => undefined,
    ...overrides,
  } as unknown as RealtimeContext;

  return { ctx, purgeCalls, reported, revocations, deltaCalls };
}

test('session RBAC separates viewing, revocation and tenant-wide emergency stop', () => {
  assert.equal(canViewAdminSessions('sys_admin'), true);
  assert.equal(canViewAdminSessions('sec_admin'), true);
  assert.equal(canViewAdminSessions('member'), false);
  assert.equal(canViewAdminSessions(null), false);

  assert.equal(canRevokeAllAdminSessions('sys_admin'), true);
  assert.equal(canRevokeAllAdminSessions('sec_admin'), false);
  assert.equal(canRevokeAllAdminSessions('member'), false);

  assert.equal(canRevokeAdminSession('sys_admin', 'sys_admin'), true);
  assert.equal(canRevokeAdminSession('sys_admin', 'sec_admin'), true);
  assert.equal(canRevokeAdminSession('sec_admin', 'member'), true);
  assert.equal(canRevokeAdminSession('sec_admin', 'sys_admin'), false);
  assert.equal(canRevokeAdminSession('member', 'member'), false);
});

test('sec_admin sees an explicit protection reason for sys_admin targets', () => {
  assert.match(
    adminSessionTargetGuardReason('sec_admin', 'sys_admin') ?? '',
    /システム管理者/
  );
  assert.equal(adminSessionTargetGuardReason('sys_admin', 'sys_admin'), null);
  assert.equal(adminSessionTargetGuardReason('sec_admin', 'member'), null);
});

test('session labels, reason validation and audit labels are admin-console ready', () => {
  assert.equal(ADMIN_SESSION_USER_TYPE_LABELS.member, '社内メンバー');
  assert.equal(ADMIN_SESSION_USER_TYPE_LABELS.guest, '外部ゲスト');
  assert.deepEqual(validateAdminSessionReasonInput('  '), {
    ok: true,
    reason: null,
  });
  assert.deepEqual(validateAdminSessionReasonInput(' 端末紛失 '), {
    ok: true,
    reason: '端末紛失',
  });
  assert.equal(
    validateAdminSessionReasonInput('x'.repeat(301)).ok,
    false
  );
  assert.equal(shortAdminSessionId('1234567890'), '12345678');

  assert.equal(
    formatAuditActionLabel('admin.session.revoke'),
    'セッション強制失効'
  );
  assert.equal(
    formatAuditActionLabel('admin.session.revoke_user'),
    'ユーザー全セッション強制失効'
  );
  assert.equal(
    formatAuditActionLabel('admin.session.revoke_all'),
    'テナント全セッション緊急失効'
  );
  assert.equal(isSessionAuditAction('admin.session.revoke_all'), true);
  assert.equal(isSessionAuditAction('admin.user.suspend'), false);
  assert.deepEqual(SESSION_AUDIT_ACTION_PREFIXES, ['admin.session.']);
});

test('member session query string carries the user scope and keyset cursor', () => {
  assert.equal(buildAdminSessionQuery({}), '');
  assert.equal(
    buildAdminSessionQuery({
      userId: 'u 1',
      userType: 'guest',
      ip: ' 203.0.113.9 ',
      q: ' laptop ',
      limit: 25,
      cursor: 'abc',
    }),
    '?userId=u+1&userType=guest&ip=203.0.113.9&q=laptop&limit=25&cursor=abc'
  );
  assert.equal(
    buildAdminSessionQuery({ userType: 'all', q: '   ' }),
    ''
  );
});

test('sync signals normalize session.revoked / tenant.sessions_revoked distinctly', () => {
  const single = normalizeSecurityRevocationEvent(signal());
  assert.equal(single?.kind, 'session.revoked');

  const all = normalizeSecurityRevocationEvent(
    signal({ eventKind: 'tenant.sessions_revoked' })
  );
  assert.equal(all?.kind, 'tenant.sessions_revoked');

  const suspended = normalizeSecurityRevocationEvent(
    signal({ eventKind: 'user.suspended' })
  );
  assert.equal(suspended?.kind, 'user.suspended');

  assert.equal(isAdminSessionRevocationKind('session.revoked'), true);
  assert.equal(isAdminSessionRevocationKind('tenant.sessions_revoked'), true);
  assert.equal(isAdminSessionRevocationKind('user.suspended'), false);

  assert.match(
    adminSessionRevocationMessage('session.revoked'),
    /このセッション/
  );
  assert.match(
    adminSessionRevocationMessage('tenant.sessions_revoked'),
    /テナント内の全セッション/
  );
});

test('session revocations purge the current scope without fetching deltas', async () => {
  for (const eventKind of ['session.revoked', 'tenant.sessions_revoked'] as const) {
    const { ctx, purgeCalls, reported, revocations, deltaCalls } =
      makeContext();
    await handleRealtimeSignal(signal({ eventKind }), ctx);
    assert.deepEqual(purgeCalls, ['purge']);
    assert.deepEqual(reported, [eventKind]);
    assert.deepEqual(revocations, [eventKind]);
    assert.equal(deltaCalls.length, 0);
  }
});

test('permission revocation still syncs deltas instead of purging the session', async () => {
  const { ctx, purgeCalls, revocations, deltaCalls } = makeContext();
  await handleRealtimeSignal(
    signal({
      type: 'sync.invalidate',
      seq: 2,
      scopeFolderIds: ['f1'],
      eventKind: 'permission.revoke',
    }),
    ctx
  );
  assert.equal(purgeCalls.length, 0);
  assert.deepEqual(revocations, ['permission.revoke']);
  assert.deepEqual(deltaCalls, ['delta']);
});
