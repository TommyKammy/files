'use client';

import { ClipboardPaste, Copy, Scissors } from 'lucide-react';

export function WorkspaceClipboardBar({
  mode,
  itemCount,
  onPaste,
  onClear,
}: {
  mode: 'copy' | 'cut';
  itemCount: number;
  onPaste: () => void;
  onClear: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="仮想クリップボード"
      className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[#2a2a2e] bg-[#111214]/95 px-3 py-1.5 text-[0.6875rem] text-white shadow-2xl"
    >
      <span className="flex items-center gap-1.5 font-medium">
        {mode === 'cut' ? (
          <Scissors className="h-3.5 w-3.5 text-[#f1e1bf]" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-[#bcc3ea]" />
        )}
        <span>
          {mode === 'cut' ? '切り取り中' : 'コピー中'}: {itemCount} 件
        </span>
      </span>
      <button
        type="button"
        onClick={onPaste}
        className="inline-flex h-6 items-center gap-1.5 rounded bg-[#5e6ad2] px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-[#4f5ac2]"
      >
        <ClipboardPaste className="h-3.5 w-3.5" />
        <span>ここへ貼り付け (⌘V)</span>
      </button>
      <button
        type="button"
        onClick={onClear}
        className="rounded px-2 py-1 text-[#b4b4bb] transition hover:bg-white/10 hover:text-white"
      >
        解除
      </button>
    </div>
  );
}
