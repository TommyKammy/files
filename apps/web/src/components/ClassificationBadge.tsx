'use client';

import { CLASSIFICATION_META } from '@/lib/formatters';
import type { ClassificationLabel } from '@/types/files';

export function ClassificationBadge({
  classification,
  compact = false,
  labelOverride,
}: {
  classification: ClassificationLabel;
  compact?: boolean;
  labelOverride?: string;
}) {
  const meta = CLASSIFICATION_META[classification] ?? CLASSIFICATION_META.unset;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-medium ${meta.badgeClass} ${
        compact ? 'px-1.5 py-0.5 text-[0.6875rem]' : 'px-2 py-0.5 text-[0.75rem]'
      }`}
    >
      <span className={`h-1 w-1 rounded-full ${meta.dotClass}`} />
      <span>{labelOverride ?? meta.label}</span>
    </span>
  );
}
