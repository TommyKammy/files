import type {
  AdminCapability,
  AdminSsoStatusResponse,
  AdminTosPolicy,
  AuthUser,
  TenantPolicyRow,
} from '@/types/files';
import type { AdminSettingsTab } from '@/lib/admin-console-tabs';
import { hasAdminCapability } from '@/lib/admin-delegations';

/**
 * Approach A pure model for the Enterprise settings workbench.
 *
 * The workbench presents a 2-pane category tree, instant keyword search and a
 * single-topic surface. Keeping the topic catalogue, capability projection,
 * search and live status badge logic here makes the whole contract testable
 * without React or a browser.
 */

export type EnterpriseSettingGroupId = AdminSettingsTab;

export type EnterpriseSettingTopicId =
  | 'shared-links'
  | 'guest-policy'
  | 'file-requests'
  | 'roles-and-invite'
  | 'folder-structure'
  | 'content-inspection'
  | 'ip-allowlist'
  | 'sso-oidc'
  | 'sessions'
  | 'tos'
  | 'retention-quota-ai'
  | 'branding'
  | 'integrations-catalog';

export interface EnterpriseSettingGroup {
  id: EnterpriseSettingGroupId;
  label: string;
  summary: string;
  topicIds: readonly EnterpriseSettingTopicId[];
}

export interface EnterpriseSettingTopic {
  id: EnterpriseSettingTopicId;
  group: EnterpriseSettingGroupId;
  label: string;
  summary: string;
  keywords: readonly string[];
  /** At least one capability grants the topic; sys_admin/sec_admin bypass. */
  capabilities: readonly AdminCapability[];
}

export const ENTERPRISE_SETTING_GROUPS: readonly EnterpriseSettingGroup[] = [
  {
    id: 'sharing',
    label: '共有と外部連携',
    summary: '共有リンク・外部ゲスト・ファイルリクエストを管理します。',
    topicIds: ['shared-links', 'guest-policy', 'file-requests'],
  },
  {
    id: 'access',
    label: 'アクセスと構成',
    summary: '高度ロール・フォルダ構成・権限継承・コンテンツ検査を管理します。',
    topicIds: ['roles-and-invite', 'folder-structure', 'content-inspection'],
  },
  {
    id: 'security',
    label: 'セキュリティと認証',
    summary: 'IP 許可リスト・OIDC SSO・アクティブセッションを管理します。',
    topicIds: ['ip-allowlist', 'sso-oidc', 'sessions'],
  },
  {
    id: 'compliance',
    label: 'ガバナンス・規約・保持',
    summary: '利用規約・保持期間・容量・ブランディングを管理します。',
    topicIds: ['tos', 'retention-quota-ai', 'branding'],
  },
  {
    id: 'integrations',
    label: '統合・外部連携',
    summary: 'SCIM プロビジョニング・SIEM Webhook・IdP 連携を管理します。',
    topicIds: ['integrations-catalog'],
  },
] as const;

