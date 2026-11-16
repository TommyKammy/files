import type { ResourceRole } from '../types/api';

/**
 * Capability-based authorization model (P9-1 / TOM-52).
 *
 * `ROLE_CAPABILITIES` is the single source of truth for what a resource role can
 * do. Endpoints must check `can(access.capabilities, '<capability>')` instead of
 * comparing linear role ranks, because the eight roles are not totally ordered:
 * `uploader` may create new files but cannot preview or download, while
 * `previewer_uploader` may preview and upload but not download.
 */

/** Every role a tenant can grant on a folder or file. */
export const RESOURCE_ROLES = [
  'owner',
  'co_owner',
  'editor',
  'viewer_uploader',
  'previewer_uploader',
  'viewer',
  'previewer',
  'uploader',
] as const satisfies readonly ResourceRole[];

/**
 * Advanced roles are folder-only and gated behind
 * `tenant_policies.advanced_roles_enabled`.
 */
export const ADVANCED_RESOURCE_ROLES: ReadonlySet<ResourceRole> = new Set<ResourceRole>([
  'uploader',
  'viewer_uploader',
  'previewer_uploader',
]);

/** Roles that existed before the capability model; always grantable. */
export const LEGACY_RESOURCE_ROLES: ReadonlySet<ResourceRole> = new Set<ResourceRole>([
  'owner',
  'co_owner',
  'editor',
  'viewer',
  'previewer',
]);

