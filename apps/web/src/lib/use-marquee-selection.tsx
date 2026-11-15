'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface IntersectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const MARQUEE_THRESHOLD_PX = 5;
const AUTO_SCROLL_EDGE_PX = 48;
const AUTO_SCROLL_STEP_PX = 18;

export function normalizeMarqueeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number
): MarqueeRect {
  return {
    left: Math.min(startX, endX),
    top: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function rectsIntersect(
  marquee: IntersectionRect,
  target: { left: number; top: number; right: number; bottom: number }
): boolean {
  return (
    marquee.left <= target.right &&
    marquee.right >= target.left &&
    marquee.top <= target.bottom &&
    marquee.bottom >= target.top
  );
}

/**
 * Maps every rendered row/card intersecting the marquee to its workspace row key.
 * Only rendered rows are considered; the caller re-runs this while auto-scrolling.
 */
export function computeMarqueeSelection(
  marquee: IntersectionRect,
  rowElements: Iterable<HTMLElement>,
  orderedRowKeys: readonly string[]
): Set<string> {
  const selected = new Set<string>();
  for (const element of rowElements) {
    const index = Number(element.dataset.rowIndex);
    if (!Number.isInteger(index) || index < 0 || index >= orderedRowKeys.length) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rectsIntersect(marquee, rect)) {
      selected.add(orderedRowKeys[index]!);
    }
  }
  return selected;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function isMarqueeIgnoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      '[data-row-index], thead, th, button, a, input, select, textarea, [role="menu"], [role="checkbox"], [data-marquee-ignore="true"]'
    )
  );
}

export interface UseMarqueeSelectionOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  /**
   * Optional larger surface (list + empty space below it) that starts the drag.
   * Defaults to the scroll container.
   */
  surfaceRef?: React.RefObject<HTMLElement | null>;
  orderedRowKeys: readonly string[];
  selectedKeys: ReadonlySet<string>;
  setSelectedKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSelectionAnchorKey: React.Dispatch<React.SetStateAction<string | null>>;
  enabled: boolean;
  onBackgroundClick?: () => void;
}

interface MarqueeSession {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  base: Set<string>;
  started: boolean;
  additive: boolean;
  frame: number | null;
  lastSignature: string;
}

/**
 * Google Drive-style rubber-band selection. Starts only on the list/grid
 * background so the existing pointer DnD (which starts on rows) keeps priority.
 */
