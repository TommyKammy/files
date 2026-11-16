import type { Capability, ResourceRole } from '@/types/files';

/**
 * Capability-based authorization model for the web client (TOM-55).
 *
 * Mirrors `apps/api/src/services/capabilities.ts`. The eight resource roles are
 * not totally ordered: `uploader` can add files but cannot preview/download,
 * while `previewer_uploader` can preview and add files but cannot download.
 * UI gates therefore always evaluate capabilities, never a linear role rank.
 */

/** Every resource role a tenant can grant on a folder or file. */
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

export const ADVANCED_RESOURCE_ROLES: ReadonlySet<ResourceRole> = new Set<ResourceRole>([
  'uploader',
  'viewer_uploader',
  'previewer_uploader',
]);

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
] as const satisfies readonly Capability[];

function capabilitySet(...capabilities: Capability[]): ReadonlySet<Capability> {
  return new Set<Capability>(capabilities);
}

const OWNER_CAPABILITIES = capabilitySet(...CAPABILITIES);

const CO_OWNER_CAPABILITIES = capabilitySet(
  ...CAPABILITIES.filter(
    (capability) =>
      capability !== 'owner.transfer' && capability !== 'folder.delete_root'
  )
);

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

export const ROLE_META: Record<ResourceRole, { label: string; description: string }> = {
  owner: { label: 'Owner', description: 'すべての権限' },
  co_owner: { label: 'Co-Owner', description: '編集 + 権限管理（Owner除く）' },
  editor: { label: 'Editor', description: '作成・更新・共有設定可' },
  viewer_uploader: {
    label: 'Viewer + Uploader',
    description: '閲覧・DL・編集 + 新規/新版アップロード',
  },
  previewer_uploader: {
    label: 'Previewer + Uploader',
    description: '画面プレビュー + 新規アップロード（DL・既存版更新は不可）',
  },
  viewer: { label: 'Viewer', description: '閲覧・ダウンロード可' },
  previewer: { label: 'Previewer', description: '画面プレビューのみ（DL不可）' },
  uploader: {
    label: 'Uploader',
    description: '新規アップロード専用（閲覧・DL・プレビュー不可）',
  },
};

export interface RoleGroup {
  id: 'owner' | 'edit' | 'upload' | 'view';
  label: '所有者/管理' | '編集' | '投稿' | '閲覧';
  roles: ResourceRole[];
}

/** Visual grouping for the permissions modal. */
export const ROLE_GROUPS: readonly RoleGroup[] = [
  {
    id: 'owner',
    label: '所有者/管理',
    roles: ['owner', 'co_owner'],
  },
  {
    id: 'edit',
    label: '編集',
    roles: ['editor'],
  },
  {
    id: 'upload',
    label: '投稿',
    roles: ['viewer_uploader', 'previewer_uploader', 'uploader'],
  },
  {
    id: 'view',
    label: '閲覧',
    roles: ['viewer', 'previewer'],
  },
] as const;

/** Files never accept the three folder-only advanced roles. */
export const FILE_ASSIGNABLE_ROLES: readonly ResourceRole[] = [
  'owner',
  'co_owner',
  'editor',
  'viewer',
  'previewer',
];

/** Japanese chip label for every capability. */
export const CAPABILITY_CHIPS: Record<Capability, string> = {
  'folder.list': '一覧',
  'folder.traverse': 'フォルダ閲覧',
  'folder.create': 'フォルダ作成',
  'folder.rename': 'フォルダ名変更',
  'folder.move': 'フォルダ移動',
  'folder.delete': 'フォルダ削除',
  'folder.delete_root': 'ルート削除',
  'folder.settings': 'フォルダ設定',
  'item.preview': 'プレビュー',
  'item.download': 'DL',
  'item.upload_new': '新規UP',
  'item.upload_version': '新版UP',
  'item.edit_content': 'WOPI編集',
  'item.rename': '名前変更',
  'item.move': '移動',
  'item.delete': '削除',
  'metadata.edit': 'メタデータ編集',
  'classification.edit': '機密区分変更',
  'permission.view': '権限閲覧',
  'permission.invite': '権限招待',
  'permission.manage': '権限管理',
  'share_link.create': '共有リンク作成',
  'share_link.manage': '共有リンク管理',
  'trash.restore': 'ゴミ箱復元',
  'trash.purge': '完全削除',
  'owner.transfer': '所有権移転',
};

