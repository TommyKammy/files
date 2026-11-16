'use client';

import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Loader2,
} from 'lucide-react';
import type { FolderSummary } from '@/types/files';

export function FolderTreeRow({
  folder,
  depth,
  isExpanded,
  isLoading,
  isActive,
  isContextMenuOpen,
  dropRing,
  onToggle,
  onNavigate,
  onContextMenu,
  onKeyDown,
}: {
  folder: FolderSummary;
  depth: number;
  isExpanded: boolean;
  isLoading: boolean;
  isActive: boolean;
  isContextMenuOpen: boolean;
  dropRing: string;
  onToggle: () => void;
  onNavigate: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      data-drop-folder-id={folder.id}
      data-drop-label={folder.name}
      onContextMenu={onContextMenu}
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      className={`group flex h-7 items-center gap-1 rounded-md pr-2 text-[0.75rem] transition ${
        dropRing
          ? `${dropRing} text-[#111214]`
          : isActive
            ? 'bg-[#e2e2e6] text-[#111214]'
            : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
      }`}
    >
      <button
        type="button"
        aria-label={
          isExpanded ? `${folder.name} を閉じる` : `${folder.name} を展開`
        }
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#676b72] hover:bg-[#e6e6e8] hover:text-[#111214]"
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
        data-folder-trigger="true"
        aria-haspopup="menu"
        aria-expanded={isContextMenuOpen}
        onClick={onNavigate}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        {isExpanded || isActive ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[#676b72]" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-[#676b72]" />
        )}
        <span className="truncate">{folder.name}</span>
      </button>

      {folder.classification === 'confidential' && (
        <span
          title="Confidential (極秘)"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#d9343f]"
        />
      )}
    </div>
  );
}