export function useMarqueeSelection({
  containerRef,
  surfaceRef,
  orderedRowKeys,
  selectedKeys,
  setSelectedKeys,
  setSelectionAnchorKey,
  enabled,
  onBackgroundClick,
}: UseMarqueeSelectionOptions) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<MarqueeSession | null>(null);
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);

  const latestRef = useRef({
    orderedRowKeys,
    selectedKeys,
    setSelectedKeys,
    setSelectionAnchorKey,
    onBackgroundClick,
  });
  latestRef.current = {
    orderedRowKeys,
    selectedKeys,
    setSelectedKeys,
    setSelectionAnchorKey,
    onBackgroundClick,
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  const hideOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    if (overlay) overlay.style.display = 'none';
    document.body.style.userSelect = '';
  }, []);

  const applyMarquee = useCallback(
    (session: MarqueeSession, additive: boolean) => {
      const container = containerRef.current;
      if (!container) return;
      const surface = surfaceRef?.current ?? container;

      const bounds = surface.getBoundingClientRect();
      const startX = Math.min(Math.max(session.startX, bounds.left), bounds.right);
      const startY = Math.min(Math.max(session.startY, bounds.top), bounds.bottom);
      const endX = Math.min(Math.max(session.lastX, bounds.left), bounds.right);
      const endY = Math.min(Math.max(session.lastY, bounds.top), bounds.bottom);
      const rect = normalizeMarqueeRect(startX, startY, endX, endY);

      const overlay = overlayRef.current;
      if (overlay) {
        overlay.style.display = 'block';
        overlay.style.left = `${rect.left}px`;
        overlay.style.top = `${rect.top}px`;
        overlay.style.width = `${rect.width}px`;
        overlay.style.height = `${rect.height}px`;
      }

      const hit = computeMarqueeSelection(
        {
          left: rect.left,
          top: rect.top,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height,
        },
        container.querySelectorAll<HTMLElement>('[data-row-index]'),
        latestRef.current.orderedRowKeys
      );

      const next = additive ? new Set([...session.base, ...hit]) : hit;
      const signature = [...next].sort().join('|');
      if (signature === session.lastSignature) return;
      session.lastSignature = signature;

      latestRef.current.setSelectedKeys(next);
      if (next.size > 0) {
        const firstKey = latestRef.current.orderedRowKeys.find((key) =>
          next.has(key)
        );
        if (firstKey) latestRef.current.setSelectionAnchorKey(firstKey);
      }
    },
    [containerRef, surfaceRef]
  );

  const stopSession = useCallback(
    (restoreBase = false) => {
      const session = sessionRef.current;
      if (!session) return;
      if (session.frame !== null) {
        cancelAnimationFrame(session.frame);
        session.frame = null;
      }
      if (restoreBase) {
        latestRef.current.setSelectedKeys(new Set(session.base));
      }
      sessionRef.current = null;
      setActive(false);
      hideOverlay();
    },
    [hideOverlay]
  );

  useEffect(() => {
    function handlePointerMove(e: PointerEvent) {
      const session = sessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;

      session.lastX = e.clientX;
      session.lastY = e.clientY;

      if (!session.started) {
        const distance = Math.hypot(
          e.clientX - session.startX,
          e.clientY - session.startY
        );
        if (distance < MARQUEE_THRESHOLD_PX) return;
        session.started = true;
        setActive(true);
        document.body.style.userSelect = 'none';
      }

      e.preventDefault();
      session.additive = e.metaKey || e.ctrlKey;
      applyMarquee(session, session.additive);

      if (session.frame === null) {
        const tick = () => {
          const current = sessionRef.current;
          const container = containerRef.current;
          if (!current || !container) return;

          const scrollContainer =
            container.scrollHeight > container.clientHeight + 1
              ? container
              : null;
          const bounds = scrollContainer
            ? container.getBoundingClientRect()
            : { top: 0, bottom: window.innerHeight };
          let delta = 0;
          if (current.lastY < bounds.top + AUTO_SCROLL_EDGE_PX) {
            delta = -AUTO_SCROLL_STEP_PX;
          } else if (current.lastY > bounds.bottom - AUTO_SCROLL_EDGE_PX) {
            delta = AUTO_SCROLL_STEP_PX;
          }
          if (delta !== 0) {
            const before = scrollContainer
              ? scrollContainer.scrollTop
              : window.scrollY;
            if (scrollContainer) {
              scrollContainer.scrollTop += delta;
            } else {
              window.scrollBy(0, delta);
            }
            const after = scrollContainer
              ? scrollContainer.scrollTop
              : window.scrollY;
            if (after !== before) {
              applyMarquee(current, current.additive);
            }
          }
          current.frame = requestAnimationFrame(tick);
        };
        session.frame = requestAnimationFrame(tick);
      }
    }

    function handlePointerUp(e: PointerEvent) {
      const session = sessionRef.current;
      if (!session || e.pointerId !== session.pointerId) return;
      const wasActive = session.started;
      stopSession();
      if (!wasActive) {
        latestRef.current.onBackgroundClick?.();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !sessionRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      stopSession(true);
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('keydown', handleKeyDown, true);
      stopSession();
    };
  }, [applyMarquee, containerRef, stopSession]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!enabled || e.button !== 0) return;
      if (isMarqueeIgnoredTarget(e.target)) return;
      stopSession();
      sessionRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        base: new Set(latestRef.current.selectedKeys),
        started: false,
        additive: false,
        frame: null,
        lastSignature: '',
      };
    },
    [enabled, stopSession]
  );

  const overlay =
    mounted && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={overlayRef}
            aria-hidden="true"
            data-marquee-overlay="true"
            className="pointer-events-none fixed z-40 rounded-sm border border-indigo-400 bg-indigo-500/10"
            style={{ display: 'none', left: 0, top: 0, width: 0, height: 0 }}
          />,
          document.body
        )
      : null;

  return { onPointerDown, overlay, active };
}
