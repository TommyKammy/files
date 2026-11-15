'use client';

import {
  Check,
  ClipboardPaste,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  List,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isImeComposingEvent, keyboardScopes } from '@/lib/keyboard-shortcuts';
import { clampPopoverPosition } from '@/lib/workspace-actions';

type BackgroundMenuActionId =
  | 'newFolder'
  | 'uploadFiles'
  | 'uploadFolder'
  | 'paste'
  | 'selectAll'
  | 'refresh'
  | 'toggleView';

interface BackgroundMenuEntry {
  id: BackgroundMenuActionId;
  label: string;
  icon: React.ReactNode;
  enabled: boolean;
  dividerBefore?: boolean;
}

export function WorkspaceBackgroundMenu({
  anchor,
  canCreate,
  canUpload,
  canUploadFolder,
  canPaste,
  clipboardCount,
  viewMode,
  onAction,
  onClose,
}: {
  anchor: { x: number; y: number };
  canCreate: boolean;
  canUpload: boolean;
  canUploadFolder: boolean;
  canPaste: boolean;
  clipboardCount: number;
  viewMode: 'list' | 'grid';
  onAction: (action: BackgroundMenuActionId) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const scopeTokenRef = useRef<string | null>(null);
  const [pos, setPos] = useState(() => {
    if (typeof window === 'undefined') return { left: anchor.x, top: anchor.y };
    return clampPopoverPosition(
      anchor.x,
      anchor.y,
      248,
      320,
      window.innerWidth,
      window.innerHeight
    );
  });

  const entries = useMemo<BackgroundMenuEntry[]>(() => {
    const list: BackgroundMenuEntry[] = [
      {
        id: 'newFolder',
        label: '新しいフォルダ',
        icon: <FolderPlus className="h-3.5 w-3.5" />,
        enabled: canCreate,
      },
      {
        id: 'uploadFiles',
        label: 'ファイルのアップロード',
        icon: <Upload className="h-3.5 w-3.5" />,
        enabled: canUpload,
      },
      {
        id: 'uploadFolder',
        label: 'フォルダのアップロード',
        icon: <FolderUp className="h-3.5 w-3.5" />,
        enabled: canUploadFolder,
      },
      {
        id: 'paste',
        label:
          clipboardCount > 0
            ? `ここへ貼り付け (${clipboardCount} 件)`
            : 'ここへ貼り付け',
        icon: <ClipboardPaste className="h-3.5 w-3.5" />,
        enabled: canPaste,
        dividerBefore: true,
      },
      {
        id: 'selectAll',
        label: 'すべて選択',
        icon: <Check className="h-3.5 w-3.5" />,
        enabled: true,
        dividerBefore: true,
      },
      {
        id: 'refresh',
        label: '表示を更新',
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        enabled: true,
      },
      {
        id: 'toggleView',
        label: viewMode === 'grid' ? 'リスト表示に切り替え' : 'グリッド表示に切り替え',
        icon:
          viewMode === 'grid' ? (
            <List className="h-3.5 w-3.5" />
          ) : (
            <LayoutGrid className="h-3.5 w-3.5" />
          ),
        enabled: true,
      },
    ];
    return list;
  }, [canCreate, canUpload, canUploadFolder, canPaste, clipboardCount, viewMode]);

  const enabledIndices = useMemo(
    () => entries.map((entry, index) => (entry.enabled ? index : -1)).filter((index) => index >= 0),
    [entries]
  );
  const [activeIndex, setActiveIndex] = useState<number>(
    () => enabledIndices[0] ?? 0
  );

  useEffect(() => {
    setActiveIndex(enabledIndices[0] ?? 0);
  }, [enabledIndices]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || typeof window === 'undefined') return;
    const rect = element.getBoundingClientRect();
    setPos(
      clampPopoverPosition(
        anchor.x,
        anchor.y,
        rect.width || 248,
        rect.height || 320,
        window.innerWidth,
        window.innerHeight
      )
    );
  }, [anchor.x, anchor.y, entries.length]);

  useEffect(() => {
    const token = keyboardScopes.pushScope('contextMenu');
    scopeTokenRef.current = token;
    return () => {
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) scopeTokenRef.current = null;
    };
  }, []);

  useEffect(() => {
    function handleOutsidePointer(e: MouseEvent) {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        menuRef.current.contains(e.target)
      ) {
        return;
      }
      onClose();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;
      if (scopeTokenRef.current && !keyboardScopes.isTopToken(scopeTokenRef.current)) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (enabledIndices.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const current = enabledIndices.indexOf(activeIndex);
        const next = current < 0 ? 0 : (current + 1) % enabledIndices.length;
        setActiveIndex(enabledIndices[next]!);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const current = enabledIndices.indexOf(activeIndex);
        const prev = current <= 0 ? enabledIndices.length - 1 : current - 1;
        setActiveIndex(enabledIndices[prev]!);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const entry = entries[activeIndex];
        if (entry?.enabled) {
          onAction(entry.id);
          onClose();
        }
      }
    }

    window.addEventListener('mousedown', handleOutsidePointer, { capture: true });
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('mousedown', handleOutsidePointer, { capture: true });
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [activeIndex, enabledIndices, entries, onAction, onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="フォルダメニュー"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      className="fixed z-50 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white/98 py-1.5 shadow-2xl backdrop-blur-xs"
    >
      <div className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-500">
        このフォルダ
      </div>
      <div className="py-1">
        {entries.map((entry, index) => {
          const isActive = index === activeIndex && entry.enabled;
          return (
            <div key={entry.id}>
              {entry.dividerBefore && (
                <div className="my-1 border-t border-slate-100" />
              )}
              <button
                type="button"
                role="menuitem"
                aria-disabled={!entry.enabled}
                disabled={!entry.enabled}
                onMouseEnter={() => {
                  if (entry.enabled) setActiveIndex(index);
                }}
                onClick={() => {
                  if (!entry.enabled) return;
                  onAction(entry.id);
                  onClose();
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition ${
                  !entry.enabled
                    ? 'cursor-not-allowed text-slate-300'
                    : isActive
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="shrink-0">{entry.icon}</span>
                <span className="truncate">{entry.label}</span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
