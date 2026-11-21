'use client';

import {
  ArrowUpRight,
  ChevronDown,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useRef, useState } from 'react';
import { AdminScimTokensSection } from '@/components/admin/AdminScimTokensSection';
import { AdminSiemSettingsSection } from '@/components/admin/AdminSiemSettingsSection';
import { AdminWebhooksTokensSection } from '@/components/admin/AdminWebhooksTokensSection';
import {
  hasActiveAdminIntegrationFilters,
  filterAdminIntegrations,
  getRecommendedAdminIntegrations,
  ADMIN_INTEGRATION_CATALOG,
  ADMIN_INTEGRATION_CATEGORY_LABELS,
  ADMIN_INTEGRATION_OFFICIAL_LABELS,
  ADMIN_INTEGRATION_STATUS_LABELS,
  resolveAdminIntegrationStatuses,
} from '@/lib/admin-integrations';
import type {
  AdminIntegrationCategory,
  AdminIntegrationCatalogItem,
  AdminIntegrationFilterState,
  AdminIntegrationId,
  AdminIntegrationOfficialKind,
  AdminIntegrationStatus,
  AdminIntegrationSsoStatus,
} from '@/lib/admin-integrations';
import { canViewScimTokens } from '@/lib/admin-groups';
import { hasAdminCapability } from '@/lib/admin-delegations';
import type {
  AdminSiemSettings,
  AuthUser,
  TenantPolicyRow,
} from '@/types/files';

const INITIAL_FILTERS: AdminIntegrationFilterState = {
  query: '',
  official: 'all',
  category: 'all',
  status: 'all',
  featuredOnly: false,
};

const OFFICIAL_FILTER_OPTIONS: readonly AdminIntegrationOfficialKind[] = [
  'official',
  'custom',
];

const CATEGORY_FILTER_OPTIONS: readonly AdminIntegrationCategory[] = [
  'identity',
  'security',
  'collaboration',
  'ai_governance',
];

const STATUS_FILTER_OPTIONS: readonly AdminIntegrationStatus[] = [
  'active',
  'not_configured',
];

function statusBadgeClass(status: AdminIntegrationStatus): string {
  return status === 'active'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : 'border-[#e1e1e4] bg-[#f4f4f6] text-[#55565a]';
}

function statusDotClass(status: AdminIntegrationStatus): string {
  return status === 'active' ? 'bg-emerald-500' : 'bg-[#a2a3a9]';
}

function IntegrationStatusBadge({
  status,
  testId,
}: {
  status: AdminIntegrationStatus;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${statusBadgeClass(
        status
      )}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${statusDotClass(status)}`}
      />
      {ADMIN_INTEGRATION_STATUS_LABELS[status]}
    </span>
  );
}

function IntegrationBadges({
  item,
  className = '',
}: {
  item: AdminIntegrationCatalogItem;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${
          item.official === 'official'
            ? 'border-[#d9ddf8] bg-[#eef0fb] text-[#3f4a9e]'
            : 'border-amber-200 bg-amber-50 text-amber-800'
        }`}
      >
        {ADMIN_INTEGRATION_OFFICIAL_LABELS[item.official]}
      </span>
      <span className="inline-flex items-center rounded-full border border-[#e1e1e4] bg-white px-2 py-0.5 text-[0.625rem] font-medium text-[#55565a]">
        {ADMIN_INTEGRATION_CATEGORY_LABELS[item.category]}
      </span>
      {item.featured && (
        <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[0.625rem] font-medium text-violet-700">
          注目
        </span>
      )}
    </div>
  );
}

