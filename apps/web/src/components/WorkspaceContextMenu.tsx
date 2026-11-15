'use client';

import {
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  Edit3,
  Eye,
  FolderInput,
  Info,
  Link2,
  Pin,
  Scissors,
  Tag,
  Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isImeComposingEvent, keyboardScopes } from '@/lib/keyboard-shortcuts';
import {
  clampPopoverPosition,
  type ContextMenuCapabilities,
  type ContextRowTarget,
} from '@/lib/workspace-actions';

export type ContextMenuActionId =
  | 'open'
  | 'download'
  | 'rename'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'moveCopy'
  | 'classify'
  | 'share'
  | 'pin'
  | 'inspector'
  | 'trash';

interface MenuEntry {
  id: ContextMenuActionId;
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  enabled: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
}

export function WorkspaceContextMenu({
  anchor,
  targets,
  primaryRow,
  capabilities,
  clipboardCount,
  onAction,
  onClose,
}: {
  anchor: { x: number; y: number };
  targets: ContextRowTarget[];
  primaryRow: ContextRowTarget | null;
  capabilities: ContextMenuCapabilities;
  clipboardCount: number;
  onAction: (action: ContextMenuActionId) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const scopeTokenRef = useRef<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    if (typeof window === 'undefined') return { left: anchor.x, top: anchor.y };
    return clampPopoverPosition(
      anchor.x,
      anchor.y,
      252,
      410,
      window.innerWidth,
      window.innerHeight
    );
  });

  const isPinnedFolder =
    primaryRow?.kind === 'folder' && primaryRow.folder.is_pinned === 1;

  const entries = useMemo<MenuEntry[]>(() => {
    const pasteTargetName =
      !capabilities.isMulti && primaryRow?.kind === 'folder'
        ? `「${primaryRow.folder.name}」へ貼り付け`
        : 'ここへ貼り付け';

    const list: MenuEntry[] = [];

    if (!capabilities.isMulti && primaryRow) {
      list.push({
        id: 'open',
        label: primaryRow.kind === 'folder' ? 'フォルダを開く' : 'プレビューを開く',
        shortcut: 'Enter',
        icon: <Eye className="h-3.5 w-3.5" />,
        enabled: capabilities.canOpen,
      });
      if (primaryRow.kind === 'file') {
        list.push({
          id: 'download',
          label: 'ダウンロード',
          shortcut: 'd',
          icon: <Download className="h-3.5 w-3.5" />,
          enabled: capabilities.canDownload,
        });
      }
      list.push({
        id: 'rename',
        label: '名前の変更',
        shortcut: 'F2',
        icon: <Edit3 className="h-3.5 w-3.5" />,
        enabled: capabilities.canRename,
      });
    }

    list.push(
      {
        id: 'copy',
        label: capabilities.isMulti ? `${targets.length} 件をコピー` : 'コピー',
        shortcut: '⌘C',
        icon: <Copy className="h-3.5 w-3.5" />,
        enabled: capabilities.canCopy,
        dividerBefore: list.length > 0,
      },
      {
        id: 'cut',
        label: capabilities.isMulti ? `${targets.length} 件を切り取り` : '切り取り',
        shortcut: '⌘X',
        icon: <Scissors className="h-3.5 w-3.5" />,
        enabled: capabilities.canCut,
      }
    );

    if (clipboardCount > 0) {
      list.push({
        id: 'paste',
        label: `${pasteTargetName} (${clipboardCount} 件)`,
        shortcut: '⌘V',
        icon: <ClipboardPaste className="h-3.5 w-3.5" />,
        enabled: capabilities.canPaste,
      });
    }

    list.push(
      {
        id: 'duplicate',
        label: capabilities.isMulti ? `${targets.length} 件を複製` : '複製',
        shortcut: '⌘D',
        icon: <Clipboard className="h-3.5 w-3.5" />,
        enabled: capabilities.canDuplicate,
      },
      {
        id: 'moveCopy',
        label: '移動 / コピー先を選択...',
        shortcut: 'm',
        icon: <FolderInput className="h-3.5 w-3.5" />,
        enabled: capabilities.canMoveCopy,
      }
    );

    list.push({
      id: 'classify',
      label: capabilities.isMulti ? '機密区分を一括変更' : '機密区分を変更',
      shortcut: 'c',
      icon: <Tag className="h-3.5 w-3.5" />,
      enabled: capabilities.canClassify,
      dividerBefore: true,
    });

    if (!capabilities.isMulti && primaryRow) {
      list.push({
        id: 'share',
        label: '共有リンク設定',
        shortcut: 's',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: capabilities.canShare,
      });
      if (primaryRow.kind === 'folder') {
        list.push({
          id: 'pin',
          label: isPinnedFolder ? 'ピン留めを解除' : 'クイックアクセスにピン留め',
          icon: <Pin className="h-3.5 w-3.5" />,
          enabled: capabilities.canPin,
        });
      }
      list.push({
        id: 'inspector',
        label: '詳細インスペクタ',
        shortcut: 'i',
        icon: <Info className="h-3.5 w-3.5" />,
        enabled: capabilities.canInspector,
      });
    }

    list.push({
      id: 'trash',
      label: capabilities.isMulti ? `${targets.length} 件をゴミ箱へ移動` : 'ゴミ箱へ移動',
      shortcut: 'Del',
      icon: <Trash2 className="h-3.5 w-3.5" />,
      enabled: capabilities.canTrash,
      danger: true,
      dividerBefore: true,
    });

    return list;
  }, [capabilities, primaryRow, targets.length, clipboardCount, isPinnedFolder]);

  const enabledIndices = useMemo(
    () => entries.map((e, i) => (e.enabled ? i : -1)).filter((i) => i >= 0),
    [entries]
  );
  const [activeIndex, setActiveIndex] = useState<number>(() => enabledIndices[0] ?? 0);

  useEffect(() => {
    setActiveIndex(enabledIndices[0] ?? 0);
  }, [enabledIndices]);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    setPos(
      clampPopoverPosition(
        anchor.x,
        anchor.y,
        rect.width || 252,
        rect.height || 380,
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
      if (scopeTokenRef.current === token) {
        scopeTokenRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    function handleOutsidePointer(e: MouseEvent) {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
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
        const currPos = enabledIndices.indexOf(activeIndex);
        const nextPos = currPos < 0 ? 0 : (currPos + 1) % enabledIndices.length;
        setActiveIndex(enabledIndices[nextPos]!);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const currPos = enabledIndices.indexOf(activeIndex);
        const prevPos =
          currPos <= 0 ? enabledIndices.length - 1 : currPos - 1;
        setActiveIndex(enabledIndices[prevPos]!);
        return;
      }

      if (e.key === 'Home') {
        e.preventDefault();
        setActiveIndex(enabledIndices[0]!);
        return;
      }

      if (e.key === 'End') {
        e.preventDefault();
        setActiveIndex(enabledIndices[enabledIndices.length - 1]!);
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const selected = entries[activeIndex];
        if (selected?.enabled) {
          onAction(selected.id);
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
      aria-label="コンテキストメニュー"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      className="fixed z-50 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white/98 py-1.5 shadow-2xl backdrop-blur-xs"
    >
      <div className="border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-500 truncate">
        {capabilities.isMulti
          ? `${targets.length} 件を選択中`
          : primaryRow?.kind === 'folder'
            ? primaryRow.folder.name
            : primaryRow?.file.name ?? 'ワークスペース'}
      </div>

      <div className="py-1">
        {entries.map((entry, idx) => {
          const isActive = idx === activeIndex && entry.enabled;
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
                  if (entry.enabled) setActiveIndex(idx);
                }}
                onClick={() => {
                  if (!entry.enabled) return;
                  onAction(entry.id);
                  onClose();
                }}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs transition ${
                  !entry.enabled
                    ? 'cursor-not-allowed text-slate-300'
                    : entry.danger
                      ? isActive
                        ? 'bg-red-50 text-red-700'
                        : 'text-red-600 hover:bg-red-50'
                      : isActive
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0">{entry.icon}</span>
                  <span className="truncate">{entry.label}</span>
                </span>
                {entry.shortcut && (
                  <kbd className="ml-2 shrink-0 font-mono text-[10px] text-slate-400">
                    {entry.shortcut}
                  </kbd>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
