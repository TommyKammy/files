import type { ResourceRole, UserRole } from '../types/api';
import {
  ADVANCED_RESOURCE_ROLES,
  can,
  isResourceRole,
  orderCapabilities,
  ROLE_CAPABILITIES,
  type Capability,
} from './capabilities';

/**
 * P9-5 / TOM-58 invitation policy.
 *
 * Policy strictness is ordered `editors` < `owners` < `admins`. The tenant
 * policy is the default floor and folder overrides may only tighten it, never
 * relax it. Effective capabilities are projected dynamically because
 * `permission.invite` is policy-dependent: the static `ROLE_CAPABILITIES`
 * matrix stays unchanged (`permission.manage` remains owner/co_owner only).
 */
export type InvitePolicy = 'owners' | 'editors' | 'admins';

export const DEFAULT_INVITE_POLICY: InvitePolicy = 'owners';

/** Lower rank = more permissive. */
export const INVITE_POLICY_STRICTNESS: Record<InvitePolicy, number> = {
  editors: 1,
  owners: 2,
  admins: 3,
};

export function isInvitePolicy(value: unknown): value is InvitePolicy {
  return value === 'owners' || value === 'editors' || value === 'admins';
}

export function invitePolicyStrictness(policy: InvitePolicy): number {
  return INVITE_POLICY_STRICTNESS[policy];
}

/** Return whichever policy is stricter; ties keep `a`. */
export function stricterInvitePolicy(
  a: InvitePolicy,
  b: InvitePolicy
): InvitePolicy {
  return INVITE_POLICY_STRICTNESS[b] > INVITE_POLICY_STRICTNESS[a] ? b : a;
}

export interface ResolvedInvitePolicy {
  tenantPolicy: InvitePolicy;
  /** Strictest of the tenant policy and strict ancestors (self excluded). */
  parentFloor: InvitePolicy;
  /** This folder's own override, or `null` when it inherits. */
  ownPolicy: InvitePolicy | null;
  effectivePolicy: InvitePolicy;
  /** Folder that established the effective policy, or null for the tenant. */
  sourceFolderId: string | null;
  sourceFolderName: string | null;
}

export interface InviteAccessLike {
  effectiveRole: ResourceRole | null;
  capabilities: readonly Capability[] | ReadonlySet<Capability>;
}

export function getTenantInvitePolicy(
  db: D1Database,
  tenantId: string
): Promise<InvitePolicy> {
  return db
    .prepare('SELECT invite_policy FROM tenant_policies WHERE tenant_id = ?')
    .bind(tenantId)
    .first<{ invite_policy: string | null }>()
    .then((row) =>
      isInvitePolicy(row?.invite_policy)
        ? row.invite_policy
        : DEFAULT_INVITE_POLICY
    );
}

interface AncestorPolicyRow {
  folder_id: string;
  depth: number;
  source_folder_id: string;
  source_folder_name: string;
  invite_policy: string | null;
}

function computeResolvedPolicy(
  tenantPolicy: InvitePolicy,
  folderId: string,
  rows: readonly AncestorPolicyRow[]
): ResolvedInvitePolicy {
  let parentFloor = tenantPolicy;
  let sourceFolderId: string | null = null;
  let sourceFolderName: string | null = null;
  let ownPolicy: InvitePolicy | null = null;
  let ownFolderName: string | null = null;

  // Rows are ordered root -> self (depth DESC), so each stricter override wins.
  const ordered = [...rows]
    .filter((row) => row.folder_id === folderId)
    .sort((a, b) => b.depth - a.depth);
  for (const row of ordered) {
    if (!isInvitePolicy(row.invite_policy)) continue;
    if (row.depth === 0) {
      ownPolicy = row.invite_policy;
      ownFolderName = row.source_folder_name;
      continue;
    }
    if (
      invitePolicyStrictness(row.invite_policy) >
      invitePolicyStrictness(parentFloor)
    ) {
      parentFloor = row.invite_policy;
      sourceFolderId = row.source_folder_id;
      sourceFolderName = row.source_folder_name;
    }
  }

  let effectivePolicy = parentFloor;
  if (
    ownPolicy !== null &&
    invitePolicyStrictness(ownPolicy) >= invitePolicyStrictness(parentFloor)
  ) {
    effectivePolicy = ownPolicy;
    // An explicit non-null override is the source even when it matches the
    // inherited floor, so the UI can explain "上書き設定済み".
    sourceFolderId = folderId;
    sourceFolderName = ownFolderName;
  }

  return {
    tenantPolicy,
    parentFloor,
    ownPolicy,
    effectivePolicy,
    sourceFolderId,
    sourceFolderName,
  };
}

