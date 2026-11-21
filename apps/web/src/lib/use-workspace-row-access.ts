'use client';

import { useCallback } from 'react';
import { canAccess, capabilitiesForRole } from '@/lib/capabilities';
import { isRowSelectable, type WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  AuthUser,
  Capability,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export function collectRowCapabilities(
  row: WorkspaceTableRow,
  folderCapabilities: Capability[] | undefined
): Capability[] | undefined {
  return row.kind === 'folder'
    ? row.folder.capabilities ?? folderCapabilities
    : folderCapabilities;
}

/**
 * Computes folder-level capability booleans and row-level permission predicates
 * for the active workspace directory.
 */
export function useWorkspaceRowAccess({
  currentFolder,
  directoryCapabilities,
  effectiveRole,
  isPathOnly,
  isTrashView,
  user,
}: {
  currentFolder: FolderSummary | null;
  directoryCapabilities: Capability[] | undefined;
  effectiveRole: ResourceRole;
  isPathOnly: boolean;
  isTrashView: boolean;
  user: AuthUser | null;
}) {
  const currentCapabilities = isPathOnly
    ? directoryCapabilities ?? (['folder.traverse'] as Capability[])
    : directoryCapabilities ?? capabilitiesForRole(effectiveRole);
  const currentAccess = {
    capabilities: currentCapabilities,
    effectiveRole,
  };

  const canPreviewCurrentFolder =
    !currentFolder || canAccess(currentAccess, 'item.preview');
  const canDownloadCurrentFolder =
    !currentFolder || canAccess(currentAccess, 'item.download');
  const canCreateFolder =
    !currentFolder || canAccess(currentAccess, 'folder.create');
  const canRenameCurrentFolder =
    !currentFolder || canAccess(currentAccess, 'folder.rename');
  const canDeleteCurrentFolder =
    !currentFolder || canAccess(currentAccess, 'folder.delete');
  const canManageCurrentFolderPerms = currentFolder
    ? user?.role === 'sys_admin' ||
      canAccess(currentAccess, 'permission.manage')
    : false;
  const canInviteCurrentFolder = currentFolder
    ? canAccess(currentAccess, 'permission.invite')
    : false;
  const canShareCurrentFolder = currentFolder
    ? canAccess(currentAccess, 'share_link.create')
    : false;
  const canManageCurrentFolderLinks = currentFolder
    ? canAccess(currentAccess, 'share_link.manage')
    : false;
  const canUploadNew = currentFolder
    ? canAccess(currentAccess, 'item.upload_new')
    : false;
  const canUploadVersion = currentFolder
    ? canAccess(currentAccess, 'item.upload_version')
    : false;
  const canClassifyCurrentFolder = currentFolder
    ? canAccess(currentAccess, 'classification.edit')
    : false;
  const canInspectCurrentFolder = canPreviewCurrentFolder;

  const rowAccess = useCallback(
    (row: WorkspaceTableRow) => ({
      capabilities: collectRowCapabilities(row, directoryCapabilities),
      effectiveRole:
        row.kind === 'folder'
          ? row.folder.effectiveRole ?? effectiveRole
          : effectiveRole,
    }),
    [directoryCapabilities, effectiveRole]
  );

  const canRenameRow = useCallback(
    (row: WorkspaceTableRow): boolean => {
      if (isTrashView || !isRowSelectable(row)) return false;
      return canAccess(
        rowAccess(row),
        row.kind === 'folder' ? 'folder.rename' : 'item.rename'
      );
    },
    [isTrashView, rowAccess]
  );

  const canDeleteRow = useCallback(
    (row: WorkspaceTableRow): boolean => {
      if (isTrashView || !isRowSelectable(row)) return false;
      return canAccess(
        rowAccess(row),
        row.kind === 'folder' ? 'folder.delete' : 'item.delete'
      );
    },
    [isTrashView, rowAccess]
  );

  const canShareRow = useCallback(
    (row: WorkspaceTableRow): boolean => {
      if (isTrashView || !isRowSelectable(row)) return false;
      return canAccess(rowAccess(row), 'share_link.create');
    },
    [isTrashView, rowAccess]
  );

  const canManageLinksRow = useCallback(
    (row: WorkspaceTableRow): boolean => {
      if (isTrashView || !isRowSelectable(row)) return false;
      return canAccess(rowAccess(row), 'share_link.manage');
    },
    [isTrashView, rowAccess]
  );

  const canClassifyRow = useCallback(
    (row: WorkspaceTableRow): boolean => {
      if (isTrashView || row.kind !== 'file' || !isRowSelectable(row)) {
        return false;
      }
      return canAccess(rowAccess(row), 'classification.edit');
    },
    [isTrashView, rowAccess]
  );

  return {
    currentCapabilities,
    canPreviewCurrentFolder,
    canDownloadCurrentFolder,
    canCreateFolder,
    canRenameCurrentFolder,
    canDeleteCurrentFolder,
    canManageCurrentFolderPerms,
    canInviteCurrentFolder,
    canShareCurrentFolder,
    canManageCurrentFolderLinks,
    canUploadNew,
    canUploadVersion,
    canClassifyCurrentFolder,
    canInspectCurrentFolder,
    canRenameRow,
    canDeleteRow,
    canShareRow,
    canManageLinksRow,
    canClassifyRow,
    // Compatibility alias used by hooks that gate inline rename only.
    canEditRow: canRenameRow,
  };
}
