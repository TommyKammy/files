'use client';

import {
  WorkspaceInspectorDrawer,
  type InspectorTarget,
} from '@/components/WorkspaceInspectorDrawer';
import { canAccess } from '@/lib/capabilities';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type {
  BreadcrumbItem,
  Capability,
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
  capabilities,
  lock,
  currentUserId,
  isPrivilegedAdmin = false,
  syncStore,
  onLockChanged,
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
  capabilities?: Capability[];
  lock?: FileLockInfo | null;
  currentUserId?: string | null;
  isPrivilegedAdmin?: boolean;
  syncStore: WorkspaceSyncStore;
  onLockChanged?: (fileId: string, lock: FileLockInfo | null) => void;
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
  const targetCapabilities =
    target.kind === 'folder'
      ? target.folder.capabilities ?? capabilities
      : capabilities;
  const access = {
    capabilities: targetCapabilities,
    effectiveRole: targetRole,
  };
  if (!canAccess(access, 'item.preview')) return null;

  return (
    <WorkspaceInspectorDrawer
      target={target}
      effectiveRole={targetRole}
      capabilities={targetCapabilities}
      breadcrumbs={breadcrumbs}
      canPreview={canAccess(access, 'item.preview')}
      canDownload={canAccess(access, 'item.download')}
      canClassify={canAccess(access, 'classification.edit')}
      canShare={canAccess(access, 'share_link.create')}
      canManageLinks={canAccess(access, 'share_link.manage')}
      canManagePerms={canAccess(access, 'permission.manage')}
      canInvitePerms={canAccess(access, 'permission.invite')}
      canVersionHistory={canAccess(access, 'item.preview')}
      currentUserId={currentUserId}
      isPrivilegedAdmin={isPrivilegedAdmin}
      lock={lock}
      syncStore={syncStore}
      onLockChanged={onLockChanged}
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
