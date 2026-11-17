import type {
  AdminCapability,
  AdminDelegationPreset,
  AdminDelegationRow,
  AuthUser,
} from '@/types/files';

/**
 * P13-1 / TOM-73 pure Co-Admin helpers.
 *
 * Presets, capability labels and surface visibility live here so the API
 * contract, nav projection, dashboard gating and unit tests share one source
 * of truth without importing React or Next.js.
 */

export const ADMIN_DELEGATION_PRESETS: Record<
  AdminDelegationPreset,
  readonly AdminCapability[]
> = {
  helpdesk: [
    'admin.users.read',
    'admin.users.suspend',
    'admin.content.unlock',
    'admin.trash.manage',
  ],
  auditor: [
    'admin.insights.read',
    'admin.audit.read',
    'admin.reports.run',
    'admin.policies.read',
  ],
  group_manager: ['admin.users.read', 'admin.groups.manage'],
  content_operator: [
    'admin.content.unlock',
    'admin.trash.manage',
    'admin.links.revoke',
  ],
};

export const ADMIN_DELEGATION_PRESET_LABELS: Record<
  AdminDelegationPreset,
  string
> = {
  helpdesk: 'ヘルプデスク',
  auditor: '監査専任',
  group_manager: 'グループ管理者',
  content_operator: 'コンテンツ運用',
};

export const ADMIN_CAPABILITY_LABELS: Record<AdminCapability, string> = {
  'admin.insights.read': 'インサイト閲覧',
  'admin.users.read': 'メンバー閲覧',
  'admin.users.suspend': 'メンバー停止/再開',
  'admin.users.manage': 'メンバー管理 (sys_admin 専用)',
  'admin.guests.manage': 'ゲスト管理',
  'admin.groups.manage': 'グループ管理',
  'admin.content.unlock': 'コンテンツ検査/強制解除',
  'admin.root_folders.read': 'ルートフォルダ閲覧',
  'admin.permissions.audit': '権限監査',
  'admin.trash.manage': 'ゴミ箱の復元',
  'admin.links.revoke': '共有リンク失効',
  'admin.reports.run': 'レポート実行',
  'admin.audit.read': '監査ログ閲覧',
  'admin.policies.read': 'ポリシー閲覧',
  'admin.policies.edit': 'ポリシー編集',
};

export const ADMIN_CAPABILITY_ORDER: readonly AdminCapability[] = [
  'admin.insights.read',
  'admin.users.read',
  'admin.users.suspend',
  'admin.users.manage',
  'admin.guests.manage',
  'admin.groups.manage',
  'admin.content.unlock',
  'admin.root_folders.read',
  'admin.permissions.audit',
  'admin.trash.manage',
  'admin.links.revoke',
  'admin.reports.run',
  'admin.audit.read',
  'admin.policies.read',
  'admin.policies.edit',
];

export const ADMIN_DELEGATION_PRESET_IDS = Object.keys(
  ADMIN_DELEGATION_PRESETS
) as AdminDelegationPreset[];

/** Expand a preset in canonical order (used by the one-click apply button). */
export function expandAdminDelegationPreset(
  preset: AdminDelegationPreset
): AdminCapability[] {
  // Keep the API preset order intact; it is part of the documented contract.
  return [...ADMIN_DELEGATION_PRESETS[preset]];
}

export function hasAdminCapability(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined,
  capability: AdminCapability
): boolean {
  if (!user || user.userType === 'guest') return false;
  if (user.role === 'sys_admin') return true;
  if (user.role === 'sec_admin') {
    // Mirrors `SEC_ADMIN_ADMIN_CAPABILITIES` in the API. The server remains
    // authoritative; this projection only drives navigation and buttons.
    return capability !== 'admin.users.manage' &&
      capability !== 'admin.groups.manage';
  }
  return (user.adminCapabilities ?? []).includes(capability);
}

export function hasAnyAdminCapability(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined
): boolean {
  if (!user || user.userType === 'guest') return false;
  if (user.role === 'sys_admin' || user.role === 'sec_admin') return true;
  return (user.adminCapabilities ?? []).length > 0;
}

export function isGovernanceConsoleUser(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined
): boolean {
  return hasAnyAdminCapability(user);
}

export function isDelegatedCoAdmin(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined
): boolean {
  return (
    !!user &&
    user.userType !== 'guest' &&
    user.role === 'member' &&
    (user.adminCapabilities ?? []).length > 0
  );
}

export function isSysAdmin(
  user: Pick<AuthUser, 'role' | 'userType'> | null | undefined
): boolean {
  return !!user && user.userType !== 'guest' && user.role === 'sys_admin';
}

export function isSecAdmin(
  user: Pick<AuthUser, 'role' | 'userType'> | null | undefined
): boolean {
  return !!user && user.userType !== 'guest' && user.role === 'sec_admin';
}

export type AdminCapabilitySurface =
  | 'all'
  | 'insights'
  | 'content'
  | 'users'
  | 'settings'
  | 'reports';

