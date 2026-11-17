import type {
  AdminSiemSettings,
  AdminSsoStatusResponse,
  TenantPolicyRow,
} from '@/types/files';

/**
 * TOM-77 pure integration catalog.
 *
 * Box の「統合の管理ページのデザイン変更」に合わせて、統合を「おすすめ」
 * と「個別管理」に分け、検索・種別・カテゴリ・利用状況・注目で絞り込める
 * ようにする。React / Next.js に依存しないため、UI と単体テストで同じ
 * カタログ・ステータス判定・フィルタ契約を共有できる。
 */

export type AdminIntegrationId =
  | 'scim-provisioning'
  | 'oidc-sso'
  | 'siem-webhook'
  | 'collabora-wopi'
  | 'workers-ai-classification';

export type AdminIntegrationOfficialKind = 'official' | 'custom';

export type AdminIntegrationCategory =
  | 'identity'
  | 'security'
  | 'collaboration'
  | 'ai_governance';

export type AdminIntegrationStatus = 'active' | 'not_configured';

export interface AdminIntegrationFilterState {
  query: string;
  official: 'all' | AdminIntegrationOfficialKind;
  category: 'all' | AdminIntegrationCategory;
  status: 'all' | AdminIntegrationStatus;
  featuredOnly: boolean;
}

export interface AdminIntegrationCatalogItem {
  id: AdminIntegrationId;
  title: string;
  vendor: string;
  summary: string;
  official: AdminIntegrationOfficialKind;
  category: AdminIntegrationCategory;
  featured: boolean;
  recommended: boolean;
}

/**
 * The integration ids intentionally mirror the API surfaces the admin
 * console already owns: SCIM tokens, OIDC SSO, SIEM webhook, Collabora WOPI
 * and Workers AI classification.
 */
export const ADMIN_INTEGRATION_CATALOG: readonly AdminIntegrationCatalogItem[] =
  [
    {
      id: 'scim-provisioning',
      title: 'SCIM 2.0 ディレクトリ同期',
      vendor: 'Files Official / IdP (Okta, Entra ID, Google Workspace)',
      summary:
        'Okta / Entra ID / Google Workspace からユーザーとグループを自動プロビジョニングし、入退社や異動を即時反映します。',
      official: 'official',
      category: 'identity',
      featured: true,
      recommended: true,
    },
    {
      id: 'oidc-sso',
      title: 'OIDC シングルサインオン (SSO)',
      vendor: 'Files Official / OpenID Connect',
      summary:
        'OpenID Connect で社内 IdP と連携し、パスワードレスな SSO とログイン許可ドメインを適用します。',
      official: 'official',
      category: 'identity',
      featured: true,
      recommended: true,
    },
    {
      id: 'siem-webhook',
      title: 'SIEM Webhook 監査ストリーム',
      vendor: 'Custom Webhook / Splunk, Datadog, Sentinel',
      summary:
        '監査ログとセキュリティイベントを HMAC-SHA256 署名付き Webhook で Splunk / Datadog / Sentinel に配信します。',
      official: 'custom',
      category: 'security',
      featured: true,
      recommended: true,
    },
    {
      id: 'collabora-wopi',
      title: 'Collabora Online (WOPI) 共同編集',
      vendor: 'Files Official / Collabora CODE & Enterprise',
      summary:
        'Collabora Online と WOPI 連携し、ブラウザ内で Office 文書を共同編集します。',
      official: 'official',
      category: 'collaboration',
      featured: true,
      recommended: false,
    },
    {
      id: 'workers-ai-classification',
      title: 'Workers AI 機密区分自動分類',
      vendor: 'Files Official / Cloudflare Workers AI & Ollama',
      summary:
        'Workers AI / Ollama でファイル内容を解析し、機密区分の自動分類候補を生成します。',
      official: 'official',
      category: 'ai_governance',
      featured: false,
      recommended: false,
    },
  ];

export const ADMIN_INTEGRATION_CATEGORY_LABELS: Record<
  AdminIntegrationCategory,
  string
