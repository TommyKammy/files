'use client';

import { ShieldCheck } from 'lucide-react';
import { guestStatusBadgeClass, guestStatusLabel } from '@/lib/admin-guests';
import type { AdminGuestLifecycleStatus } from '@/types/files';

export function GuestStatusBadge({
  status,
}: {
  status: AdminGuestLifecycleStatus;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${guestStatusBadgeClass(
        status
      )}`}
    >
      {guestStatusLabel(status)}
    </span>
  );
}

export function DlpBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[0.5625rem] font-semibold text-purple-800">
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      DLP 保護: メタデータのみ
    </span>
  );
}
