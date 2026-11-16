'use client';

import { useEffect, useRef } from 'react';
import {
  isImeComposingEvent,
  keyboardScopes,
} from '@/lib/keyboard-shortcuts';

type ModalBackdrop = 'light' | 'dark' | 'deep';

/**
 * Shared modal surface built on the native <dialog> element.
 *
 * `showModal()` gives us browser-managed focus containment, top-layer
 * rendering, inert background content and Escape handling. This component
 * adds the things the native element does not do for us:
 * - register a `modal` entry on KeyboardScopeStack so workspace single-key
 *   shortcuts (Delete / F2 / move / preview arrows) stay disabled
 * - move initial focus to `[data-autofocus]` (or the first focusable control)
 * - ignore Enter/Escape during Japanese IME composition
 * - return focus to the invoking element when the dialog unmounts
 */
export function ModalShell({
  label,
  labelledBy,
  onClose,
  children,
  className = '',
  align = 'center',
  backdrop = 'dark',
  blur = true,
  returnFocus = null,
  describedBy,
}: {
  label: string;
  /** Optional id of the visible heading; takes precedence over `label`. */
  labelledBy?: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  align?: 'center' | 'top';
  backdrop?: ModalBackdrop;
  blur?: boolean;
  returnFocus?: HTMLElement | null;
  describedBy?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const token = keyboardScopes.pushScope('modal');
    return () => {
      keyboardScopes.popScope(token);
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    previouslyFocusedRef.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);

    if (!dialog.open) {
      dialog.showModal();
    }

    const focusTarget =
      dialog.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );

    if (focusTarget) {
      // showModal() runs its own first-focusable pass; re-apply the intended
      // target on the next frame so [data-autofocus] wins consistently.
      const applyFocus = () => {
        if (dialog.open) focusTarget.focus({ preventScroll: true });
      };
      applyFocus();
      requestAnimationFrame(applyFocus);
    }

    return () => {
      if (dialog.open) dialog.close();
      const target = returnFocus ?? previouslyFocusedRef.current;
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
      }
    };
  }, [returnFocus]);

  return (
    <dialog
      ref={dialogRef}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-backdrop={backdrop}
      data-blur={blur ? 'true' : 'false'}
      data-align={align}
      className="modal-shell"
      onKeyDown={(event) => {
        if (!isImeComposingEvent(event.nativeEvent)) return;
        if (event.key === 'Escape') {
          // Keep the native dialog open while the IME owns Escape.
          event.preventDefault();
          event.stopPropagation();
        } else if (event.key === 'Enter') {
          // Do not let a composing Enter submit a modal form.
          event.stopPropagation();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <div className={className}>{children}</div>
    </dialog>
  );
}
