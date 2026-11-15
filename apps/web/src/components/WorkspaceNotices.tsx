'use client';

import { AlertCircle } from 'lucide-react';

export function WorkspaceNotices({
  activeDirectoryNotice,
  error,
  onDismissNotice,
}: {
  activeDirectoryNotice: string | null;
  error: string | null;
  onDismissNotice: () => void;
}) {
  if (!activeDirectoryNotice && !error) return null;

  return (
    <>
      {activeDirectoryNotice && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{activeDirectoryNotice}</span>
          </div>
          <button
            type="button"
            onClick={onDismissNotice}
            className="rounded px-2 py-0.5 text-[0.6875rem] font-medium hover:bg-amber-100"
          >
            閉じる
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </>
  );
}
