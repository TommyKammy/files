'use client';

import { CAPABILITY_CHIPS } from '@/lib/capabilities';
import type { Capability } from '@/types/files';

export function capabilityLabels(capabilities: Capability[]): string[] {
  return capabilities.map((capability) => CAPABILITY_CHIPS[capability]);
}

export function CapabilityChips({
  capabilityLabels: labels,
  max,
  ariaLabel,
}: {
  capabilityLabels: string[];
  max?: number;
  ariaLabel: string;
}) {
  const shown = max !== undefined ? labels.slice(0, max) : labels;
  const hidden = labels.length - shown.length;
  return (
    <ul aria-label={ariaLabel} className="flex flex-wrap gap-1">
      {shown.map((label) => (
        <li
          key={label}
          className="rounded-full border border-blue-100 bg-blue-50 px-1.5 py-0.5 text-[0.625rem] leading-4 text-blue-700"
        >
          {label}
        </li>
      ))}
      {hidden > 0 && (
        <li className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[0.625rem] leading-4 text-slate-600">
          +{hidden}
        </li>
      )}
    </ul>
  );
}
