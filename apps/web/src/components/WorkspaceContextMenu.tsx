'use client';

import {
  Activity,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FolderInput,
  History,
  Info,
  Link2,
  Lock,
  Pin,
  Scissors,
  Shield,
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
  | 'openInNewTab'
  | 'copyLink'
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
  | 'permissions'
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
  children?: MenuEntry[];
}

function isEntrySelectable(entry: MenuEntry): boolean {
  if (entry.children && entry.children.length > 0) {
    return entry.children.some((child) => child.enabled);
  }
  return entry.enabled;
}

export function WorkspaceContextMenu({
  anchor,
  targets,
  primaryRow,
  capabilities,
  clipboardCount,
  returnFocus = null,
  onAction,
  onClose,
}: {
  anchor: { x: number; y: number };
  targets: ContextRowTarget[];
  primaryRow: ContextRowTarget | null;
  capabilities: ContextMenuCapabilities;
  clipboardCount: number;
  returnFocus?: HTMLElement | null;
  onAction: (action: ContextMenuActionId) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const parentItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const submenuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
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
      const openChildren: MenuEntry[] = [
        {
          id: 'open',
          label:
            primaryRow.kind === 'folder' ? 'フォルダを開く' : 'プレビューを開く',
          shortcut: 'Enter',
          icon: <Eye className="h-3.5 w-3.5" />,
          enabled: capabilities.canOpen,
        },
      ];
      openChildren.push({
        id: 'openInNewTab',
        label: '新しいタブで開く',
        icon: <ExternalLink className="h-3.5 w-3.5" />,
        enabled: capabilities.canOpen,
      });
      list.push({
        id: 'open',
        label: '開く',
        icon: <Eye className="h-3.5 w-3.5" />,
        enabled: openChildren.some((child) => child.enabled),
        children: openChildren,
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

    if (capabilities.isMulti) {
      list.push(
        {
          id: 'duplicate',
          label: `${targets.length} 件を複製`,
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
    }

    list.push({
      id: 'classify',
      label: capabilities.isMulti ? '機密区分を一括変更' : '機密区分を変更',
      shortcut: 'c',
      icon: <Tag className="h-3.5 w-3.5" />,
      enabled: capabilities.canClassify,
      dividerBefore: true,
    });

    if (!capabilities.isMulti && primaryRow) {
      const shareChildren: MenuEntry[] = [
        {
          id: 'share',
          label: '共有リンク設定',
          shortcut: 's',
          icon: <Link2 className="h-3.5 w-3.5" />,
          enabled: capabilities.canShare,
        },
        {
          id: 'copyLink',
          label: 'リンクをコピー',
          icon: <ExternalLink className="h-3.5 w-3.5" />,
          enabled: capabilities.canCopyLink,
        },
        {
          id: 'permissions',
          label: '権限管理',
          icon: <Shield className="h-3.5 w-3.5" />,
          enabled: capabilities.canPermissions,
        },
      ];
      list.push({
        id: 'share',
        label: '共有',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: shareChildren.some((child) => child.enabled),
        children: shareChildren,
      });

      const organizeChildren: MenuEntry[] = [
        {
          id: 'moveCopy',
          label: '移動 / コピー先を選択...',
          shortcut: 'm',
          icon: <FolderInput className="h-3.5 w-3.5" />,
          enabled: capabilities.canMoveCopy,
        },
        {
          id: 'duplicate',
          label: '複製',
          shortcut: '⌘D',
          icon: <Clipboard className="h-3.5 w-3.5" />,
          enabled: capabilities.canDuplicate,
        },
      ];
      if (primaryRow.kind === 'folder') {
        organizeChildren.push({
          id: 'pin',
          label: isPinnedFolder ? 'ピン留めを解除' : 'クイックアクセスにピン留め',
          icon: <Pin className="h-3.5 w-3.5" />,
          enabled: capabilities.canPin,
        });
      }
      list.push({
        id: 'moveCopy',
        label: '整理',
        icon: <FolderInput className="h-3.5 w-3.5" />,
        enabled: organizeChildren.some((child) => child.enabled),
        children: organizeChildren,
      });

      list.push({
        id: 'inspector',
        label: '詳細',
        icon: <Info className="h-3.5 w-3.5" />,
        enabled: capabilities.canInspector,
        children: [
          {
            id: 'inspector',
            label: '詳細インスペクタ',
            shortcut: 'i',
            icon: <Info className="h-3.5 w-3.5" />,
            enabled: capabilities.canInspector,
          },
          {
            id: 'inspector',
            label: '版履歴（準備中）',
            icon: <History className="h-3.5 w-3.5" />,
            enabled: false,
          },
          {
            id: 'inspector',
            label: 'アクティビティ（準備中）',
            icon: <Activity className="h-3.5 w-3.5" />,
            enabled: false,
          },
          {
            id: 'inspector',
            label: 'ロック（Phase 7）',
            icon: <Lock className="h-3.5 w-3.5" />,
            enabled: false,
          },
        ],
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
    () => entries.map((entry, index) => (isEntrySelectable(entry) ? index : -1)).filter((index) => index >= 0),
    [entries]
  );
  const [activeIndex, setActiveIndex] = useState<number>(() => enabledIndices[0] ?? 0);
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
    previouslyFocusedRef.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
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
    };
  }, [onClose, returnFocus]);

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposingEvent(e.nativeEvent)) return;
    if (scopeTokenRef.current && !keyboardScopes.isTopToken(scopeTokenRef.current)) {
      return;
    }

    if (e.key === 'Tab') {
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
      if (entry?.children && entry.children.length > 0) {
        e.preventDefault();
        const firstEnabled = entry.children.findIndex((child) => child.enabled);
        if (firstEnabled >= 0) {
          setOpenSubmenuIndex(activeIndex);
          setSubmenuActiveIndex(firstEnabled);
        }
      }
      return;
    }

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
      const prevPos = currPos <= 0 ? enabledIndices.length - 1 : currPos - 1;
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
      if (!selected) return;
      if (selected.children && selected.children.length > 0) {
        const firstEnabled = selected.children.findIndex((child) => child.enabled);
        if (firstEnabled >= 0) {
          setOpenSubmenuIndex(activeIndex);
          setSubmenuActiveIndex(firstEnabled);
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
    typeof window !== 'undefined' && pos.left + 252 + 232 > window.innerWidth;
  const submenuOpensUp =
    openSubmenuIndex !== null && openSubmenuIndex >= Math.max(0, entries.length - 2);

  const openSubmenu = (index: number) => {
    const entry = entries[index];
    if (!entry?.children?.length) return;
    const firstEnabled = entry.children.findIndex((child) => child.enabled);
    if (firstEnabled < 0) return;
    setOpenSubmenuIndex(index);
    setSubmenuActiveIndex(firstEnabled);
  };

  const activateEntry = (entry: MenuEntry, index: number) => {
    if (entry.children && entry.children.length > 0) {
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
      aria-label="コンテキストメニュー"
      tabIndex={-1}
      onKeyDown={handleMenuKeyDown}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      className="fixed z-50 w-60 rounded-lg border border-[#e4e4e7] bg-white py-1 shadow-2xl focus:outline-none"
    >
      <div className="border-b border-[#f0f0f1] px-2.5 py-1.5 text-[0.6875rem] font-medium text-[#6b6f76] truncate">
        {capabilities.isMulti
          ? `${targets.length} 件を選択中`
          : primaryRow?.kind === 'folder'
            ? primaryRow.folder.name
            : primaryRow?.file.name ?? 'ワークスペース'}
      </div>

      <div className="py-1">
        {entries.map((entry, index) => {
          const hasChildren = Boolean(entry.children && entry.children.length > 0);
          const isActive = index === activeIndex && isEntrySelectable(entry);
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
                aria-disabled={!isEntrySelectable(entry)}
                aria-haspopup={hasChildren ? 'menu' : undefined}
                aria-expanded={hasChildren ? openSubmenuIndex === index : undefined}
                onMouseEnter={() => {
                  if (!isEntrySelectable(entry)) return;
                  setActiveIndex(index);
                  if (hasChildren) openSubmenu(index);
                  else setOpenSubmenuIndex(null);
                }}
                onClick={() => activateEntry(entry, index)}
                className={`flex w-full items-center justify-between px-2.5 py-1 text-left text-[0.75rem] transition ${
                  !isEntrySelectable(entry)
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
                  {hasChildren && <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
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
