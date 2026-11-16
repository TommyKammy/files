'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function CopyableUrl({
  title,
  value,
  inputId,
  inputName,
  ariaLabel,
  tone = 'emerald',
}: {
  title: string;
  value: string;
  inputId: string;
  inputName: string;
  ariaLabel: string;
  tone?: 'emerald' | 'indigo';
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  async function handleCopy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1800);
  }

  const toneClass =
    tone === 'indigo'
      ? {
          panel: 'border-indigo-200 bg-indigo-50',
          title: 'text-indigo-950',
          input: 'border-indigo-200',
          button: 'bg-indigo-600 hover:bg-indigo-700',
        }
      : {
          panel: 'border-emerald-200 bg-emerald-50',
          title: 'text-emerald-900',
          input: 'border-emerald-200',
          button: 'bg-emerald-600 hover:bg-emerald-700',
        };

  return (
    <div className={`rounded-xl border p-3.5 space-y-2 ${toneClass.panel}`}>
      <div className={`text-xs font-semibold ${toneClass.title}`}>
        {title}
      </div>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          name={inputName}
          aria-label={ariaLabel}
          readOnly
          value={value}
          className={`flex-1 rounded-lg border bg-white px-2.5 py-1.5 font-mono text-xs text-slate-800 ${toneClass.input}`}
        />
        <button
          type="button"
          onClick={handleCopy}
          className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold text-white ${toneClass.button}`}
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5" />
              <span>コピー済み</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span>コピー</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
