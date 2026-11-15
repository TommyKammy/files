'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const VIRTUALIZE_ROW_THRESHOLD = 40;
export const DEFAULT_ROW_HEIGHT_PX = 52;
export const DEFAULT_OVERSCAN_ROWS = 10;

export interface VirtualWindowParams {
  totalCount: number;
  rowHeight?: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
  threshold?: number;
}

export interface VirtualWindowResult {
  virtualized: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  totalHeightPx: number;
}

/**
 * Pure window calculation for smooth 60fps virtualized table rendering on folders
 * containing thousands of items without bloating DOM nodes.
 */
export function computeVirtualWindow(params: VirtualWindowParams): VirtualWindowResult {
  const totalCount = Math.max(0, params.totalCount);
  const rowHeight = Math.max(24, params.rowHeight ?? DEFAULT_ROW_HEIGHT_PX);
  const overscan = Math.max(1, params.overscan ?? DEFAULT_OVERSCAN_ROWS);
  const threshold = params.threshold ?? VIRTUALIZE_ROW_THRESHOLD;
  const totalHeightPx = totalCount * rowHeight;

  if (totalCount <= threshold) {
    return {
      virtualized: false,
      startIndex: 0,
      endIndex: totalCount,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      totalHeightPx,
    };
  }

  const safeViewport = Math.max(rowHeight, params.viewportHeight || 600);
  const maxScrollTop = Math.max(0, totalHeightPx - safeViewport);
  const safeScrollTop = Math.min(Math.max(0, params.scrollTop), maxScrollTop);

  const visibleStart = Math.floor(safeScrollTop / rowHeight);
  const visibleCount = Math.ceil(safeViewport / rowHeight);

  const startIndex = Math.max(0, visibleStart - overscan);
  const endIndex = Math.min(totalCount, visibleStart + visibleCount + overscan);

  const topSpacerPx = startIndex * rowHeight;
  const bottomSpacerPx = Math.max(0, (totalCount - endIndex) * rowHeight);

  return {
    virtualized: true,
    startIndex,
    endIndex,
    topSpacerPx,
    bottomSpacerPx,
    totalHeightPx,
  };
}

export function useTableVirtualWindow(
  totalCount: number,
  options?: { rowHeight?: number; overscan?: number; threshold?: number }
) {
  const rowHeight = options?.rowHeight ?? DEFAULT_ROW_HEIGHT_PX;
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      if (el.clientHeight > 0) {
        setViewportHeight(el.clientHeight);
      }
    };
    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, [totalCount]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
  }, []);

  const windowState = computeVirtualWindow({
    totalCount,
    rowHeight,
    scrollTop,
    viewportHeight,
    overscan: options?.overscan,
    threshold: options?.threshold,
  });

  const scrollRowIntoView = useCallback(
    (index: number) => {
      const el = containerRef.current;
      if (!el) return;
      if (windowState.virtualized) {
        const rowTop = index * rowHeight;
        const rowBottom = rowTop + rowHeight;
        if (rowTop < el.scrollTop) {
          el.scrollTop = rowTop;
        } else if (rowBottom > el.scrollTop + el.clientHeight) {
          el.scrollTop = Math.max(0, rowBottom - el.clientHeight);
        }
        return;
      }
      const targetRow = el.querySelector<HTMLElement>(
        `[data-row-index="${index}"]`
      );
      targetRow?.scrollIntoView({ block: 'nearest' });
    },
    [rowHeight, windowState.virtualized]
  );

  return {
    containerRef,
    onScroll,
    scrollRowIntoView,
    ...windowState,
  };
}
