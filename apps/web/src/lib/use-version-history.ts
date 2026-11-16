'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { FileItem } from '@/types/files';
import {
  VersionHistoryController,
  type VersionHistoryControllerState,
  type VersionHistoryRestoreSuccess,
  type VersionRestoreOutcome,
} from '@/lib/version-history-controller';
import type { VersionHistoryPreviewState } from '@/lib/version-history-controller';

export function useVersionHistory({
  fileId,
  initialCurrentVersionNum,
  initialMetaVersion,
  pageSize,
  onFileUpdated,
  onRestored,
}: {
  fileId: string;
  initialCurrentVersionNum: number;
  initialMetaVersion: number;
  pageSize?: number;
  onFileUpdated?: (file: FileItem) => void;
  onRestored?: (result: VersionHistoryRestoreSuccess) => void;
}): VersionHistoryControllerState & {
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
  restore: (
    version: Parameters<VersionHistoryController['restore']>[0]
  ) => Promise<VersionRestoreOutcome>;
  preparePreview: (
    version: Parameters<VersionHistoryController['preparePreview']>[0]
  ) => Promise<VersionHistoryPreviewState | null>;
  closePreview: () => void;
  download: (
    version: Parameters<VersionHistoryController['download']>[0]
  ) => Promise<void>;
  clearRestoreError: () => void;
} {
  // Callbacks are kept in a ref so a parent re-render cannot rebuild the
  // controller (and therefore page back to v1) mid-flight.
  const callbacksRef = useRef({ onFileUpdated, onRestored });
  useEffect(() => {
    callbacksRef.current = { onFileUpdated, onRestored };
  }, [onFileUpdated, onRestored]);

  const controller = useMemo(
    () =>
      new VersionHistoryController({
        fileId,
        initialCurrentVersionNum,
        initialMetaVersion,
        pageSize,
        onFileUpdated: (file) =>
          callbacksRef.current.onFileUpdated?.(file),
        onRestored: (result) =>
          callbacksRef.current.onRestored?.(result),
      }),
    // Initial values are mount-time seeds; the controller owns the live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileId, pageSize]
  );

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState
  );

  useEffect(() => {
    void controller.loadInitial();
    return () => controller.cancel();
  }, [controller]);

  return {
    ...state,
    loadMore: () => controller.loadMore(),
    reload: () => controller.reload(),
    restore: (version) => controller.restore(version),
    preparePreview: (version) => controller.preparePreview(version),
    closePreview: () => controller.closePreview(),
    download: (version) => controller.download(version),
    clearRestoreError: () => controller.clearRestoreError(),
  };
}
