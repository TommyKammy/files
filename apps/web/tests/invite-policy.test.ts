import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClientError } from '@/lib/files-api';
import { ROLE_CAPABILITIES } from '@/lib/capabilities';
import {
  canInviteByPolicy,
  effectiveInvitePolicy,
  grantableRolesForCaller,
  invitePolicyAudienceLabel,
  invitePolicySourceLabel,
  invitePolicyStrictness,
  isRoleWithinCapabilitySubset,
  permissionsButtonLabel,
  readFolderInvitePolicy,
  readTenantInvitePolicy,
  resolvePermissionsActionMode,
  stricterInvitePolicy,
} from '@/lib/invite-policy';
import { formatPermissionError } from '@/lib/use-permissions-modal';
import type { Capability, InvitePolicy, ResourceRole } from '@/types/files';

const EDITOR_CAPABILITIES = [...ROLE_CAPABILITIES.editor];
const OWNER_CAPABILITIES = [...ROLE_CAPABILITIES.owner];
const VIEWER_CAPABILITIES = [...ROLE_CAPABILITIES.viewer];

function withInvite(capabilities: Capability[]): Capability[] {
  return [...new Set([...capabilities, 'permission.invite' as Capability])];
}

test('invite policy strictness orders editors < owners < admins', () => {
  assert.equal(invitePolicyStrictness('editors'), 1);
  assert.equal(invitePolicyStrictness('owners'), 2);
  assert.equal(invitePolicyStrictness('admins'), 3);
  assert.equal(stricterInvitePolicy('editors', 'owners'), 'owners');
  assert.equal(stricterInvitePolicy('owners', 'editors'), 'owners');
  assert.equal(stricterInvitePolicy('owners', 'admins'), 'admins');
  assert.equal(stricterInvitePolicy('admins', 'owners'), 'admins');
  assert.equal(effectiveInvitePolicy('owners', null), 'owners');
  assert.equal(effectiveInvitePolicy('owners', 'editors'), 'owners');
  assert.equal(effectiveInvitePolicy('owners', 'admins'), 'admins');
});

test('reads tenant and folder invite policy projections', () => {
  assert.equal(readTenantInvitePolicy(null), 'owners');
  assert.equal(
    readTenantInvitePolicy({ invite_policy: 'editors' } as never),
    'editors'
  );
  assert.equal(
    readTenantInvitePolicy({ invitePolicy: 'admins' } as never),
    'admins'
  );
  assert.equal(readFolderInvitePolicy(null), null);
  assert.equal(readFolderInvitePolicy({ invite_policy: null }), null);
  assert.equal(
    readFolderInvitePolicy({ invite_policy: 'owners' }),
    'owners'
  );
});

test('canInviteByPolicy follows the 3 x 4 + admin matrix', () => {
  const cases: Array<{
    policy: InvitePolicy;
    role: ResourceRole;
    capabilities: Capability[];
    userRole: 'sys_admin' | 'sec_admin' | 'member';
    expected: boolean;
  }> = [
    { policy: 'owners', role: 'owner', capabilities: OWNER_CAPABILITIES, userRole: 'member', expected: true },
    { policy: 'owners', role: 'co_owner', capabilities: [...ROLE_CAPABILITIES.co_owner], userRole: 'member', expected: true },
    { policy: 'owners', role: 'editor', capabilities: EDITOR_CAPABILITIES, userRole: 'member', expected: false },
    { policy: 'owners', role: 'viewer', capabilities: VIEWER_CAPABILITIES, userRole: 'member', expected: false },
    { policy: 'editors', role: 'editor', capabilities: EDITOR_CAPABILITIES, userRole: 'member', expected: true },
    { policy: 'editors', role: 'viewer_uploader', capabilities: [...ROLE_CAPABILITIES.viewer_uploader], userRole: 'member', expected: false },
    { policy: 'editors', role: 'viewer', capabilities: VIEWER_CAPABILITIES, userRole: 'member', expected: false },
    { policy: 'admins', role: 'owner', capabilities: OWNER_CAPABILITIES, userRole: 'member', expected: false },
    { policy: 'admins', role: 'owner', capabilities: OWNER_CAPABILITIES, userRole: 'sec_admin', expected: false },
    { policy: 'admins', role: 'owner', capabilities: OWNER_CAPABILITIES, userRole: 'sys_admin', expected: true },
    { policy: 'admins', role: 'editor', capabilities: EDITOR_CAPABILITIES, userRole: 'sys_admin', expected: true },
    { policy: 'admins', role: 'viewer', capabilities: VIEWER_CAPABILITIES, userRole: 'sys_admin', expected: false },
  ];

  for (const entry of cases) {
    assert.equal(
      canInviteByPolicy(
        entry.policy,
        { effectiveRole: entry.role, capabilities: entry.capabilities },
        entry.userRole
      ),
      entry.expected,
      `${entry.policy} / ${entry.role} / ${entry.userRole}`
    );
  }
});

