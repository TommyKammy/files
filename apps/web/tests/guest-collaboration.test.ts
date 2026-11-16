import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClientError, fetchGuestSummary, searchPrincipals } from '@/lib/files-api';
import {
  GUEST_POLICY_DISABLED_NOTICE,
  GUEST_SHARED_LINK_NOTE,
  buildGuestMailPreviewDraft,
  buildGuestWorkspaceBanner,
  formatGuestMailPreview,
  formatGuestSummary,
  guestAssignableRoleOptions,
  guestDomainGuidance,
  guestInvitationStatusLabel,
  guestRoleOptions,
  guestSessionIssueFromCode,
  guestSessionIssueFromError,
  isGuestInvitationExpired,
  isGuestSessionIssueCode,
} from '@/lib/guest-collaboration';
import type { GuestSummaryResponse } from '@/types/files';

test('guest roles never allow owner/co-owner and gate editor + folder-only roles', () => {
  const defaults = guestRoleOptions({
    targetType: 'folder',
    advancedRolesEnabled: false,
    allowGuestElevatedRoles: false,
  });
  const byRole = new Map(defaults.map((option) => [option.role, option]));
  assert.equal(byRole.get('owner')?.enabled, false);
  assert.equal(byRole.get('co_owner')?.enabled, false);
  assert.equal(byRole.get('editor')?.enabled, false);
  assert.match(byRole.get('editor')?.reason ?? '', /既定/);
  assert.equal(byRole.get('viewer')?.enabled, true);
  assert.equal(byRole.get('previewer')?.enabled, true);
  assert.equal(byRole.get('uploader')?.enabled, false);
  assert.match(byRole.get('uploader')?.reason ?? '', /無効/);

  const elevatedFolder = guestRoleOptions({
    targetType: 'folder',
    advancedRolesEnabled: true,
    allowGuestElevatedRoles: true,
  });
  assert.deepEqual(
    guestAssignableRoleOptions({
      targetType: 'folder',
      advancedRolesEnabled: true,
      allowGuestElevatedRoles: true,
    }).map((option) => option.role),
    [
      'editor',
      'viewer_uploader',
      'previewer_uploader',
      'viewer',
      'previewer',
      'uploader',
    ]
  );
  assert.equal(
    elevatedFolder.find((option) => option.role === 'owner')?.enabled,
    false
  );

  const fileTarget = guestRoleOptions({
    targetType: 'file',
    advancedRolesEnabled: true,
    allowGuestElevatedRoles: true,
  });
  for (const role of ['uploader', 'viewer_uploader', 'previewer_uploader'] as const) {
    const option = fileTarget.find((candidate) => candidate.role === role);
    assert.equal(option?.enabled, false);
    assert.match(option?.reason ?? '', /フォルダ専用/);
  }

  const callerCapped = guestRoleOptions({
    targetType: 'folder',
    advancedRolesEnabled: true,
    allowGuestElevatedRoles: true,
    grantableRoles: ['viewer', 'previewer'],
  });
  assert.equal(
    callerCapped.find((option) => option.role === 'editor')?.enabled,
    false
  );
  assert.match(
    callerCapped.find((option) => option.role === 'editor')?.reason ?? '',
    /権限範囲/
  );
});

