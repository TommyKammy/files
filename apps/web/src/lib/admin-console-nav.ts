import {
  GUEST_AUDIT_ACTION_PREFIXES,
  PERMISSION_AUDIT_ACTION_PREFIXES,
  ROOT_FOLDER_AUDIT_ACTIONS,
  USER_AUDIT_ACTION_PREFIXES,
} from '@/lib/admin-audit';
import type { UserRole } from '@/types/files';

/**
 * Pure definitions for the admin console information architecture.
 *
 * Keeping the nav tree, per-section fetch plan and audit-preset parsing here
 * makes the routing rules unit-testable without rendering React or Next.js.
 */

export type AdminConsoleSection =
  | 'all'
  | 'insights'
  | 'content'
  | 'users'
  | 'settings'
  | 'reports';

/** Roles that currently receive the governance console. */
export type AdminConsoleRole = Extract<UserRole, 'sys_admin' | 'sec_admin'>;

export interface AdminConsoleNavItem {
  section: AdminConsoleSection;
  href: string;
  label: string;
  heading: string;
  summary: string;
  /**
   * Future Co-Admin filters can restrict individual destinations by extending
   * this role list without changing the shell or the route components.
   */
  roles: readonly AdminConsoleRole[];
}

export const ADMIN_CONSOLE_NAV_ITEMS: readonly AdminConsoleNavItem[] = [
  {
    section: 'all',
    href: '/admin',
    label: 'すべて（統合ビュー）',
    heading: 'ガバナンス & セキュリティ統合ダッシュボード',
    summary: 'D1 O(1) 統計・Workers AI 分類レビュー・緊急失効・不変監査ログ',
    roles: ['sys_admin', 'sec_admin'],
  },
  {
    section: 'insights',
    href: '/admin/insights',
    label: 'インサイト',
    heading: 'インサイト',
    summary: 'ストレージ使用量・機密分類内訳・D1 メタデータ容量を監視します。',
    roles: ['sys_admin', 'sec_admin'],
  },
  {
    section: 'content',
    href: '/admin/content',
    label: 'コンテンツ',
    heading: 'コンテンツ',
    summary:
      '全社横断コンテンツ検索・AI 分類提案のレビュー・ルートフォルダ管理・テナントゴミ箱を一元管理します。',
    roles: ['sys_admin', 'sec_admin'],
  },
  {
    section: 'users',
    href: '/admin/users',
    label: 'ユーザーとグループ',
    heading: 'ユーザーとグループ',
    summary:
      '社内メンバー・グループ・SCIM トークンと外部ゲストの検索・ロール/クォータ管理・停止/再開・一括登録・監査を管理します。',
    roles: ['sys_admin', 'sec_admin'],
  },
  {
    section: 'settings',
    href: '/admin/settings',
    label: 'ガバナンスと設定',
    heading: 'ガバナンスと設定',
    summary:
      'アクセス制御・共有リンクポリシー・ゲストポリシーを一括して管理します。',
    roles: ['sys_admin', 'sec_admin'],
  },
  {
    section: 'reports',
    href: '/admin/reports',
    label: 'レポートと監査',
    heading: 'レポートと監査',
    summary:
      'アクセス権監査・不変監査ログ・CSV エクスポートを確認します。',
    roles: ['sys_admin', 'sec_admin'],
  },
] as const;

export const ADMIN_ROLE_BADGE_LABELS: Record<AdminConsoleRole, string> = {
  sys_admin: 'システム管理者 (sys_admin)',
  sec_admin: 'セキュリティ管理者 (sec_admin)',
};

export function isAdminConsoleRole(
  role: UserRole | null | undefined
): role is AdminConsoleRole {
  return role === 'sys_admin' || role === 'sec_admin';
}

/** Role-aware nav projection; members receive no console destinations. */
export function getAdminConsoleNavItems(
  role: UserRole | null | undefined
): AdminConsoleNavItem[] {
  if (!isAdminConsoleRole(role)) return [];
  return ADMIN_CONSOLE_NAV_ITEMS.filter((item) => item.roles.includes(role));
}

export function getAdminConsoleNavItem(
  section: AdminConsoleSection
): AdminConsoleNavItem {
  return (
    ADMIN_CONSOLE_NAV_ITEMS.find((item) => item.section === section) ??
    ADMIN_CONSOLE_NAV_ITEMS[0]!
  );
}

