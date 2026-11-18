'use client';

import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  Search,
  SquareStack,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ENTERPRISE_SETTING_GROUPS,
  filterEnterpriseSettingTopics,
  getEnterpriseSettingGroup,
  getEnterpriseTopicStatusBadge,
  getVisibleEnterpriseSettingTopics,
  isEnterpriseSettingGroupId,
  resolveEnterpriseSettingTopic,
  type EnterpriseSettingGroupId,
  type EnterpriseSettingStatusState,
  type EnterpriseSettingTopic,
  type EnterpriseSettingTopicId,
} from '@/lib/admin-enterprise-settings';
import type { AuthUser } from '@/types/files';

const SEARCH_INPUT_ID = 'enterprise-settings-search-input';

type ViewMode = 'topic' | 'group';

export interface AdminEnterpriseSettingsWorkbenchProps {
  user: AuthUser | null;
  /**
   * Active `AdminSettingsTab` on the focused `/admin/settings` route. The
   * integrated `/admin?tab=settings` view passes `settings`, which is not a
   * workbench group, so the workbench keeps its own group selection there.
   */
  activeTabId?: string | null;
  onSelectTab?: (tabId: string) => void;
  statusState?: EnterpriseSettingStatusState;
  /** Deep link value from `/admin/settings?topic=...`. */
  initialTopic?: string | string[] | null;
  renderTopic: (topicId: EnterpriseSettingTopicId) => ReactNode;
  /** Optional batch renderer for `group` view; falls back to stacked topics. */
  renderGroup?: (groupId: EnterpriseSettingGroupId) => ReactNode;
}

