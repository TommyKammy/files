import type { KeyboardScope } from './scopes';

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
  target?: unknown;
}

/**
 * LIFO overlay scope stack ensuring Escape and single-key shortcuts
 * apply strictly to the topmost active layer (palette, help, modal, preview, inlineRename, picker, or workspace).
 */

export function isImeComposingEvent(e: KeyEventLike): boolean {
  return (
    Boolean(e.isComposing) ||
    e.key === 'Process' ||
    e.keyCode === 229 ||
    e.which === 229
  );
}

interface TargetLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  closest?: (selector: string) => unknown;
}

/** True when focus is inside an input/textarea/select/contenteditable field. */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const node = target as TargetLike;
  const tag =
    typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  if (node.isContentEditable === true) {
    return true;
  }
  if (typeof node.closest === 'function') {
    return (
      node.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]') !==
      null
    );
  }
  return false;
}

/**
 * True when Enter/Space or other navigation keys should defer to a non-row UI control
 * (such as sidebar navigation links or modal/toolbar buttons outside the table rows).
 */
export function isInteractiveNonRowTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const node = target as TargetLike;
  if (typeof node.closest === 'function') {
    if (node.closest('aside, a, summary') !== null) {
      return true;
    }
    const btn = node.closest('button');
    if (btn !== null && node.closest('[data-workspace-row-trigger="true"]') === null) {
      return true;
    }
    return false;
  }
  const tag =
    typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  return tag === 'BUTTON' || tag === 'A';
}

/**
 * Guards workspace-level shortcuts against active overlays, IME composition, and text input fields.
 */
export function shouldHandleWorkspaceKey(
  e: KeyEventLike,
  topScope: KeyboardScope
): boolean {
  if (topScope !== 'workspace') return false;
  if (isImeComposingEvent(e)) return false;
  if (isEditableTarget(e.target)) return false;
  return true;
}

/** Safe trash shortcut matcher: requires Delete or Cmd/Ctrl+Backspace (never bare Backspace). */
export function isTrashShortcut(e: KeyEventLike): boolean {
  if (isImeComposingEvent(e)) return false;
  if (e.key === 'Delete' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    return true;
  }
  if (
    (e.metaKey || e.ctrlKey) &&
    !e.altKey &&
    !e.shiftKey &&
    e.key === 'Backspace'
  ) {
    return true;
  }
  return false;
}


