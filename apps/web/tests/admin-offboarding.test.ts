import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OFFBOARDING_CONFIRMATION_TEXT,
  canExecuteMemberOffboarding,
  canOpenMemberOffboarding,
  canViewMemberOffboarding,
  createOffboardingIdempotencyKey,
  filterOffboardingTransferCandidates,
  formatOffboardingResultSummary,
  matchesOffboardingConfirmation,
  memberCanBeOffboarded,
  memberCanOpenOffboarding,
  memberOffboardingGuardReason,
  memberOffboardingOpenGuardReason,
  offboardingRequiresTransfer,
  summarizeOffboardingActions,
} from '@/lib/admin-offboarding';
import {
  fetchAdminMemberOffboardingPreview,
  offboardAdminMember,
} from '@/lib/files-api';
import type {
  AdminOffboardingPreviewResponse,
  AdminOffboardingResponse,
  AdminOffboardingTransferCandidate,
} from '@/types/files';

function candidate(
  overrides: Partial<AdminOffboardingTransferCandidate> = {}
): AdminOffboardingTransferCandidate {
  return {
    id: 'u-1',
    email: 'alpha@example.com',
    displayName: 'Alpha Member',
    role: 'member',
    ...overrides,
  };
}

function preview(
  overrides: Partial<AdminOffboardingPreviewResponse> = {}
): AdminOffboardingPreviewResponse {
  return {
    user: {
      id: 'leaver',
      email: 'leaver@example.com',
      displayName: 'Leaver',
      role: 'member',
      status: 'active',
      userType: 'member',
      offboardedAt: null,
    },
    ownedFolders: [],
    ownedFolderCount: 0,
    soleOwnerCount: 0,
    directPermissions: {
      total: 0,
      folder: 0,
      file: 0,
      folderCount: 0,
      fileCount: 0,
    },
    activeSharedLinks: [],
    activeFileRequests: [],
    heldLocks: [],
    activeSessionCount: 0,
    activeWopiSessionCount: 0,
    groupMembershipCount: 0,
    transferCandidates: [],
    generatedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

function offboardingResult(
  overrides: Partial<AdminOffboardingResponse['summary']> = {}
): AdminOffboardingResponse {
  return {
    ok: true,
    replayed: false,
    user: {
      id: 'leaver',
      email: 'leaver@example.com',
      displayName: 'Leaver',
      department: null,
      role: 'member',
      status: 'suspended',
      storageQuotaBytes: null,
      usedBytes: 0,
      fileCount: 0,
      lastLoginAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    },
    transferTarget: candidate({ id: 'successor', email: 'successor@example.com' }),
    options: {
      sharedLinksAction: 'transfer_owner',
      fileRequestsAction: 'transfer_owner',
      userAction: 'suspend',
      revokeDirectPermissions: true,
      removeGroupMemberships: true,
      releaseHeldLocks: true,
    },
    summary: {
      ownedFolderCount: 3,
      transferredFolderCount: 3,
      soleOwnerFolderCount: 1,
      directPermissionsRevoked: 5,
      groupMembershipsRemoved: 2,
      sharedLinksTransferred: 2,
      sharedLinksRevoked: 0,
      fileRequestsTransferred: 2,
      fileRequestsDeactivated: 0,
      sessionsRevoked: 2,
      wopiSessionsRevoked: 2,
      locksReleased: 1,
      statusChanged: true,
      ...overrides,
    },
    syncSeq: 42,
    notice: 'done',
  };
}

test('offboarding RBAC allows preview for admins and execution only for sys_admin', () => {
  assert.equal(canViewMemberOffboarding('sys_admin'), true);
  assert.equal(canViewMemberOffboarding('sec_admin'), true);
  assert.equal(canViewMemberOffboarding('member'), false);
  assert.equal(canViewMemberOffboarding(null), false);

  assert.equal(canOpenMemberOffboarding('sys_admin'), true);
  assert.equal(canOpenMemberOffboarding('sec_admin'), true);
  assert.equal(canOpenMemberOffboarding('member'), false);

  assert.equal(canExecuteMemberOffboarding('sys_admin'), true);
  assert.equal(canExecuteMemberOffboarding('sec_admin'), false);
  assert.equal(canExecuteMemberOffboarding('member'), false);
});

test('offboarding guard blocks self and the last active sys_admin', () => {
  const member = { id: 'm-1', role: 'member' as const, status: 'active' as const };
  assert.equal(
    memberOffboardingGuardReason({
      viewerRole: 'sys_admin',
      viewerId: 'admin',
      member,
      activeSysAdminCount: 2,
    }),
    null
  );
  assert.equal(
    memberCanBeOffboarded({
      viewerRole: 'sys_admin',
      viewerId: 'admin',
      member,
      activeSysAdminCount: 2,
    }),
    true
  );
  assert.match(
    memberOffboardingGuardReason({
      viewerRole: 'sys_admin',
      viewerId: 'm-1',
      member,
      activeSysAdminCount: 2,
    })!,
    /自分自身/
  );
  assert.match(
    memberOffboardingGuardReason({
      viewerRole: 'sec_admin',
      viewerId: 'sec',
      member,
      activeSysAdminCount: 2,
    })!,
    /sys_admin 専用/
  );
  assert.match(
    memberOffboardingGuardReason({
      viewerRole: 'sys_admin',
      viewerId: 'admin',
      member: { id: 's-1', role: 'sys_admin', status: 'active' },
      activeSysAdminCount: 1,
    })!,
    /最後の有効な sys_admin/
  );
  assert.equal(
    memberCanBeOffboarded({
      viewerRole: 'sys_admin',
      viewerId: 'admin',
      member: { id: 's-2', role: 'sys_admin', status: 'suspended' },
      activeSysAdminCount: 1,
    }),
    true
  );

  // sec_admin can inspect the preview but cannot execute.
  const secTarget = { id: 'm-2', role: 'member' as const, status: 'active' as const };
  assert.equal(
    memberCanOpenOffboarding({
      viewerRole: 'sec_admin',
      viewerId: 'sec',
      member: secTarget,
      activeSysAdminCount: 2,
    }),
    true
  );
  assert.equal(
    memberOffboardingOpenGuardReason({
      viewerRole: 'member',
      viewerId: 'member',
      member: secTarget,
      activeSysAdminCount: 2,
    }),
    '退職/移管の表示は管理者専用です。'
  );
  assert.equal(
    memberCanBeOffboarded({
      viewerRole: 'sec_admin',
      viewerId: 'sec',
      member: secTarget,
      activeSysAdminCount: 2,
    }),
    false
  );
});

test('transfer candidate filtering matches email, display name and id', () => {
  const candidates = [
    candidate(),
    candidate({ id: 'u-2', email: 'bravo@example.com', displayName: 'Bravo' }),
    candidate({ id: 'u-3', email: 'charlie@example.com', displayName: 'Charlie' }),
  ];
  assert.deepEqual(
    filterOffboardingTransferCandidates(candidates, 'BRAVO').map((item) => item.id),
    ['u-2']
  );
  assert.deepEqual(
    filterOffboardingTransferCandidates(candidates, 'charlie@').map((item) => item.id),
    ['u-3']
  );
  assert.deepEqual(
    filterOffboardingTransferCandidates(candidates, 'u-1').map((item) => item.id),
    ['u-1']
  );
  assert.equal(filterOffboardingTransferCandidates(candidates, '   ').length, 3);
  assert.equal(filterOffboardingTransferCandidates(candidates, 'nobody').length, 0);
});

test('confirmation and transfer requirement follow the wizard rules', () => {
  assert.equal(OFFBOARDING_CONFIRMATION_TEXT, 'OFFBOARD');
  assert.equal(matchesOffboardingConfirmation('OFFBOARD', 'a@example.com'), true);
  assert.equal(
    matchesOffboardingConfirmation('  A@Example.com ', 'a@example.com'),
    true
  );
  assert.equal(matchesOffboardingConfirmation('offboard', 'a@example.com'), false);
  assert.equal(matchesOffboardingConfirmation('DELETE', 'a@example.com'), false);

  assert.equal(
    offboardingRequiresTransfer({
      ownedFolderCount: 1,
      sharedLinksAction: 'revoke_all',
      fileRequestsAction: 'deactivate_all',
    }),
    true
  );
  assert.equal(
    offboardingRequiresTransfer({
      ownedFolderCount: 0,
      sharedLinksAction: 'transfer_owner',
      fileRequestsAction: 'deactivate_all',
    }),
    true
  );
  assert.equal(
    offboardingRequiresTransfer({
      ownedFolderCount: 0,
      sharedLinksAction: 'revoke_all',
      fileRequestsAction: 'deactivate_all',
    }),
    false
  );
});

test('action and result summaries expose the transfer counts', () => {
  assert.equal(
    summarizeOffboardingActions({
      sharedLinksAction: 'transfer_owner',
      fileRequestsAction: 'deactivate_all',
      userAction: 'suspend',
    }),
    '共有リンク: 後任メンバーへ移管 / ファイルリクエスト: すべて一括停止 / アカウント: アカウントを停止'
  );

  const summary = formatOffboardingResultSummary({
    summary: offboardingResult().summary,
  });
  assert.match(summary, /フォルダ 3 件移管/);
  assert.match(summary, /直接権限 5 件剥奪/);
  assert.match(summary, /共有リンク 移管 2 件 \/ 失効 0 件/);
  assert.match(summary, /ファイルリクエスト 移管 2 件 \/ 停止 0 件/);
  assert.match(summary, /セッション 2 件失効/);
  assert.match(summary, /ロック 1 件解放/);

  const key = createOffboardingIdempotencyKey('member-1');
  assert.match(key, /^admin-member-offboard-member-1-/);
});

test('offboarding API client sends preview GET and idempotent POST', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{
    url: string;
    init: RequestInit | undefined;
  }> = [];

  const previewBody = preview({
    ownedFolderCount: 1,
    soleOwnerCount: 1,
    directPermissions: {
      total: 2,
      folder: 1,
      file: 1,
      folderCount: 1,
      fileCount: 1,
    },
  });
  const resultBody = offboardingResult();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (url.endsWith('/offboarding-preview')) {
      return new Response(JSON.stringify(previewBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(resultBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const previewResponse = await fetchAdminMemberOffboardingPreview('user-1');
    assert.equal(previewResponse.soleOwnerCount, 1);
    assert.equal(calls[0]?.url, '/api/admin/users/user-1/offboarding-preview');
    assert.equal(calls[0]?.init?.method, undefined);

    const response = await offboardAdminMember(
      'user-1',
      {
        transferToUserId: 'successor',
        sharedLinksAction: 'transfer_owner',
        fileRequestsAction: 'deactivate_all',
        userAction: 'suspend',
        revokeDirectPermissions: true,
        removeGroupMemberships: true,
        releaseHeldLocks: false,
        confirmation: 'OFFBOARD',
      },
      { idempotencyKey: 'idem-1' }
    );
    assert.equal(response.summary.transferredFolderCount, 3);
    const post = calls[1]!;
    assert.equal(post.url, '/api/admin/users/user-1/offboard');
    assert.equal(post.init?.method, 'POST');
    const headers = new Headers(post.init?.headers);
    assert.equal(headers.get('Idempotency-Key'), 'idem-1');
    assert.deepEqual(JSON.parse(String(post.init?.body)), {
      transferToUserId: 'successor',
      sharedLinksAction: 'transfer_owner',
      fileRequestsAction: 'deactivate_all',
      userAction: 'suspend',
      revokeDirectPermissions: true,
      removeGroupMemberships: true,
      releaseHeldLocks: false,
      confirmation: 'OFFBOARD',
      idempotencyKey: 'idem-1',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
