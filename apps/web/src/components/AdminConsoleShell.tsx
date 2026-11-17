'use client';

import {
  BarChart3,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Settings,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { isDelegatedCoAdmin } from '@/lib/admin-delegations';
import {
  ADMIN_ROLE_BADGE_LABELS,
  getVisibleAdminNavItems,
  isAdminConsoleRole,
  type AdminConsoleSection,
} from '@/lib/admin-console-nav';
import type { AuthUser } from '@/types/files';

const SECTION_ICONS = {
  all: LayoutDashboard,
  insights: BarChart3,
  content: FolderOpen,
  users: Users,
  settings: Settings,
  reports: FileText,
} as const;

const ROLE_BADGE_CLASS: Record<'sys_admin' | 'sec_admin' | 'co_admin', string> = {
  sys_admin: 'border-[#d9dcf5] bg-[#eef0fc] text-[#3f4a9e]',
  sec_admin: 'border-[#e7dfc7] bg-[#faf5e8] text-[#8a6a1f]',
  co_admin: 'border-[#cfe8dc] bg-[#edf8f2] text-[#1f6b4a]',
};

/**
 * Secondary (left) navigation for the multi-view admin console.
 *
 * The shell is intentionally presentational: active state comes from the
 * route-owned `section` prop, while role-aware filtering is delegated to the
 * pure `getAdminConsoleNavItems` definition so Co-Admin scopes can evolve
 * without touching every page.
 */
export function AdminConsoleShell({
  user,
  section,
  children,
}: {
  user: AuthUser;
  section: AdminConsoleSection;
  children: ReactNode;
}) {
  const items = getVisibleAdminNavItems(user);
  const roleBadge = isAdminConsoleRole(user.role)
    ? ADMIN_ROLE_BADGE_LABELS[user.role]
    : isDelegatedCoAdmin(user)
      ? '共同管理者 (Co-Admin)'
      : null;
  const roleBadgeKey = isAdminConsoleRole(user.role)
    ? user.role
    : isDelegatedCoAdmin(user)
      ? 'co_admin'
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:gap-5">
      <nav
        aria-label="管理コンソールナビゲーション"
        data-testid="admin-console-nav"
        className="min-w-0 lg:sticky lg:top-2 lg:w-52 lg:shrink-0 xl:w-56"
      >
        <div className="mb-2 flex items-center justify-between gap-2 lg:block lg:space-y-1.5">
          <div className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-[#55565a]">
            管理コンソール
          </div>
          {roleBadge && roleBadgeKey && (
            <span
              data-testid="admin-console-role-badge"
              data-role={roleBadgeKey}
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium ${ROLE_BADGE_CLASS[roleBadgeKey]}`}
            >
              {roleBadge}
            </span>
          )}
        </div>

        <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
          {items.map((item) => {
            const Icon = SECTION_ICONS[item.section];
            const active = item.section === section;
            return (
              <li key={item.section} className="shrink-0 lg:w-full">
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  data-admin-section={item.section}
                  className={`flex h-8 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-[0.75rem] font-medium transition ${
                    active
                      ? 'bg-[#e2e2e6] text-[#111214]'
                      : 'text-[#3c3f46] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <Icon
                    className={`h-3.5 w-3.5 shrink-0 ${
                      active ? 'text-[#5e6ad2]' : 'text-[#676b72]'
                    }`}
                    aria-hidden="true"
                  />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-w-0 flex-1 space-y-5">{children}</div>
    </div>
  );
}
