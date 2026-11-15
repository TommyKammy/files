'use client';

import { Check } from 'lucide-react';

export function WorkspaceSelectionCheckbox({
  checked,
  label,
  onClick,
}: {
  checked: boolean;
  label: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-label={label}
      aria-checked={checked}
      data-workspace-row-trigger="true"
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition hover:bg-[#f2f2f4]"
    >
      <span
        className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border transition ${
          checked
            ? 'border-[#5e6ad2] bg-[#5e6ad2] text-white'
            : 'border-[#cfcfd4] bg-white text-transparent hover:border-[#9aa4dd]'
        }`}
      >
        <Check className="h-3 w-3" />
      </span>
    </button>
  );
}
