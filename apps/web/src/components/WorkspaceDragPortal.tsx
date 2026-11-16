'use client';

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Folder,
  FileText,
  MoveRight,
} from 'lucide-react';
import {
  createContext,
  useContext,
  useMemo,
} from 'react';
import { createPortal } from 'react-dom';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { type DragWorkspaceItem, encodeDropFolderId } from '@/lib/drag-drop-controller';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  useWorkspaceDragSession,
  type ActiveHoveredDropTarget,
} from '@/lib/use-workspace-drag-session';

export type { ActiveHoveredDropTarget } from '@/lib/use-workspace-drag-session';

export interface WorkspaceDragContextValue {
  isDragging: boolean;
  dragItems: DragWorkspaceItem[];
  hoveredTarget: ActiveHoveredDropTarget | null;
  startPointerDragCandidate: (
    event: React.PointerEvent,
    items: DragWorkspaceItem[]
  ) => void;
  registerScrollContainer: (el: HTMLElement | null) => void;
  cancelDrag: () => void;
}

const WorkspaceDragContext = createContext<WorkspaceDragContextValue | null>(null);

export function useWorkspaceDrag(): WorkspaceDragContextValue | null {
  return useContext(WorkspaceDragContext);
}

export function getDropTargetClassName(
  targetFolderId: string | null,
  hoveredTarget: ActiveHoveredDropTarget | null
): string {
  const encoded = encodeDropFolderId(targetFolderId);
  if (!hoveredTarget || hoveredTarget.rawId !== encoded) return '';
  if (!hoveredTarget.evaluation.allowed) {
    return 'ring-2 ring-red-400 bg-red-50/70';
  }
  if (hoveredTarget.evaluation.promotesToConfidential) {
    return 'ring-2 ring-amber-500 bg-amber-50/80';
  }
  return 'ring-2 ring-blue-500 bg-blue-50/80';
}

export function WorkspaceDragProvider({
  syncStore,
  currentFolderId,
  isSysAdmin,
  onPrefetchFolder,
  onDropMove,
  children,
}: {
  syncStore: WorkspaceSyncStore;
  currentFolderId: string | null;
  isSysAdmin: boolean;
  onPrefetchFolder: (folderId: string) => void;
  onDropMove: (
    items: DragWorkspaceItem[],
    targetFolderId: string | null,
    targetLabel: string
  ) => void;
  children:
    | React.ReactNode
    | ((ctx: WorkspaceDragContextValue) => React.ReactNode);
}) {
  const {
    isDragging,
    dragItems,
    hoveredTarget,
    startPointerDragCandidate,
    registerScrollContainer,
    cancelDrag,
    ghostRef,
    pointerPosRef,
    strictestDragClass,
  } = useWorkspaceDragSession({
    syncStore,
    currentFolderId,
    isSysAdmin,
    onPrefetchFolder,
    onDropMove,
  });

  const contextValue = useMemo<WorkspaceDragContextValue>(
    () => ({
      isDragging,
      dragItems,
      hoveredTarget,
      startPointerDragCandidate,
      registerScrollContainer,
      cancelDrag,
    }),
    [
      isDragging,
      dragItems,
      hoveredTarget,
      startPointerDragCandidate,
      registerScrollContainer,
      cancelDrag,
    ]
  );

  return (
    <WorkspaceDragContext.Provider value={contextValue}>
      {typeof children === 'function' ? children(contextValue) : children}
      {isDragging &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={ghostRef}
            aria-hidden="true"
            style={{
              transform: `translate3d(${Math.round(pointerPosRef.current.x + 16)}px, ${Math.round(pointerPosRef.current.y + 14)}px, 0)`,
            }}
            className="pointer-events-none fixed left-0 top-0 z-50 max-w-xs select-none will-change-transform"
          >
            <div className="rounded-xl border border-slate-300 bg-white/95 px-3 py-2 shadow-xl backdrop-blur-xs">
              <div className="flex items-center gap-2">
                {dragItems[0]?.type === 'folder' ? (
                  <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-blue-500" />
                )}
                <span className="truncate text-xs font-semibold text-slate-900">
                  {dragItems.length === 1
                    ? dragItems[0]!.name
                    : `${dragItems.length} 件を移動`}
                </span>
                <ClassificationBadge classification={strictestDragClass} compact />
              </div>

              {hoveredTarget && (
                <div className="mt-1.5 flex items-center gap-1.5 border-t border-slate-100 pt-1.5 text-[0.6875rem]">
                  {!hoveredTarget.evaluation.allowed ? (
                    <span className="inline-flex items-center gap-1 font-medium text-red-600">
                      <Ban className="h-3.5 w-3.5 shrink-0" />
                      <span>{hoveredTarget.evaluation.reason ?? '移動できません'}</span>
                    </span>
                  ) : hoveredTarget.evaluation.promotesToConfidential ? (
                    <span className="inline-flex items-center gap-1 font-medium text-amber-700">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                      <span>
                        「{hoveredTarget.label}」へ移動（機密区分が「極秘」へ自動昇格します）
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 font-medium text-blue-700">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <MoveRight className="h-3 w-3 shrink-0" />
                      <span>「{hoveredTarget.label}」へ移動</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </WorkspaceDragContext.Provider>
  );
}
