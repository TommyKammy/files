import {
  canAccess,
  type CapabilityTarget,
} from '@/lib/capabilities';
import type {
  Capability,
  InvitePolicy,
  ResourceRole,
  TenantPolicyRow,
  UserRole,
} from '@/types/files';

export {
  grantableRolesForCaller,
  isRoleWithinCapabilitySubset,
  type GrantableRolesInput,
} from '@/lib/capabilities';

/** Mirrors `apps/api/src/services/invite-policy.ts`. */
export const INVITE_POLICY_STRICTNESS: Record<InvitePolicy, number> = {
  editors: 1,
  owners: 2,
  admins: 3,
};

export const DEFAULT_INVITE_POLICY: InvitePolicy = 'owners';

export const INVITE_POLICY_LABEL: Record<InvitePolicy, string> = {
  editors: '編集者以上',
  owners: '所有者/共同所有者のみ',
  admins: '管理者のみ',
};

export const INVITE_POLICY_DESCRIPTION: Record<InvitePolicy, string> = {
  editors:
    '所有者・共同所有者に加えて、編集者（Editor）も新しいメンバーを招待できます。',
  owners:
    '所有者（Owner）と共同所有者（Co-Owner）だけが新しいメンバーを招待できます。',
  admins:
    'システム管理者（sys_admin）だけが、フォルダへのアクセス権を持つ場合に限り招待できます。',
};

export function isInvitePolicy(value: unknown): value is InvitePolicy {
  return value === 'owners' || value === 'editors' || value === 'admins';
}

export function invitePolicyStrictness(policy: InvitePolicy): number {
  return INVITE_POLICY_STRICTNESS[policy];
}

export function stricterInvitePolicy(
  a: InvitePolicy,
  b: InvitePolicy
): InvitePolicy {
  return INVITE_POLICY_STRICTNESS[b] > INVITE_POLICY_STRICTNESS[a] ? b : a;
}

/** Stricter of two optional policies; `null` inherits (does not weaken). */
export function effectiveInvitePolicy(
  inheritedFloor: InvitePolicy,
  ownPolicy: InvitePolicy | null | undefined
): InvitePolicy {
  if (!ownPolicy) return inheritedFloor;
  return stricterInvitePolicy(inheritedFloor, ownPolicy);
}

export function readTenantInvitePolicy(
  policy: Pick<TenantPolicyRow, 'invite_policy' | 'invitePolicy'> | null | undefined
): InvitePolicy {
  if (!policy) return DEFAULT_INVITE_POLICY;
  if (isInvitePolicy(policy.invitePolicy)) return policy.invitePolicy;
  if (isInvitePolicy(policy.invite_policy)) return policy.invite_policy;
  return DEFAULT_INVITE_POLICY;
}

export function readFolderInvitePolicy(
  folder: { invite_policy?: InvitePolicy | null; invitePolicy?: InvitePolicy | null } | null | undefined
): InvitePolicy | null {
  if (!folder) return null;
  if (isInvitePolicy(folder.invitePolicy)) return folder.invitePolicy;
  if (isInvitePolicy(folder.invite_policy)) return folder.invite_policy;
  return null;
}

function isEditorTierRole(role: ResourceRole | null): boolean {
  return role === 'owner' || role === 'co_owner' || role === 'editor';
}

export function canInviteByPolicy(
  effectivePolicy: InvitePolicy,
  access: CapabilityTarget,
  userRole: UserRole | null | undefined
): boolean {
  const role =
    access && typeof access === 'object'
      ? access.effectiveRole ?? access.role ?? null
      : typeof access === 'string'
        ? access
        : null;
  if (!role) return false;

  switch (effectivePolicy) {
    case 'admins':
      return (
        userRole === 'sys_admin' &&
        (isEditorTierRole(role) || canAccess(access, 'permission.manage'))
      );
    case 'owners':
      return canAccess(access, 'permission.manage');
    case 'editors':
      return canAccess(access, 'permission.manage') || role === 'editor';
    default:
      return false;
  }
}

export type PermissionsActionMode = 'manage' | 'invite';

/**
 * Decide which permissions affordance the UI should expose. `manage` keeps the
 * existing `権限管理` label; invite-only callers (editor under the `editors`
 * policy) see `メンバー招待`.
 */
export function resolvePermissionsActionMode(input: {
  isSysAdmin?: boolean;
  capabilities?: readonly Capability[] | null;
  effectiveRole?: ResourceRole | null;
}): PermissionsActionMode | null {
  const access = {
    capabilities: input.capabilities,
    effectiveRole: input.effectiveRole ?? null,
  };
  if (input.isSysAdmin || canAccess(access, 'permission.manage')) {
    return 'manage';
  }
  if (canAccess(access, 'permission.invite')) return 'invite';
  return null;
}

export function permissionsButtonLabel(
  mode: PermissionsActionMode | null,
  options?: { manageLabel?: string; inviteLabel?: string }
): string | null {
  if (mode === 'manage') return options?.manageLabel ?? '権限管理';
  if (mode === 'invite') return options?.inviteLabel ?? 'メンバー招待';
  return null;
}

/** Japanese explanation of who may invite under the effective policy. */
export function invitePolicyAudienceLabel(policy: InvitePolicy): string {
  switch (policy) {
    case 'editors':
      return '所有者・共同所有者・編集者';
    case 'owners':
      return '所有者・共同所有者';
    case 'admins':
      return 'システム管理者（sys_admin）のみ';
    default:
      return '所有者・共同所有者';
  }
}

/** Banner source text: tenant default, ancestor inheritance, or own override. */
export function invitePolicySourceLabel(input: {
  targetType: 'folder' | 'file';
  targetId: string;
  effectivePolicy: InvitePolicy;
  sourceFolderId: string | null;
  sourceFolderName: string | null;
}): string {
  if (input.sourceFolderId && input.sourceFolderId === input.targetId) {
    return 'このフォルダで上書き設定済み';
  }
  if (input.sourceFolderId) {
    const prefix = input.targetType === 'file' ? '所属フォルダ' : '親フォルダ';
    return `${prefix}「${input.sourceFolderName ?? '上位フォルダ'}」から継承`;
  }
  return `テナント既定（${INVITE_POLICY_LABEL[input.effectivePolicy]}）`;
}
