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

  const [directoryLoadingMore, setDirectoryLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trash = useWorkspaceTrash();

  const nextCursor = isTrashView ? trash.nextCursor : directory.nextCursor;
  const loadingMore = isTrashView ? trash.loadingMore : directoryLoadingMore;
  const isInitialLoading = isTrashView
    ? !trash.loaded && !trash.error
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
    if (!nextCursor || loadingMore) return;
    if (isTrashView) {
      await trash.loadMore();
      return;
    }
    setDirectoryLoadingMore(true);
    try {
      await syncStore.loadMoreDirectory(folderId);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : '追加読み込みに失敗しました'
      );
    } finally {
      setDirectoryLoadingMore(false);
    }
  }

  return {
    snapshot,
    directory,
    pinnedFolders,
    user,
    authChecked,
    trash,
    trashError: trash.error,
    error,
    setError,
    loadingMore,
    isInitialLoading,
    nextCursor,
    loadActiveView,
    handleLoadMore,
  };
}
