'use client';

import { Route } from 'lucide-react';
import type { ComponentProps } from 'react';
import { WorkspaceNotices } from '@/components/WorkspaceNotices';
import { WorkspacePermissionBanner } from '@/components/WorkspacePermissionBanner';
import { WorkspaceTrashBulkBar } from '@/components/WorkspaceTrashBulkBar';
import { WorkspaceTrashFilters } from '@/components/WorkspaceTrashFilters';
import type { Capability, ResourceRole } from '@/types/files';

export interface WorkspaceBannersAndTrashProps {
  isTrashView: boolean;
  isPathOnly: boolean;
  showRoleBanner: boolean;
  effectiveRole: ResourceRole;
  directoryCapabilities: Capability[] | undefined;
  guestInfo: {
    externalOrg: string | null;
    expiresAt: string | null;
  } | null;
  trashBulkBar: ComponentProps<typeof WorkspaceTrashBulkBar>;
  trashFilters: ComponentProps<typeof WorkspaceTrashFilters>;
  notices: ComponentProps<typeof WorkspaceNotices>;
}

/**
 * Renders the Trash bulk bar/filters, workspace notices, path-only banner,
 * and role/guest permission banner above the folder/file list.
 */
export function WorkspaceBannersAndTrash({
  isTrashView,
  isPathOnly,
  showRoleBanner,
  effectiveRole,
  directoryCapabilities,
  guestInfo,
  trashBulkBar,
  trashFilters,
  notices,
}: WorkspaceBannersAndTrashProps) {
  return (
    <>
      {isTrashView && <WorkspaceTrashBulkBar {...trashBulkBar} />}
      {isTrashView && <WorkspaceTrashFilters {...trashFilters} />}
      <WorkspaceNotices {...notices} />

      {isPathOnly && (
        <div
          role="status"
          data-testid="path-only-banner"
          className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-[0.75rem] leading-relaxed text-sky-900"
        >
          <Route className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
          <div>
            <p className="font-semibold">
              途中階層 (パス専用): アクセス可能な子孫フォルダへ移動するための経路表示です。ファイル一覧・アップロード・編集は許可されていません。
            </p>
            <p className="mt-0.5 text-[0.6875rem] text-sky-800">
              下のフォルダから共有されたターゲットへ移動してください。
            </p>
          </div>
        </div>
      )}

      {showRoleBanner && (
        <WorkspacePermissionBanner
          role={effectiveRole}
          capabilities={directoryCapabilities}
          guest={guestInfo}
        />
      )}
    </>
  );
}
