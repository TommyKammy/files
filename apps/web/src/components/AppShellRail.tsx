'use client';

import { CheckSquare, Clock, FolderOpen, LogOut, Search, Share2, ShieldAlert, Star, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShellFolderTree } from '@/components/AppShellFolderTree';
import { CommandPalette } from '@/components/CommandPalette';
import { NotificationBellPopover } from '@/components/NotificationBellPopover';
import {
  getDropTargetClassName,
  useWorkspaceDrag,
} from '@/components/WorkspaceDragPortal';
import { hasAnyAdminCapability } from '@/lib/admin-delegations';
import { ROOT_DROP_ID } from '@/lib/drag-drop-controller';
import { logoutSession } from '@/lib/files-api';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import type { WorkspacePaletteActions } from '@/lib/palette-actions';
import {
  getWorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import type { AuthUser, SearchResultItem } from '@/types/files';

export type { WorkspacePaletteActions } from '@/lib/palette-actions';

export function AppShellRail({
  user,
  activeView,
  activeFolderId = null,
  onSelectResult,
  onSelectFolder,
  workspaceActions,
}: {
  user: AuthUser | null;
  activeView?: 'workspace' | 'trash' | 'admin' | 'shared' | 'search' | 'recents' | 'favorites' | 'tasks';
  activeFolderId?: string | null;
  onSelectResult?: (item: SearchResultItem) => void;
  onSelectFolder?: (folderId: string) => void;
  workspaceActions?: WorkspacePaletteActions;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const syncStore = getWorkspaceSyncStore();
  const snapshot = useWorkspaceSyncSnapshot();
  const dragCtx = useWorkspaceDrag();

  const [searchOpen, setSearchOpen] = useState(false);
  // Every `/admin/*` deep link belongs to the governance view, even when a
  // caller omits `activeView`. The explicit prop still wins for other views.
  const resolvedView =
    activeView === 'admin' || pathname.startsWith('/admin')
      ? 'admin'
      : activeView === 'search' || pathname.startsWith('/workspace/search')
        ? 'search'
        : (activeView ?? 'workspace');
  const isGuest = user?.userType === 'guest';
  // TOM-73: sys_admin / sec_admin plus members holding an active Co-Admin
  // delegation see the governance entry point. Guests never do.
  const isAdmin = hasAnyAdminCapability(user);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function handleLogout() {
    await logoutSession();
    router.push('/');
    router.refresh();
  }

  return (
    <>
      <aside className="sticky top-0 flex h-screen w-[245px] shrink-0 self-start flex-col justify-between bg-[#efeff1] text-[#111214]">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-4">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-[#5e6ad2] text-[0.6875rem] font-semibold text-white">
                F
              </div>
              <div className="min-w-0">
                <div className="truncate text-[0.8125rem] font-semibold tracking-[-0.01em] text-[#111214]">
                  Files
                </div>
                <div className="truncate text-[0.6875rem] text-[#3c3f46]">
                  Enterprise Governance
                </div>
              </div>
            </div>
            <NotificationBellPopover enabled={Boolean(user)} />
          </div>

          <div className="px-3 pb-2">
            {isGuest ? (
              <div className="rounded-md border border-[#d7d7dc] bg-[#f9f9fa] px-2 py-1.5 text-[0.6875rem] leading-relaxed text-[#3c3f46]">
                <span className="block font-medium text-[#111214]">
                  外部ゲスト
                </span>
                <span className="block truncate">
                  {user?.externalOrg ?? '外部組織未設定'}
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="flex h-7 w-full items-center justify-between rounded-md px-2 text-[0.8125rem] text-[#111214] transition hover:bg-[#e4e4e6] hover:text-[#111214]"
              >
                <span className="flex items-center gap-2">
                  <Search className="h-4 w-4 text-[#676b72]" />
                  <span>横断検索...</span>
                </span>
                <kbd className="rounded border border-[#d7d7dc] bg-[#f9f9fa] px-1 py-0.5 font-mono text-[0.625rem] text-[#3c3f46]">
                  ⌘K
                </kbd>
              </button>
            )}
          </div>

          <nav aria-label="メインナビゲーション" className="space-y-0.5 px-2">
            {isGuest ? (
              <Link
                href="/workspace?view=shared"
                className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                  resolvedView === 'shared' || resolvedView === 'workspace'
                    ? 'bg-[#e2e2e6] text-[#111214]'
                    : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                }`}
              >
                <Share2 className="h-4 w-4 text-[#676b72]" />
                <span>共有アイテム</span>
              </Link>
            ) : (
              <>
                <Link
                  href="/workspace"
                  data-drop-folder-id={ROOT_DROP_ID}
                  data-drop-label="マイファイル"
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                    dragCtx?.isDragging
                      ? `${getDropTargetClassName(
                          null,
                          dragCtx.hoveredTarget
                        ) || (resolvedView === 'workspace'
                          ? 'bg-[#e2e2e6] text-[#111214]'
                          : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]')}`
                      : resolvedView === 'workspace'
                        ? 'bg-[#e2e2e6] text-[#111214]'
                        : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <FolderOpen className="h-4 w-4 text-[#676b72]" />
                  <span>マイファイル</span>
                </Link>

                <Link
                  href="/workspace?view=shared"
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                    resolvedView === 'shared'
                      ? 'bg-[#e2e2e6] text-[#111214]'
                      : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <Share2 className="h-4 w-4 text-[#676b72]" />
                  <span>共有アイテム</span>
                </Link>

                <Link
                  href="/workspace?view=recents"
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                    resolvedView === 'recents'
                      ? 'bg-[#e2e2e6] text-[#111214]'
                      : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <Clock className="h-4 w-4 text-[#676b72]" />
                  <span>最近使用した項目</span>
                </Link>

                <Link
                  href="/workspace?view=favorites"
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                    resolvedView === 'favorites'
                      ? 'bg-[#e2e2e6] text-[#111214]'
                      : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <Star className="h-4 w-4 text-[#676b72]" />
                  <span>お気に入り</span>
                </Link>

                <Link
                  href="/workspace?view=tasks"
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                    resolvedView === 'tasks'
                      ? 'bg-[#e2e2e6] text-[#111214]'
                      : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <CheckSquare className="h-4 w-4 text-[#676b72]" />
                  <span>タスク</span>
                </Link>

                <Link
                  href="/workspace/search"
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                    resolvedView === 'search'
                      ? 'bg-[#e2e2e6] text-[#111214]'
                      : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <Search className="h-4 w-4 text-[#676b72]" />
                  <span>詳細検索</span>
                </Link>

                <Link
                  href="/workspace?view=trash"
                  className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                    resolvedView === 'trash'
                      ? 'bg-[#e2e2e6] text-[#111214]'
                      : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <Trash2 className="h-4 w-4 text-[#676b72]" />
                  <span>ゴミ箱</span>
                </Link>

                {isAdmin && (
                  <Link
                    href="/admin"
                    className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                      resolvedView === 'admin'
                        ? 'bg-[#e2e2e6] text-[#111214]'
                        : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                    }`}
                  >
                    <ShieldAlert className="h-4 w-4 text-[#676b72]" />
                    <span>ガバナンス</span>
                  </Link>
                )}
              </>
            )}
          </nav>

          {user && !isGuest && (resolvedView === 'workspace' || resolvedView === 'trash') && (
            <AppShellFolderTree
              syncStore={syncStore}
              activeFolderId={activeFolderId}
              revision={snapshot.revision}
              onSelectFolder={onSelectFolder}
            />
          )}
        </div>

        <div className="p-2 pb-8">
          {user ? (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-[#e6e6e8]">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#5e6ad2] text-[0.625rem] font-semibold text-white">
                {user.displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.75rem] font-medium text-[#111214]">
                  {user.displayName}
                </div>
                <div className="truncate text-[0.6875rem] text-[#3c3f46]">
                  {user.email}
                </div>
                {isGuest && (
                  <div className="truncate text-[0.625rem] text-[#676b72]">
                    {user.externalOrg ?? '外部組織未設定'}
                    {user.expiresAt
                      ? ` / 期限 ${new Date(user.expiresAt).toLocaleDateString('ja-JP')}`
                      : ''}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={handleLogout}
                title="サインアウト"
                className="flex h-6 w-6 items-center justify-center rounded text-[#676b72] transition hover:bg-[#dcdcdf] hover:text-[#111214]"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="px-2 py-1 text-[0.75rem] text-[#3c3f46]">未認証</div>
          )}
        </div>
      </aside>

      {!isGuest && (
        <CommandPalette
          open={searchOpen}
          user={user}
          activeView={
            resolvedView === 'recents' ||
            resolvedView === 'favorites' ||
            resolvedView === 'tasks'
              ? 'workspace'
              : resolvedView
          }
          workspaceActions={workspaceActions}
          onSelectResult={onSelectResult}
          onSelectFolder={onSelectFolder}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </>
  );
}
