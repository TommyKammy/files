'use client';

import { useEffect, useRef } from 'react';
import type * as React from 'react';
import type { ReactNode } from 'react';
import type { AdminConsoleSection } from '@/lib/admin-console-nav';
import {
  getAdminTabDomId,
  getAdminTabPanelDomId,
  type AdminConsoleTabItem,
} from '@/lib/admin-console-tabs';
import { isImeComposingEvent } from '@/lib/keyboard/events';

/**
 * TOM-74 horizontal WAI-ARIA tablist for the admin console.
 *
 * The component is presentational: the active tab and the visible tab set are
 * resolved by `useGovernanceDashboard`, which keeps the URL (`?tab=`) and the
 * Co-Admin capability projection in one place.
 */
export function AdminSectionTabs({
  section,
  tabs,
  activeTabId,
  onSelectTab,
  ariaLabel = '管理コンソールのセクション内タブ',
  badges,
}: {
  section: AdminConsoleSection;
  tabs: readonly AdminConsoleTabItem[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  ariaLabel?: string;
  badges?: Partial<Record<string, number>>;
}) {
  const tablistRef = useRef<HTMLDivElement | null>(null);

  // Keep the selected tab visible in the single scrolling row. `container`
  // limits scrolling to the tablist instead of moving the whole page.
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tablistRef.current?.querySelector<HTMLElement>(
      `[data-tab-id="${activeTabId}"]`
    );
    tab?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      container: 'nearest',
    } as ScrollIntoViewOptions);
  }, [activeTabId]);

  function focusTab(tabId: string) {
    tablistRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)
      ?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (isImeComposingEvent(event) || tabs.length === 0) return;

    const currentIndex = Math.max(
      0,
      activeTabId ? tabs.findIndex((tab) => tab.id === activeTabId) : 0
    );

    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    onSelectTab(nextTab.id);
    focusTab(nextTab.id);
  }

  return (
    <div
      ref={tablistRef}
      role="tablist"
      aria-label={ariaLabel}
      data-testid="admin-section-tabs"
      {...({ focusgroup: 'tablist nomemory' } as React.HTMLAttributes<HTMLDivElement>)}
      onKeyDown={handleKeyDown}
      className="flex items-center gap-1 overflow-x-auto border-b border-[#e7e7ea] whitespace-nowrap"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const badgeCount = badges?.[tab.id];
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={getAdminTabDomId(section, tab.id)}
            data-testid={`admin-tab-${tab.id}`}
            data-tab-id={tab.id}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            {...(active
              ? ({
                  focusgroupstart: '',
                } as React.ButtonHTMLAttributes<HTMLButtonElement>)
              : {})}
            onClick={() => onSelectTab(tab.id)}
            className="relative inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-t-md px-3 text-[0.75rem] font-medium text-[#55565a] transition-colors after:pointer-events-none after:content-[''] hover:text-[#111214] aria-selected:text-[#3f4a9e] aria-selected:after:absolute aria-selected:after:inset-x-0 aria-selected:after:bottom-0 aria-selected:after:border-b-2 aria-selected:after:border-[#5e6ad2]"
          >
            {tab.label}
            {typeof badgeCount === 'number' && badgeCount > 0 && (
              <span
                data-testid={`admin-tab-badge-${tab.id}`}
                aria-hidden="true"
                className="ml-1.5 inline-flex items-center rounded-full bg-[#eef0fb] px-1.5 py-0.5 text-[0.625rem] font-semibold leading-none text-[#3f4a9e]"
              >
                {badgeCount}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Active tab panel; one panel is mounted at a time (delayed mounting). */
export function AdminTabPanel({
  section,
  tabId,
  summary,
  children,
}: {
  section: AdminConsoleSection;
  tabId: string;
  summary?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={getAdminTabPanelDomId(section, tabId)}
      aria-labelledby={getAdminTabDomId(section, tabId)}
      data-testid={`admin-tabpanel-${tabId}`}
      className="space-y-4"
    >
      {summary && (
        <p
          data-testid="admin-active-tab-summary"
          className="text-[0.6875rem] text-[#55565a]"
        >
          {summary}
        </p>
      )}
      {children}
    </div>
  );
}
