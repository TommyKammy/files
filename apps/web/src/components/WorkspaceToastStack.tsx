'use client';

import { Undo2, X } from 'lucide-react';
import type { WorkspaceToastItem } from '@/types/files';

export function WorkspaceToastStack({
  toasts,
  canUndo,
  onUndo,
  onDismiss,
}: {
  toasts: WorkspaceToastItem[];
  canUndo: boolean;
  onUndo: () => void;
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[0.6875rem] shadow-lg ${
            toast.kind === 'error'
              ? 'border-[#5a2a2e] bg-[#2a1416]/95 text-[#fdf0f1]'
              : toast.kind === 'warning'
                ? 'border-[#5a4a2a] bg-[#2a2314]/95 text-[#fdf6e9]'
                : 'border-[#2a2a2e] bg-[#111214]/95 text-[#f9f9fa]'
          }`}
        >
          <span className="min-w-0 flex-1 leading-relaxed">
            {toast.message}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {toast.canUndo && canUndo && (
              <button
                type="button"
                onClick={onUndo}
                className="inline-flex items-center gap-1 rounded-md bg-white/15 px-2.5 py-1 font-medium text-white hover:bg-white/25"
              >
                <Undo2 className="h-3 w-3" />
                <span>{toast.undoLabel ?? '元に戻す'} (⌘Z)</span>
              </button>
            )}
            <button
              type="button"
              aria-label="通知を閉じる"
              onClick={() => onDismiss(toast.id)}
              className="flex h-6 w-6 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