/**
 * Resolve invite policies for many folders in one query (used by roots,
 * children and sync bootstrap so list responses never issue N+1 queries).
 */
export async function resolveEffectiveInvitePoliciesForFolders(
  db: D1Database,
  tenantId: string,
  folderIds: readonly string[]
): Promise<Map<string, ResolvedInvitePolicy>> {
  const uniqueIds = [...new Set(folderIds.filter(Boolean))];
  const tenantPolicy = await getTenantInvitePolicy(db, tenantId);
  const result = new Map<string, ResolvedInvitePolicy>();
  for (const folderId of uniqueIds) {
    result.set(folderId, {
      tenantPolicy,
      parentFloor: tenantPolicy,
      ownPolicy: null,
      effectivePolicy: tenantPolicy,
      sourceFolderId: null,
      sourceFolderName: null,
    });
  }
  if (uniqueIds.length === 0) return result;

  for (let i = 0; i < uniqueIds.length; i += 30) {
    const chunk = uniqueIds.slice(i, i + 30);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT fc.descendant_id AS folder_id,
                fc.depth AS depth,
                f.id AS source_folder_id,
                f.name AS source_folder_name,
                f.invite_policy AS invite_policy
           FROM folder_closures fc
           JOIN folders f
             ON f.tenant_id = fc.tenant_id
            AND f.id = fc.ancestor_id
            AND f.deleted_at IS NULL
          WHERE fc.tenant_id = ?
            AND fc.descendant_id IN (${placeholders})
            AND f.invite_policy IS NOT NULL
          ORDER BY fc.descendant_id ASC, fc.depth DESC`
      )
      .bind(tenantId, ...chunk)
      .all<AncestorPolicyRow>();

    const byFolder = new Map<string, AncestorPolicyRow[]>();
    for (const row of rows.results) {
      const list = byFolder.get(row.folder_id) ?? [];
      list.push(row);
      byFolder.set(row.folder_id, list);
    }
    for (const folderId of chunk) {
      result.set(
        folderId,
        computeResolvedPolicy(
          tenantPolicy,
          folderId,
          byFolder.get(folderId) ?? []
        )
      );
    }
  }
  return result;
}

/**
 * Resolve the effective invitation policy for a folder (or the tenant when
 * `folderId` is null). Folder overrides are applied root -> self, keeping the
 * strictest policy at every level.
 */
export async function resolveEffectiveInvitePolicy(
  db: D1Database,
  tenantId: string,
  folderId: string | null
): Promise<ResolvedInvitePolicy> {
  if (folderId === null) {
    const tenantPolicy = await getTenantInvitePolicy(db, tenantId);
    return {
      tenantPolicy,
      parentFloor: tenantPolicy,
      ownPolicy: null,
      effectivePolicy: tenantPolicy,
      sourceFolderId: null,
      sourceFolderName: null,
    };
  }
  const policies = await resolveEffectiveInvitePoliciesForFolders(db, tenantId, [
    folderId,
  ]);
  return (
    policies.get(folderId) ?? {
      tenantPolicy: await getTenantInvitePolicy(db, tenantId),
      parentFloor: DEFAULT_INVITE_POLICY,
      ownPolicy: null,
      effectivePolicy: DEFAULT_INVITE_POLICY,
      sourceFolderId: null,
      sourceFolderName: null,
    }
  );
}

function isEditorTierRole(role: ResourceRole | null): boolean {
  return role === 'owner' || role === 'co_owner' || role === 'editor';
}

/**
 * Policy gate for invitations.
 *
 * - `owners`: only callers holding `permission.manage` (owner / co_owner).
 * - `editors`: owners / co-owners plus the editor tier (`folder.list` and
 *   `item.edit_content`), never viewer-uploader / previewer / uploader.
 * - `admins`: only sys_admin accounts that also hold folder access as
 *   owner / co_owner / editor (or `permission.manage`).
 */
export function canUserInviteByPolicy(
  effectivePolicy: InvitePolicy,
  access: InviteAccessLike,
  userRole: UserRole | null | undefined
): boolean {
  if (!access.effectiveRole) return false;

  switch (effectivePolicy) {
    case 'admins':
      return (
        userRole === 'sys_admin' &&
        (isEditorTierRole(access.effectiveRole) ||
          can(access.capabilities, 'permission.manage'))
      );
    case 'owners':
      return can(access.capabilities, 'permission.manage');
    case 'editors':
      return (
        can(access.capabilities, 'permission.manage') ||
        (access.effectiveRole === 'editor' &&
          can(access.capabilities, 'folder.list') &&
          can(access.capabilities, 'item.edit_content'))
      );
    default:
      return false;
  }
}

/**
 * Project the policy-aware capability array returned by list / detail APIs.
 * `permission.invite` is added only when the caller can actually invite under
 * the effective policy, and removed otherwise. `ROLE_CAPABILITIES` is never
 * mutated, so standalone capability-matrix assertions stay valid.
 */
export function computeEffectivePermissionsCapabilities(
  capabilities: readonly Capability[] | ReadonlySet<Capability>,
  effectiveRole: ResourceRole | null,
  effectivePolicy: InvitePolicy,
  userRole: UserRole | null | undefined
): Capability[] {
  const projected = new Set<Capability>(capabilities);
  const allowed = canUserInviteByPolicy(
    effectivePolicy,
    { effectiveRole, capabilities: projected },
    userRole
  );
  if (allowed) projected.add('permission.invite');
  else projected.delete('permission.invite');
  return orderCapabilities(projected);
}

/**
 * True when every capability of `requestedRole` is held by the caller.
 * This is the guard that stops an editor-invite capability from granting
 * co-owner / owner roles.
 */
export function isRoleWithinCapabilitySubset(
  requestedRole: ResourceRole,
  callerCapabilities:
    | readonly Capability[]
    | ReadonlySet<Capability>
    | null
    | undefined
): boolean {
  if (!isResourceRole(requestedRole) || !callerCapabilities) return false;
  for (const capability of ROLE_CAPABILITIES[requestedRole]) {
    if (!can(callerCapabilities, capability)) return false;
  }
  return true;
}

export interface GrantableRolesInput {
  targetType: 'folder' | 'file';
  callerCapabilities: readonly Capability[] | ReadonlySet<Capability>;
  callerRole: ResourceRole | null;
  canManage: boolean;
  canInvite: boolean;
  advancedRolesEnabled: boolean;
}

/**
 * Roles the current caller may grant on this target. Filtered by target kind,
 * advanced-role policy, owner escalation guard, effective invite policy and the
 * caller's capability subset.
 */
export function grantableRolesForCaller(
  input: GrantableRolesInput
): ResourceRole[] {
  if (!input.canInvite) return [];

  const candidateRoles: ResourceRole[] =
    input.targetType === 'file'
      ? ['owner', 'co_owner', 'editor', 'viewer', 'previewer']
      : [
          'owner',
          'co_owner',
          'editor',
          'viewer_uploader',
          'previewer_uploader',
          'viewer',
          'previewer',
          'uploader',
        ];

  return candidateRoles.filter((role) => {
    if (ADVANCED_RESOURCE_ROLES.has(role) && !input.advancedRolesEnabled) {
      return false;
    }
    // Only an owner (or a sys_admin acting with owner-level capability subset)
    // can grant `owner`.
    if (role === 'owner' && input.callerRole !== 'owner') return false;
    // A caller with `permission.manage` may grant anything their own capability
    // set covers; invite-only callers are capped by the same subset rule.
    return isRoleWithinCapabilitySubset(role, input.callerCapabilities);
  });
}
