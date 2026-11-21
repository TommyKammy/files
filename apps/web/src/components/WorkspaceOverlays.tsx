'use client';

import type { ComponentProps } from 'react';
import { CreateOfficeDocModal } from '@/components/CreateOfficeDocModal';
import {
  VersionHistoryModal,
  type VersionHistoryTarget,
} from '@/components/VersionHistoryModal';
import { WorkspaceActionOverlays } from '@/components/WorkspaceActionOverlays';
import { WorkspaceClipboardBar } from '@/components/WorkspaceClipboardBar';
import { WorkspaceInspectorOverlay } from '@/components/WorkspaceInspectorOverlay';
import { WorkspaceManagementModals } from '@/components/WorkspaceManagementModals';
import { WorkspaceToastStack } from '@/components/WorkspaceToastStack';
import { WorkspaceTrashBulkDialogs } from '@/components/WorkspaceTrashBulkDialogs';
import { WorkspaceTrashRestoreModal } from '@/components/WorkspaceTrashRestoreModal';
import { WorkspaceUtilityOverlays } from '@/components/WorkspaceUtilityOverlays';
import type { OfficeDocumentKind } from '@/lib/files-api/create-office';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { Capability, FileItem, ResourceRole } from '@/types/files';

export interface WorkspaceOverlaysProps {
  inspector: ComponentProps<typeof WorkspaceInspectorOverlay>;
  utility: ComponentProps<typeof WorkspaceUtilityOverlays>;
  actions: ComponentProps<typeof WorkspaceActionOverlays>;
  clipboardBar: ComponentProps<typeof WorkspaceClipboardBar> | null;
  trashBulkDialogs: ComponentProps<typeof WorkspaceTrashBulkDialogs>;
  trashRestoreModal: ComponentProps<typeof WorkspaceTrashRestoreModal> | null;
  managementModals: ComponentProps<typeof WorkspaceManagementModals>;
  versionHistory: {
    file: VersionHistoryTarget;
    effectiveRole: ResourceRole;
    capabilities: Capability[] | undefined;
    canDownload: boolean;
    returnFocus: HTMLElement | null;
    onClose: () => void;
  } | null;
  toastStack: ComponentProps<typeof WorkspaceToastStack>;
  createOffice: {
    kind: OfficeDocumentKind | null;
    folderId: string | null;
    onClose: () => void;
  };
  syncStore: WorkspaceSyncStore;
}

/**
 * Renders the workspace overlay, drawer, modal, clipboard bar, and toast stack.
 */
export function WorkspaceOverlays({
  inspector,
  utility,
  actions,
  clipboardBar,
  trashBulkDialogs,
  trashRestoreModal,
  managementModals,
  versionHistory,
  toastStack,
  createOffice,
  syncStore,
}: WorkspaceOverlaysProps) {
  return (
    <>
      <WorkspaceInspectorOverlay {...inspector} />
      <WorkspaceUtilityOverlays {...utility} />
      <WorkspaceActionOverlays {...actions} />

      {clipboardBar && <WorkspaceClipboardBar {...clipboardBar} />}

      <WorkspaceTrashBulkDialogs {...trashBulkDialogs} />

      {trashRestoreModal && <WorkspaceTrashRestoreModal {...trashRestoreModal} />}

      <WorkspaceManagementModals {...managementModals} />

      {versionHistory && (
        <VersionHistoryModal
          file={versionHistory.file}
          effectiveRole={versionHistory.effectiveRole}
          capabilities={versionHistory.capabilities}
          canDownload={versionHistory.canDownload}
          returnFocus={versionHistory.returnFocus}
          onFileUpdated={(file) => syncStore.upsertFileInCache(file)}
          onRestored={(result) => {
            const nextLabel = result.version
              ? `v${result.version.versionNum}`
              : result.file?.current_version_num
                ? `v${result.file.current_version_num}`
                : '新しいバージョン';
            syncStore.pushToast(
              {
                kind: 'info',
                message: `v${result.restoredFromVersionNum} を復元しました。${nextLabel} として現在版を更新しました。`,
              },
              10_000
            );
          }}
          onClose={versionHistory.onClose}
        />
      )}

      <WorkspaceToastStack {...toastStack} />

      <CreateOfficeDocModal
        kind={createOffice.kind}
        folderId={createOffice.folderId}
        syncStore={syncStore}
        onClose={createOffice.onClose}
      />
    </>
  );
}
