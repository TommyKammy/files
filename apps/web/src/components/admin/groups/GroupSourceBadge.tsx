'use client';

import {
  groupSourceBadgeClass,
  groupSourceLabel,
} from '@/lib/admin-groups';

export function GroupSourceBadge({ source }: { source: 'scim' | 'manual' }) {
  return (
    <span
      data-testid="group-source-badge"
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${groupSourceBadgeClass(
        source
      )}`}
    >
      {groupSourceLabel(source)}
    </span>
  );
}