/** Maps a pathname to the section that owns it (unknown paths fall back to all). */
export function getAdminConsoleSectionFromPathname(
  pathname: string | null | undefined
): AdminConsoleSection {
  if (!pathname?.startsWith('/admin')) return 'all';
  const pathOnly = pathname.split(/[?#]/, 1)[0] ?? '';
  const segment = pathOnly.replace(/\/+$/, '').split('/')[2];
  if (!segment) return 'all';
  return (
    ADMIN_CONSOLE_NAV_ITEMS.find((item) => item.section === segment)?.section ??
    'all'
  );
}

export interface AdminSectionFetchPlan {
  storageStats: boolean;
  aiSuggestions: boolean;
  sharedLinks: boolean;
  policies: boolean;
  auditLogs: boolean;
  inheritanceConflicts: boolean;
  /**
   * True when every dashboard value is fetched by the section's own child
   * components, so the shell can stop showing its initial loading surface
   * immediately.
   */
  completesImmediately: boolean;
}

/**
 * Section -> API mapping used by `useGovernanceDashboard`.
 *
 * `all` keeps the original bulk dashboard load. Focused routes deliberately
 * fetch less so deep links never pay for unrelated admin endpoints.
 */
export const ADMIN_SECTION_FETCH_PLANS: Record<
  AdminConsoleSection,
  AdminSectionFetchPlan
> = {
  all: {
    storageStats: true,
    aiSuggestions: true,
    sharedLinks: true,
    policies: true,
    auditLogs: true,
    inheritanceConflicts: true,
    completesImmediately: false,
  },
  insights: {
    storageStats: true,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: false,
    inheritanceConflicts: false,
    completesImmediately: false,
  },
  content: {
    storageStats: false,
    aiSuggestions: true,
    sharedLinks: false,
    policies: false,
    auditLogs: false,
    inheritanceConflicts: false,
    completesImmediately: false,
  },
  users: {
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: false,
    inheritanceConflicts: false,
    completesImmediately: true,
  },
  settings: {
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: true,
    policies: true,
    auditLogs: false,
    inheritanceConflicts: true,
    completesImmediately: false,
  },
  reports: {
    storageStats: false,
    aiSuggestions: false,
    sharedLinks: false,
    policies: false,
    auditLogs: true,
    inheritanceConflicts: false,
    completesImmediately: false,
  },
};

export function getAdminSectionFetchPlan(
  section: AdminConsoleSection
): AdminSectionFetchPlan {
  return ADMIN_SECTION_FETCH_PLANS[section] ?? ADMIN_SECTION_FETCH_PLANS.all;
}

export function adminSectionHasDashboardFetch(
  section: AdminConsoleSection
): boolean {
  const plan = getAdminSectionFetchPlan(section);
  return (
    plan.storageStats ||
    plan.aiSuggestions ||
    plan.sharedLinks ||
    plan.policies ||
    plan.auditLogs ||
    plan.inheritanceConflicts
  );
}

export type AdminAuditPreset = 'rootFolder' | 'guest' | 'permission' | 'user';

export interface AdminAuditPresetConfig {
  actions: readonly string[];
  actionPrefixes: readonly string[];
  presetKind: 'permission' | 'guest' | 'user' | null;
}

export const ADMIN_AUDIT_PRESETS: Record<
  AdminAuditPreset,
  AdminAuditPresetConfig
> = {
  rootFolder: {
    actions: ROOT_FOLDER_AUDIT_ACTIONS,
    actionPrefixes: [],
    presetKind: null,
  },
  guest: {
    actions: [],
    actionPrefixes: GUEST_AUDIT_ACTION_PREFIXES,
    presetKind: 'guest',
  },
  permission: {
    actions: [],
    actionPrefixes: PERMISSION_AUDIT_ACTION_PREFIXES,
    presetKind: 'permission',
  },
  user: {
    actions: [],
    actionPrefixes: USER_AUDIT_ACTION_PREFIXES,
    presetKind: 'user',
  },
};

export const AUDIT_PRESET_QUERY_KEY = 'auditPreset';

/** Parses `/admin/reports?auditPreset=...` into a known preset or null. */
export function parseAdminAuditPreset(
  value: string | string[] | null | undefined
): AdminAuditPreset | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/[_-]/g, '');
  if (normalized === 'rootfolder') return 'rootFolder';
  if (normalized === 'guest') return 'guest';
  if (normalized === 'permission') return 'permission';
  if (normalized === 'user') return 'user';
  return null;
}

export function buildAdminAuditPresetHref(
  preset: AdminAuditPreset
): string {
  return `/admin/reports?${AUDIT_PRESET_QUERY_KEY}=${preset}`;
}
