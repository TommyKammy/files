import {
  getAdminConsoleNavItem,
  getAdminSectionFetchPlan,
  isAdminConsoleRole,
  parseAdminAuditPreset,
  type AdminConsoleSection,
  type AdminSectionFetchPlan,
} from '@/lib/admin-console-nav';
import {
  hasAdminCapability,
  isGovernanceConsoleUser,
} from '@/lib/admin-delegations';
import type { AdminCapability, AuthUser } from '@/types/files';

/**
 * TOM-74 pure tab definitions for the admin console.
 *
 * Every console section exposes a horizontal WAI-ARIA tablist whose tab set is
 * a role/capability projection. Keeping the definitions, visibility filter,
 * URL parsing and per-tab fetch plan here makes the contract unit-testable
 * without React, Next.js or a browser.
 */

export type AdminAllTab =
  | 'overview'
  | 'content'
  | 'users'
  | 'settings'
  | 'integrations'
  | 'reports';

export type AdminContentTab =
  | 'manager'
  | 'root-folders'
  | 'trash'
  | 'file-requests'
  | 'ai-classification';

export type AdminUsersTab = 'members' | 'groups' | 'guests' | 'delegations';

export type AdminSettingsTab =
  | 'sharing'
  | 'access'
  | 'security'
  | 'compliance'
  | 'integrations';

export type AdminReportsTab = 'audit-logs' | 'permissions' | 'jobs';

export type AdminConsoleTabId =
  | AdminAllTab
  | AdminContentTab
  | AdminUsersTab
  | AdminSettingsTab
  | AdminReportsTab;

export interface AdminConsoleTabItem<T extends string = AdminConsoleTabId> {
  id: T;
  section: AdminConsoleSection;
  label: string;
  summary: string;
  capabilities: readonly AdminCapability[];
  ownedApiPrefixes: readonly string[];
}

export const ADMIN_CONSOLE_TABS: Record<
  AdminConsoleSection,
  readonly AdminConsoleTabItem[]