test('capability subset filters grantable roles for editor invite-only callers', () => {
  assert.equal(isRoleWithinCapabilitySubset('viewer', EDITOR_CAPABILITIES), true);
  assert.equal(isRoleWithinCapabilitySubset('uploader', EDITOR_CAPABILITIES), true);
  assert.equal(isRoleWithinCapabilitySubset('co_owner', EDITOR_CAPABILITIES), false);
  assert.equal(isRoleWithinCapabilitySubset('owner', EDITOR_CAPABILITIES), false);

  const editorRoles = grantableRolesForCaller({
    targetType: 'folder',
    callerCapabilities: EDITOR_CAPABILITIES,
    callerRole: 'editor',
    canManage: false,
    canInvite: true,
    advancedRolesEnabled: true,
  });
  assert.deepEqual(editorRoles, [
    'editor',
    'viewer_uploader',
    'previewer_uploader',
    'viewer',
    'previewer',
    'uploader',
  ]);
  assert.ok(!editorRoles.includes('owner'));
  assert.ok(!editorRoles.includes('co_owner'));

  const noAdvanced = grantableRolesForCaller({
    targetType: 'folder',
    callerCapabilities: EDITOR_CAPABILITIES,
    callerRole: 'editor',
    canManage: false,
    canInvite: true,
    advancedRolesEnabled: false,
  });
  assert.deepEqual(noAdvanced, ['editor', 'viewer', 'previewer']);

  const fileRoles = grantableRolesForCaller({
    targetType: 'file',
    callerCapabilities: EDITOR_CAPABILITIES,
    callerRole: 'editor',
    canManage: false,
    canInvite: true,
    advancedRolesEnabled: true,
  });
  assert.deepEqual(fileRoles, ['editor', 'viewer', 'previewer']);

  const ownerRoles = grantableRolesForCaller({
    targetType: 'folder',
    callerCapabilities: OWNER_CAPABILITIES,
    callerRole: 'owner',
    canManage: true,
    canInvite: true,
    advancedRolesEnabled: true,
  });
  assert.ok(ownerRoles.includes('owner'));
  assert.ok(ownerRoles.includes('co_owner'));

  const deniedRoles = grantableRolesForCaller({
    targetType: 'folder',
    callerCapabilities: OWNER_CAPABILITIES,
    callerRole: 'owner',
    canManage: true,
    canInvite: false,
    advancedRolesEnabled: true,
  });
  assert.deepEqual(deniedRoles, []);
});

test('invite button gating distinguishes manage from invite-only', () => {
  assert.equal(
    resolvePermissionsActionMode({
      capabilities: OWNER_CAPABILITIES,
      effectiveRole: 'owner',
    }),
    'manage'
  );
  assert.equal(
    resolvePermissionsActionMode({
      capabilities: withInvite(EDITOR_CAPABILITIES),
      effectiveRole: 'editor',
    }),
    'invite'
  );
  assert.equal(
    resolvePermissionsActionMode({
      capabilities: EDITOR_CAPABILITIES,
      effectiveRole: 'editor',
    }),
    null
  );
  assert.equal(
    resolvePermissionsActionMode({
      capabilities: VIEWER_CAPABILITIES,
      effectiveRole: 'viewer',
    }),
    null
  );
  assert.equal(resolvePermissionsActionMode({ isSysAdmin: true }), 'manage');

  assert.equal(permissionsButtonLabel('manage'), '権限管理');
  assert.equal(permissionsButtonLabel('invite'), 'メンバー招待');
  assert.equal(permissionsButtonLabel(null), null);
});

test('invite policy banner labels explain source and audience', () => {
  assert.equal(invitePolicyAudienceLabel('editors'), '所有者・共同所有者・編集者');
  assert.equal(invitePolicyAudienceLabel('owners'), '所有者・共同所有者');
  assert.equal(invitePolicyAudienceLabel('admins'), 'システム管理者（sys_admin）のみ');
  assert.equal(
    invitePolicySourceLabel({
      targetType: 'folder',
      targetId: 'folder-1',
      effectivePolicy: 'owners',
      sourceFolderId: 'folder-1',
      sourceFolderName: 'Folder 1',
    }),
    'このフォルダで上書き設定済み'
  );
  assert.equal(
    invitePolicySourceLabel({
      targetType: 'folder',
      targetId: 'folder-2',
      effectivePolicy: 'owners',
      sourceFolderId: 'folder-1',
      sourceFolderName: 'Parent',
    }),
    '親フォルダ「Parent」から継承'
  );
  assert.equal(
    invitePolicySourceLabel({
      targetType: 'file',
      targetId: 'file-1',
      effectivePolicy: 'editors',
      sourceFolderId: 'folder-1',
      sourceFolderName: 'Parent',
    }),
    '所属フォルダ「Parent」から継承'
  );
});

test('formats invite policy guardrail codes in Japanese', () => {
  assert.match(
    formatPermissionError(
      new ApiClientError(403, 'restricted', 'INVITE_POLICY_RESTRICTED', {
        effectiveInvitePolicy: 'owners',
      }),
      'fallback'
    ),
    /所有者\/共同所有者のみ/
  );
  assert.match(
    formatPermissionError(
      new ApiClientError(409, 'relax', 'INVITE_POLICY_CANNOT_RELAX', {
        inheritedFloor: 'admins',
      }),
      'fallback'
    ),
    /管理者のみ.*緩めることはできません/
  );
  assert.match(
    formatPermissionError(
      new ApiClientError(403, 'manage', 'MANAGE_PERMISSION_REQUIRED'),
      'fallback'
    ),
    /既存の権限の変更・削除/
  );
  assert.match(
    formatPermissionError(
      new ApiClientError(403, 'subset', 'ROLE_EXCEEDS_CALLER_CAPABILITIES'),
      'fallback'
    ),
    /権限範囲を超えています/
  );
  assert.match(
    formatPermissionError(
      new ApiClientError(409, 'waterfall', 'WATERFALL_INHERITED_LOCKED', {
        ancestorFolderName: 'Parent',
        inheritedRole: 'viewer',
      }),
      'fallback'
    ),
    /親フォルダ「Parent」/
  );
});
