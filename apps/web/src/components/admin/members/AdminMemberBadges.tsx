'use client';

import {
  ADMIN_MEMBER_ROLE_LABELS,
  memberRoleBadgeClass,
  memberStatusBadgeClass,
} from '@/lib/admin-users';
import type { AdminMemberRow, UserRole } from '@/types/files';

export function MemberStatusBadge({
  status,
}: {
  status: AdminMemberRow['status'];
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${memberStatusBadgeClass(
        status
      )}`}
    >
      {status === 'active' ? '有効' : '停止中'}
    </span>
  );
}

export function MemberRoleBadge({ role }: { role: UserRole }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${memberRoleBadgeClass(
        role
      )}`}
    >
      {ADMIN_MEMBER_ROLE_LABELS[role]}
    </span>
  );
}
