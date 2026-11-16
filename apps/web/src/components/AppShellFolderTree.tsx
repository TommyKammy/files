'use client';

import { ChevronDown, ChevronRight, Folder, Pin, X } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { FolderTreeRow } from '@/components/FolderTreeRow';
import { useFolderTree } from '@/lib/use-folder-tree';
import { FolderTreeContextMenu } from '@/components/FolderTreeContextMenu';
import { MoveCopyTreeModal } from '@/components/MoveCopyTreeModal';
import { PermissionsModal } from '@/components/PermissionsModal';
import { SharePopover } from '@/components/SharePopover';
import {
  getDropTargetClassName,
  useWorkspaceDrag,
} from '@/components/WorkspaceDragPortal';
import { canAccess } from '@/lib/capabilities';
import { formatDateTime } from '@/lib/formatters';
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
  const dragCtx = useWorkspaceDrag();
  const snapshot = useWorkspaceSyncSnapshot();
  const user = snapshot.user;
  const isSysAdmin = user?.role === 'sys_admin';
  const isPrivilegedAdmin =
    user?.role === 'sys_admin' || user?.role === 'sec_admin';
  // Touch revision so React re-evaluates syncStore cached views after updates
  void revision;

  const {
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
  } = useFolderTree({ syncStore, activeFolderId, onSelectFolder });

  const folderAccess = (folder: FolderSummary) => {
    const role = resolveFolderRole(folder);
    return {
      capabilities:
        folder.capabilities ??
        syncStore.getDirectoryView(folder.id).capabilities,
      effectiveRole: role,
    };
  };

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
        const access = folderAccess(contextMenu.folder);
        const canShare =
          isPrivilegedAdmin || canAccess(access, 'share_link.create');
        const canManagePermissions =
          isPrivilegedAdmin || canAccess(access, 'permission.manage');
        const canPermissions =
          canManagePermissions || canAccess(access, 'permission.invite');
        const canCopyLink =
          isPrivilegedAdmin ||
          (canAccess(access, 'item.preview') &&
            !(
              access.effectiveRole === 'uploader' ||
              access.effectiveRole === 'previewer_uploader' ||
              access.effectiveRole === 'viewer_uploader'
            ));
        return (
          <FolderTreeContextMenu
            anchor={{ x: contextMenu.x, y: contextMenu.y }}
            folder={contextMenu.folder}
            canShare={canShare}
            canCopyLink={canCopyLink}
            canManagePermissions={canPermissions}
            permissionsLabel={
              canManagePermissions ? '権限管理' : 'メンバー招待'
            }
            canMove={isPrivilegedAdmin || canAccess(access, 'folder.move')}
            canPin={isPrivilegedAdmin || canAccess(access, 'folder.rename')}
            canTrash={isPrivilegedAdmin || canAccess(access, 'folder.delete')}
            returnFocus={contextMenu.trigger}
            onAction={handleFolderMenuAction}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      {shareTarget && (() => {
        const access = folderAccess(shareTarget);
        const canCreate =
          isPrivilegedAdmin || canAccess(access, 'share_link.create');
        const canManage =
          isPrivilegedAdmin || canAccess(access, 'share_link.manage');
        return (
          <SharePopover
            targetType="folder"
            targetId={shareTarget.id}
            targetName={shareTarget.name}
            classification={shareTarget.classification}
            canEdit={canCreate}
            canManageLinks={canManage}
            onClose={() => setShareTarget(null)}
          />
        );
      })()}

      {permissionsTarget && (
        <PermissionsModal
          targetType="folder"
          targetId={permissionsTarget.folder.id}
          targetName={permissionsTarget.folder.name}
          effectiveRole={permissionsTarget.role}
          targetCapabilities={folderAccess(permissionsTarget.folder).capabilities}
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
