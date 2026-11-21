'use client';

import { Loader2, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { AppShellRail } from '@/components/AppShellRail';
import { LocalDevQuickLoginPanel, SignInCard } from '@/components/SignInCard';
import { getVisibleAdminNavItems } from '@/lib/admin-console-nav';
import type { SyncStoreSnapshot, WorkspaceSyncStore } from '@/lib/sync-store';
import type { AuthUser } from '@/types/files';

interface GovernanceAuthGatesProps {
  authChecked: boolean;
  user: AuthUser | null;
  snapshot: SyncStoreSnapshot;
  syncStore: WorkspaceSyncStore;
  isPrivilegedAdmin: boolean;
  sectionAllowed: boolean;
}

/**
 * Renders early-return authentication, role, and delegated-section gates
 * before the governance dashboard shell mounts.
 */
export function GovernanceAuthGates({
  authChecked,
  user,
  snapshot,
  syncStore,
  isPrivilegedAdmin,
  sectionAllowed,
}: GovernanceAuthGatesProps) {
  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
        認証を確認中...
      </div>
    );
  }

  if (!user) {
    if (snapshot.sessionError?.code === 'SESSION_REVOKED_BY_ADMIN') {
      return (
        <SignInCard
          title="セッションが管理者によって失効されました"
          description={
            snapshot.sessionError.message ||
            '管理者が強制サインアウトを実行しました。安全のため再度サインインしてください。'
          }
          returnTo="/admin"
          preferredRoles={['sys_admin', 'sec_admin']}
          onSignedIn={(signedIn) => {
            void syncStore.adoptAuthenticatedUser(signedIn);
          }}
        />
      );
    }
    return (
      <SignInCard
        title="ガバナンスセンターへサインイン"
        description="システム管理者 (sys_admin) またはセキュリティ管理者 (sec_admin) としてサインインしてください。"
        returnTo="/admin"
        preferredRoles={['sys_admin', 'sec_admin']}
        onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
      />
    );
  }

  if (!isPrivilegedAdmin) {
    return (
      <div className="flex min-h-screen bg-[#efeff1] text-slate-900">
        <AppShellRail user={user} activeView="workspace" />
        <main className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-xs space-y-3">
            <ShieldAlert className="mx-auto h-8 w-8 text-amber-500" />
            <h1 className="text-base font-semibold text-slate-900">
              アクセス権限がありません (403)
            </h1>
            <p className="text-[0.6875rem] text-[#55565a]">
              管理ガバナンスコンソールは sys_admin または sec_admin ロール専用です。
            </p>
            <Link
              href="/workspace"
              className="inline-flex rounded-md bg-[#5e6ad2] px-4 py-2 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2]"
            >
              ワークスペースに戻る
            </Link>
            <LocalDevQuickLoginPanel
              preferredRoles={['sys_admin', 'sec_admin']}
              onSignedIn={(signedIn) => {
                void syncStore.adoptAuthenticatedUser(signedIn);
              }}
            />
          </div>
        </main>
      </div>
    );
  }

  if (!sectionAllowed) {
    const visibleItems = getVisibleAdminNavItems(user);
    return (
      <div className="flex min-h-screen bg-[#efeff1] text-slate-900">
        <AppShellRail user={user} activeView="admin" />
        <main className="flex flex-1 items-center justify-center p-8">
          <div
            data-testid="admin-section-denied"
            className="max-w-lg rounded-2xl border border-amber-200 bg-white p-8 text-center shadow-xs space-y-3"
          >
            <ShieldAlert className="mx-auto h-8 w-8 text-amber-500" />
            <h1 className="text-base font-semibold text-slate-900">
              権限がありません
            </h1>
            <p className="text-[0.6875rem] text-[#55565a]">
              このセクションを表示する管理 Capability が委任されていません。
              許可済みのタブから利用してください。
            </p>
            {visibleItems.length > 0 && (
              <div className="flex flex-wrap justify-center gap-2 pt-1">
                {visibleItems.map((item) => (
                  <Link
                    key={item.section}
                    href={item.href}
                    className="inline-flex rounded-md border border-[#e1e1e4] bg-white px-3 py-1.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </main>
      </div>
    );
  }

  return null;
}
