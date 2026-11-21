'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  addFavorite,
  buildFavoriteKey,
  listFavorites,
  removeFavorite,
  touchRecentItem,
} from '@/lib/files-api/favorites-recents';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type { AuthUser } from '@/types/files';

/**
 * Manages workspace favorites preload/toggling and recent-item view tracking.
 */
export function useWorkspaceFavorites({
  user,
  isGuestUser,
  folderId,
  isTrashView,
  isSharedView,
  isRecentsView,
  isFavoritesView,
  isTasksView,
  syncStore,
  setError,
}: {
  user: AuthUser | null;
  isGuestUser: boolean;
  folderId: string | null;
  isTrashView: boolean;
  isSharedView: boolean;
  isRecentsView: boolean;
  isFavoritesView: boolean;
  isTasksView: boolean;
  syncStore: WorkspaceSyncStore;
  setError: (error: string | null) => void;
}) {
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user || isGuestUser) {
      setFavoriteKeys(new Set());
      return;
    }
    const controller = new AbortController();
    void listFavorites(controller.signal)
      .then((res) => {
        setFavoriteKeys(
          new Set(
            res.items.map((item) => buildFavoriteKey(item.itemType, item.id))
          )
        );
      })
      .catch(() => {
        // Non-blocking preload for context menu star state.
      });
    return () => controller.abort();
  }, [user, isGuestUser]);

  useEffect(() => {
    if (
      !user ||
      !folderId ||
      isTrashView ||
      isSharedView ||
      isRecentsView ||
      isFavoritesView ||
      isTasksView
    ) {
      return;
    }
    void touchRecentItem('folder', folderId, 'view').catch(() => {});
  }, [
    user,
    folderId,
    isTrashView,
    isSharedView,
    isRecentsView,
    isFavoritesView,
    isTasksView,
  ]);

  const handleToggleFavorite = useCallback(
    async (row: WorkspaceTableRow) => {
      const itemType = row.kind;
      const itemId = row.kind === 'folder' ? row.folder.id : row.file.id;
      const itemName = row.kind === 'folder' ? row.folder.name : row.file.name;
      const key = buildFavoriteKey(itemType, itemId);
      const currentlyFavorited = favoriteKeys.has(key);
      try {
        if (currentlyFavorited) {
          await removeFavorite(itemType, itemId);
          setFavoriteKeys((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
          syncStore.pushToast({
            kind: 'info',
            message: `「${itemName}」をお気に入りから解除しました`,
          });
        } else {
          await addFavorite(itemType, itemId);
          setFavoriteKeys((prev) => new Set(prev).add(key));
          syncStore.pushToast({
            kind: 'info',
            message: `「${itemName}」をお気に入りに追加しました`,
          });
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'お気に入りの更新に失敗しました'
        );
      }
    },
    [favoriteKeys, syncStore, setError]
  );

  const isRowFavorited = useCallback(
    (row: WorkspaceTableRow | null | undefined): boolean => {
      if (!row) return false;
      const itemId = row.kind === 'folder' ? row.folder.id : row.file.id;
      return favoriteKeys.has(buildFavoriteKey(row.kind, itemId));
    },
    [favoriteKeys]
  );

  const touchRecentFile = useCallback((fileId: string) => {
    void touchRecentItem('file', fileId, 'view').catch(() => {});
  }, []);

  return {
    favoriteKeys,
    handleToggleFavorite,
    isRowFavorited,
    touchRecentFile,
  };
}
