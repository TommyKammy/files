'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function ModalHeader({
  icon,
  title,
  subtitle,
  badge,
  onClose,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-slate-900">
              {title}
            </h2>
            {badge}
          </div>
          {subtitle && (
            <p className="text-[0.6875rem] text-slate-500">{subtitle}</p>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label="閉じる"
        onClick={onClose}
        className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
