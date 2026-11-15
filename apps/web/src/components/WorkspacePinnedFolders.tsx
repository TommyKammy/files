'use client';

import { Folder } from 'lucide-react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  getDropTargetClassName,
  type WorkspaceDragContextValue,
} from '@/components/WorkspaceDragPortal';
import type { IntentPrefetcher } from '@/lib/intent-prefetch';
import type { FolderSummary } from '@/types/files';

export function WorkspacePinnedFolders({
  isTrashView,
  folderId,
  pinnedFolders,
  revalidating,
  dragCtx,
  prefetcher,
  onOpenFolder,
}: {
  isTrashView: boolean;
  folderId: string | null;
  pinnedFolders: FolderSummary[];
  revalidating: boolean;
  dragCtx: WorkspaceDragContextValue | null;
  prefetcher: IntentPrefetcher;
  onOpenFolder: (folderId: string) => void;
}) {
  if (isTrashView || folderId || pinnedFolders.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          ピン留めされたワークスペース
        </h2>
        {revalidating && (
          <span className="text-[0.6875rem] text-[#6b6f76]">同期中...</span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {pinnedFolders.map((pinned) => {
          const pinnedDropClass =
            dragCtx?.isDragging
              ? getDropTargetClassName(
                  pinned.id,
                  dragCtx.hoveredTarget
                )
              : '';
          return (
            <button
              key={`pinned:${pinned.id}`}
              type="button"
              data-drop-folder-id={pinned.id}
              data-drop-label={pinned.name}
              onMouseEnter={() => prefetcher.scheduleHoverPrefetch(pinned.id)}
              onMouseLeave={() => prefetcher.cancel(pinned.id)}
              onFocus={() => prefetcher.scheduleCursorPrefetch(pinned.id)}
              onBlur={() => prefetcher.cancel(pinned.id)}
              onClick={() => onOpenFolder(pinned.id)}
              className={`flex items-center gap-3 rounded-lg border border-[#e7e7ea] bg-white p-3 text-left transition hover:border-[#d7d7dc] hover:bg-[#f6f6f8] ${pinnedDropClass}`}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#f4f4f5] text-[#6b6f76]">
                <Folder className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] font-medium text-[#111214]">
                  {pinned.name}
                </p>
                <div className="mt-1">
                  <ClassificationBadge
                    classification={pinned.classification}
                    compact
                  />
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
