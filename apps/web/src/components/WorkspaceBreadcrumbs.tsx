'use client';

import { ChevronRight } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  getDropTargetClassName,
  useWorkspaceDrag,
} from '@/components/WorkspaceDragPortal';
import { ROOT_DROP_ID } from '@/lib/drag-drop-controller';
import type { BreadcrumbItem } from '@/types/files';

export function WorkspaceBreadcrumbs({
  folderId,
  breadcrumbs,
}: {
  folderId: string | null;
  breadcrumbs: BreadcrumbItem[];
}) {
  const router = useRouter();
  const dragCtx = useWorkspaceDrag();

  return (
    <nav
      aria-label="パンくずリスト"
      className="flex flex-wrap items-center gap-1 text-[0.75rem]"
    >
      <button
        type="button"
        data-drop-folder-id={ROOT_DROP_ID}
        data-drop-label="マイファイル"
        onClick={() => router.push('/workspace')}
        className={`min-h-6 rounded px-1.5 py-0.5 font-medium transition hover:bg-[#ececee] ${
          !folderId ? 'text-slate-900' : 'text-slate-500'
        } ${
          dragCtx?.isDragging
            ? getDropTargetClassName(null, dragCtx.hoveredTarget ?? null)
            : ''
        }`}
      >
        マイファイル
      </button>
      {breadcrumbs.map((crumb, idx) => (
        <span key={crumb.id} className="flex items-center gap-1">
          <ChevronRight className="h-4 w-4 text-[#6b6f76]" />
          <button
            type="button"
            data-drop-folder-id={crumb.id}
            data-drop-label={crumb.name}
            onClick={() =>
              router.push(
                `/workspace?folderId=${encodeURIComponent(crumb.id)}`
              )
            }
            className={`min-h-6 rounded px-1.5 py-0.5 font-medium transition hover:bg-[#ececee] ${
              idx === breadcrumbs.length - 1
                ? 'text-[#111214]'
                : 'text-[#6b6f76]'
            } ${
              dragCtx?.isDragging
                ? getDropTargetClassName(crumb.id, dragCtx.hoveredTarget ?? null)
                : ''
            }`}
          >
            {crumb.name}
            {crumb.accessMode === 'path' && (
              <span className="ml-1 rounded-full border border-sky-200 bg-sky-50 px-1 py-0.5 text-[0.5625rem] font-medium text-sky-700">
                パス
              </span>
            )}
          </button>
        </span>
      ))}
    </nav>
  );
}