export function AdminIntegrationsSection({
  user,
  policy,
  ssoStatus,
  initialSiem,
  onSelectSettingsTab,
  integratedView = false,
}: {
  user: AuthUser | null;
  policy: TenantPolicyRow | null;
  ssoStatus: AdminIntegrationSsoStatus | null;
  initialSiem?: AdminSiemSettings | null;
  onSelectSettingsTab: (tabId: string) => void;
  /** `/admin` has a single settings tab; `/admin/settings` has a security tab. */
  integratedView?: boolean;
}) {
  const baseId = useId();
  const individualRef = useRef<HTMLElement | null>(null);
  const [filters, setFilters] =
    useState<AdminIntegrationFilterState>(INITIAL_FILTERS);
  const [selectedIntegrationId, setSelectedIntegrationId] =
    useState<AdminIntegrationId | null>(null);

  const statuses = useMemo(
    () =>
      resolveAdminIntegrationStatuses({
        ssoStatus,
        siem: initialSiem,
        policy,
      }),
    [initialSiem, policy, ssoStatus]
  );

  const recommendedIntegrations = useMemo(
    () => getRecommendedAdminIntegrations(ADMIN_INTEGRATION_CATALOG, statuses),
    [statuses]
  );

  const filteredIntegrations = useMemo(
    () => filterAdminIntegrations(ADMIN_INTEGRATION_CATALOG, statuses, filters),
    [filters, statuses]
  );

  const selectedIntegration =
    ADMIN_INTEGRATION_CATALOG.find(
      (item) => item.id === selectedIntegrationId
    ) ?? null;
  const selectedStatus = selectedIntegrationId
    ? (statuses[selectedIntegrationId] ?? 'not_configured')
    : null;

  const filtersActive = hasActiveAdminIntegrationFilters(filters);
  const filteredIds = useMemo(
    () => new Set(filteredIntegrations.map((item) => item.id)),
    [filteredIntegrations]
  );

  const canViewScim = canViewScimTokens(user?.role);
  const canViewSiem = hasAdminCapability(user, 'admin.policies.read');

  // The initial view intentionally renders both inline configuration panels
  // so `/admin/settings?tab=integrations` keeps its existing SCIM entry point.
  // A selection or a narrowed result set focuses the matching panel instead.
  const showScim =
    canViewScim &&
    (selectedIntegrationId
      ? selectedIntegrationId === 'scim-provisioning'
      : !filtersActive || filteredIds.has('scim-provisioning'));
  const showSiem =
    canViewSiem &&
    (selectedIntegrationId
      ? selectedIntegrationId === 'siem-webhook'
      : !filtersActive || filteredIds.has('siem-webhook'));

  function patchFilters(patch: Partial<AdminIntegrationFilterState>) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function focusIndividualManagement() {
    individualRef.current?.scrollIntoView({
      block: 'start',
      behavior: 'smooth',
    });
  }

  function selectIntegration(id: AdminIntegrationId) {
    setSelectedIntegrationId(id);
    focusIndividualManagement();
  }

  function selectRecommended(id: AdminIntegrationId) {
    setSelectedIntegrationId(id);
    // Recommended cards always target the full catalog; clearing the current
    // filters keeps the selected integration visible in the management grid.
    setFilters(INITIAL_FILTERS);
    focusIndividualManagement();
  }

  function openSecuritySettings() {
    onSelectSettingsTab(integratedView ? 'settings' : 'security');
  }

  return (
    <section
      data-testid="admin-integrations-section"
      aria-labelledby={`${baseId}-integrations-heading`}
      className="space-y-4"
    >
      <h2 id={`${baseId}-integrations-heading`} className="sr-only">
        統合の管理
      </h2>

      <details
        data-testid="integrations-recommended-details"
        open
        className="group rounded-2xl border border-[#e7e7ea] bg-white p-4 shadow-xs"
      >
        <summary
          data-testid="integrations-recommended-summary"
          className="flex cursor-pointer list-none items-center gap-2 text-[#111214] [&::-webkit-details-marker]:hidden"
        >
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[#5e6ad2] transition-transform group-open:rotate-180"
          />
          <span className="text-[0.875rem] font-semibold tracking-[-0.01em]">
            おすすめの統合
          </span>
          <span className="rounded-full border border-[#e1e1e4] bg-[#f9f9fa] px-2 py-0.5 text-[0.625rem] font-medium text-[#55565a]">
            {recommendedIntegrations.length} 件
          </span>
          <span className="ml-auto hidden text-[0.625rem] text-[#8a8b90] sm:inline">
            まずはここから設定を開始
          </span>
        </summary>

        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {recommendedIntegrations.map((item) => (
            <article
              key={item.id}
              data-testid={`integration-recommended-card-${item.id}`}
              className="flex flex-col gap-2 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-[0.75rem] font-semibold text-[#111214]">
                    {item.title}
                  </h3>
                  <p className="mt-0.5 text-[0.625rem] text-[#55565a]">
                    {item.vendor}
                  </p>
                </div>
                <IntegrationStatusBadge
                  status={item.status}
                  testId={`integration-recommended-status-${item.id}`}
                />
              </div>
              <IntegrationBadges item={item} />
              <div className="mt-auto flex items-center justify-end">
                <button
                  type="button"
                  data-testid={`integration-recommended-select-${item.id}`}
                  onClick={() => selectRecommended(item.id)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d9ddf8] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3f4a9e] transition hover:bg-[#eef0fb]"
                >
                  個別管理で表示
                  <ArrowUpRight
                    className="h-3 w-3"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </article>
          ))}
        </div>
      </details>

      <section
        ref={individualRef}
        id="integrations-individual-management"
        data-testid="integrations-individual-management"
        aria-labelledby={`${baseId}-individual-heading`}
        tabIndex={-1}
        className="space-y-3 rounded-2xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5e6ad2]"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2
              id={`${baseId}-individual-heading`}
              className="text-[0.875rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              統合の個別管理
            </h2>
            <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
              種別・カテゴリ・利用状況で絞り込み、接続情報をこのタブ内で直接管理します。
            </p>
          </div>
          <p
            role="status"
            data-testid="integrations-filter-result-count"
            className="text-[0.6875rem] font-medium text-[#55565a]"
          >
            {filteredIntegrations.length} 件の統合
          </p>
        </div>

        <div className="rounded-2xl border border-[#e7e7ea] bg-white p-4 shadow-xs">
          <div className="mb-3 flex items-center gap-1.5 text-[0.75rem] font-semibold text-[#111214]">
            <SlidersHorizontal
              className="h-3.5 w-3.5 text-[#5e6ad2]"
              aria-hidden="true"
            />
            フィルタ
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <label className="block text-[0.625rem] font-medium text-[#55565a] xl:col-span-2">
              統合を検索
              <span className="relative mt-1 block">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a8b90]"
                />
                <input
                  type="search"
                  data-testid="integrations-filter-query"
                  value={filters.query}
                  onChange={(event) => patchFilters({ query: event.target.value })}
                  placeholder="タイトル・提供元・説明で検索"
                  className="h-8 w-full rounded-md border border-[#d7d7dc] bg-white pl-7 pr-2 text-[0.6875rem] text-[#111214] placeholder:text-[#8a8b90]"
                />
              </span>
            </label>

            <label className="block text-[0.625rem] font-medium text-[#55565a]">
              種別
              <select
                data-testid="integrations-filter-official"
                value={filters.official}
                onChange={(event) =>
                  patchFilters({
                    official: event.target
                      .value as AdminIntegrationFilterState['official'],
                  })
                }
                className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.6875rem] text-[#111214]"
              >
                <option value="all">すべて</option>
                {OFFICIAL_FILTER_OPTIONS.map((official) => (
                  <option key={official} value={official}>
                    {ADMIN_INTEGRATION_OFFICIAL_LABELS[official]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-[0.625rem] font-medium text-[#55565a]">
              カテゴリ
              <select
                data-testid="integrations-filter-category"
                value={filters.category}
                onChange={(event) =>
                  patchFilters({
                    category: event.target
                      .value as AdminIntegrationFilterState['category'],
                  })
                }
                className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.6875rem] text-[#111214]"
              >
                <option value="all">すべて</option>
                {CATEGORY_FILTER_OPTIONS.map((category) => (
                  <option key={category} value={category}>
                    {ADMIN_INTEGRATION_CATEGORY_LABELS[category]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-[0.625rem] font-medium text-[#55565a]">
              利用状況
              <select
                data-testid="integrations-filter-status"
                value={filters.status}
                onChange={(event) =>
                  patchFilters({
                    status: event.target
                      .value as AdminIntegrationFilterState['status'],
                  })
                }
                className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.6875rem] text-[#111214]"
              >
                <option value="all">すべて</option>
                {STATUS_FILTER_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {ADMIN_INTEGRATION_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#f2f2f4] pt-3">
            <label className="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium text-[#3c3f46]">
              <input
                type="checkbox"
                data-testid="integrations-filter-featured"
                checked={filters.featuredOnly}
                onChange={(event) =>
                  patchFilters({ featuredOnly: event.target.checked })
                }
                className="h-3.5 w-3.5 rounded border-[#c9c9cf] accent-[#5e6ad2]"
              />
              注目の統合のみ表示
            </label>
            <button
              type="button"
              data-testid="integrations-filter-reset"
              onClick={() => setFilters(INITIAL_FILTERS)}
              className="inline-flex h-7 items-center rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
            >
              フィルタをリセット
            </button>
          </div>
        </div>

        {filteredIntegrations.length === 0 ? (
          <p
            data-testid="integrations-empty-state"
            className="rounded-2xl border border-dashed border-[#d7d7dc] bg-white px-4 py-6 text-center text-[0.75rem] text-[#55565a]"
          >
            条件に一致する統合はありません。検索語やフィルタを変更してください。
          </p>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {filteredIntegrations.map((item) => {
              const status = statuses[item.id] ?? 'not_configured';
              const selected = selectedIntegrationId === item.id;
              return (
                <li
                  key={item.id}
                  data-testid={`integration-card-${item.id}`}
                  data-integration-id={item.id}
                  data-integration-status={status}
                  data-selected={selected ? 'true' : undefined}
                  className={`flex flex-col gap-2 rounded-2xl border bg-white p-4 shadow-xs transition ${
                    selected
                      ? 'border-[#5e6ad2] ring-2 ring-[#eef0fb]'
                      : 'border-[#e7e7ea]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-[0.8125rem] font-semibold text-[#111214]">
                      {item.title}
                    </h3>
                    <IntegrationStatusBadge
                      status={status}
                      testId={`integration-status-${item.id}`}
                    />
                  </div>
                  <p className="text-[0.625rem] text-[#55565a]">{item.vendor}</p>
                  <p className="text-[0.6875rem] leading-relaxed text-[#3c3f46]">
                    {item.summary}
                  </p>
                  <IntegrationBadges item={item} />
                  <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                    <button
                      type="button"
                      data-testid={`integration-select-${item.id}`}
                      aria-pressed={selected}
                      onClick={() => selectIntegration(item.id)}
                      className={`inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[0.6875rem] font-medium transition ${
                        selected
                          ? 'border-[#5e6ad2] bg-[#eef0fb] text-[#3f4a9e]'
                          : 'border-[#e1e1e4] bg-white text-[#3c3f46] hover:bg-[#f2f2f4]'
                      }`}
                    >
                      {selected ? '個別管理を表示中' : '個別管理を表示'}
                    </button>
                    {item.id === 'oidc-sso' && (
                      <button
                        type="button"
                        data-testid="integration-quick-link-oidc-sso"
                        onClick={openSecuritySettings}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d9ddf8] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3f4a9e] transition hover:bg-[#eef0fb]"
                      >
                        セキュリティタブで設定
                        <ArrowUpRight
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                      </button>
                    )}
                    {item.id === 'workers-ai-classification' && (
                      <Link
                        href="/admin/content?tab=ai-classification"
                        data-testid="integration-quick-link-workers-ai-classification"
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
                      >
                        AI 分類レビューへ
                        <ArrowUpRight
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {selectedIntegration && (
          <div
            data-testid="integration-selected-summary"
            className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border border-[#d9ddf8] bg-[#f7f8ff] p-4"
          >
            <div>
              <p className="text-[0.625rem] font-medium text-[#3f4a9e]">
                選択中の統合
              </p>
              <h3 className="mt-0.5 text-[0.875rem] font-semibold text-[#111214]">
                {selectedIntegration.title}
              </h3>
              <p className="mt-0.5 text-[0.625rem] text-[#55565a]">
                {selectedIntegration.vendor}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <IntegrationStatusBadge
                status={selectedStatus ?? 'not_configured'}
                testId="integration-selected-status"
              />
              <button
                type="button"
                data-testid="integration-selection-clear"
                onClick={() => setSelectedIntegrationId(null)}
                className="inline-flex h-7 items-center rounded-md border border-[#d9ddf8] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3f4a9e] transition hover:bg-[#eef0fb]"
              >
                選択を解除
              </button>
            </div>
          </div>
        )}

        <div
          data-testid="integrations-inline-config"
          className="space-y-3"
        >
          {showScim && <AdminScimTokensSection user={user} />}
          {showSiem && (
            <AdminSiemSettingsSection
              canManage={user?.role === 'sys_admin'}
              initialSiem={initialSiem}
            />
          )}
          {!selectedIntegrationId && <AdminWebhooksTokensSection user={user} />}

          {selectedIntegrationId === 'oidc-sso' && (
            <div
              data-testid="integration-setup-guidance-oidc-sso"
              className="rounded-2xl border border-[#e7e7ea] bg-white p-4 shadow-xs"
            >
              <h3 className="text-[0.875rem] font-semibold text-[#111214]">
                OIDC SSO の設定場所
              </h3>
              <p className="mt-1 text-[0.6875rem] text-[#55565a]">
                Issuer・クライアント ID / シークレット・許可ドメイン・ログイン必須化は
                「セキュリティとセッション」タブで管理します。この統合の利用状況は
                そこでの設定に連動して自動更新されます。
              </p>
              <button
                type="button"
                data-testid="integration-open-security-settings"
                onClick={openSecuritySettings}
                className="mt-2 inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-[#4f5ac2]"
              >
                セキュリティ設定を開く
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          )}

          {selectedIntegrationId === 'collabora-wopi' && (
            <div
              data-testid="integration-setup-guidance-collabora-wopi"
              className="rounded-2xl border border-[#e7e7ea] bg-white p-4 shadow-xs"
            >
              <h3 className="text-[0.875rem] font-semibold text-[#111214]">
                Collabora Online (WOPI) の構成
              </h3>
              <p className="mt-1 text-[0.6875rem] text-[#55565a]">
                Collabora の接続先と WOPI 署名鍵はデプロイ時の環境変数
                (WOPI_URL / WOPI_SECRET 等) で構成します。ファイルの共同編集は
                構成済みの環境で自動的に有効になります。
              </p>
            </div>
          )}

          {selectedIntegrationId === 'workers-ai-classification' && (
            <div
              data-testid="integration-setup-guidance-workers-ai-classification"
              className="rounded-2xl border border-[#e7e7ea] bg-white p-4 shadow-xs"
            >
              <h3 className="text-[0.875rem] font-semibold text-[#111214]">
                Workers AI 機密区分自動分類の設定場所
              </h3>
              <p className="mt-1 text-[0.6875rem] text-[#55565a]">
                分類モードと自動適用しきい値は「Enterprise設定 &gt; コンテンツと共有」で、
                生成された分類候補のレビューは「コンテンツ &gt; AI 分類レビュー」で
                管理します。
              </p>
              <Link
                href="/admin/content?tab=ai-classification"
                data-testid="integration-open-ai-classification"
                className="mt-2 inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-[#4f5ac2]"
              >
                AI 分類レビューを開く
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
          )}

          {!showScim && !showSiem && !selectedIntegrationId && (
            <p
              data-testid="integrations-inline-empty"
              className="rounded-2xl border border-dashed border-[#d7d7dc] bg-white px-4 py-6 text-center text-[0.75rem] text-[#55565a]"
            >
              この条件に一致する統合は、この画面から直接設定できません。カードの
              「個別管理を表示」から対象の統合を選択してください。
            </p>
          )}
        </div>
      </section>
    </section>
  );
}
