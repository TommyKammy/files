'use client';

import { ChevronDown, ChevronRight, Folder, FolderOpen, Loader2, Pin } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  getDropTargetClassName,
  useWorkspaceDrag,
} from '@/components/WorkspaceDragPortal';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
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
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set());

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

  // Auto-expand sidebar node during spring-loaded hover so nested folders reveal smoothly
  useEffect(() => {
    const springId = dragCtx?.springTargetId;
    if (!springId) return;
    setExpandedIds((prev) => {
      if (prev.has(springId)) return prev;
      const next = new Set(prev);
      next.add(springId);
      return next;
    });
    if (!syncStore.hasCachedDirectory(springId)) {
      void syncStore.ensureDirectoryLoaded(springId, { isPrefetch: true }).catch(() => {});
    }
  }, [dragCtx?.springTargetId, syncStore]);

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
      const isSpringTarget = dragCtx?.springTargetId === folder.id;
      const childView = isExpanded ? syncStore.getDirectoryView(folder.id) : null;
      const dropRing = dragCtx?.isDragging
        ? getDropTargetClassName(
            folder.id,
            dragCtx.hoveredTarget,
            dragCtx.springTargetId
          )
        : '';

      return (
        <div key={folder.id}>
          <div
            data-drop-folder-id={folder.id}
            data-drop-label={folder.name}
            style={{ paddingLeft: `${8 + depth * 12}px` }}
            className={`group flex items-center gap-1 rounded-md pr-2 py-1 text-xs transition ${
              dropRing
                ? `${dropRing} text-slate-900`
                : isActive
                  ? 'bg-blue-600/20 text-white'
                  : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
            }`}
          >
            <button
              type="button"
              aria-label={isExpanded ? `${folder.name} を閉じる` : `${folder.name} を展開`}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(folder.id);
              }}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:text-white"
            >
              {isLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>

            <button
              type="button"
              onClick={() => navigateToFolder(folder.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              {isExpanded || isActive ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400/80" />
              )}
              <span className="truncate">{folder.name}</span>
            </button>

            {isSpringTarget ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-blue-500" />
            ) : (
              folder.classification === 'confidential' && (
                <span
                  title="Confidential (極秘)"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400"
                />
              )
            )}
          </div>

          {isExpanded && childView && childView.folders.length > 0 && (
            <div className="space-y-0.5">{renderTreeNodes(childView.folders, depth + 1)}</div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="mt-4 border-t border-slate-800/80 px-3 pt-3">
      {pinnedFolders.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <Pin className="h-3 w-3 text-amber-400" />
            <span>クイックアクセス</span>
          </div>
          <div className="space-y-0.5">
            {pinnedFolders.map((pinned) => {
              const isActive = activeFolderId === pinned.id;
              const dropRing = dragCtx?.isDragging
                ? getDropTargetClassName(
                    pinned.id,
                    dragCtx.hoveredTarget,
                    dragCtx.springTargetId
                  )
                : '';

              return (
                <button
                  key={pinned.id}
                  type="button"
                  data-drop-folder-id={pinned.id}
                  data-drop-label={pinned.name}
                  onClick={() => navigateToFolder(pinned.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
                    dropRing
                      ? `${dropRing} text-slate-900`
                      : isActive
                        ? 'bg-blue-600/20 text-white'
                        : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                  }`}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span className="min-w-0 flex-1 truncate">{pinned.name}</span>
                  {pinned.classification === 'confidential' && (
                    <span
                      title="Confidential (極秘)"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setTreeCollapsed((prev) => !prev)}
          className="mb-1 flex w-full items-center justify-between px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-200"
        >
          <span>フォルダツリー</span>
          {treeCollapsed ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>

        {!treeCollapsed && (
          <div className="max-h-56 space-y-0.5 overflow-y-auto pr-0.5">
            {rootFolders.length > 0 ? (
              renderTreeNodes(rootFolders, 0)
            ) : (
              <div className="px-2 py-1 text-[11px] text-slate-500">
                フォルダはありません
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