/**
 * Concise chips shown next to a role. Derived from the capability matrix so a
 * role can never display an action it cannot actually perform.
 */
const ROLE_CHIP_CAPABILITIES: Record<ResourceRole, Capability[]> = {
  owner: [
    'folder.list',
    'item.preview',
    'item.download',
    'item.upload_new',
    'item.upload_version',
    'item.edit_content',
    'permission.manage',
    'owner.transfer',
  ],
  co_owner: [
    'folder.list',
    'item.preview',
    'item.download',
    'item.upload_new',
    'item.upload_version',
    'item.edit_content',
    'permission.manage',
    'trash.restore',
  ],
  editor: [
    'folder.list',
    'item.preview',
    'item.download',
    'item.upload_new',
    'item.upload_version',
    'item.edit_content',
    'classification.edit',
    'share_link.manage',
  ],
  viewer_uploader: [
    'folder.list',
    'item.preview',
    'item.download',
    'item.upload_new',
    'item.upload_version',
    'item.edit_content',
    'share_link.create',
  ],
  previewer_uploader: [
    'folder.list',
    'item.preview',
    'item.upload_new',
    'folder.create',
  ],
  viewer: ['folder.list', 'item.preview', 'item.download'],
  previewer: ['folder.list', 'item.preview'],
  uploader: ['folder.list', 'item.upload_new', 'folder.create'],
};

export const ROLE_CAPABILITY_CHIPS: Record<ResourceRole, string[]> = Object.fromEntries(
  RESOURCE_ROLES.map((role) => [
    role,
    ROLE_CHIP_CAPABILITIES[role].map((capability) => CAPABILITY_CHIPS[capability]),
  ])
) as Record<ResourceRole, string[]>;

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

export function isAdvancedResourceRole(
  role: ResourceRole | null | undefined
): boolean {
  return role !== null && role !== undefined && ADVANCED_RESOURCE_ROLES.has(role);
}

/** Return capabilities in the canonical `CAPABILITIES` order. */
export function orderCapabilities(capabilities: Iterable<Capability>): Capability[] {
  const set = capabilities instanceof Set ? capabilities : new Set(capabilities);
  return CAPABILITIES.filter((capability) => set.has(capability));
}

export function capabilitiesForRole(role: ResourceRole | null | undefined): Capability[] {
  if (!role || !isResourceRole(role)) return [];
  return orderCapabilities(ROLE_CAPABILITIES[role]);
}

/** Union of capabilities granted by every role. */
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
 * Non-linear role composition. Mirrors the API `joinRoles` so the UI can show
 * `viewer + uploader = viewer_uploader` without round-tripping through a role
 * rank that would collapse orthogonal grants.
 */
