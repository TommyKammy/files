'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiClientError } from '@/lib/files-api';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import { useWorkspaceDirectory } from '@/lib/sync-store';
import { useWorkspaceTrash } from '@/lib/use-workspace-trash';

export function useWorkspaceData({
  folderId,
  isTrashView,
  syncStore,
}: {
  folderId: string | null;
  isTrashView: boolean;
  syncStore: WorkspaceSyncStore;
}) {
  const { snapshot, directory, pinnedFolders } = useWorkspaceDirectory(
    isTrashView ? null : folderId
  );
  const user = snapshot.user;
  const authChecked = snapshot.authStatus !== 'unknown';

  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trash = useWorkspaceTrash({ setError });

  const nextCursor = isTrashView ? null : directory.nextCursor;
  const isInitialLoading = isTrashView
    ? trash.loading && !trash.loaded
    : !directory.existsInCache &&
      (!snapshot.bootstrapDone || snapshot.revalidating);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hydrated = await syncStore.hydrateFromScopeHint();
      if (!cancelled && hydrated && !isTrashView) {
        void syncStore
          .ensureDirectoryLoaded(folderId)
          .catch(() => undefined);
      }
      await syncStore.bootstrap();
    })();
    return () => {
      cancelled = true;
    };
    // Initial SWR hydration + bootstrap once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStore]);

  const loadActiveView = useCallback(
    async (options?: { force?: boolean }) => {
      if (snapshot.authStatus !== 'authenticated' || !user) return;
      setError(null);

      try {
        if (isTrashView) {
          await trash.loadTrash();
        } else {
          await syncStore.ensureDirectoryLoaded(folderId, {
            force: options?.force,
          });
        }
      } catch (err) {
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'フォルダ内容の取得に失敗しました'
        );
      }
    },
    [
      snapshot.authStatus,
      user,
      isTrashView,
      syncStore,
      folderId,
      trash.loadTrash,
    ]
  );

  useEffect(() => {
    if (snapshot.authStatus === 'authenticated' && user) {
      void loadActiveView();
    }
  }, [snapshot.authStatus, user, loadActiveView]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore || isTrashView) return;
    setLoadingMore(true);
    try {
      await syncStore.loadMoreDirectory(folderId);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '追加読み込みに失敗しました'
      );
    } finally {
      setLoadingMore(false);
    }
  }

  return {
    snapshot,
    directory,
    pinnedFolders,
    user,
    authChecked,
    trash,
    error,
    setError,
    loadingMore,
    isInitialLoading,
    nextCursor,
    loadActiveView,
    handleLoadMore,
  };
}
