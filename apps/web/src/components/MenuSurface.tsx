import { ChevronRight } from 'lucide-react';
import {
  isMenuEntrySelectable,
  useMenuSurface,
  type MenuEntry,
} from '@/lib/use-menu-surface';
import type { KeyboardScope } from '@/lib/keyboard-shortcuts';

export type { MenuEntry } from '@/lib/use-menu-surface';
export { isMenuEntrySelectable } from '@/lib/use-menu-surface';

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
  const {
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
  } = useMenuSurface({
    anchor,
    entries,
    onAction,
    onClose,
    returnFocus,
    width,
    height,
    scopeName,
  });

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