> = {
  all: [
    {
      id: 'overview',
      section: 'all',
      label: 'インサイト・概要',
      summary:
        'D1 O(1) ストレージ統計・セキュリティブロック・共有リスクの KPI を確認します。',
      capabilities: ['admin.insights.read'],
      ownedApiPrefixes: [
        '/api/admin/insights',
        '/api/admin/storage-stats',
      ],
    },
    {
      id: 'content',
      section: 'all',
      label: 'コンテンツ',
      summary:
        '全社横断のコンテンツ検索・AI 分類レビュー・ルートフォルダ管理・ゴミ箱・ファイルリクエストをまとめて操作します。',
      capabilities: [
        'admin.content.unlock',
        'admin.root_folders.read',
        'admin.trash.manage',
      ],
      ownedApiPrefixes: [
        '/api/admin/content',
        '/api/admin/root-folders',
        '/api/admin/trash',
        '/api/admin/file-requests',
        '/api/admin/ai-suggestions',
      ],
    },
    {
      id: 'users',
      section: 'all',
      label: 'ユーザーとグループ',
      summary:
        '社内メンバー・グループ・外部コラボレーター・共同管理者の権限と停止状態を管理します。',
      capabilities: [
        'admin.users.read',
        'admin.users.suspend',
        'admin.users.manage',
        'admin.groups.manage',
        'admin.guests.manage',
      ],
      ownedApiPrefixes: [
        '/api/admin/users',
        '/api/admin/groups',
        '/api/admin/guests',
        '/api/admin/delegations',
      ],
    },
    {
      id: 'settings',
      section: 'all',
      label: 'Enterprise設定',
      summary:
        '共有・アクセス制御・セキュリティ・コンプライアンス・テナントポリシーを一括して管理します。',
      capabilities: [
        'admin.policies.edit',
        'admin.policies.read',
        'admin.links.revoke',
        'admin.guests.manage',
      ],
      ownedApiPrefixes: [
        '/api/admin/settings-bundle',
        '/api/admin/policies',
        '/api/admin/shared-links',
        '/api/admin/tos',
        '/api/admin/sessions',
        '/api/admin/sso',
      ],
    },
    {
      id: 'integrations',
      section: 'all',
      label: '統合',
      summary:
        'SCIM プロビジョニング・SIEM Webhook・OIDC SSO などの外部システム連携を管理します。',
      capabilities: [
        'admin.policies.read',
        'admin.policies.edit',
        'admin.users.read',
      ],
      ownedApiPrefixes: [
        '/api/admin/settings-bundle',
        '/api/admin/scim-tokens',
        '/api/admin/siem',
        '/api/admin/sso',
      ],
    },
    {
      id: 'reports',
      section: 'all',
      label: 'レポートと監査',
      summary:
        '不変監査ログ・アクセス権監査・非同期 CSV レポート出力と定期スケジュールを確認します。',
      capabilities: [
        'admin.audit.read',
        'admin.permissions.audit',
        'admin.reports.run',
      ],
      ownedApiPrefixes: [
        '/api/audit-logs',
        '/api/admin/permissions',
        '/api/admin/reports',
      ],
    },
  ],
  insights: [],
  content: [
    {
      id: 'manager',
      section: 'content',
      label: 'コンテンツマネージャー',
      summary:
        '全社横断のファイル検索・検査プレビュー・強制ロック解除を実行します。',
      capabilities: ['admin.content.unlock'],
      ownedApiPrefixes: ['/api/admin/content'],
    },
    {
      id: 'root-folders',
      section: 'content',
      label: 'ルートフォルダ管理',
      summary:
        'ルートフォルダの作成・所有者譲渡・アーカイブ/復元と監査プリセットを管理します。',
      capabilities: ['admin.root_folders.read'],
      ownedApiPrefixes: ['/api/admin/root-folders'],
    },
    {
      id: 'trash',
      section: 'content',
      label: 'ゴミ箱',
      summary:
        'テナント全体の削除済みアイテムを復元・完全削除し、操作履歴を確認します。',
      capabilities: ['admin.trash.manage'],
      ownedApiPrefixes: ['/api/admin/trash', '/api/audit-logs'],
    },
    {
      id: 'file-requests',
      section: 'content',
      label: 'ファイルリクエスト',
      summary:
        '全社のファイルリクエストを検索し、緊急停止や再開を一括して管理します。',
      capabilities: ['admin.content.unlock'],
      ownedApiPrefixes: ['/api/admin/file-requests'],
    },
    {
      id: 'ai-classification',
      section: 'content',
      label: 'AI 分類レビュー',
      summary:
        'Workers AI が提案した機密区分をレビューし、承認・上書きを実行します。',
      capabilities: ['admin.content.unlock'],
      ownedApiPrefixes: ['/api/admin/ai-suggestions'],
    },
  ],
  users: [
    {
      id: 'members',
      section: 'users',
      label: '管理対象ユーザー',
      summary:
        '社内メンバーのロール・クォータ・停止/再開・一括登録と SCIM トークンを管理します。',
      capabilities: [
        'admin.users.read',
        'admin.users.suspend',
        'admin.users.manage',
      ],
      ownedApiPrefixes: ['/api/admin/users'],
    },
    {
      id: 'groups',
      section: 'users',
      label: 'グループ',
      summary:
        'グループの作成・メンバー編成・テナント全体のアクセス権を管理します。',
      capabilities: ['admin.users.read', 'admin.groups.manage'],
      ownedApiPrefixes: ['/api/admin/groups'],
    },
    {
      id: 'guests',
      section: 'users',
      label: '外部コラボレーター',
      summary:
        'ゲストの招待・有効期限・外部組織・アクセス停止を管理します。',
      capabilities: ['admin.guests.manage'],
      ownedApiPrefixes: ['/api/admin/guests'],
    },
    {
      id: 'delegations',
      section: 'users',
      label: '共同管理者 (Co-Admin)',
      summary:
        'メンバーへ委任する管理 Capability とグループ/ルートフォルダのスコープを管理します。',
      capabilities: ['admin.users.read', 'admin.users.manage'],
      ownedApiPrefixes: ['/api/admin/delegations'],
    },
  ],
  settings: [
    {
      id: 'sharing',
      section: 'settings',
      label: 'コンテンツと共有',
      summary:
        '共有リンクの緊急失効・ゲストポリシー・招待ポリシー・透かし設定を管理します。',
      capabilities: [
        'admin.links.revoke',
        'admin.policies.read',
        'admin.policies.edit',
        'admin.guests.manage',
      ],
      ownedApiPrefixes: [
        '/api/admin/settings-bundle',
        '/api/admin/shared-links',
        '/api/admin/policies',
        '/api/admin/guests',
      ],
    },
    {
      id: 'access',
      section: 'settings',
      label: 'アクセス制御とフォルダ構成',
      summary:
        '高度ロール・フォルダ構成モード・権限継承モード・招待ポリシーを管理します。',
      capabilities: ['admin.policies.edit', 'admin.policies.read'],
      ownedApiPrefixes: [
        '/api/admin/settings-bundle',
        '/api/admin/policies',
      ],
    },
    {
      id: 'security',
      section: 'settings',
      label: 'セキュリティとセッション',
      summary:
        'IP 許可リスト・OIDC SSO・セッション失効・セキュリティポリシーを管理します。',
      capabilities: [
        'admin.policies.read',
        'admin.policies.edit',
        'admin.users.read',
      ],
      ownedApiPrefixes: [
        '/api/admin/settings-bundle',
        '/api/admin/policies',
        '/api/admin/sso',
        '/api/admin/sessions',
      ],
    },
    {
      id: 'compliance',
      section: 'settings',
      label: 'カスタム設定・利用規約',
      summary:
        'テナント固有の利用規約・コンプライアンス表示・監査保持設定を管理します。',
      capabilities: ['admin.policies.read', 'admin.policies.edit'],
      ownedApiPrefixes: [
        '/api/admin/settings-bundle',
        '/api/admin/tos',
        '/api/admin/policies',
      ],
    },
    {
      id: 'integrations',
      section: 'settings',
      label: '統合 (Integrations)',
      summary:
        'SCIM プロビジョニング・SIEM Webhook・OIDC SSO の接続情報を管理します。',
      capabilities: [
        'admin.policies.read',
        'admin.policies.edit',
        'admin.users.read',
      ],
      ownedApiPrefixes: [
        '/api/admin/settings-bundle',
        '/api/admin/scim-tokens',
        '/api/admin/siem',
        '/api/admin/sso',
      ],
    },
  ],
  reports: [
    {
      id: 'audit-logs',
      section: 'reports',
      label: '監査ログ',
      summary:
        'テナント全体の不変監査ログをアクション・主体・日付で絞り込んで確認します。',
      capabilities: ['admin.audit.read'],
      ownedApiPrefixes: ['/api/audit-logs'],
    },
    {
      id: 'permissions',
      section: 'reports',
      label: 'アクセス権監査',
      summary:
        'フォルダ権限の継承・競合・過剰付与を監査し、是正対象を特定します。',
      capabilities: ['admin.permissions.audit'],
      ownedApiPrefixes: ['/api/admin/permissions'],
    },
    {
      id: 'jobs',
      section: 'reports',
      label: 'レポート出力・定期スケジュール',
      summary:
        'Queues/R2 の非同期 CSV レポートジョブと定期出力スケジュールを管理します。',
      capabilities: ['admin.reports.run'],
      ownedApiPrefixes: ['/api/admin/reports'],
    },
  ],
};

