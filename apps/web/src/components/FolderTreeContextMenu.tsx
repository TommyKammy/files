'use client';

import {
  ChevronRight,
  ExternalLink,
  FolderInput,
  FolderOpen,
  Info,
  Link2,
  Pin,
  Shield,
  Trash2,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isImeComposingEvent, keyboardScopes } from '@/lib/keyboard-shortcuts';
import { clampPopoverPosition } from '@/lib/workspace-actions';
import type { FolderSummary } from '@/types/files';

export type FolderTreeMenuAction =
  | 'open'
  | 'openInNewTab'
  | 'share'
  | 'copyLink'
  | 'permissions'
  | 'move'
  | 'pin'
  | 'info'
  | 'trash';

interface FolderMenuEntry {
  id: FolderTreeMenuAction;
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  enabled: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
  children?: FolderMenuEntry[];
}

function isSelectable(entry: FolderMenuEntry): boolean {
  if (entry.children && entry.children.length > 0) {
    return entry.children.some((child) => child.enabled);
  }
  return entry.enabled;
}

export function FolderTreeContextMenu({
  anchor,
  folder,
  canShare,
  canManagePermissions,
  canMove,
  canPin,
  canTrash,
  returnFocus = null,
  onAction,
  onClose,
}: {
  anchor: { x: number; y: number };
  folder: FolderSummary;
  canShare: boolean;
  canManagePermissions: boolean;
  canMove: boolean;
  canPin: boolean;
  canTrash: boolean;
  returnFocus?: HTMLElement | null;
  onAction: (action: FolderTreeMenuAction) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const parentItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const submenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const didInitialFocusRef = useRef(false);
  const scopeTokenRef = useRef<string | null>(null);
  const [pos, setPos] = useState(() => {
    if (typeof window === 'undefined') return { left: anchor.x, top: anchor.y };
    return clampPopoverPosition(
      anchor.x,
      anchor.y,
      248,
      300,
      window.innerWidth,
      window.innerHeight
    );
  });

  const entries = useMemo<FolderMenuEntry[]>(() => {
    const openChildren: FolderMenuEntry[] = [
      {
        id: 'open',
        label: 'フォルダを開く',
        shortcut: 'Enter',
        icon: <FolderOpen className="h-3.5 w-3.5" />,
        enabled: true,
      },
      {
        id: 'openInNewTab',
        label: '新しいタブで開く',
        icon: <ExternalLink className="h-3.5 w-3.5" />,
        enabled: true,
      },
    ];

    const shareChildren: FolderMenuEntry[] = [
      {
        id: 'share',
        label: '共有リンク設定',
        shortcut: 's',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: canShare,
      },
      {
        id: 'copyLink',
        label: 'リンクをコピー',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: true,
      },
      {
        id: 'permissions',
        label: '権限管理',
        icon: <Shield className="h-3.5 w-3.5" />,
        enabled: canManagePermissions,
      },
    ];

    const organizeChildren: FolderMenuEntry[] = [
      {
        id: 'move',
        label: '移動 / コピー先を選択...',
        shortcut: 'm',
        icon: <FolderInput className="h-3.5 w-3.5" />,
        enabled: canMove,
      },
      {
        id: 'pin',
        label:
          folder.is_pinned === 1
            ? 'クイックアクセスから外す'
            : 'クイックアクセスに追加',
        icon: <Pin className="h-3.5 w-3.5" />,
        enabled: canPin,
      },
    ];

    return [
      {
        id: 'open',
        label: '開く',
        icon: <FolderOpen className="h-3.5 w-3.5" />,
        enabled: true,
        children: openChildren,
      },
      {
        id: 'share',
        label: '共有',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: shareChildren.some((child) => child.enabled),
        children: shareChildren,
      },
      {
        id: 'move',
        label: '整理',
        icon: <FolderInput className="h-3.5 w-3.5" />,
        enabled: organizeChildren.some((child) => child.enabled),
        children: organizeChildren,
      },
      {
        id: 'info',
        label: 'フォルダ情報',
        shortcut: 'i',
        icon: <Info className="h-3.5 w-3.5" />,
        enabled: true,
        dividerBefore: true,
      },
      {
        id: 'trash',
        label: 'ゴミ箱へ移動',
        shortcut: 'Del',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        enabled: canTrash,
        danger: true,
        dividerBefore: true,
      },
    ];
  }, [
    canShare,
    canManagePermissions,
    canMove,
    canPin,
    canTrash,
    folder.is_pinned,
  ]);

  const enabledIndices = useMemo(
    () =>
      entries
        .map((entry, index) => (isSelectable(entry) ? index : -1))
        .filter((index) => index >= 0),
    [entries]
  );
  const [activeIndex, setActiveIndex] = useState(() => enabledIndices[0] ?? 0);
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);
  const [submenuActiveIndex, setSubmenuActiveIndex] = useState(0);

  const submenuEntries =
    openSubmenuIndex !== null ? entries[openSubmenuIndex]?.children ?? [] : [];
  const submenuEnabledIndices = useMemo(
    () =>
      submenuEntries
        .map((entry, index) => (entry.enabled ? index : -1))
        .filter((index) => index >= 0),
    [submenuEntries]
  );

  useEffect(() => {
    setActiveIndex(enabledIndices[0] ?? 0);
    setOpenSubmenuIndex(null);
  }, [enabledIndices]);

  const closeAndRestore = () => {
    const target = returnFocus ?? previouslyFocusedRef.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
    onClose();
  };

  // Focus the active item itself, not just the menu container. This is what
  // makes arrow-key navigation announce the current item to screen readers.
  useEffect(() => {
    if (openSubmenuIndex !== null) return;
    parentItemRefs.current[activeIndex]?.focus({ preventScroll: true });
  }, [activeIndex, openSubmenuIndex]);

  useEffect(() => {
    if (openSubmenuIndex === null) return;
    submenuItemRefs.current[submenuActiveIndex]?.focus({ preventScroll: true });
  }, [openSubmenuIndex, submenuActiveIndex]);

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || typeof window === 'undefined') return;
    const rect = element.getBoundingClientRect();
    setPos(
      clampPopoverPosition(
        anchor.x,
        anchor.y,
        rect.width || 248,
        rect.height || 300,
        window.innerWidth,
        window.innerHeight
      )
    );
  }, [anchor.x, anchor.y, entries.length]);

  useEffect(() => {
    previouslyFocusedRef.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    const token = keyboardScopes.pushScope('contextMenu');
    scopeTokenRef.current = token;
    function handleOutsidePointer(e: MouseEvent) {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      onClose();
    }
    function handleFocusIn(e: FocusEvent) {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return;
      }
      onClose();
    }
    window.addEventListener('mousedown', handleOutsidePointer, { capture: true });
    window.addEventListener('focusin', handleFocusIn, { capture: true });
    return () => {
      window.removeEventListener('mousedown', handleOutsidePointer, { capture: true });
      window.removeEventListener('focusin', handleFocusIn, { capture: true });
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) scopeTokenRef.current = null;
    };
  }, [onClose, returnFocus]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposingEvent(e.nativeEvent)) return;
    if (scopeTokenRef.current && !keyboardScopes.isTopToken(scopeTokenRef.current)) {
      return;
    }

    if (e.key === 'Tab') {
      // Leave the menu system; the default Tab move happens from the restored trigger.
      closeAndRestore();
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (openSubmenuIndex !== null) {
        setOpenSubmenuIndex(null);
        return;
      }
      closeAndRestore();
      return;
    }

    if (openSubmenuIndex !== null) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setOpenSubmenuIndex(null);
        return;
      }
      if (submenuEnabledIndices.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const current = submenuEnabledIndices.indexOf(submenuActiveIndex);
        const next = current < 0 ? 0 : (current + 1) % submenuEnabledIndices.length;
        setSubmenuActiveIndex(submenuEnabledIndices[next]!);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const current = submenuEnabledIndices.indexOf(submenuActiveIndex);
        const prev = current <= 0 ? submenuEnabledIndices.length - 1 : current - 1;
        setSubmenuActiveIndex(submenuEnabledIndices[prev]!);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const selected = submenuEntries[submenuActiveIndex];
        if (selected?.enabled) {
          onAction(selected.id);
          closeAndRestore();
        }
      }
      return;
    }

    if (enabledIndices.length === 0) return;
    if (e.key === 'ArrowRight') {
      const entry = entries[activeIndex];
      if (entry?.children?.length) {
        e.preventDefault();
        const first = entry.children.findIndex((child) => child.enabled);
        if (first >= 0) {
          setOpenSubmenuIndex(activeIndex);
          setSubmenuActiveIndex(first);
        }
      }
      return;
    }
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
      if (!selected) return;
      if (selected.children?.length) {
        const first = selected.children.findIndex((child) => child.enabled);
        if (first >= 0) {
          setOpenSubmenuIndex(activeIndex);
          setSubmenuActiveIndex(first);
        }
        return;
      }
      if (selected.enabled) {
        onAction(selected.id);
        closeAndRestore();
      }
    }
  };

  const submenuOnLeft =
    typeof window !== 'undefined' && pos.left + 248 + 220 > window.innerWidth;
  const submenuOpensUp =
    openSubmenuIndex !== null && openSubmenuIndex >= Math.max(0, entries.length - 2);

  const openSubmenu = (index: number) => {
    const entry = entries[index];
    if (!entry?.children?.length) return;
    const first = entry.children.findIndex((child) => child.enabled);
    if (first < 0) return;
    setOpenSubmenuIndex(index);
    setSubmenuActiveIndex(first);
  };

  const activateEntry = (entry: FolderMenuEntry, index: number) => {
    if (entry.children?.length) {
      openSubmenu(index);
      return;
    }
    if (!entry.enabled) return;
    onAction(entry.id);
    closeAndRestore();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="フォルダメニュー"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      className="fixed z-50 w-60 rounded-lg border border-[#e4e4e7] bg-white py-1 shadow-2xl focus:outline-none"
    >
      <div className="truncate border-b border-[#f0f0f1] px-2.5 py-1.5 text-[0.6875rem] font-medium text-[#6b6f76]">
        {folder.name}
      </div>
      <div className="py-1">
        {entries.map((entry, index) => {
          const hasChildren = Boolean(entry.children?.length);
          const isActive = index === activeIndex && isSelectable(entry);
          return (
            <div key={`${entry.id}:${index}`} className="relative">
              {entry.dividerBefore && (
                <hr className="my-1 border-[#f0f0f1]" />
              )}
              <button
                ref={(element) => {
                  parentItemRefs.current[index] = element;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={!isSelectable(entry)}
                aria-haspopup={hasChildren ? 'menu' : undefined}
                aria-expanded={hasChildren ? openSubmenuIndex === index : undefined}
                onMouseEnter={() => {
                  if (!isSelectable(entry)) return;
                  setActiveIndex(index);
                  if (hasChildren) openSubmenu(index);
                  else setOpenSubmenuIndex(null);
                }}
                onClick={() => activateEntry(entry, index)}
                className={`flex w-full items-center justify-between px-2.5 py-1 text-left text-[0.75rem] transition ${
                  !isSelectable(entry)
                    ? 'cursor-not-allowed text-[#b4b4bb]'
                    : entry.danger
                      ? isActive
                        ? 'bg-[#fdf0f1] text-[#b3242e]'
                        : 'text-[#d9343f] hover:bg-[#fdf0f1]'
                      : isActive
                        ? 'bg-[#eef0fb] text-[#4f5ac2]'
                        : 'text-[#3c3f46] hover:bg-[#f4f4f5]'
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0">{entry.icon}</span>
                  <span className="truncate">{entry.label}</span>
                </span>
                <span className="ml-2 flex shrink-0 items-center gap-1">
                  {entry.shortcut && !hasChildren && (
                    <kbd
                      aria-hidden="true"
                      className="font-mono text-[0.625rem] text-[#6b6f76]"
                    >
                      {entry.shortcut}
                    </kbd>
                  )}
                  {hasChildren && <ChevronRight className="h-3.5 w-3.5 text-[#6b6f76]" />}
                </span>
              </button>

              {hasChildren && openSubmenuIndex === index && (
                <div
                  role="menu"
                  aria-label={`${entry.label} サブメニュー`}
                  className={`absolute z-[60] w-56 rounded-lg border border-[#e4e4e7] bg-white py-1 shadow-2xl ${
                    submenuOnLeft ? 'right-[calc(100%+4px)]' : 'left-[calc(100%+4px)]'
                  } ${submenuOpensUp ? 'bottom-0' : 'top-0'}`}
                >
                  {entry.children!.map((child, childIndex) => {
                    const isChildActive =
                      childIndex === submenuActiveIndex && child.enabled;
                    return (
                      <button
                        key={`${child.id}:${childIndex}`}
                        ref={(element) => {
                          submenuItemRefs.current[childIndex] = element;
                        }}
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        aria-disabled={!child.enabled}
                        onMouseEnter={() => {
                          if (child.enabled) setSubmenuActiveIndex(childIndex);
                        }}
                        onClick={() => {
                          if (!child.enabled) return;
                          onAction(child.id);
                          closeAndRestore();
                        }}
                        className={`flex w-full items-center justify-between px-2.5 py-1 text-left text-[0.75rem] transition ${
                          !child.enabled
                            ? 'cursor-not-allowed text-[#b4b4bb]'
                            : isChildActive
                              ? 'bg-[#eef0fb] text-[#4f5ac2]'
                              : 'text-[#3c3f46] hover:bg-[#f4f4f5]'
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0">{child.icon}</span>
                          <span className="truncate">{child.label}</span>
                        </span>
                        {child.shortcut && (
                          <kbd
                            aria-hidden="true"
                            className="ml-2 shrink-0 font-mono text-[0.625rem] text-[#6b6f76]"
                          >
                            {child.shortcut}
                          </kbd>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