test('guest mail preview is redacted and never carries an invitation token', () => {
  const draft = buildGuestMailPreviewDraft({
    displayName: ' 山田 太郎 ',
    externalOrg: 'Partner Inc.',
    targetType: 'folder',
    targetName: '共同プロジェクト',
    role: 'viewer_uploader',
    expiresAt: '2026-12-01T00:00:00.000Z',
    invitedByName: 'Dev Admin',
  });
  assert.match(draft.subject, /外部ゲストコラボレーターの招待/);
  assert.match(draft.bodyPreview, /山田 太郎/);
  assert.match(draft.bodyPreview, /共同プロジェクト/);
  assert.match(draft.bodyPreview, /Partner Inc\./);
  assert.match(draft.bodyPreview, /Dev Admin/);
  assert.doesNotMatch(draft.bodyPreview, /token=/);
  assert.doesNotMatch(draft.bodyPreview, /https?:\/\//);

  const formatted = formatGuestMailPreview({
    subject: 'invite',
    bodyPreview: [
      'こんにちは',
      'https://files.example.com/guest/accept?token=super-secret-token',
      'token=another-token&x=1',
      '認証コード: 123456',
      'コード 654321',
    ].join('\n'),
  });
  assert.equal(formatted.subject, 'invite');
  assert.equal(formatted.redacted, true);
  assert.doesNotMatch(formatted.bodyPreview, /super-secret-token/);
  assert.doesNotMatch(formatted.bodyPreview, /another-token/);
  assert.doesNotMatch(formatted.bodyPreview, /123456/);
  assert.doesNotMatch(formatted.bodyPreview, /654321/);
  assert.match(formatted.bodyPreview, /招待リンクはメール本文に記載/);

  const empty = formatGuestMailPreview(null);
  assert.match(empty.subject, /外部ゲストコラボレーターの招待/);
  assert.equal(empty.redacted, false);
});

test('guest session errors map to cause-specific Japanese recovery copy', () => {
  const expired = guestSessionIssueFromCode('GUEST_ACCOUNT_EXPIRED', 'guest');
  assert.ok(expired);
  assert.match(expired!.title, /有効期限/);
  assert.equal(expired!.actionHref, '/guest/login');
  assert.match(expired!.actionLabel, /外部ゲストサインイン/);

  const suspended = guestSessionIssueFromCode('GUEST_ACCOUNT_SUSPENDED', 'guest');
  assert.match(suspended!.title, /停止/);

  const revoked = guestSessionIssueFromCode('INVITATION_REVOKED', 'guest');
  assert.match(revoked!.title, /取り消/);

  const sessionExpired = guestSessionIssueFromCode(
    'SESSION_EXPIRED_OR_REVOKED',
    'guest'
  );
  assert.match(sessionExpired!.title, /セッション/);

  // Member sessions keep the normal SSO flow.
  assert.equal(
    guestSessionIssueFromCode('SESSION_EXPIRED_OR_REVOKED', 'member'),
    null
  );

  const apiError = new ApiClientError(401, 'Guest account has expired', 'GUEST_ACCOUNT_EXPIRED');
  assert.equal(
    guestSessionIssueFromError(apiError, { userType: 'guest' })?.code,
    'GUEST_ACCOUNT_EXPIRED'
  );
  assert.equal(
    guestSessionIssueFromError(apiError, { userType: 'member' }),
    null
  );
  assert.equal(
    guestSessionIssueFromError(
      new ApiClientError(401, 'Authentication required'),
      { userType: 'guest' }
    )?.actionHref,
    '/guest/login'
  );
  assert.equal(guestSessionIssueFromError(new Error('network')), null);
  assert.equal(isGuestSessionIssueCode('GUEST_ACCOUNT_EXPIRED'), true);
  assert.equal(isGuestSessionIssueCode('FORBIDDEN'), false);

  assert.equal(guestInvitationStatusLabel('pending'), '招待中');
  assert.equal(guestInvitationStatusLabel('accepted'), '受諾済み');
  assert.equal(guestInvitationStatusLabel('expired'), '期限切れ');
  assert.equal(guestInvitationStatusLabel('revoked'), '停止/取消済み');
  assert.equal(isGuestInvitationExpired({ status: 'revoked', expiresAt: '2099-01-01' }), false);
  assert.equal(isGuestInvitationExpired({ status: 'pending', expiresAt: '2000-01-01' }), true);
  assert.equal(isGuestInvitationExpired({ status: 'pending', expiresAt: '2099-01-01' }), false);
  assert.match(guestDomainGuidance([]), /フェイルクローズ/);
  assert.match(guestDomainGuidance(['partner.example']), /partner\.example/);
  assert.match(GUEST_POLICY_DISABLED_NOTICE, /\/admin/);
  assert.match(GUEST_SHARED_LINK_NOTE, /共有リンク/);
});

test('guest workspace banner derives allowed and denied operations from capabilities', () => {
  const uploader = buildGuestWorkspaceBanner({
    externalOrg: 'Partner Inc.',
    expiresAt: '2026-12-01T00:00:00.000Z',
    role: 'viewer_uploader',
    capabilities: [
      'folder.list',
      'folder.traverse',
      'folder.create',
      'item.preview',
      'item.download',
      'item.upload_new',
      'item.upload_version',
      'permission.view',
      'share_link.create',
    ],
  });
  assert.equal(uploader.roleLabel, 'Viewer + Uploader');
  assert.ok(uploader.allowed.includes('アップロード'));
  assert.ok(uploader.allowed.includes('プレビュー'));
  assert.ok(uploader.allowed.includes('ダウンロード'));
  assert.ok(uploader.denied.includes('権限管理'));
  assert.ok(uploader.denied.includes('削除'));
  assert.ok(uploader.denied.includes('ルートフォルダ作成'));
  assert.match(uploader.expiresLabel, /2026/);

  const previewer = buildGuestWorkspaceBanner({
    role: 'previewer',
    capabilities: ['folder.list', 'folder.traverse', 'item.preview'],
  });
  assert.deepEqual(previewer.allowed, ['プレビュー']);
  assert.ok(previewer.denied.includes('削除'));

  const previewerUploader = buildGuestWorkspaceBanner({
    role: 'previewer_uploader',
    capabilities: [
      'folder.list',
      'folder.traverse',
      'folder.create',
      'item.preview',
      'item.upload_new',
    ],
  });
  assert.deepEqual(previewerUploader.allowed, ['アップロード', 'プレビュー']);
  assert.ok(!previewerUploader.allowed.includes('ダウンロード'));
});

test('guest summary formatting exposes inheritance, DLP-safe items and invitations', () => {
  const summary: GuestSummaryResponse = {
    guest: {
      id: 'guest-1',
      email: 'guest@partner.example',
      displayName: 'External Guest',
      userType: 'guest',
      externalOrg: 'Partner Inc.',
      status: 'active',
      expiresAt: '2026-12-01T00:00:00.000Z',
      lastLoginAt: '2026-11-17T01:00:00.000Z',
      invitedBy: 'admin-1',
      invitedByName: 'Dev Admin',
    },
    invitations: [
      {
        id: 'inv-1',
        userId: 'guest-1',
        email: 'guest@partner.example',
        displayName: 'External Guest',
        externalOrg: 'Partner Inc.',
        invitedBy: 'admin-1',
        invitedByName: 'Dev Admin',
        targetType: 'folder',
        targetId: 'folder-1',
        targetName: 'Shared Folder',
        role: 'editor',
        status: 'accepted',
        expiresAt: '2026-12-01T00:00:00.000Z',
        acceptedAt: '2026-11-17T00:00:00.000Z',
        revokedAt: null,
        revokedBy: null,
        resendCount: 0,
        lastSentAt: '2026-11-17T00:00:00.000Z',
        createdAt: '2026-11-17T00:00:00.000Z',
        updatedAt: '2026-11-17T00:00:00.000Z',
        mailPreview: {
          subject: 'invite',
          bodyPreview: 'token=should-not-show',
        },
      },
    ],
    effectivePermissions: [
      {
        targetType: 'folder',
        targetId: 'folder-1',
        targetName: 'Shared Folder',
        role: 'viewer',
        inherited: true,
        inheritedFromName: 'Parent Folder',
        synthesizedRole: 'editor',
        capabilities: ['item.preview', 'item.download'],
      },
      {
        targetType: 'folder',
        targetId: 'folder-1',
        targetName: 'Shared Folder',
        role: 'editor',
        inherited: false,
        inheritedFromName: null,
        synthesizedRole: 'editor',
        capabilities: ['item.preview', 'item.download'],
      },
    ],
    sharedItems: [
      {
        itemType: 'folder',
        id: 'folder-1',
        name: 'Shared Folder',
        classification: 'internal',
        pathLabel: 'マイファイル / Parent Folder / Shared Folder',
        effectiveRole: 'editor',
        synthesizedRole: 'editor',
        capabilities: ['item.preview'],
        folderId: null,
        extension: null,
        mimeType: null,
        sizeBytes: null,
        updatedAt: '2026-11-17T00:00:00.000Z',
      },
      {
        itemType: 'file',
        id: 'file-1',
        name: 'plan.txt',
        classification: 'confidential',
        pathLabel: 'マイファイル / Shared Folder',
        effectiveRole: 'editor',
        synthesizedRole: 'editor',
        capabilities: ['item.preview'],
        folderId: 'folder-1',
        extension: 'txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        updatedAt: '2026-11-17T00:00:00.000Z',
      },
    ],
    guestPolicy: {
      allowExternalCollaborators: true,
      externalDomainAllowlist: ['partner.example'],
      allowGuestElevatedRoles: true,
      guestGrantableRoles: ['viewer', 'previewer', 'editor'],
      guestInvitationExpiryDays: 7,
    },
    accessSummary: {
      folderCount: 1,
      fileCount: 1,
      itemCount: 2,
      invitationCount: 1,
    },
  };

  const view = formatGuestSummary(summary);
  assert.equal(view.guest.externalOrgLabel, 'Partner Inc.');
  assert.equal(view.guest.invitedByLabel, 'Dev Admin');
  assert.equal(view.guest.statusLabel, '有効');
  assert.match(view.summaryLine, /共有 2 件/);
  assert.equal(view.effectivePermissions[0].sourceLabel, '継承元: Parent Folder');
  assert.equal(view.effectivePermissions[1].sourceLabel, '直接付与');
  assert.equal(view.effectivePermissions[0].synthesizedLabel, 'Editor');
  assert.equal(view.sharedItems[1].classificationLabel, '極秘 (Confidential)');
  assert.equal(view.sharedItems[1].roleLabel, 'Editor');
  assert.equal(view.invitations[0].statusLabel, '受諾済み');
  assert.doesNotMatch(
    JSON.stringify(view.invitations[0].mailPreview),
    /should-not-show/
  );

  const stopped = formatGuestSummary({
    ...summary,
    guest: { ...summary.guest, status: 'suspended' },
  });
  assert.equal(stopped.guest.statusLabel, '停止');
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(
  body: unknown,
  status = 200
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('guest collaboration API clients call the expected endpoints and preserve guest metadata', async () => {
  const searchMock = installFetchMock({
    principals: [
      {
        type: 'user',
        id: 'guest-1',
        displayName: 'External Guest',
        email: 'guest@partner.example',
        department: null,
        userType: 'guest',
        externalOrg: 'Partner Inc.',
        expiresAt: '2026-12-01T00:00:00.000Z',
        lastLoginAt: '2026-11-17T00:00:00.000Z',
        invitedBy: 'admin-1',
        invitationStatus: 'accepted',
      },
    ],
  });
  try {
    const response = await searchPrincipals(' Partner ', 'guest');
    assert.equal(
      searchMock.calls[0].url,
      '/api/principals/search?q=Partner&kind=guest'
    );
    assert.equal(searchMock.calls[0].init.credentials, 'include');
    assert.deepEqual(response.principals[0], {
      type: 'user',
      id: 'guest-1',
      name: 'External Guest',
      email: 'guest@partner.example',
      department: null,
      userType: 'guest',
      externalOrg: 'Partner Inc.',
      expiresAt: '2026-12-01T00:00:00.000Z',
      lastLoginAt: '2026-11-17T00:00:00.000Z',
      invitedBy: 'admin-1',
      invitationStatus: 'accepted',
    });
  } finally {
    searchMock.restore();
  }

  const summaryMock = installFetchMock({
    guest: {
      id: 'guest/1',
      email: 'guest@partner.example',
      displayName: 'External Guest',
      userType: 'guest',
      externalOrg: 'Partner Inc.',
      status: 'active',
      expiresAt: null,
      lastLoginAt: null,
      invitedBy: 'admin-1',
      invitedByName: 'Dev Admin',
    },
    invitations: [],
    effectivePermissions: [],
    sharedItems: [],
    guestPolicy: {
      allowExternalCollaborators: true,
      externalDomainAllowlist: [],
      allowGuestElevatedRoles: false,
      guestGrantableRoles: ['viewer'],
      guestInvitationExpiryDays: 14,
    },
    accessSummary: {
      folderCount: 0,
      fileCount: 0,
      itemCount: 0,
      invitationCount: 0,
    },
  });
  try {
    const summary = await fetchGuestSummary('guest/1');
    assert.equal(
      summaryMock.calls[0].url,
      '/api/guests/guest%2F1/summary'
    );
    assert.equal(summary.guest.invitedByName, 'Dev Admin');
    assert.equal(summary.guestPolicy.guestInvitationExpiryDays, 14);
  } finally {
    summaryMock.restore();
  }
});
