'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

export function useMenuSurface<T extends string>({
  anchor,
  entries,
  onAction,
  onClose,
  returnFocus = null,
  width = 248,
  height = 300,
  scopeName = 'contextMenu',
}: {
  anchor: { x: number; y: number };
  entries: Array<MenuEntry<T>>;
  onAction: (id: T) => void;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  width?: number;
  height?: number;
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

  return {
    menuRef,
    parentItemRefs,
    submenuItemRefs,
    pos,
    activeIndex,
    setActiveIndex,
    openSubmenuIndex,
    setOpenSubmenuIndex,
    submenuActiveIndex,
    setSubmenuActiveIndex,
    submenuEntries,
    openSubmenu,
    activateEntry,
    handleKeyDown,
    closeAndRestore,
  };
}