export function getAdminTabsForSection(
  section: AdminConsoleSection
): readonly AdminConsoleTabItem[] {
  return ADMIN_CONSOLE_TABS[section] ?? [];
}

/**
 * Role-aware tab projection.
 *
 * sys_admin / sec_admin see every tab of the section. A delegated Co-Admin
 * only sees tabs where at least one required capability is granted, so the
 * tablist can never select a panel whose APIs would immediately 403.
 */
export function getVisibleAdminTabs(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined,
  section: AdminConsoleSection
): AdminConsoleTabItem[] {
  if (!user || !isGovernanceConsoleUser(user)) return [];
  const tabs = getAdminTabsForSection(section);
  if (isAdminConsoleRole(user.role)) return [...tabs];
  return tabs.filter((tab) =>
    tab.capabilities.some((capability) =>
      hasAdminCapability(user, capability)
    )
  );
}

/** Normalizes a `?tab=` query value (arrays take the first entry). */
export function parseAdminTabQuery(
  raw: string | string[] | null | undefined
): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return value ? value : null;
}

/**
 * Resolves the active tab: explicit `?tab=`, then the audit-preset deep link
 * (`/admin/reports?auditPreset=...`), then the first visible tab.
 */
export function resolveActiveAdminTab(
  user: Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'> | null | undefined,
  section: AdminConsoleSection,
  rawTab?: string | string[] | null,
  options?: { auditPreset?: string | string[] | null }
): AdminConsoleTabItem | null {
  const visible = getVisibleAdminTabs(user, section);
  if (visible.length === 0) return null;

  const parsed = parseAdminTabQuery(rawTab);
  if (parsed) {
    const requested = visible.find((tab) => tab.id === parsed);
    if (requested) return requested;
  }

  if (
    section === 'reports' &&
    parseAdminAuditPreset(options?.auditPreset) !== null
  ) {
    const auditTab = visible.find((tab) => tab.id === 'audit-logs');
    if (auditTab) return auditTab;
  }

  return visible[0] ?? null;
}

