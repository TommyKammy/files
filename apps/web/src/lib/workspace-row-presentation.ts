import {
  getWorkspaceRowKey,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type {
  FileItem,
  FolderSummary,
  WorkspaceClipboardState,
} from '@/types/files';

export function describeWorkspaceRow({
  row,
  isTrashView,
  clipboardState,
  isCutPending,
}: {
  row: WorkspaceTableRow;
  isTrashView: boolean;
  clipboardState: WorkspaceClipboardState | null;
  isCutPending: (kind: 'file' | 'folder', id: string) => boolean;
}): {
  rowKey: string;
  file: FileItem | null;
  folder: FolderSummary | null;
  isPendingUpload: boolean;
  isCut: boolean;
  isDropEligible: boolean;
} {
  const rowKey = getWorkspaceRowKey(row);
  const file = row.kind === 'file' ? row.file : null;
  const folder = row.kind === 'folder' ? row.folder : null;
  const isPendingUpload = Boolean(
    file && (file.upload_state === 'pending' || file.optimistic)
  );
  const isCut = Boolean(
    clipboardState?.mode === 'cut' &&
      isCutPending(
        row.kind,
        row.kind === 'folder' ? row.folder.id : row.file.id
      )
  );
  const isDropEligible = Boolean(
    folder && !isTrashView && folder.deleted_at == null
  );

  return {
    rowKey,
    file,
    folder,
    isPendingUpload,
    isCut,
    isDropEligible,
  };
}
