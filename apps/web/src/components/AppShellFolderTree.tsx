'use client';

import { ChevronDown, ChevronRight, Folder, FolderOpen, Info, Loader2, Pin, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { FolderTreeRow } from '@/components/FolderTreeRow';
import {
  type FolderTreeMenuAction,
  FolderTreeContextMenu,
} from '@/components/FolderTreeContextMenu';
import { MoveCopyTreeModal } from '@/components/MoveCopyTreeModal';
import { PermissionsModal } from '@/components/PermissionsModal';
import { SharePopover } from '@/components/SharePopover';
import {
  getDropTargetClassName,
  useWorkspaceDrag,
} from '@/components/WorkspaceDragPortal';
import { formatDateTime, hasRoleAtLeast } from '@/lib/formatters';
import {
  type WorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import { clampPopoverPosition } from '@/lib/workspace-actions';
import type { FolderSummary } from '@/types/files';

const MAX_TREE_DEPTH = 4;

interface AppShellFolderTreeProps {
  syncStore: WorkspaceSyncStore;
  activeFolderId?: string | null;
  revision: number;
  onSelectFolder?: (folderId: string) => void;
}

export function AppShellFolderTree({
  syncStore,
  activeFolderId = null,
  revision,
  onSelectFolder,
}: AppShellFolderTreeProps) {
  const router = useRouter();
  const dragCtx = useWorkspaceDrag();
  const snapshot = useWorkspaceSyncSnapshot();
  const user = snapshot.user;
  const isSysAdmin = user?.role === 'sys_admin';
  const isPrivilegedAdmin =
    user?.role === 'sys_admin' || user?.role === 'sec_admin';
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    folder: FolderSummary;
    trigger: HTMLElement | null;
  } | null>(null);
  const [shareTarget, setShareTarget] = useState<FolderSummary | null>(null);
  const [permissionsTarget, setPermissionsTarget] = useState<{
    folder: FolderSummary;
    role: 'previewer' | 'viewer' | 'editor' | 'co_owner' | 'owner';
  } | null>(null);
  const [moveTarget, setMoveTarget] = useState<FolderSummary | null>(null);
  const [infoTarget, setInfoTarget] = useState<{
    x: number;
    y: number;
    folder: FolderSummary;
  } | null>(null);

  // Touch revision so React re-evaluates syncStore cached views after updates
  void revision;

  const pinnedFolders = syncStore.getPinnedFolders().slice(0, 6);
  const rootView = syncStore.getDirectoryView(null);
  const rootFolders = rootView.folders;

  useEffect(() => {
    if (!rootView.existsInCache) {
      void syncStore.ensureDirectoryLoaded(null, { isPrefetch: true }).catch(() => {});
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
            : current.querySelector<HTMLElement>('[data-folder-trigger="true"]') ??
              current
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
          setShareTarget(folder);
          break;
        case 'copyLink': {
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
          setPermissionsTarget({ folder, role });
          break;
        case 'move':
          setMoveTarget(folder);
          break;
        case 'pin': {
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
    window.addEventListener('mousedown', handleOutsidePointer, { capture: true });
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('mousedown', handleOutsidePointer, { capture: true });
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
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

  const renderTreeNodes = (folders: FolderSummary[], depth: number): React.ReactNode => {
    if (depth > MAX_TREE_DEPTH || folders.length === 0) return null;

    return folders.map((folder) => {
      const isExpanded = expandedIds.has(folder.id);
      const isLoading = loadingIds.has(folder.id);
      const isActive = activeFolderId === folder.id;
      const childView = isExpanded ? syncStore.getDirectoryView(folder.id) : null;
      const dropRing = dragCtx?.isDragging
        ? getDropTargetClassName(
            folder.id,
            dragCtx.hoveredTarget
          )
        : '';

      return (
        <div key={folder.id}>
          <FolderTreeRow
            folder={folder}
            depth={depth}
            isExpanded={isExpanded}
            isLoading={isLoading}
            isActive={isActive}
            isContextMenuOpen={contextMenu?.folder.id === folder.id}
            dropRing={dropRing}
            onToggle={() => toggleExpand(folder.id)}
            onNavigate={() => navigateToFolder(folder.id)}
            onContextMenu={(e) => openFolderContextMenu(e, folder)}
            onKeyDown={(e) => openFolderMenuFromKeyboard(e, folder)}
          />

          {isExpanded && childView && childView.folders.length > 0 && (
            <div className="space-y-0.5">
              {renderTreeNodes(childView.folders, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-[#dedee1] px-2 pt-3">
      {pinnedFolders.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium text-[#111214]">
            <Pin className="h-3 w-3 text-[#676b72]" />
            <span>クイックアクセス</span>
          </div>
          <div className="space-y-0.5">
            {pinnedFolders.map((pinned) => {
              const isActive = activeFolderId === pinned.id;
              const dropRing = dragCtx?.isDragging
                ? getDropTargetClassName(
                    pinned.id,
                    dragCtx.hoveredTarget
                  )
                : '';

              return (
                <button
                  key={pinned.id}
                  type="button"
                  data-drop-folder-id={pinned.id}
                  data-drop-label={pinned.name}
                  aria-haspopup="menu"
                  aria-expanded={contextMenu?.folder.id === pinned.id}
                  onContextMenu={(e) => openFolderContextMenu(e, pinned)}
                  onKeyDown={(e) => openFolderMenuFromKeyboard(e, pinned)}
                  onClick={() => navigateToFolder(pinned.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
                    dropRing
                      ? `${dropRing} text-[#111214]`
                      : isActive
                        ? 'bg-[#e2e2e6] text-[#111214]'
                        : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                  }`}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[#676b72]" />
                  <span className="min-w-0 flex-1 truncate">{pinned.name}</span>
                  {pinned.classification === 'confidential' && (
                    <span
                      title="Confidential (極秘)"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#d9343f]"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setTreeCollapsed((prev) => !prev)}
          className="mb-1 flex min-h-6 w-full items-center justify-between px-1 py-0.5 text-[0.6875rem] font-medium text-[#111214] hover:text-[#111214]"
        >
          <span>フォルダツリー</span>
          {treeCollapsed ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>

        {!treeCollapsed && (
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5">
            {rootFolders.length > 0 ? (
              renderTreeNodes(rootFolders, 0)
            ) : (
              <div className="px-2 py-1 text-[0.6875rem] text-[#3c3f46]">
                フォルダはありません
              </div>
            )}
          </div>
        )}
      </div>

      {contextMenu && (() => {
        const role = resolveFolderRole(contextMenu.folder);
        const canEdit = isPrivilegedAdmin || hasRoleAtLeast(role, 'editor');
        const canManage = isPrivilegedAdmin || hasRoleAtLeast(role, 'co_owner');
        return (
          <FolderTreeContextMenu
            anchor={{ x: contextMenu.x, y: contextMenu.y }}
            folder={contextMenu.folder}
            canShare={canEdit}
            canManagePermissions={canManage}
            canMove={canEdit}
            canPin={canEdit}
            canTrash={canEdit}
            returnFocus={contextMenu.trigger}
            onAction={handleFolderMenuAction}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      {shareTarget && (
        <SharePopover
          targetType="folder"
          targetId={shareTarget.id}
          targetName={shareTarget.name}
          classification={shareTarget.classification}
          canEdit={
            isPrivilegedAdmin ||
            hasRoleAtLeast(resolveFolderRole(shareTarget), 'editor')
          }
          onClose={() => setShareTarget(null)}
        />
      )}

      {permissionsTarget && (
        <PermissionsModal
          targetType="folder"
          targetId={permissionsTarget.folder.id}
          targetName={permissionsTarget.folder.name}
          effectiveRole={permissionsTarget.role}
          onClose={() => setPermissionsTarget(null)}
        />
      )}

      {moveTarget && user && (
        <MoveCopyTreeModal
          items={[
            {
              type: 'folder',
              id: moveTarget.id,
              name: moveTarget.name,
              parentId: moveTarget.parent_id,
              classification: moveTarget.classification,
              effectiveRole: resolveFolderRole(moveTarget),
            },
          ]}
          modeHint="move"
          currentFolderId={activeFolderId}
          user={user}
          isSysAdmin={isSysAdmin}
          syncStore={syncStore}
          onClose={() => setMoveTarget(null)}
          onSuccess={() => setMoveTarget(null)}
        />
      )}

      {infoTarget && (() => {
        const pos = clampPopoverPosition(
          infoTarget.x + 8,
          infoTarget.y + 8,
          288,
          236,
          window.innerWidth,
          window.innerHeight
        );
        const role = resolveFolderRole(infoTarget.folder);
        return (
          <div
            role="dialog"
            aria-label="フォルダ情報"
            data-folder-info-card="true"
            style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
            className="fixed z-50 w-72 rounded-lg border border-[#e4e4e7] bg-white p-3 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#f4f4f5] text-[#6b6f76]">
                  <Folder className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[0.8125rem] font-medium text-[#111214]">
                    {infoTarget.folder.name}
                  </p>
                  <p className="text-[0.6875rem] text-[#6b6f76]">フォルダ</p>
                </div>
              </div>
              <button
                type="button"
                aria-label="フォルダ情報を閉じる"
                onClick={() => setInfoTarget(null)}
                className="flex h-6 w-6 items-center justify-center rounded text-[#6b6f76] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="mt-3 space-y-2 border-t border-[#f0f0f1] pt-2.5 text-[0.6875rem]">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#6b6f76]">機密区分</span>
                <ClassificationBadge
                  classification={infoTarget.folder.classification}
                  compact
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#6b6f76]">実効ロール</span>
                <span className="font-medium text-[#111214]">{role}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#6b6f76]">更新日時</span>
                <span className="text-[#3c3f46]">
                  {formatDateTime(infoTarget.folder.updated_at)}
                </span>
              </div>
              <div className="flex items-start justify-between gap-3">
                <span className="shrink-0 text-[#6b6f76]">フォルダID</span>
                <span className="break-all text-right font-mono text-[0.625rem] text-[#3c3f46]">
                  {infoTarget.folder.id}
                </span>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
