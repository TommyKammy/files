'use client';

import { Loader2 } from 'lucide-react';
import { AppShellRail } from '@/components/AppShellRail';
import { SignInCard } from '@/components/SignInCard';
import { WorkspaceFavoritesView } from '@/components/WorkspaceFavoritesView';
import { WorkspaceMyTasksView } from '@/components/WorkspaceMyTasksView';
import { WorkspaceRecentsView } from '@/components/WorkspaceRecentsView';
import { WorkspaceSharedItemsView } from '@/components/WorkspaceSharedItemsView';
import {
  guestSessionIssueFromCode,
  type GuestSessionIssue,
} from '@/lib/guest-collaboration';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { AuthUser, SearchResultItem } from '@/types/files';

export interface WorkspaceAuthGateProps {
  authChecked: boolean;
  user: AuthUser | null;
  sessionError: {
    code?: string | null;
    message?: string | null;
    userType?: AuthUser['userType'] | null;
  } | null;
  syncStore: WorkspaceSyncStore;
}

/**
 * Renders the session-checking spinner or appropriate SignInCard when the user
 * is not authenticated.
 */
export function WorkspaceAuthGate({
  authChecked,
  user,
  sessionError,
  syncStore,
}: WorkspaceAuthGateProps) {
  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
        セッションを確認中...
      </div>
    );
  }

  if (user) return null;

  const sessionIssue: GuestSessionIssue | null = sessionError
    ? guestSessionIssueFromCode(
        sessionError.code ?? null,
        sessionError.userType
      )
    : null;

  if (sessionError?.code === 'SESSION_REVOKED_BY_ADMIN') {
    return (
      <SignInCard
        title="セッションが管理者によって失効されました"
        description={
          sessionError.message ||
          '管理者が強制サインアウトを実行しました。安全のため再度サインインしてください。'
        }
        returnTo="/workspace"
        onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
      />
    );
  }

  if (sessionIssue) {
    return (
      <SignInCard
        title="外部ゲストの再サインインが必要です"
        description="セッションが失効したため、ワークスペースの内容を安全に破棄しました。原因を確認し、外部ゲストサインインから認証コードを再取得してください。"
        returnTo="/workspace"
        guestIssue={sessionIssue}
        onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
      />
    );
  }

  return (
    <SignInCard
      title="Files ワークスペースへサインイン"
      description="組織の SSO (OIDC) セッションが必要です。認証後、自動的にワークスペースへ戻ります。"
      returnTo="/workspace"
      onSignedIn={(signedIn) => {
        void syncStore.adoptAuthenticatedUser(signedIn);
      }}
    />
  );
}

export interface WorkspaceSpecialViewShellProps {
  user: AuthUser;
  viewKind: 'tasks' | 'recents' | 'favorites' | 'shared';
  isGuestUser: boolean;
  onSelectResult: (item: SearchResultItem) => void;
  onOpenFolder: (folderId: string) => void;
  onTouchRecentFile: (fileId: string) => void;
}

/**
 * Renders the shell for non-directory workspace sub-views: tasks, recents,
 * favorites, and shared items.
 */
export function WorkspaceSpecialViewShell({
  user,
  viewKind,
  isGuestUser,
  onSelectResult,
  onOpenFolder,
  onTouchRecentFile,
}: WorkspaceSpecialViewShellProps) {
  function openFileWindow(fileId: string, trackRecent: boolean) {
    if (trackRecent) {
      onTouchRecentFile(fileId);
    }
    window.open(`/workspace/file/${encodeURIComponent(fileId)}`, '_blank');
  }

  return (
    <div className="flex min-h-screen bg-[#efeff1] text-[#111214]">
      <AppShellRail
        user={user}
        activeView={viewKind}
        activeFolderId={null}
        onSelectResult={onSelectResult}
        onSelectFolder={onOpenFolder}
      />
      <main
        id="workspace-main"
        tabIndex={-1}
        className="mb-2 mr-2 mt-2 min-w-0 flex-1 space-y-4 rounded-2xl border border-[#e7e7ea] bg-[#f9f9fa] px-5 py-4 lg:px-7"
      >
        {viewKind === 'tasks' ? (
          <WorkspaceMyTasksView
            onOpenFolder={onOpenFolder}
            onOpenFile={(fileId) => openFileWindow(fileId, true)}
          />
        ) : viewKind === 'recents' ? (
          <WorkspaceRecentsView
            onOpenFolder={onOpenFolder}
            onOpenFile={(fileId) => openFileWindow(fileId, true)}
          />
        ) : viewKind === 'favorites' ? (
          <WorkspaceFavoritesView
            onOpenFolder={onOpenFolder}
            onOpenFile={(fileId) => openFileWindow(fileId, true)}
          />
        ) : (
          <WorkspaceSharedItemsView
            isGuest={isGuestUser}
            externalOrg={user.externalOrg ?? null}
            expiresAt={user.expiresAt ?? null}
            onOpenFolder={onOpenFolder}
            onOpenFile={(fileId) => openFileWindow(fileId, false)}
          />
        )}
      </main>
    </div>
  );
}
