'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { FolderTreeMenuAction } from '@/components/FolderTreeContextMenu';
import { canAccess } from '@/lib/capabilities';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { FolderSummary, ResourceRole } from '@/types/files';

export function useFolderTree({
  syncStore,
  activeFolderId,
  onSelectFolder,
}: {
  syncStore: WorkspaceSyncStore;
  activeFolderId: string | null;
  onSelectFolder?: (folderId: string) => void;
}) {
  const router = useRouter();
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set()
  );
  const [loadingIds, setLoadingIds] = useState<Set<string>>(
    () => new Set()
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    folder: FolderSummary;
    trigger: HTMLElement | null;
  } | null>(null);
  const [shareTarget, setShareTarget] = useState<FolderSummary | null>(null);
  const [permissionsTarget, setPermissionsTarget] = useState<{
    folder: FolderSummary;
    role: ResourceRole;
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState<FolderSummary | null>(null);
  const [infoTarget, setInfoTarget] = useState<{
    x: number;
    y: number;
    folder: FolderSummary;
  } | null>(null);

  const pinnedFolders = syncStore.getPinnedFolders().slice(0, 6);
  const rootView = syncStore.getDirectoryView(null);
  const rootFolders = rootView.folders;

  useEffect(() => {
    if (!rootView.existsInCache) {
      void syncStore
        .ensureDirectoryLoaded(null, { isPrefetch: true })
        .catch(() => {});
    }
  }, [syncStore, rootView.existsInCache]);

  const navigateToFolder = useCallback(
    (folderId: string) => {
      if (onSelectFolder) {
        onSelectFolder(folderId);
      } else {
        router.push(`/workspace?folderId=${encodeURIComponent(folderId)}`);
      }
    },
    [onSelectFolder, router]
  );

  const resolveFolderRole = useCallback(
    (folder: FolderSummary) =>
      folder.effectiveRole ??
      syncStore.getDirectoryView(folder.id).effectiveRole ??
      'viewer',
    [syncStore]
  );

  const openFolderMenuAt = useCallback(
    (
      x: number,
      y: number,
      folder: FolderSummary,
      trigger: HTMLElement | null
    ) => {
      setContextMenu({ x, y, folder, trigger });
    },
    []
  );

  const openFolderContextMenu = useCallback(
    (event: React.MouseEvent, folder: FolderSummary) => {
      event.preventDefault();
      event.stopPropagation();
      const current = event.currentTarget;
      const trigger =
        current instanceof HTMLElement
          ? current.matches('button')
            ? current
            : current.querySelector<HTMLElement>(
                '[data-folder-trigger="true"]'
              ) ?? current
          : null;
      openFolderMenuAt(event.clientX, event.clientY, folder, trigger);
    },
    [openFolderMenuAt]
  );

  const openFolderMenuFromKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLElement>, folder: FolderSummary) => {
      if (
        event.key !== 'ContextMenu' &&
        !(event.shiftKey && event.key === 'F10')
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      openFolderMenuAt(
        Math.round(rect.left + 24),
        Math.round(rect.top + rect.height / 2),
        folder,
        event.currentTarget
      );
    },
    [openFolderMenuAt]
  );

  const handleFolderMenuAction = useCallback(
    (action: FolderTreeMenuAction) => {
      const folder = contextMenu?.folder;
      if (!folder) return;
      const role = resolveFolderRole(folder);
      const access = {
        capabilities:
          folder.capabilities ??
          syncStore.getDirectoryView(folder.id).capabilities,
        effectiveRole: role,
      };
      const deny = (message: string) => {
        syncStore.pushToast({ kind: 'error', message });
        setContextMenu(null);
      };

      switch (action) {
        case 'open':
          navigateToFolder(folder.id);
          break;
        case 'openInNewTab':
          window.open(
            `/workspace?folderId=${encodeURIComponent(folder.id)}`,
            '_blank',
            'noopener,noreferrer'
          );
          break;
        case 'share':
          if (!canAccess(access, 'share_link.create')) {
            deny('共有リンクを作成する権限がありません');
            break;
          }
          setShareTarget(folder);
          break;
        case 'copyLink': {
          if (!canAccess(access, 'item.preview')) {
            deny('リンクをコピーする権限がありません');
            break;
          }
          const url = `${window.location.origin}/workspace?folderId=${encodeURIComponent(folder.id)}`;
          void navigator.clipboard
            .writeText(url)
            .then(() =>
              syncStore.pushToast({
                kind: 'info',
                message: '内部リンクをコピーしました',
              })
            )
            .catch(() =>
              syncStore.pushToast({
                kind: 'error',
                message: 'リンクをコピーできませんでした',
              })
            );
          break;
        }
        case 'permissions':
          if (!canAccess(access, 'permission.manage')) {
            deny('権限を管理する権限がありません');
            break;
          }
          setPermissionsTarget({ folder, role });
          break;
        case 'move':
          if (!canAccess(access, 'folder.move')) {
            deny('フォルダを移動する権限がありません');
            break;
          }
          setMoveTarget(folder);
          break;
        case 'pin': {
          if (!canAccess(access, 'folder.rename')) {
            deny('ピン留めを変更する権限がありません');
            break;
          }
          const res = syncStore.optimisticToggleFolderPin(folder);
          if (!res.ok) {
            syncStore.pushToast({
              kind: 'error',
              message: res.error ?? 'ピン留めの変更に失敗しました',
            });
          }
          break;
        }
        case 'info':
          setInfoTarget({
            x: contextMenu.x,
            y: contextMenu.y,
            folder,
          });
          break;
        case 'trash': {
          if (!canAccess(access, 'folder.delete')) {
            deny('フォルダを削除する権限がありません');
            break;
          }
          const res = syncStore.optimisticSoftDeleteFolder(folder);
          if (!res.ok) {
            syncStore.pushToast({
              kind: 'error',
              message: res.error ?? 'フォルダの削除に失敗しました',
            });
            break;
          }
          const affectsActiveFolder =
            activeFolderId === folder.id ||
            (activeFolderId
              ? syncStore.isFolderAncestorOf(folder.id, activeFolderId)
              : false);
          if (affectsActiveFolder) {
            if (folder.parent_id) navigateToFolder(folder.parent_id);
            else router.push('/workspace');
          }
          break;
        }
      }
      setContextMenu(null);
    },
    [
      contextMenu,
      resolveFolderRole,
      navigateToFolder,
      syncStore,
      activeFolderId,
      router,
    ]
  );

  useEffect(() => {
    if (!infoTarget) return;
    function handleOutsidePointer(e: MouseEvent) {
      if (
        e.target instanceof Element &&
        e.target.closest('[data-folder-info-card="true"]')
      ) {
        return;
      }
      setInfoTarget(null);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setInfoTarget(null);
    }
    window.addEventListener('mousedown', handleOutsidePointer, {
      capture: true,
    });
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('mousedown', handleOutsidePointer, {
        capture: true,
      });
      window.removeEventListener('keydown', handleKeyDown, {
        capture: true,
      });
    };
  }, [infoTarget]);

  const toggleExpand = useCallback(
    (folderId: string) => {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(folderId)) {
          next.delete(folderId);
        } else {
          next.add(folderId);
          if (!syncStore.isDirectoryFresh(folderId)) {
            setLoadingIds((curr) => new Set(curr).add(folderId));
            void syncStore
              .ensureDirectoryLoaded(folderId, { isPrefetch: true })
              .catch(() => {})
              .finally(() => {
                setLoadingIds((curr) => {
                  if (!curr.has(folderId)) return curr;
                  const updated = new Set(curr);
                  updated.delete(folderId);
                  return updated;
                });
              });
          }
        }
        return next;
      });
    },
    [syncStore]
  );

  return {
    treeCollapsed,
    setTreeCollapsed,
    expandedIds,
    loadingIds,
    contextMenu,
    setContextMenu,
    shareTarget,
    setShareTarget,
    permissionsTarget,
    setPermissionsTarget,
    moveTarget,
    setMoveTarget,
    infoTarget,
    setInfoTarget,
    pinnedFolders,
    rootFolders,
    navigateToFolder,
    resolveFolderRole,
    openFolderContextMenu,
    openFolderMenuFromKeyboard,
    handleFolderMenuAction,
    toggleExpand,
  };
}