export const ENTERPRISE_SETTING_TOPICS: readonly EnterpriseSettingTopic[] = [
  {
    id: 'shared-links',
    group: 'sharing',
    label: '共有リンクポリシー',
    summary:
      '社内SSO限定・Confidential動的透かし・編集リンク許可・最大有効期限を管理します。',
    keywords: [
      '共有リンク',
      '透かし',
      'ウォーターマーク',
      'SSO限定',
      '編集リンク',
      '有効期限',
      '緊急失効',
      'watermark',
      'shared link',
    ],
    capabilities: [
      'admin.links.revoke',
      'admin.policies.read',
      'admin.policies.edit',
    ],
  },
  {
    id: 'guest-policy',
    group: 'sharing',
    label: '外部ゲスト招待',
    summary:
      '外部コラボレーターの招待可否・昇格ロール・許可ドメイン・招待期限・セッション時間を管理します。',
    keywords: [
      'ゲスト',
      '外部コラボレーター',
      '招待',
      'ドメイン',
      '有効期限',
      'セッション',
      'guest',
    ],
    capabilities: [
      'admin.guests.manage',
      'admin.policies.read',
      'admin.policies.edit',
    ],
  },
  {
    id: 'file-requests',
    group: 'sharing',
    label: 'ファイルリクエスト制限',
    summary:
      'ファイルリクエストの有効化・最大アップロードサイズ・許可拡張子強制を管理します。',
    keywords: [
      'ファイルリクエスト',
      'アップロード上限',
      'サイズ',
      '拡張子',
      'file request',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'roles-and-invite',
    group: 'access',
    label: 'ロールと招待権限',
    summary:
      '高度ロール (8ロール) の有効化とテナント全体の招待ポリシーを管理します。',
    keywords: [
      '高度ロール',
      '8ロール',
      'ロール',
      '招待ポリシー',
      '招待権限',
      'Uploader',
      'Previewer',
      'role',
      'invite',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'folder-structure',
    group: 'access',
    label: 'フォルダ構成と権限継承',
    summary:
      'オープン/クローズド構成モードと権限継承モード (Standard/Waterfall/Restricted) を管理します。',
    keywords: [
      'フォルダ構成',
      'オープン',
      'クローズド',
      'ルートフォルダ',
      '権限継承',
      'Waterfall',
      'Restricted',
      '競合',
      'inheritance',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'content-inspection',
    group: 'access',
    label: 'コンテンツ検査ポリシー',
    summary:
      '管理者によるコンテンツ検査レベル (メタデータのみ / 本文プレビュー許可) を管理します。',
    keywords: [
      'コンテンツ検査',
      'プレビュー',
      'メタデータ',
      '検査ポリシー',
      'inspect',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'ip-allowlist',
    group: 'security',
    label: 'IP 許可リスト',
    summary:
      'CIDR ベースの接続元 IP 制限と適用スコープを管理します。',
    keywords: [
      'IP',
      '許可リスト',
      'CIDR',
      'アクセス制限',
      'ロックアウト',
      'allowlist',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'sso-oidc',
    group: 'security',
    label: 'SSO (OIDC) 認証統制',
    summary:
      'OIDC シングルサインオン強制ポリシー・対象ドメイン・IdP 接続状態を管理します。',
    keywords: [
      'SSO',
      'OIDC',
      'シングルサインオン',
      'IdP',
      'コールバック',
      'ドメイン',
      '認証',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'sessions',
    group: 'security',
    label: 'アクティブセッション統制',
    summary:
      '稼働中セッションの検索・個別強制失効・全社緊急一括サインアウトを実行します。',
    keywords: [
      'セッション',
      '強制サインアウト',
      '緊急失効',
      'ログイン',
      'session',
      'revoke',
    ],
    capabilities: ['admin.users.read'],
  },
  {
    id: 'tos',
    group: 'compliance',
    label: 'カスタム利用規約 (ToS)',
    summary:
      'テナント固有の利用規約同意ゲート・対象範囲・Markdown 本文・バージョン更新を管理します。',
    keywords: [
      '利用規約',
      'ToS',
      '同意',
      '規約',
      'コンプライアンス',
      'Markdown',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'retention-quota-ai',
    group: 'compliance',
    label: '保持期間・容量・AI 分類',
    summary:
      'ゴミ箱保持日数・AI 自動分類モード・ストレージ容量アラート閾値を管理します。',
    keywords: [
      'ゴミ箱',
      '保持期間',
      'AI',
      '自動分類',
      'クォータ',
      '容量',
      '閾値',
      'アラート',
      'retention',
      'quota',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'branding',
    group: 'compliance',
    label: 'カスタムブランディング',
    summary:
      '共有リンク・ファイルリクエスト画面に表示する組織名・連絡先・フッター注記を管理します。',
    keywords: [
      'ブランディング',
      '組織名',
      '連絡先',
      'フッター',
      'ロゴ',
      'branding',
    ],
    capabilities: ['admin.policies.read', 'admin.policies.edit'],
  },
  {
    id: 'integrations-catalog',
    group: 'integrations',
    label: '外部システム統合 (SCIM / SIEM)',
    summary:
      'SCIM プロビジョニング・SIEM Webhook・OIDC SSO・Collabora Online 連携を管理します。',
    keywords: [
      '統合',
      'SCIM',
      'SIEM',
      'Webhook',
      'Collabora',
      'WOPI',
      'プロビジョニング',
      'integrations',
    ],
    capabilities: [
      'admin.policies.read',
      'admin.policies.edit',
      'admin.users.read',
    ],
  },
] as const;

const TOPIC_BY_ID = new Map<EnterpriseSettingTopicId, EnterpriseSettingTopic>(
  ENTERPRISE_SETTING_TOPICS.map((topic) => [topic.id, topic])
);

const GROUP_BY_ID = new Map<
  EnterpriseSettingGroupId,
  EnterpriseSettingGroup
>(ENTERPRISE_SETTING_GROUPS.map((group) => [group.id, group]));

export function isEnterpriseSettingGroupId(
  value: unknown
): value is EnterpriseSettingGroupId {
  return (
    typeof value === 'string' &&
    GROUP_BY_ID.has(value as EnterpriseSettingGroupId)
  );
}

export function isEnterpriseSettingTopicId(
  value: unknown
): value is EnterpriseSettingTopicId {
  return (
    typeof value === 'string' &&
    TOPIC_BY_ID.has(value as EnterpriseSettingTopicId)
  );
}

export function getEnterpriseSettingTopic(
  topicId: EnterpriseSettingTopicId
): EnterpriseSettingTopic {
  return TOPIC_BY_ID.get(topicId)!;
}

export function getEnterpriseSettingGroup(
  groupId: EnterpriseSettingGroupId
): EnterpriseSettingGroup {
  return GROUP_BY_ID.get(groupId)!;
}

/**
 * Role-aware topic projection.
 *
 * sys_admin and sec_admin see every topic. A delegated Co-Admin only sees
 * topics where at least one required capability is granted, so the left tree
 * can never open a panel whose APIs would immediately 403.
 */
export function getVisibleEnterpriseSettingTopics(
  user:
    | Pick<AuthUser, 'role' | 'userType' | 'adminCapabilities'>
    | null
    | undefined
): EnterpriseSettingTopic[] {
  if (!user || user.userType === 'guest') return [];
  if (user.role === 'sys_admin' || user.role === 'sec_admin') {
    return [...ENTERPRISE_SETTING_TOPICS];
  }
  return ENTERPRISE_SETTING_TOPICS.filter((topic) =>
    topic.capabilities.some((capability) =>
      hasAdminCapability(user, capability)
    )
  );
}

/** Normalizes a raw `?topic=` value to a known topic id (first array entry). */
export function parseEnterpriseTopicQuery(
  raw: string | string[] | null | undefined
): EnterpriseSettingTopicId | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (!value) return null;
  return isEnterpriseSettingTopicId(value) ? value : null;
}

/**
 * Resolves the visible topic to focus.
 *
 * A valid, visible explicit topic wins. Otherwise the first visible topic of
 * the active settings group is used, then the first visible topic overall.
 */
export function resolveEnterpriseSettingTopic(
  activeTabId: string | null | undefined,
  rawTopic: string | string[] | null | undefined,
  visibleTopics: readonly EnterpriseSettingTopic[]
): EnterpriseSettingTopic | null {
  if (visibleTopics.length === 0) return null;

  const parsed = parseEnterpriseTopicQuery(rawTopic);
  if (parsed) {
    const requested = visibleTopics.find(
      (topic) => topic.id === parsed || topic.label.toLowerCase() === parsed
    );
    if (requested) return requested;
  }

  if (activeTabId) {
    const inGroup = visibleTopics.find(
      (topic) => topic.group === activeTabId
    );
    if (inGroup) return inGroup;
  }

  return visibleTopics[0] ?? null;
}

/**
 * Case-insensitive keyword search across the label, summary, group label and
 * keywords. NFKC normalization lets full-width Latin queries match.
 */
export function filterEnterpriseSettingTopics(
  topics: readonly EnterpriseSettingTopic[],
  query: string | null | undefined
): EnterpriseSettingTopic[] {
  const parsed = query?.trim().toLowerCase();
  if (!parsed) return [...topics];
  const needle = parsed.normalize('NFKC');

  return topics.filter((topic) => {
    const groupLabel = GROUP_BY_ID.get(topic.group)?.label ?? '';
    const haystack = [topic.label, topic.summary, groupLabel, ...topic.keywords]
      .join(' ')
      .normalize('NFKC')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export interface EnterpriseSettingStatusState {
  policy?: TenantPolicyRow | null;
  sharedLinkCount?: number;
  sharedLinks?: readonly unknown[] | null;
  guestInvitationCount?: number;
  guestInvitations?: readonly unknown[] | null;
  activeSessionCount?: number;
  sessions?: {
    summary?: { activeTotal?: number } | null;
  } | null;
  tos?: Pick<AdminTosPolicy, 'enabled' | 'version'> | null;
  ssoStatus?: Pick<AdminSsoStatusResponse, 'requireSsoLogin' | 'providers'> | null;
  siem?: { enabled?: boolean } | null;
  siemEnabled?: boolean;
  scimTokenCount?: number;
  scimTokens?: readonly unknown[] | null;
}

function readPolicyBoolean(
  policy: TenantPolicyRow | null | undefined,
  camel: keyof TenantPolicyRow,
  snake: keyof TenantPolicyRow,
  fallback = false
): boolean {
  if (!policy) return fallback;
  const camelValue = policy[camel];
  if (typeof camelValue === 'boolean') return camelValue;
  const snakeValue = policy[snake];
  if (typeof snakeValue === 'number') return snakeValue === 1;
  if (typeof snakeValue === 'boolean') return snakeValue;
  return fallback;
}

function readPolicyNumber(
  policy: TenantPolicyRow | null | undefined,
  camel: keyof TenantPolicyRow,
  snake: keyof TenantPolicyRow,
  fallback: number
): number {
  if (!policy) return fallback;
  const raw = policy[camel] ?? policy[snake];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function readPolicyString(
  policy: TenantPolicyRow | null | undefined,
  camel: keyof TenantPolicyRow,
  snake: keyof TenantPolicyRow,
  fallback: string
): string {
  if (!policy) return fallback;
  const raw = policy[camel] ?? policy[snake];
  return typeof raw === 'string' ? raw : fallback;
}

/**
 * Short, live current-value badge shown in the tree and topic header.
 *
 * The strings stay human-readable rather than exposing raw JSON so operators
 * can scan the whole tree without opening a single topic.
 */
export function getEnterpriseTopicStatusBadge(
  topicId: EnterpriseSettingTopicId,
  state: EnterpriseSettingStatusState = {}
): string {
  const { policy } = state;

  switch (topicId) {
    case 'shared-links': {
      const watermark = readPolicyBoolean(
        policy,
        'require_watermark_confidential',
        'require_watermark_confidential'
      );
      const maxDays = readPolicyNumber(
        policy,
        'max_link_expiration_days',
        'max_link_expiration_days',
        30
      );
      return `透かし: ${watermark ? 'ON' : 'OFF'} / 最大${maxDays}日`;
    }
    case 'guest-policy': {
      const allowed = readPolicyBoolean(
        policy,
        'allowExternalCollaborators',
        'allow_external_collaborators'
      );
      return `ゲスト: ${allowed ? '許可' : '拒否'}`;
    }
    case 'file-requests': {
      const allowed = readPolicyBoolean(
        policy,
        'allowFileRequests',
        'allow_file_requests',
        true
      );
      if (!allowed) return 'リクエスト: 拒否';
      const maxBytes = readPolicyNumber(
        policy,
        'fileRequestMaxSizeBytes',
        'file_request_max_size_bytes',
        100 * 1024 * 1024
      );
      const maxMiB = Math.max(1, Math.round(maxBytes / (1024 * 1024)));
      return `リクエスト: 許可 / ${maxMiB}MiB`;
    }
    case 'roles-and-invite': {
      const enabled = readPolicyBoolean(
        policy,
        'advancedRolesEnabled',
        'advanced_roles_enabled'
      );
      return `8ロール: ${enabled ? 'ON' : 'OFF'}`;
    }
    case 'folder-structure': {
      const folderMode = readPolicyString(
        policy,
        'folderStructureMode',
        'folder_structure_mode',
        'open'
      );
      const inheritance = readPolicyString(
        policy,
        'permissionInheritanceMode',
        'permission_inheritance_mode',
        'additive'
      );
      return `${folderMode === 'closed' ? 'Closed' : 'Open'} / ${
        inheritance === 'waterfall' ? 'Waterfall' : 'Standard'
      }`;
    }
    case 'content-inspection': {
      const mode = readPolicyString(
        policy,
        'adminContentInspectPolicy',
        'admin_content_inspect_policy',
        'watermark_confidential'
      );
      const label =
        mode === 'disabled'
          ? '全面禁止'
          : mode === 'deny_confidential'
            ? '機密禁止'
            : '透かし付きプレビュー';
      return `検査: ${label}`;
    }
    case 'ip-allowlist': {
      const enabled = readPolicyBoolean(
        policy,
        'ipAllowlistEnabled',
        'ip_allowlist_enabled'
      );
      if (!enabled) return 'IP制限: OFF';
      const scope = readPolicyString(
        policy,
        'ipAllowlistScope',
        'ip_allowlist_scope',
        'admin_only'
      );
      const scopeLabel =
        scope === 'all_access'
          ? '全アクセス'
          : scope === 'internal_users'
            ? '社内ユーザー'
            : '管理者のみ';
      return `IP制限: ON (${scopeLabel})`;
    }
    case 'sso-oidc': {
      const required = readPolicyBoolean(
        policy,
        'requireSsoLogin',
        'require_sso_login',
        Boolean(state.ssoStatus?.requireSsoLogin)
      );
      return `SSO必須: ${required ? 'ON' : 'OFF'}`;
    }
    case 'sessions': {
      const count =
        state.activeSessionCount ?? state.sessions?.summary?.activeTotal;
      return typeof count === 'number'
        ? `セッション: ${count}件`
        : 'セッション: —';
    }
    case 'tos': {
      if (!state.tos?.enabled) return 'ToS: 無効';
      return `ToS: 有効 (v${state.tos.version ?? 1})`;
    }
    case 'retention-quota-ai': {
      const retention = readPolicyNumber(
        policy,
        'trash_retention_days',
        'trash_retention_days',
        30
      );
      const warn = readPolicyNumber(
        policy,
        'quotaWarnThresholdPct',
        'quota_warn_threshold_pct',
        80
      );
      return `保持: ${retention}日 / 警告: ${warn}%`;
    }
    case 'branding': {
      const orgName =
        policy?.brandingOrgName ?? policy?.branding_org_name ?? null;
      return orgName?.trim()
        ? 'ブランド: 設定済み'
        : 'ブランド: 未設定';
    }
    case 'integrations-catalog': {
      const scimCount =
        state.scimTokenCount ?? state.scimTokens?.length ?? undefined;
      const siemEnabled = state.siemEnabled ?? state.siem?.enabled ?? false;
      const providerCount = state.ssoStatus?.providers?.length ?? 0;
      const hasScim = typeof scimCount === 'number' && scimCount > 0;
      if (!hasScim && !siemEnabled && providerCount === 0) {
        return '統合: 未設定';
      }
      const parts: string[] = [];
      if (typeof scimCount === 'number') {
        parts.push(`SCIM: ${scimCount > 0 ? 'ON' : 'OFF'}`);
      }
      parts.push(`SIEM: ${siemEnabled ? 'ON' : 'OFF'}`);
      if (providerCount > 0) parts.push('OIDC: ON');
      return parts.join(' / ');
    }
    default:
      return '—';
  }
}