/** Canonical capability list. Order is stable for API responses and tests. */
export const CAPABILITIES = [
  'folder.list',
  'folder.traverse',
  'folder.create',
  'folder.rename',
  'folder.move',
  'folder.delete',
  'folder.delete_root',
  'folder.settings',
  'item.preview',
  'item.download',
  'item.upload_new',
  'item.upload_version',
  'item.edit_content',
  'item.rename',
  'item.move',
  'item.delete',
  'metadata.edit',
  'classification.edit',
  'permission.view',
  'permission.invite',
  'permission.manage',
  'share_link.create',
  'share_link.manage',
  'trash.restore',
  'trash.purge',
  'owner.transfer',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

function capabilitySet(...capabilities: Capability[]): ReadonlySet<Capability> {
  return new Set<Capability>(capabilities);
}

/** `owner` can do everything, including root-folder deletion and ownership transfer. */
const OWNER_CAPABILITIES = capabilitySet(...CAPABILITIES);

/**
 * `co_owner` mirrors `owner` except for the two owner-exclusive capabilities
 * (`owner.transfer`, `folder.delete_root`).
 */
const CO_OWNER_CAPABILITIES = capabilitySet(
  ...CAPABILITIES.filter(
    (capability) =>
      capability !== 'owner.transfer' && capability !== 'folder.delete_root'
  )
);

/** `editor` owns content lifecycle + sharing, but no permission/owner management. */
const EDITOR_CAPABILITIES = capabilitySet(
  'folder.list',
  'folder.traverse',
  'folder.create',
  'folder.rename',
  'folder.move',
  'folder.delete',
  'item.preview',
  'item.download',
  'item.upload_new',
  'item.upload_version',
  'item.edit_content',
  'item.rename',
  'item.move',
  'item.delete',
  'metadata.edit',
  'classification.edit',
  'permission.view',
  'share_link.create',
  'share_link.manage',
  'trash.restore'
);

/**
 * `viewer_uploader` = viewer + uploader: full content preview/download/edit
 * (including new versions and WOPI), but no rename/move/delete, no permission
 * invitation/management, no classification/metadata edits, no trash restore and
 * no share-link management. Share links it creates are display-only.
 */
const VIEWER_UPLOADER_CAPABILITIES = capabilitySet(
  'folder.list',
  'folder.traverse',
  'folder.create',
  'item.preview',
  'item.download',
  'item.upload_new',
  'item.upload_version',
  'item.edit_content',
  'permission.view',
  'share_link.create'
);

/**
 * `previewer_uploader` may preview and add brand-new files only. It can never
 * download, upload new versions, edit existing content (WOPI), or share.
 */
const PREVIEWER_UPLOADER_CAPABILITIES = capabilitySet(
  'folder.list',
  'folder.traverse',
  'folder.create',
  'item.preview',
  'item.upload_new'
);

const VIEWER_CAPABILITIES = capabilitySet(
  'folder.list',
  'folder.traverse',
  'item.preview',
  'item.download',
  'permission.view'
);

const PREVIEWER_CAPABILITIES = capabilitySet(
  'folder.list',
  'folder.traverse',
  'item.preview'
);

/**
 * `uploader` may only browse folders and add brand-new files. No preview,
 * download, version upload, WOPI edit, permission listing or search exposure.
 */
const UPLOADER_CAPABILITIES = capabilitySet(
  'folder.list',
  'folder.traverse',
  'folder.create',
  'item.upload_new'
);

/** Single source of truth: role -> granted capabilities. */
export const ROLE_CAPABILITIES: Record<ResourceRole, ReadonlySet<Capability>> = {
  owner: OWNER_CAPABILITIES,
  co_owner: CO_OWNER_CAPABILITIES,
  editor: EDITOR_CAPABILITIES,
  viewer_uploader: VIEWER_UPLOADER_CAPABILITIES,
  previewer_uploader: PREVIEWER_UPLOADER_CAPABILITIES,
  viewer: VIEWER_CAPABILITIES,
  previewer: PREVIEWER_CAPABILITIES,
  uploader: UPLOADER_CAPABILITIES,
};

export interface EffectiveAccess {
  effectiveRole: ResourceRole | null;
  capabilities: Capability[];
}

export function isResourceRole(value: unknown): value is ResourceRole {
  return (
    typeof value === 'string' &&
    (RESOURCE_ROLES as readonly string[]).includes(value)
  );
}

export function isAdvancedResourceRole(role: ResourceRole | null | undefined): boolean {
  return role !== null && role !== undefined && ADVANCED_RESOURCE_ROLES.has(role);
}

/** Parse a `GROUP_CONCAT(DISTINCT p.role)` result into validated, de-duplicated roles. */
export function parseRoleList(raw: string | null | undefined): ResourceRole[] {
  if (!raw) return [];
  const roles = new Set<ResourceRole>();
  for (const token of raw.split(',')) {
    const role = token.trim();
    if (isResourceRole(role)) roles.add(role);
  }
  return [...roles];
}

/** Return capabilities in the canonical `CAPABILITIES` order. */
export function orderCapabilities(
  capabilities: Iterable<Capability>
): Capability[] {
  const set = capabilities instanceof Set ? capabilities : new Set(capabilities);
  return CAPABILITIES.filter((capability) => set.has(capability));
}

export function capabilitiesForRole(role: ResourceRole): Capability[] {
  return orderCapabilities(ROLE_CAPABILITIES[role]);
}

/** Union of capabilities granted by every role (used by monotonicity checks). */
export function capabilitiesForRoles(
  roles: Iterable<ResourceRole | null | undefined>
): Capability[] {
  const capabilities = new Set<Capability>();
  for (const role of roles) {
    if (!role || !isResourceRole(role)) continue;
    for (const capability of ROLE_CAPABILITIES[role]) capabilities.add(capability);
  }
  return orderCapabilities(capabilities);
}

/**
 * Non-linear role composition.
 *
 * Linear `MAX(rank)` collapses `viewer + uploader` into `viewer`, losing the
 * upload rights, and treats preview-only/upload-only roles as comparable even
 * though they are orthogonal. Composition instead follows the documented
 * precedence (owner > co_owner > editor) and then derives the highest preset
 * from the union of preview/download/new-upload feature flags.
 *
 * The result is commutative and idempotent, and `ROLE_CAPABILITIES[result]` is
 * always a superset of the capabilities of every input role.
 */
export function joinRoles(
  roles: Iterable<ResourceRole | null | undefined>
): ResourceRole | null {
  const granted = new Set<ResourceRole>();
  for (const role of roles) {
    if (isResourceRole(role)) granted.add(role);
  }
  if (granted.size === 0) return null;
  if (granted.has('owner')) return 'owner';
  if (granted.has('co_owner')) return 'co_owner';
  if (granted.has('editor')) return 'editor';

  let hasPreview = false;
  let hasDownload = false;
  let hasUploadNew = false;
  for (const role of granted) {
    const capabilities = ROLE_CAPABILITIES[role];
    if (capabilities.has('item.preview')) hasPreview = true;
    if (capabilities.has('item.download')) hasDownload = true;
    if (capabilities.has('item.upload_new')) hasUploadNew = true;
  }

  if (hasPreview && hasDownload && hasUploadNew) return 'viewer_uploader';
  if (hasPreview && hasUploadNew) return 'previewer_uploader';
  if (hasPreview && hasDownload) return 'viewer';
  if (hasPreview) return 'previewer';
  if (hasUploadNew) return 'uploader';
  return null;
}

/**
 * Synthesize the effective role and capability array returned by list, sync and
 * detail APIs. Capabilities are the union of the preset and every granted role,
 * so they can only grow when more grants are added.
 */
export function synthesizeEffectiveAccess(
  roles: Iterable<ResourceRole | null | undefined>
): EffectiveAccess {
  const granted = [...new Set([...roles].filter(isResourceRole))];
  const effectiveRole = joinRoles(granted);
  if (!effectiveRole) {
    return { effectiveRole: null, capabilities: [] };
  }
  const capabilities = new Set<Capability>(ROLE_CAPABILITIES[effectiveRole]);
  for (const role of granted) {
    for (const capability of ROLE_CAPABILITIES[role]) capabilities.add(capability);
  }
  return {
    effectiveRole,
    capabilities: orderCapabilities(capabilities),
  };
}

/** Capability check used by every endpoint. Accepts `Set` or JSON array form. */
export function can(
  capabilities: ReadonlySet<Capability> | readonly Capability[] | null | undefined,
  capability: Capability
): boolean {
  if (!capabilities) return false;
  if (Array.isArray(capabilities)) {
    return (capabilities as readonly Capability[]).includes(capability);
  }
  return (capabilities as ReadonlySet<Capability>).has(capability);
}

/**
 * Convenience for call sites that only carry a role (pure helpers, tests).
 * Equivalent to `can(capabilitiesForRole(role), capability)`.
 */
export function canRole(
  role: ResourceRole | null | undefined,
  capability: Capability
): boolean {
  if (!role || !isResourceRole(role)) return false;
  return ROLE_CAPABILITIES[role].has(capability);
}

/** Roles granted a capability, in canonical role order. */
export function rolesWithCapability(capability: Capability): ResourceRole[] {
  return RESOURCE_ROLES.filter((role) =>
    ROLE_CAPABILITIES[role].has(capability)
  );
}

/**
 * SQL `IN (...)` literal for roles holding a capability. Values come from the
 * closed `ResourceRole` union, so the generated list cannot be injected.
 */
export function capabilityRoleSqlList(capability: Capability): string {
  return rolesWithCapability(capability)
    .map((role) => `'${role}'`)
    .join(', ');
}

/**
 * Advanced roles are folder-only. Direct file grants of these roles are ignored
 * defensively so a legacy/corrupt row can never widen file access.
 */
export function filterFileTargetRoles(
  roles: Iterable<ResourceRole | null | undefined>
): ResourceRole[] {
  const result: ResourceRole[] = [];
  for (const role of roles) {
    if (!isResourceRole(role)) continue;
    if (ADVANCED_RESOURCE_ROLES.has(role)) continue;
    result.push(role);
  }
  return result;
}