const SURFACE_CAPABILITIES: Record<
  Exclude<AdminCapabilitySurface, 'all'>,
  readonly AdminCapability[]
> = {
  insights: ['admin.insights.read'],
  content: [
    'admin.content.unlock',
    'admin.trash.manage',
    'admin.root_folders.read',
  ],
  users: [
    'admin.users.read',
    'admin.users.suspend',
    'admin.users.manage',
    'admin.groups.manage',
    'admin.guests.manage',
  ],
  // Read-only policy visibility alone does not surface the settings tab: the
  // auditor preset intentionally stays on insights/reports. Mutating or
  // link-management capabilities do.
  settings: ['admin.policies.edit', 'admin.links.revoke', 'admin.guests.manage'],
  reports: [
    'admin.audit.read',
    'admin.reports.run',
    'admin.permissions.audit',
  ],
};

/** Capabilities that grant a console surface; used for messaging/tests. */
export function getAdminSurfaceCapabilities(
  surface: Exclude<AdminCapabilitySurface, 'all'>
): readonly AdminCapability[] {
  return SURFACE_CAPABILITIES[surface];
}

export function canAccessAdminSurface(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined,
  surface: AdminCapabilitySurface
): boolean {
  if (!hasAnyAdminCapability(user)) return false;
  if (surface === 'all') return true;
  return SURFACE_CAPABILITIES[surface].some((capability) =>
    hasAdminCapability(user, capability)
  );
}

/** First permitted focused route; `null` when only the integrated view is allowed. */
export function getFirstAccessibleAdminHref(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined
): string | null {
  for (const surface of ['insights', 'reports', 'content', 'users', 'settings'] as const) {
    if (canAccessAdminSurface(user, surface)) {
      return surface === 'insights'
        ? '/admin/insights'
        : surface === 'reports'
          ? '/admin/reports'
          : surface === 'content'
            ? '/admin/content'
            : surface === 'users'
              ? '/admin/users'
              : '/admin/settings';
    }
  }
  return null;
}

export function canManageAdminDelegations(
  user: Pick<AuthUser, 'role' | 'userType'> | null | undefined
): boolean {
  return isSysAdmin(user);
}

export function delegationPresetLabel(
  preset: string | null | undefined
): string {
  if (!preset) return 'カスタム';
  return (
    ADMIN_DELEGATION_PRESET_LABELS[preset as AdminDelegationPreset] ?? preset
  );
}

export function delegationScopeLabel(
  delegation: Pick<
    AdminDelegationRow,
    'scopeGroupId' | 'scopeRootFolderId' | 'groupName' | 'rootFolderName'
  >
): string {
  const parts: string[] = [];
  if (delegation.scopeGroupId) {
    parts.push(`グループ: ${delegation.groupName ?? delegation.scopeGroupId}`);
  }
  if (delegation.scopeRootFolderId) {
    parts.push(
      `ルート: ${delegation.rootFolderName ?? delegation.scopeRootFolderId}`
    );
  }
  return parts.length > 0 ? parts.join(' / ') : 'テナント全体';
}

/** Deliberately cannot be delegated; rendered as an immutable notice. */
export const SYS_ADMIN_ONLY_CAPABILITIES: readonly AdminCapability[] = [
  'admin.users.manage',
];

export const SYS_ADMIN_ONLY_OPERATIONS = [
  '委任の作成・変更・削除',
  'SCIM トークン管理',
  'メンバーのオフボーディング',
  'テナント全セッションの緊急失効',
  'ゴミ箱の完全空化',
  'ルートフォルダの作成・所有者譲渡・アーカイブ/復元',
  'ユーザーロール変更・新規メンバー登録',
] as const;

export function adminDelegationErrorMessage(
  code: string | null | undefined,
  fallback: string
): string {
  switch (code) {
    case 'OUT_OF_DELEGATION_SCOPE':
      return '委任スコープ外の操作は許可されていません。';
    case 'PRIVILEGE_ESCALATION_FORBIDDEN':
      return '特権アカウント・他の共同管理者・自分自身への操作は禁止されています。';
    case 'DELEGATION_EXISTS':
      return 'このメンバーには既に有効な共同管理者委任があります。';
    case 'GUEST_DELEGATION_FORBIDDEN':
      return 'ゲストアカウントには管理権限を委任できません。';
    case 'DELEGATION_USER_NOT_FOUND':
    case 'DELEGATION_TARGET_NOT_MEMBER':
      return '委任先はテナント内の一般メンバーを選択してください。';
    case 'DELEGATION_GROUP_NOT_FOUND':
      return '指定したグループが見つかりません。';
    case 'DELEGATION_ROOT_FOLDER_NOT_FOUND':
    case 'DELEGATION_ROOT_FOLDER_INVALID':
      return '指定したルートフォルダが見つからないか、ルートではありません。';
    default:
      return fallback;
  }
}
