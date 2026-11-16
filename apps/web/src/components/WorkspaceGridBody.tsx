'use client';

import type { ReactNode } from 'react';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';

export function WorkspaceGridBody({
  visibleRows,
  startIndex,
  columns,
  topSpacerPx,
  bottomSpacerPx,
  renderCard,
}: {
  visibleRows: WorkspaceTableRow[][];
  startIndex: number;
  columns: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  renderCard: (row: WorkspaceTableRow, globalIdx: number) => ReactNode;
}) {
  return (
    <div className="p-4">
      {topSpacerPx > 0 && (
        <div aria-hidden="true" style={{ height: `${topSpacerPx}px` }} />
      )}
      {visibleRows.map((chunk, chunkIdx) => {
        const baseIdx = (startIndex + chunkIdx) * columns;
        return (
          <div
            key={`grid-row:${startIndex + chunkIdx}`}
            className="mb-3 grid grid-cols-1 gap-3 last:mb-0 sm:grid-cols-2 lg:grid-cols-4"
          >
            {chunk.map((row, colIdx) => renderCard(row, baseIdx + colIdx))}
          </div>
        );
      })}
      {bottomSpacerPx > 0 && (
        <div aria-hidden="true" style={{ height: `${bottomSpacerPx}px` }} />
      )}
    </div>
  );
}