> = {
  identity: 'ID 管理',
  security: 'セキュリティ',
  collaboration: 'コラボレーション',
  ai_governance: 'AI ガバナンス',
};

export const ADMIN_INTEGRATION_OFFICIAL_LABELS: Record<
  AdminIntegrationOfficialKind,
  string
> = {
  official: '公式',
  custom: 'カスタム',
};

export const ADMIN_INTEGRATION_STATUS_LABELS: Record<
  AdminIntegrationStatus,
  string
> = {
  active: '有効',
  not_configured: '未設定',
};

/**
 * `/api/admin/sso/status` currently exposes providers rather than a boolean
 * projection. Accept an optional `oidcConfigured` flag so the catalog can use
 * one status while older API payloads still fall back to the policy flags.
 */
export type AdminIntegrationSsoStatus = AdminSsoStatusResponse & {
  oidcConfigured?: boolean;
};

export interface AdminIntegrationStatusInput {
  ssoStatus?: AdminIntegrationSsoStatus | null;
  siem?: AdminSiemSettings | null;
  policy?: TenantPolicyRow | null;
}

export type AdminIntegrationStatuses = Record<
  AdminIntegrationId,
  AdminIntegrationStatus
>;

/**
 * Resolves the user-visible utilisation status for every catalog entry.
 *
 * SCIM / Collabora / Workers AI are infrastructure capabilities that the
 * console treats as available by default. OIDC and SIEM only become "active"
 * once the tenant policy or the persisted integration settings say so.
 */
export function resolveAdminIntegrationStatuses(
  input: AdminIntegrationStatusInput = {}
): AdminIntegrationStatuses {
  const oidcConfigured = Boolean(
    input.ssoStatus?.oidcConfigured ||
      input.policy?.requireSsoLogin ||
      input.policy?.require_sso_login === 1
  );
  const siemConfigured = Boolean(input.siem?.enabled && input.siem?.url);

  return {
    'scim-provisioning': 'active',
    'oidc-sso': oidcConfigured ? 'active' : 'not_configured',
    'siem-webhook': siemConfigured ? 'active' : 'not_configured',
    'collabora-wopi': 'active',
    'workers-ai-classification': 'active',
  };
}

export function hasActiveAdminIntegrationFilters(
  filters: AdminIntegrationFilterState
): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.official !== 'all' ||
    filters.category !== 'all' ||
    filters.status !== 'all' ||
    filters.featuredOnly
  );
}

function integrationMatchesQuery(
  item: AdminIntegrationCatalogItem,
  query: string
): boolean {
  if (!query) return true;
  return [item.id, item.title, item.vendor, item.summary]
    .join('\n')
    .toLowerCase()
    .includes(query);
}

export function filterAdminIntegrations(
  catalog: readonly AdminIntegrationCatalogItem[],
  statuses: AdminIntegrationStatuses,
  filters: AdminIntegrationFilterState
): AdminIntegrationCatalogItem[] {
  const query = filters.query.trim().toLowerCase();

  return catalog.filter((item) => {
    if (filters.official !== 'all' && item.official !== filters.official) {
      return false;
    }
    if (filters.category !== 'all' && item.category !== filters.category) {
      return false;
    }
    if (
      filters.status !== 'all' &&
      (statuses[item.id] ?? 'not_configured') !== filters.status
    ) {
      return false;
    }
    if (filters.featuredOnly && !item.featured) {
      return false;
    }
    return integrationMatchesQuery(item, query);
  });
}

export type AdminIntegrationWithStatus = AdminIntegrationCatalogItem & {
  status: AdminIntegrationStatus;
};

/**
 * Recommended integrations keep the Box "おすすめの統合" section at the top
 * of the page. Status is attached so the cards can render the same badge as
 * the individual management list without a second lookup.
 */
export function getRecommendedAdminIntegrations(
  catalog: readonly AdminIntegrationCatalogItem[],
  statuses: AdminIntegrationStatuses
): AdminIntegrationWithStatus[] {
  return catalog
    .filter((item) => item.recommended)
    .map((item) => ({
      ...item,
      status: statuses[item.id] ?? 'not_configured',
    }));
}
