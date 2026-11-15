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
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  computeEdgeAutoScrollDelta,
  decodeDropFolderId,
  DRAG_THRESHOLD_PX,
  type DragWorkspaceItem,
  type DropTargetEvaluation,
  encodeDropFolderId,
  evaluateDropTarget,
  DROP_HOVER_PREFETCH_DELAY_MS,
} from '@/lib/drag-drop-controller';
import {
  hasRoleAtLeast,
  pickStricterClassification,
} from '@/lib/formatters';
import { keyboardScopes } from '@/lib/keyboard-shortcuts';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { ClassificationLabel, ResourceRole } from '@/types/files';

export interface ActiveHoveredDropTarget {
  rawId: string;
  folderId: string | null;
  label: string;
  evaluation: DropTargetEvaluation;
}

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

function shouldIgnoreDragStart(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (
    target.closest(
      'input, select, textarea, label, [role="checkbox"], [data-no-drag="true"]'
    )
  ) {
    return true;
  }
  const interactive = target.closest('button, a, [role="button"]');
  if (!interactive) return false;
  // Allow dragging by the row's primary folder/file name trigger; 6px threshold preserves normal clicks
  return !interactive.matches(
    '[data-workspace-row-trigger="true"]:not([role="checkbox"])'
  );
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
  const [dragItems, setDragItems] = useState<DragWorkspaceItem[]>([]);
  const [hoveredTarget, setHoveredTarget] =
    useState<ActiveHoveredDropTarget | null>(null);

  const isDragging = dragItems.length > 0;

  const ghostRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLElement | null>(null);
  const pointerPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastHoveredRawRef = useRef<string | null>(null);
  const cleanupCandidateRef = useRef<(() => void) | null>(null);
  const cleanupActiveRef = useRef<(() => void) | null>(null);
  const dragItemsRef = useRef<DragWorkspaceItem[]>([]);
  const currentFolderIdRef = useRef<string | null>(currentFolderId);
  const scopeTokenRef = useRef<string | null>(null);

  const onPrefetchRef = useRef(onPrefetchFolder);
  const onDropMoveRef = useRef(onDropMove);
  const isSysAdminRef = useRef(isSysAdmin);

  currentFolderIdRef.current = currentFolderId;
  onPrefetchRef.current = onPrefetchFolder;
  onDropMoveRef.current = onDropMove;
  isSysAdminRef.current = isSysAdmin;

  const evaluateTargetByRawId = useCallback(
    (
      rawId: string,
      label: string,
      items: DragWorkspaceItem[]
    ): ActiveHoveredDropTarget | null => {
      const targetFolderId = decodeDropFolderId(rawId);
      if (targetFolderId === undefined) return null;

      const snapshot = syncStore.getDirectoryView(targetFolderId);
      const cachedFolder = targetFolderId ? snapshot.folder : null;
      const targetClassification: ClassificationLabel =
        cachedFolder?.classification ?? 'unset';
      const ancestors =
        targetFolderId !== null
          ? syncStore.getAncestorClassifications(targetFolderId)
          : [];
      const targetEffectiveRole: ResourceRole =
        cachedFolder?.effectiveRole ?? snapshot.effectiveRole ?? 'editor';

      const evaluation = evaluateDropTarget({
        dragItems: items,
        targetFolderId,
        targetClassification,
        targetAncestorClassifications: ancestors,
        targetEffectiveRole,
        isSysAdmin: isSysAdminRef.current,
        isAncestorOf: (ancId, candId) => syncStore.isFolderAncestorOf(ancId, candId),
        resolveItemRole: (item) => {
          if (item.effectiveRole) return item.effectiveRole;
          return syncStore.getDirectoryView(item.parentId).effectiveRole;
        },
      });

      return {
        rawId,
        folderId: targetFolderId,
        label: label || (targetFolderId === null ? 'マイファイル' : 'フォルダ'),
        evaluation,
      };
    },
    [syncStore]
  );

  const cancelDrag = useCallback(() => {
    cleanupCandidateRef.current?.();
    cleanupCandidateRef.current = null;
    cleanupActiveRef.current?.();
    cleanupActiveRef.current = null;
    dragItemsRef.current = [];
    lastHoveredRawRef.current = null;
    setDragItems([]);
    setHoveredTarget(null);
    if (typeof document !== 'undefined') {
      delete document.body.dataset.workspaceDragging;
      document.body.style.userSelect = '';
    }
    if (scopeTokenRef.current) {
      keyboardScopes.popScope(scopeTokenRef.current);
      scopeTokenRef.current = null;
    }
  }, []);

  useEffect(() => () => cancelDrag(), [cancelDrag]);

  // Hover prefetch only: warm the folder view without navigating or opening it.
  useEffect(() => {
    if (
      !isDragging ||
      !hoveredTarget ||
      !hoveredTarget.evaluation.allowed ||
      hoveredTarget.folderId === null ||
      hoveredTarget.folderId === currentFolderId
    ) {
      return;
    }

    const folderId = hoveredTarget.folderId;
    const prefetchTimer = window.setTimeout(() => {
      onPrefetchRef.current(folderId);
    }, DROP_HOVER_PREFETCH_DELAY_MS);

    return () => window.clearTimeout(prefetchTimer);
  }, [isDragging, hoveredTarget, currentFolderId]);

  const activateDragSession = useCallback(
    (items: DragWorkspaceItem[], startX: number, startY: number) => {
      dragItemsRef.current = items;
      pointerPosRef.current = { x: startX, y: startY };
      lastHoveredRawRef.current = null;
      setDragItems(items);
      setHoveredTarget(null);

      if (typeof document !== 'undefined') {
        document.body.dataset.workspaceDragging = '1';
        document.body.style.userSelect = 'none';
      }
      scopeTokenRef.current = keyboardScopes.pushScope('modal');

      let rafId = 0;

      const updateHitTarget = (clientX: number, clientY: number) => {
        if (typeof document === 'undefined') return;
        const el = document.elementFromPoint(clientX, clientY);
        const dropEl = el?.closest('[data-drop-folder-id]') as HTMLElement | null;
        const rawId = dropEl?.dataset.dropFolderId ?? null;
        const label = dropEl?.dataset.dropLabel ?? '';

        if (!rawId) {
          if (lastHoveredRawRef.current !== null) {
            lastHoveredRawRef.current = null;
            setHoveredTarget(null);
          }
          return;
        }

        if (lastHoveredRawRef.current !== rawId) {
          lastHoveredRawRef.current = rawId;
          setHoveredTarget(evaluateTargetByRawId(rawId, label, dragItemsRef.current));
        }
      };

      const frameLoop = () => {
        const { x, y } = pointerPosRef.current;
        if (ghostRef.current) {
          ghostRef.current.style.transform = `translate3d(${Math.round(x + 16)}px, ${Math.round(y + 14)}px, 0)`;
        }

        const scrollEl = scrollContainerRef.current;
        if (scrollEl) {
          const rect = scrollEl.getBoundingClientRect();
          const delta = computeEdgeAutoScrollDelta(y, rect, x);
          if (delta !== 0) {
            scrollEl.scrollTop += delta;
          }
        }

        updateHitTarget(x, y);
        rafId = window.requestAnimationFrame(frameLoop);
      };

      rafId = window.requestAnimationFrame(frameLoop);

      const handleMove = (ev: PointerEvent) => {
        pointerPosRef.current = { x: ev.clientX, y: ev.clientY };
      };

      const handleUp = (ev: PointerEvent) => {
        pointerPosRef.current = { x: ev.clientX, y: ev.clientY };
        const el =
          typeof document !== 'undefined'
            ? document.elementFromPoint(ev.clientX, ev.clientY)
            : null;
        const dropEl = el?.closest('[data-drop-folder-id]') as HTMLElement | null;
        const rawId = dropEl?.dataset.dropFolderId ?? null;
        const label = dropEl?.dataset.dropLabel ?? '';
        const itemsToMove = [...dragItemsRef.current];

        cancelDrag();

        if (typeof window !== 'undefined') {
          const swallowPostDragClick = (clickEv: MouseEvent) => {
            clickEv.preventDefault();
            clickEv.stopPropagation();
          };
          window.addEventListener('click', swallowPostDragClick, {
            capture: true,
            once: true,
          });
          window.setTimeout(() => {
            window.removeEventListener('click', swallowPostDragClick, {
              capture: true,
            });
          }, 80);
        }

        if (rawId && itemsToMove.length > 0) {
          const finalTarget = evaluateTargetByRawId(rawId, label, itemsToMove);
          if (finalTarget && finalTarget.evaluation.allowed) {
            onDropMoveRef.current(itemsToMove, finalTarget.folderId, finalTarget.label);
          }
        }
      };

      const handleKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          cancelDrag();
        }
      };

      window.addEventListener('pointermove', handleMove, { passive: true });
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', cancelDrag);
      window.addEventListener('keydown', handleKeyDown, { capture: true });

      cleanupActiveRef.current = () => {
        if (rafId) window.cancelAnimationFrame(rafId);
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', cancelDrag);
        window.removeEventListener('keydown', handleKeyDown, { capture: true });
      };
    },
    [cancelDrag, evaluateTargetByRawId]
  );

  const startPointerDragCandidate = useCallback(
    (event: React.PointerEvent, items: DragWorkspaceItem[]) => {
      if (event.button !== 0 || items.length === 0) return;
      if (shouldIgnoreDragStart(event.target)) return;

      // Require at least editor role on at least one item, otherwise don't steal click selection
      const hasEditable = items.some(
        (it) =>
          isSysAdminRef.current ||
          hasRoleAtLeast(
            it.effectiveRole ?? syncStore.getDirectoryView(it.parentId).effectiveRole,
            'editor'
          )
      );
      if (!hasEditable) return;

      cleanupCandidateRef.current?.();
      const startX = event.clientX;
      const startY = event.clientY;
      const pointerId = event.pointerId;

      const detachCandidate = () => {
        window.removeEventListener('pointermove', onCandidateMove);
        window.removeEventListener('pointerup', onCandidateEnd);
        window.removeEventListener('pointercancel', onCandidateEnd);
        cleanupCandidateRef.current = null;
      };

      const onCandidateMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (dist >= DRAG_THRESHOLD_PX) {
          detachCandidate();
          activateDragSession(items, ev.clientX, ev.clientY);
        }
      };

      const onCandidateEnd = () => {
        detachCandidate();
      };

      window.addEventListener('pointermove', onCandidateMove, { passive: true });
      window.addEventListener('pointerup', onCandidateEnd);
      window.addEventListener('pointercancel', onCandidateEnd);
      cleanupCandidateRef.current = detachCandidate;
    },
    [activateDragSession, syncStore]
  );

  const registerScrollContainer = useCallback((el: HTMLElement | null) => {
    scrollContainerRef.current = el;
  }, []);

  const strictestDragClass = useMemo<ClassificationLabel>(() => {
    let label: ClassificationLabel = 'unset';
    for (const item of dragItems) {
      label = pickStricterClassification(label, item.classification);
    }
    return label;
  }, [dragItems]);

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