export function AdminEnterpriseSettingsWorkbench({
  user,
  activeTabId = null,
  onSelectTab,
  statusState = {},
  initialTopic = null,
  renderTopic,
  renderGroup,
}: AdminEnterpriseSettingsWorkbenchProps) {
  const parentGroupId = isEnterpriseSettingGroupId(activeTabId)
    ? activeTabId
    : null;
  const initialResolvedTopic = resolveEnterpriseSettingTopic(
    parentGroupId,
    initialTopic,
    getVisibleEnterpriseSettingTopics(user)
  );

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ViewMode>('topic');
  const [selectedTopicId, setSelectedTopicId] =
    useState<EnterpriseSettingTopicId | null>(
      () => initialResolvedTopic?.id ?? null
    );
  const [activeGroupId, setActiveGroupId] = useState<EnterpriseSettingGroupId>(
    () => initialResolvedTopic?.group ?? parentGroupId ?? 'sharing'
  );
  const selectedTopicRef = useRef(selectedTopicId);
  selectedTopicRef.current = selectedTopicId;
  const previousParentGroupRef = useRef<EnterpriseSettingGroupId | null>(
    parentGroupId
  );

  const capabilityKey = user?.adminCapabilities?.join('|') ?? '';
  const visibleTopics = useMemo(
    () => getVisibleEnterpriseSettingTopics(user),
    // The capability list is the only mutable input; `user` itself is a
    // snapshot object that can be recreated on every sync tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [user?.role, user?.userType, capabilityKey]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rawTopic = new URL(window.location.href).searchParams.get('topic');
    if (!rawTopic) return;
    const requested = resolveEnterpriseSettingTopic(
      parentGroupId,
      rawTopic,
      visibleTopics
    );
    if (!requested) return;
    if (parentGroupId && requested.group !== parentGroupId) return;
    setActiveGroupId(requested.group);
    setSelectedTopicId(requested.id);
  }, [parentGroupId, visibleTopics]);

  useEffect(() => {
    if (!parentGroupId) return;
    if (previousParentGroupRef.current === parentGroupId) return;
    previousParentGroupRef.current = parentGroupId;

    setActiveGroupId(parentGroupId);
    const current = selectedTopicRef.current
      ? visibleTopics.find((item) => item.id === selectedTopicRef.current)
      : null;
    if (current && current.group === parentGroupId) {
      writeTopicToUrl(current.id);
      return;
    }
    // A horizontal tab change owns the group: drop the previous topic deep
    // link so the URL stays canonical (`?tab=security`, not a stale topic).
    setSelectedTopicId(null);
    writeTopicToUrl(null);
  }, [parentGroupId, visibleTopics]);

  const activeTopic = resolveEnterpriseSettingTopic(
    activeGroupId,
    selectedTopicId,
    visibleTopics
  );
  const activeGroup = activeTopic
    ? getEnterpriseSettingGroup(activeTopic.group)
    : null;
  const groupTopics = activeTopic
    ? visibleTopics.filter((topic) => topic.group === activeTopic.group)
    : [];
  const activeIndex = activeTopic
    ? groupTopics.findIndex((topic) => topic.id === activeTopic.id)
    : -1;
  const previousTopic = activeIndex > 0 ? groupTopics[activeIndex - 1] : null;
  const nextTopic =
    activeIndex >= 0 && activeIndex < groupTopics.length - 1
      ? groupTopics[activeIndex + 1]
      : null;

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const matches = useMemo(
    () => filterEnterpriseSettingTopics(visibleTopics, trimmedQuery),
    [visibleTopics, trimmedQuery]
  );

  function writeTopicToUrl(topicId: EnterpriseSettingTopicId | null) {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (topicId) {
      url.searchParams.set('topic', topicId);
    } else {
      url.searchParams.delete('topic');
    }
    const next = `${url.pathname}${url.search}`;
    const current = `${window.location.pathname}${window.location.search}`;
    if (next !== current) {
      window.history.replaceState(window.history.state, '', next);
    }
  }

  function selectTopicInternal(topic: EnterpriseSettingTopic) {
    setMode('topic');
    setActiveGroupId(topic.group);
    setSelectedTopicId(topic.id);
    writeTopicToUrl(topic.id);
  }

  function openTopic(topic: EnterpriseSettingTopic) {
    setQuery('');
    selectTopicInternal(topic);
    if (onSelectTab && parentGroupId !== topic.group) {
      onSelectTab(topic.group);
    }
  }

  function scrollToPaneTop() {
    if (typeof document === 'undefined') return;
    document
      .getElementById('enterprise-settings-pane')
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  const topicBadge = (topic: EnterpriseSettingTopic) =>
    getEnterpriseTopicStatusBadge(topic.id, statusState);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#e7e7ea] bg-white p-3">
        <search className="min-w-[15rem] flex-1">
          <label htmlFor={SEARCH_INPUT_ID} className="sr-only">
            Enterprise 設定を検索
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8a8b90]"
            />
            <input
              id={SEARCH_INPUT_ID}
              data-testid="enterprise-settings-search"
              type="search"
              name="enterpriseSettingsSearch"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('');
              }}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="キーワードで設定を検索（例: 透かし / IP / ToS）"
              className="h-8 w-full rounded-md border border-[#d7d7dc] bg-white pl-8 pr-8 text-[0.75rem] text-[#111214] placeholder:text-[#8a8b90] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
            />
            {hasQuery && (
              <button
                type="button"
                data-testid="enterprise-settings-search-clear"
                aria-label="検索をクリア"
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[#676b72] transition hover:bg-[#f2f2f4] hover:text-[#111214] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </search>

        <div className="flex items-center gap-2">
          <span className="text-[0.625rem] font-medium text-[#6b6f76]">
            表示:
            {mode === 'topic' ? '1トピック集中' : 'カテゴリ一括'}
          </span>
          <button
            type="button"
            data-testid="enterprise-settings-view-mode-toggle"
            aria-pressed={mode === 'group'}
            onClick={() => setMode((value) => (value === 'topic' ? 'group' : 'topic'))}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
          >
            {mode === 'topic' ? (
              <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <SquareStack className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {mode === 'topic' ? 'カテゴリ内を一括表示' : '1トピック集中表示'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <nav
          aria-label="Enterprise設定カテゴリ"
          data-testid="enterprise-settings-nav"
          className="space-y-3 self-start rounded-xl border border-[#e7e7ea] bg-white p-3 lg:sticky lg:top-4"
        >
          {visibleTopics.length === 0 ? (
            <p className="text-[0.6875rem] text-[#55565a]">
              表示できる設定カテゴリがありません。
            </p>
          ) : (
            ENTERPRISE_SETTING_GROUPS.map((group) => {
              const topics = visibleTopics.filter(
                (topic) => topic.group === group.id
              );
              if (topics.length === 0) return null;
              return (
                <section
                  key={group.id}
                  data-testid={`enterprise-nav-group-${group.id}`}
                  aria-labelledby={`enterprise-nav-group-${group.id}-heading`}
                >
                  <h3
                    id={`enterprise-nav-group-${group.id}-heading`}
                    className="px-1 text-[0.625rem] font-semibold uppercase tracking-[0.08em] text-[#6b6f76]"
                  >
                    {group.label}
                  </h3>
                  <ul className="mt-1 space-y-0.5">
                    {topics.map((topic) => {
                      const isActive = activeTopic?.id === topic.id;
                      return (
                        <li key={topic.id}>
                          <button
                            type="button"
                            data-testid={`enterprise-topic-${topic.id}`}
                            aria-current={isActive ? 'true' : undefined}
                            onClick={() => openTopic(topic)}
                            className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] ${
                              isActive
                                ? 'bg-[#eef0fb] text-[#2f3a8f]'
                                : 'text-[#3c3f46] hover:bg-[#f5f5f7]'
                            }`}
                          >
                            <span className="text-[0.75rem] font-medium leading-snug">
                              {topic.label}
                            </span>
                            <span
                              data-testid={`enterprise-topic-badge-${topic.id}`}
                              className="text-[0.625rem] leading-snug text-[#676b72]"
                            >
                              {topicBadge(topic)}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </nav>

        <div
          id="enterprise-settings-pane"
          data-testid="enterprise-settings-pane"
          className="min-w-0 space-y-4"
        >
          {hasQuery ? (
            <section aria-label="Enterprise設定の検索結果" className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#e7e7ea] bg-white px-4 py-3">
                <p
                  role="status"
                  data-testid="enterprise-settings-search-count"
                  className="text-[0.75rem] font-medium text-[#111214]"
                >
                  検索結果: {matches.length} 件
                </p>
                <p className="text-[0.625rem] text-[#55565a]">
                  「{trimmedQuery}」に一致する設定トピック
                </p>
              </div>

              {matches.length === 0 ? (
                <div
                  data-testid="enterprise-settings-search-empty"
                  className="rounded-xl border border-dashed border-[#d7d7dc] bg-white px-5 py-10 text-center"
                >
                  <p className="text-[0.8125rem] font-medium text-[#111214]">
                    一致する設定が見つかりません
                  </p>
                  <p className="mt-1 text-[0.6875rem] text-[#55565a]">
                    別のキーワード（例: 共有リンク, 透かし, IP, SSO, ToS, SCIM）で検索してください。
                  </p>
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="mt-3 inline-flex h-8 items-center rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
                  >
                    検索をクリア
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {matches.map((topic) => {
                    const group = getEnterpriseSettingGroup(topic.group);
                    return (
                      <article
                        key={topic.id}
                        data-testid={`enterprise-search-card-${topic.id}`}
                        className="space-y-2"
                      >
                        <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[#e7e7ea] bg-white px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-[0.625rem] font-medium text-[#6b6f76]">
                              {group.label}
                            </p>
                            <h3 className="mt-0.5 text-[0.8125rem] font-semibold text-[#111214]">
                              {topic.label}
                            </h3>
                            <p className="mt-1 text-[0.6875rem] leading-relaxed text-[#55565a]">
                              {topic.summary}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span
                              data-testid={`enterprise-search-card-badge-${topic.id}`}
                              className="inline-flex rounded-full border border-[#e1e1e4] bg-[#f9f9fa] px-2 py-0.5 text-[0.625rem] font-medium text-[#3c3f46]"
                            >
                              {topicBadge(topic)}
                            </span>
                            <button
                              type="button"
                              data-testid={`enterprise-search-open-${topic.id}`}
                              onClick={() => {
                                openTopic(topic);
                                scrollToPaneTop();
                              }}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
                            >
                              この設定を開く
                              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        </header>
                        <div data-testid={`enterprise-search-topic-body-${topic.id}`}>
                          {renderTopic(topic.id)}
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : activeTopic && activeGroup ? (
            <>
              <section
                data-testid="enterprise-active-topic-header"
                aria-labelledby="enterprise-active-topic-heading"
                className="rounded-xl border border-[#e7e7ea] bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[0.625rem] font-medium text-[#6b6f76]">
                      {activeGroup.label}
                    </p>
                    <h2
                      id="enterprise-active-topic-heading"
                      className="mt-0.5 text-[0.875rem] font-semibold tracking-[-0.01em] text-[#111214]"
                    >
                      {activeTopic.label}
                    </h2>
                    <p className="mt-1 max-w-3xl text-[0.6875rem] leading-relaxed text-[#55565a]">
                      {activeTopic.summary}
                    </p>
                  </div>
                  <span
                    data-testid="enterprise-active-topic-badge"
                    className="inline-flex items-center rounded-full border border-[#d9dcf5] bg-[#eef0fc] px-2.5 py-1 text-[0.625rem] font-medium text-[#3f4a9e]"
                  >
                    {topicBadge(activeTopic)}
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#f2f2f4] pt-3">
                  <div
                    role="group"
                    aria-label={`${activeGroup.label}の他の設定`}
                    className="flex flex-wrap gap-1.5"
                  >
                    {groupTopics.map((topic) => {
                      const isActive = topic.id === activeTopic.id;
                      return (
                        <button
                          key={topic.id}
                          type="button"
                          data-testid={`enterprise-topic-pill-${topic.id}`}
                          aria-pressed={isActive}
                          onClick={() => selectTopicInternal(topic)}
                          className={`rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium transition focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] ${
                            isActive
                              ? 'border-[#5e6ad2] bg-[#5e6ad2] text-white'
                              : 'border-[#d7d7dc] bg-white text-[#3c3f46] hover:bg-[#f2f2f4]'
                          }`}
                        >
                          {topic.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      data-testid="enterprise-topic-prev"
                      disabled={!previousTopic}
                      onClick={() => {
                        if (!previousTopic) return;
                        selectTopicInternal(previousTopic);
                      }}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      前へ
                    </button>
                    <button
                      type="button"
                      data-testid="enterprise-topic-next"
                      disabled={!nextTopic}
                      onClick={() => {
                        if (!nextTopic) return;
                        selectTopicInternal(nextTopic);
                      }}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
                    >
                      次へ
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </section>

              {mode === 'topic' ? (
                <div data-testid={`enterprise-topic-card-${activeTopic.id}`}>
                  {renderTopic(activeTopic.id)}
                </div>
              ) : (
                <div
                  data-testid="enterprise-settings-group-view"
                  className="space-y-4"
                >
                  {renderGroup ? (
                    renderGroup(activeTopic.group)
                  ) : (
                    groupTopics.map((topic) => (
                      <div
                        key={topic.id}
                        data-testid={`enterprise-topic-card-${topic.id}`}
                      >
                        {renderTopic(topic.id)}
                      </div>
                    ))
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-xl border border-dashed border-[#d7d7dc] bg-white px-5 py-10 text-center text-[0.75rem] text-[#55565a]">
              表示できる Enterprise 設定がありません。
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
