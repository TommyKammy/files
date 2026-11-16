'use client';

import { getTrashRetentionBadge } from '@/lib/trash-view';

export function TrashRetentionBadge({
  daysRemaining,
  className = '',
}: {
  daysRemaining: number | null | undefined;
  className?: string;
}) {
  const badge = getTrashRetentionBadge(daysRemaining);
  return (
    <span
      data-retention-level={badge.level}
      title={badge.description}
      aria-label={badge.description}
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium leading-none ${badge.className} ${className}`}
    >
      {badge.label}
    </span>
  );
}
