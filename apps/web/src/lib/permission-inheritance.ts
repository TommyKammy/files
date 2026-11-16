import type {
  AccessMode,
  PermissionInheritanceMode,
  TenantPolicyRow,
} from '@/types/files';

/** Read the tenant inheritance mode from either the camelCase or raw column. */
export function readPermissionInheritanceMode(
  policy: TenantPolicyRow | null | undefined
): PermissionInheritanceMode {
  if (!policy) return 'additive';
  if (policy.permissionInheritanceMode === 'waterfall') return 'waterfall';
  if (policy.permission_inheritance_mode === 'waterfall') return 'waterfall';
  return 'additive';
}

/** `path` ancestors are traversal-only and must hide every mutating action. */
export function isPathOnlyAccessMode(
  accessMode: AccessMode | null | undefined
): boolean {
  return accessMode === 'path';
}

/** Human-readable label used by badges and the shared-items path column. */
export function formatSharedItemPath(
  breadcrumbs: ReadonlyArray<{ name: string }>
): string {
  if (breadcrumbs.length === 0) return 'マイファイル (ルート)';
  return ['マイファイル', ...breadcrumbs.map((crumb) => crumb.name)].join(' / ');
}

/**
 * Invite-policy helpers live in `lib/invite-policy.ts`; re-exported here so
 * permission-policy consumers can import them alongside inheritance helpers.
 */
export {
  DEFAULT_INVITE_POLICY,
  INVITE_POLICY_DESCRIPTION,
  INVITE_POLICY_LABEL,
  INVITE_POLICY_STRICTNESS,
  canInviteByPolicy,
  effectiveInvitePolicy,
  grantableRolesForCaller,
  invitePolicyAudienceLabel,
  invitePolicySourceLabel,
  invitePolicyStrictness,
  isInvitePolicy,
  isRoleWithinCapabilitySubset,
  readFolderInvitePolicy,
  readTenantInvitePolicy,
  stricterInvitePolicy,
} from './invite-policy';
