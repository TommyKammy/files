'use client';

import { useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { InspectorTarget } from '@/components/WorkspaceInspectorDrawer';
import type { ActiveModal } from '@/components/WorkspaceManagementModals';
import { canAccess } from '@/lib/capabilities';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type {
  Capability,
  FolderSummary,
  ResourceRole,
  TenantPolicyRow,
} from '@/types/files';

/**
 * Derives the active inspector target and provides share/permission modal
 * openers scoped to that target.
 */
export function useWorkspaceInspectorActions({
  isTrashView,
  focusedRow,
  selectedRows,
  currentFolder,
  effectiveRole,
  currentCapabilities,
  policy,
  setActiveModal,
}: {
  isTrashView: boolean;
  focusedRow: WorkspaceTableRow | null;
  selectedRows: WorkspaceTableRow[];
  currentFolder: FolderSummary | null;
  effectiveRole: ResourceRole;
  currentCapabilities: Capability[];
  policy: TenantPolicyRow | null | undefined;
  setActiveModal: Dispatch<SetStateAction<ActiveModal | null>>;
}) {
  const inspectorTarget = useMemo<InspectorTarget | null>(() => {
    if (isTrashView) return null;
    const candidate = focusedRow ?? selectedRows[0] ?? null;
    if (candidate) {
      return candidate.kind === 'folder'
        ? { kind: 'folder', folder: candidate.folder }
        : { kind: 'file', file: candidate.file };
    }
    return currentFolder ? { kind: 'folder', folder: currentFolder } : null;
  }, [isTrashView, focusedRow, selectedRows, currentFolder]);

  function handleOpenInspectorShare(target: InspectorTarget) {
    const targetIsFolder = target.kind === 'folder';
    const targetEffectiveRole = targetIsFolder
      ? target.folder.effectiveRole ?? effectiveRole
      : effectiveRole;
    const targetCaps = targetIsFolder
      ? target.folder.capabilities ?? currentCapabilities
      : currentCapabilities;
    setActiveModal({
      kind: 'share',
      targetType: target.kind,
      targetId: targetIsFolder ? target.folder.id : target.file.id,
      targetName: targetIsFolder ? target.folder.name : target.file.name,
      classification: targetIsFolder
        ? target.folder.classification
        : target.file.classification,
      canEdit: canAccess(
        { capabilities: targetCaps, effectiveRole: targetEffectiveRole },
        'share_link.create'
      ),
      canManageLinks: canAccess(
        { capabilities: targetCaps, effectiveRole: targetEffectiveRole },
        'share_link.manage'
      ),
      policy,
    });
  }

  function handleOpenInspectorPermissions(target: InspectorTarget) {
    const targetIsFolder = target.kind === 'folder';
    const targetEffectiveRole = targetIsFolder
      ? target.folder.effectiveRole ?? effectiveRole
      : effectiveRole;
    setActiveModal({
      kind: 'permissions',
      targetType: target.kind,
      targetId: targetIsFolder ? target.folder.id : target.file.id,
      targetName: targetIsFolder ? target.folder.name : target.file.name,
      effectiveRole: targetEffectiveRole,
      targetCapabilities: targetIsFolder
        ? target.folder.capabilities ?? currentCapabilities
        : currentCapabilities,
    });
  }

  return {
    inspectorTarget,
    handleOpenInspectorShare,
    handleOpenInspectorPermissions,
  };
}