/** Builds `/admin/<section>?tab=...&extra=...` without dropping the route. */
export function buildAdminTabHref(
  section: AdminConsoleSection,
  tabId: string,
  extraParams?: Record<string, string | null | undefined>
): string {
  const params = new URLSearchParams();
  params.set('tab', tabId);
  for (const [key, value] of Object.entries(extraParams ?? {})) {
    if (value === null || value === undefined) continue;
    params.set(key, value);
  }
  return `${getAdminConsoleNavItem(section).href}?${params.toString()}`;
}

export function getAdminTabDomId(
  section: AdminConsoleSection,
  tabId: string
): string {
  return `admin-tab-${section}-${tabId}`;
}

export function getAdminTabPanelDomId(
  section: AdminConsoleSection,
  tabId: string
): string {
  return `admin-tabpanel-${section}-${tabId}`;
}

function emptyFetchPlan(): AdminSectionFetchPlan {
  return {
    insights: false,
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: false,
    inheritanceConflicts: false,
    settingsBundle: false,
    completesImmediately: false,
  };
}

function fetchPlan(
  overrides: Partial<AdminSectionFetchPlan>
): AdminSectionFetchPlan {
  return { ...emptyFetchPlan(), ...overrides };
}

/**
 * Per-tab fetch plan for delayed mounting.
 *
 * Only the active tab pays for its shell-level hydration; child components
 * that own their own endpoints mark the shell as complete immediately.
 */
export function getAdminTabFetchPlan(
  section: AdminConsoleSection,
  tabId: string | null | undefined
): AdminSectionFetchPlan {
  switch (section) {
    case 'all':
      switch (tabId) {
        case 'overview':
          return fetchPlan({ insights: true, storageStats: true });
        case 'content':
          return fetchPlan({ aiSuggestions: true });
        case 'users':
          return fetchPlan({ completesImmediately: true });
        case 'settings':
        case 'integrations':
          return fetchPlan({ settingsBundle: true });
        case 'reports':
          return fetchPlan({ auditLogs: true });
        default:
          return getAdminSectionFetchPlan('all');
      }
    case 'content':
      switch (tabId) {
        case 'manager':
        case 'root-folders':
        case 'trash':
        case 'file-requests':
          return fetchPlan({ completesImmediately: true });
        case 'ai-classification':
          return fetchPlan({ aiSuggestions: true });
        default:
          return getAdminSectionFetchPlan('content');
      }
    case 'users':
      switch (tabId) {
        case 'members':
        case 'groups':
        case 'guests':
        case 'delegations':
          return fetchPlan({ completesImmediately: true });
        default:
          return getAdminSectionFetchPlan('users');
      }
    case 'settings':
      switch (tabId) {
        case 'sharing':
        case 'access':
        case 'security':
        case 'compliance':
        case 'integrations':
          return fetchPlan({ settingsBundle: true });
        default:
          return getAdminSectionFetchPlan('settings');
      }
    case 'reports':
      switch (tabId) {
        case 'audit-logs':
          return fetchPlan({ auditLogs: true });
        case 'permissions':
        case 'jobs':
          return fetchPlan({ completesImmediately: true });
        default:
          return getAdminSectionFetchPlan('reports');
      }
    case 'insights':
    default:
      return getAdminSectionFetchPlan(section);
  }
}
