import type { AdminCapability, AdminScope } from '../../types/api';

export type { AdminCapability, AdminScope } from '../../types/api';

/**
 * P13-1 / TOM-73 Co-Admin delegation and scoped capability resolution.
 *
 * A Co-Admin is an ordinary internal `member` that `sys_admin` explicitly
 * delegated a subset of admin capabilities to. Delegation never changes
 * `users.role`, so every legacy `sys_admin`-only handler keeps rejecting
 * Co-Admins even when a custom capability set contains a similarly named
 * capability. The resolution helpers below are also used by
 * `sessionAuthMiddleware`, `/api/auth/me` and `/api/sync/bootstrap` so the
 * client can render only permitted navigation and sections.
 */

export const ADMIN_CAPABILITIES = [
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
] as const;

export const ADMIN_DELEGATION_PRESETS = {
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
} as const satisfies Record<string, readonly AdminCapability[]>;

export type AdminDelegationPreset = keyof typeof ADMIN_DELEGATION_PRESETS;

/**
 * `sec_admin` keeps the security-operator surface it had before TOM-73.
 * `admin.users.manage`, `admin.groups.manage` and tenant destructive actions
 * remain absent; the route handlers still enforce the legacy sys_admin-only
 * checks (offboarding, revoke-all, SCIM, delegation management, ...).
 */
export const SEC_ADMIN_ADMIN_CAPABILITIES: readonly AdminCapability[] = [
  'admin.insights.read',
  'admin.users.read',
  'admin.users.suspend',
  'admin.guests.manage',
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

export interface AdminAuthorization {
  capabilities: AdminCapability[];
  scope: AdminScope | null;
}

export interface AdminDelegationRow {
  id: string;
  tenantId: string;
  userId: string;
  preset: string | null;
  permissions: AdminCapability[];
  scopeGroupId: string | null;
  scopeRootFolderId: string | null;
  note: string | null;
  grantedBy: string;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  userEmail: string | null;
  userStatus: 'active' | 'suspended' | null;
  groupName: string | null;
  rootFolderName: string | null;
  grantedByName: string | null;
}

export interface AdminDelegationListResult {
  delegations: AdminDelegationRow[];
  presets: Array<{
    id: AdminDelegationPreset;
    capabilities: AdminCapability[];
  }>;
  capabilities: Array<{
    id: AdminCapability;
    label: string;
  }>;
}

export class AdminDelegationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminDelegationError';
  }
}

export interface RawDelegationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  preset: string | null;
  permissions_json: string;
  scope_group_id: string | null;
  scope_root_folder_id: string | null;
  note: string | null;
  granted_by: string;
  created_at: string;
  updated_at: string;
  user_name: string | null;
  user_email: string | null;
  user_status: 'active' | 'suspended' | null;
  group_name: string | null;
  root_folder_name: string | null;
  granted_by_name: string | null;
}

export const ADMIN_DELEGATION_CAPABILITY_LABELS: Record<
  AdminCapability,
  string
> = {
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

/** Build the JSON envelope every Co-Admin error response uses. */
export function adminDelegationErrorBody(err: AdminDelegationError): {
  error: string;
  code: string;
} {
  return { error: err.message, code: err.code };
}

/** Normalize a header/body-supplied scope value. */
export function normalizeDelegationScopeValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
