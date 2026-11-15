'use client';

import { useEffect, useRef } from 'react';

type ModalBackdrop = 'light' | 'dark' | 'deep';

/**
 * Shared modal surface built on the native <dialog> element.
 *
 * `showModal()` gives us browser-managed focus containment, top-layer
 * rendering, inert background content and Escape handling. This component
 * adds the two things the native element does not do for us:
 * - move initial focus to `[data-autofocus]` (or the first focusable control)
 * - return focus to the invoking element when the dialog unmounts
 */
export function ModalShell({
  label,
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
      aria-label={label}
      aria-describedby={describedBy}
      data-backdrop={backdrop}
      data-blur={blur ? 'true' : 'false'}
      data-align={align}
      className="modal-shell"
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
