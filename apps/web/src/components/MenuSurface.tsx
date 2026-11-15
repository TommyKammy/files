'use client';

import { ChevronRight } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  isImeComposingEvent,
  keyboardScopes,
  type KeyboardScope,
} from '@/lib/keyboard-shortcuts';
import { clampPopoverPosition } from '@/lib/workspace-actions';

export interface MenuEntry<T extends string> {
  id: T;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  enabled: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
  children?: Array<MenuEntry<T>>;
}

export function isMenuEntrySelectable<T extends string>(
  entry: MenuEntry<T>
): boolean {
  if (entry.children && entry.children.length > 0) {
    return entry.children.some((child) => child.enabled);
  }
  return entry.enabled;
}

export function MenuSurface<T extends string>({
  anchor,
  entries,
  ariaLabel,
  header,
  onAction,
  onClose,
  returnFocus = null,
  width = 248,
  height = 300,
  widthClass = 'w-60',
  submenuWidthClass = 'w-56',
  tone = 'default',
  scopeName = 'contextMenu',
}: {
  anchor: { x: number; y: number };
  entries: Array<MenuEntry<T>>;
  ariaLabel: string;
  header: React.ReactNode;
  onAction: (id: T) => void;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  width?: number;
  height?: number;
  widthClass?: string;
  submenuWidthClass?: string;
  tone?: 'default' | 'blue';
  scopeName?: KeyboardScope;
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
      width,
      height,
      window.innerWidth,
      window.innerHeight
    );
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const [openSubmenuIndex, setOpenSubmenuIndex] = useState<number | null>(null);
  const [submenuActiveIndex, setSubmenuActiveIndex] = useState(0);

  const enabledIndices = useMemo(
    () =>
      entries
        .map((entry, index) => (isMenuEntrySelectable(entry) ? index : -1))
        .filter((index) => index >= 0),
    [entries]
  );

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
        rect.width || width,
        rect.height || height,
        window.innerWidth,
        window.innerHeight
      )
    );
  }, [anchor.x, anchor.y, entries.length, height, width]);

  useEffect(() => {
    previouslyFocusedRef.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);

    const token = keyboardScopes.pushScope(scopeName);
    scopeTokenRef.current = token;

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

    function handleFocusIn(e: FocusEvent) {
      if (
        menuRef.current &&
        e.target instanceof Node &&
        menuRef.current.contains(e.target)
      ) {
        return;
      }
      onClose();
    }

    window.addEventListener('mousedown', handleOutsidePointer, {
      capture: true,
    });
    window.addEventListener('focusin', handleFocusIn, { capture: true });

    return () => {
      window.removeEventListener('mousedown', handleOutsidePointer, {
        capture: true,
      });
      window.removeEventListener('focusin', handleFocusIn, { capture: true });
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) scopeTokenRef.current = null;
    };
  }, [onClose, returnFocus, scopeName]);

  const openSubmenu = (index: number) => {
    const entry = entries[index];
    if (!entry?.children?.length) return;
    const firstEnabled = entry.children.findIndex((child) => child.enabled);
    if (firstEnabled < 0) return;
    setOpenSubmenuIndex(index);
    setSubmenuActiveIndex(firstEnabled);
  };

  const activateEntry = (entry: MenuEntry<T>, index: number) => {
    if (entry.children?.length) {
      openSubmenu(index);
      return;
    }
    if (!entry.enabled) return;
    onAction(entry.id);
    closeAndRestore();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposingEvent(e.nativeEvent)) return;
    if (
      scopeTokenRef.current &&
      !keyboardScopes.isTopToken(scopeTokenRef.current)
    ) {
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
        const next =
          current < 0 ? 0 : (current + 1) % submenuEnabledIndices.length;
        setSubmenuActiveIndex(submenuEnabledIndices[next]!);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const current = submenuEnabledIndices.indexOf(submenuActiveIndex);
        const prev =
          current <= 0 ? submenuEnabledIndices.length - 1 : current - 1;
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
        openSubmenu(activeIndex);
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
      const prev =
        current <= 0 ? enabledIndices.length - 1 : current - 1;
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
        openSubmenu(activeIndex);
        return;
      }
      if (selected.enabled) {
        onAction(selected.id);
        closeAndRestore();
      }
    }
  };

  const submenuOnLeft =
    typeof window !== 'undefined' &&
    pos.left + width + 232 > window.innerWidth;
  const submenuOpensUp =
    openSubmenuIndex !== null &&
    openSubmenuIndex >= Math.max(0, entries.length - 2);

  const itemToneClass = (entry: MenuEntry<T>, active: boolean) => {
    if (!isMenuEntrySelectable(entry)) {
      return 'cursor-not-allowed text-[#b4b4bb]';
    }
    if (entry.danger) {
      return active
        ? 'bg-[#fdf0f1] text-[#b3242e]'
        : 'text-[#d9343f] hover:bg-[#fdf0f1]';
    }
    if (tone === 'blue') {
      return active
        ? 'bg-blue-50 text-blue-700'
        : 'text-slate-700 hover:bg-slate-50';
    }
    return active
      ? 'bg-[#eef0fb] text-[#4f5ac2]'
      : 'text-[#3c3f46] hover:bg-[#f4f4f5]';
  };

  const submenuToneClass = (entry: MenuEntry<T>, active: boolean) => {
    if (!entry.enabled) return 'cursor-not-allowed text-[#b4b4bb]';
    if (tone === 'blue') {
      return active
        ? 'bg-blue-50 text-blue-700'
        : 'text-slate-700 hover:bg-slate-50';
    }
    return active
      ? 'bg-[#eef0fb] text-[#4f5ac2]'
      : 'text-[#3c3f46] hover:bg-[#f4f4f5]';
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      className={`fixed z-50 ${widthClass} rounded-lg border border-[#e4e4e7] bg-white py-1 shadow-2xl focus:outline-none`}
    >
      <div className="truncate border-b border-[#f0f0f1] px-2.5 py-1.5 text-[0.6875rem] font-medium text-[#6b6f76]">
        {header}
      </div>

      <div className="py-1">
        {entries.map((entry, index) => {
          const hasChildren = Boolean(entry.children?.length);
          const isActive =
            index === activeIndex && isMenuEntrySelectable(entry);
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
                aria-disabled={!isMenuEntrySelectable(entry)}
                aria-haspopup={hasChildren ? 'menu' : undefined}
                aria-expanded={
                  hasChildren ? openSubmenuIndex === index : undefined
                }
                onMouseEnter={() => {
                  if (!isMenuEntrySelectable(entry)) return;
                  setActiveIndex(index);
                  if (hasChildren) openSubmenu(index);
                  else setOpenSubmenuIndex(null);
                }}
                onClick={() => activateEntry(entry, index)}
                className={`flex w-full items-center justify-between px-2.5 py-1 text-left text-[0.75rem] transition ${itemToneClass(
                  entry,
                  isActive
                )}`}
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
                  {hasChildren && (
                    <ChevronRight className="h-3.5 w-3.5 text-[#6b6f76]" />
                  )}
                </span>
              </button>

              {hasChildren && openSubmenuIndex === index && (
                <div
                  role="menu"
                  aria-label={`${entry.label} サブメニュー`}
                  className={`absolute z-[60] ${submenuWidthClass} rounded-lg border border-[#e4e4e7] bg-white py-1 shadow-2xl ${
                    submenuOnLeft
                      ? 'right-[calc(100%+4px)]'
                      : 'left-[calc(100%+4px)]'
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
                        className={`flex w-full items-center justify-between px-2.5 py-1 text-left text-[0.75rem] transition ${submenuToneClass(
                          child,
                          isChildActive
                        )}`}
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
