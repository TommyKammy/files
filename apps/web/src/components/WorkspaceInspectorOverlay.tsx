'use client';

import {
  WorkspaceInspectorDrawer,
  type InspectorTarget,
} from '@/components/WorkspaceInspectorDrawer';
import { hasRoleAtLeast } from '@/lib/formatters';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type {
  BreadcrumbItem,
  FileItem,
  FileLockInfo,
  ResourceRole,
} from '@/types/files';

export function WorkspaceInspectorOverlay({
  open,
  isTrashView,
  target,
  breadcrumbs,
  effectiveRole,
  canEditCurrentFolder,
  canDownloadCurrentFolder,
  canManageCurrentFolderPerms,
  isPrivilegedAdmin,
  lock,
  syncStore,
  onClose,
  onPreview,
  onDownload,
  onOpenVersionHistory,
  onOpenClassification,
  onOpenShare,
  onOpenPermissions,
  onApproveAi,
}: {
  open: boolean;
  isTrashView: boolean;
  target: InspectorTarget | null;
  breadcrumbs: BreadcrumbItem[];
  effectiveRole: ResourceRole;
  canEditCurrentFolder: boolean;
  canDownloadCurrentFolder: boolean;
  canManageCurrentFolderPerms: boolean;
  isPrivilegedAdmin: boolean;
  lock?: FileLockInfo | null;
  syncStore: WorkspaceSyncStore;
  onClose: () => void;
  onPreview: (file: FileItem) => void;
  onDownload: (fileId: string) => void;
  onOpenVersionHistory: (
    file: FileItem,
    returnFocus?: HTMLElement | null
  ) => void;
  onOpenClassification: (file: FileItem) => void;
  onOpenShare: (target: InspectorTarget) => void;
  onOpenPermissions: (target: InspectorTarget) => void;
  onApproveAi: (file: FileItem) => void;
}) {
  if (!open || !target || isTrashView) return null;

  const targetRole =
    target.kind === 'folder'
      ? target.folder.effectiveRole ?? effectiveRole
      : effectiveRole;
  const targetCanEdit =
    target.kind === 'folder'
      ? hasRoleAtLeast(targetRole, 'editor')
      : canEditCurrentFolder;
  const targetCanDownload =
    target.kind === 'folder'
      ? hasRoleAtLeast(targetRole, 'viewer')
      : canDownloadCurrentFolder;
  const targetCanManagePerms =
    target.kind === 'folder'
      ? hasRoleAtLeast(targetRole, 'co_owner')
      : canManageCurrentFolderPerms;

  return (
    <WorkspaceInspectorDrawer
      target={target}
      effectiveRole={targetRole}
      breadcrumbs={breadcrumbs}
      canEdit={targetCanEdit}
      canDownload={targetCanDownload}
      canManagePerms={targetCanManagePerms}
      isPrivilegedAdmin={isPrivilegedAdmin}
      lock={lock}
      syncStore={syncStore}
      onClose={onClose}
      onPreview={onPreview}
      onDownload={onDownload}
      onOpenVersionHistory={onOpenVersionHistory}
      onOpenClassification={onOpenClassification}
      onOpenShare={onOpenShare}
      onOpenPermissions={onOpenPermissions}
      onApproveAi={onApproveAi}
    />
  );
}