export function synthesizeEffectiveRoleFromRoles(
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

export function synthesizeEffectiveAccessFromRoles(
  roles: Iterable<ResourceRole | null | undefined>
): EffectiveAccess {
  const granted = [...new Set([...roles].filter(isResourceRole))];
  const effectiveRole = synthesizeEffectiveRoleFromRoles(granted);
  if (!effectiveRole) return { effectiveRole: null, capabilities: [] };
  const capabilities = new Set<Capability>(ROLE_CAPABILITIES[effectiveRole]);
  for (const role of granted) {
    for (const capability of ROLE_CAPABILITIES[role]) capabilities.add(capability);
  }
  return { effectiveRole, capabilities: orderCapabilities(capabilities) };
}

/**
 * Japanese breakdown of contributing grants, e.g. `Viewer + Uploader`.
 * Order follows the supplied grants so inherited rows can be listed before
 * direct rows.
 */
export function formatRoleBreakdown(
  roles: Iterable<ResourceRole | null | undefined>
): string {
  const labels: string[] = [];
  for (const role of roles) {
    if (!role || !isResourceRole(role)) continue;
    const label = ROLE_META[role].label;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.join(' + ');
}

export type CapabilityTarget =
  | ResourceRole
  | {
      effectiveRole?: ResourceRole | null;
      role?: ResourceRole | null;
      capabilities?: readonly Capability[] | null;
    }
  | null
  | undefined;

function targetRole(target: CapabilityTarget): ResourceRole | null {
  if (!target) return null;
  if (typeof target === 'string') return isResourceRole(target) ? target : null;
  const role = target.effectiveRole ?? target.role ?? null;
  return isResourceRole(role) ? role : null;
}

function targetCapabilities(
  target: CapabilityTarget
): readonly Capability[] | null {
  if (!target || typeof target === 'string') return null;
  return Array.isArray(target.capabilities) ? target.capabilities : null;
}

/**
 * Capability check. An explicit `capabilities` array always wins; otherwise the
 * role fallback is derived from `ROLE_CAPABILITIES`.
 */
export function hasCapability(
  capabilities: readonly Capability[] | null | undefined,
  role: ResourceRole | null | undefined,
  capability: Capability
): boolean {
  if (Array.isArray(capabilities)) return capabilities.includes(capability);
  if (!role || !isResourceRole(role)) return false;
  return ROLE_CAPABILITIES[role].has(capability);
}

/** UI-wide capability gate. */
export function canAccess(
  target: CapabilityTarget,
  capability: Capability
): boolean {
  const capabilities = targetCapabilities(target);
  if (capabilities) return capabilities.includes(capability);
  return hasCapability(null, targetRole(target), capability);
}

/** Role groups applicable to a target; files omit the folder-only 投稿 group. */
export function roleGroupsForTarget(
  targetType: 'folder' | 'file',
  options?: { advancedRolesEnabled?: boolean }
): RoleGroup[] {
  if (targetType === 'file') {
    return ROLE_GROUPS.map((group) => ({
      ...group,
      roles: group.roles.filter((role) =>
        (FILE_ASSIGNABLE_ROLES as readonly ResourceRole[]).includes(role)
      ),
    })).filter((group) => group.roles.length > 0);
  }
  if (options?.advancedRolesEnabled === false) {
    return ROLE_GROUPS.map((group) => ({
      ...group,
      roles: group.roles.filter((role) => !ADVANCED_RESOURCE_ROLES.has(role)),
    })).filter((group) => group.roles.length > 0);
  }
  return ROLE_GROUPS.map((group) => ({ ...group, roles: [...group.roles] }));
}

/**
 * True when every capability of `requestedRole` is held by the caller.
 * Mirrors `apps/api/src/services/invite-policy.ts`.
 */
export function isRoleWithinCapabilitySubset(
  requestedRole: ResourceRole,
  callerCapabilities: readonly Capability[] | null | undefined
): boolean {
  if (!callerCapabilities) return false;
  const target = ROLE_CAPABILITIES[requestedRole];
  if (!target) return false;
  for (const capability of target) {
    if (!callerCapabilities.includes(capability)) return false;
  }
  return true;
}

export interface GrantableRolesInput {
  targetType: 'folder' | 'file';
  callerCapabilities: readonly Capability[];
  callerRole: ResourceRole | null;
  canManage: boolean;
  canInvite: boolean;
  advancedRolesEnabled: boolean;
}

/**
 * Roles the current caller may grant. Invite-only callers are capped by their
 * capability subset, so an editor can never grant `co_owner` / `owner`.
 */
export function grantableRolesForCaller(
  input: GrantableRolesInput
): ResourceRole[] {
  if (!input.canInvite) return [];
  const candidates: ResourceRole[] =
    input.targetType === 'file'
      ? [...FILE_ASSIGNABLE_ROLES]
      : [...RESOURCE_ROLES];

  return candidates.filter((role) => {
    if (ADVANCED_RESOURCE_ROLES.has(role) && !input.advancedRolesEnabled) {
      return false;
    }
    if (role === 'owner' && input.callerRole !== 'owner') return false;
    return isRoleWithinCapabilitySubset(role, input.callerCapabilities);
  });
}
