'use client';

import { useCallback, useMemo, useState } from 'react';
import { canAccess } from '@/lib/capabilities';
import {
  ApiClientError,
  downloadWorkspaceZip,
  triggerBlobDownload,
} from '@/lib/files-api';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type { Capability, ResourceRole } from '@/types/files';

/**
 * Manages multi-selection ZIP download capability and download execution.
 */
export function useWorkspaceZipDownload({
  selectedRows,
  directoryCapabilities,
  resolveRowRole,
  collectRowCapabilities,
  setError,
}: {
  selectedRows: WorkspaceTableRow[];
  directoryCapabilities: Capability[] | undefined;
  resolveRowRole: (row: WorkspaceTableRow) => ResourceRole;
  collectRowCapabilities: (
    row: WorkspaceTableRow,
    folderCapabilities: Capability[] | undefined
  ) => Capability[] | undefined;
  setError: (error: string | null) => void;
}) {
  const [downloadingZip, setDownloadingZip] = useState(false);

  const canDownloadSelection = useMemo(
    () =>
      selectedRows.length > 0 &&
      selectedRows.every((row) =>
        canAccess(
          {
            capabilities: collectRowCapabilities(row, directoryCapabilities),
            effectiveRole: resolveRowRole(row),
          },
          'item.download'
        )
      ),
    [selectedRows, directoryCapabilities, resolveRowRole, collectRowCapabilities]
  );

  const handleDownloadZip = useCallback(async () => {
    if (downloadingZip || selectedRows.length === 0 || !canDownloadSelection) {
      return;
    }
    setDownloadingZip(true);
    setError(null);
    try {
      const { blob, filename } = await downloadWorkspaceZip({
        items: selectedRows.map((row) => ({
          type: row.kind,
          id: row.kind === 'folder' ? row.folder.id : row.file.id,
        })),
      });
      triggerBlobDownload(blob, filename);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ZIPダウンロードに失敗しました'
      );
    } finally {
      setDownloadingZip(false);
    }
  }, [downloadingZip, selectedRows, canDownloadSelection, setError]);

  return {
    downloadingZip,
    canDownloadSelection,
    handleDownloadZip,
  };
}
