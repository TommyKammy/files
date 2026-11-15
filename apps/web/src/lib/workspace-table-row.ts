import type { FileItem, FolderSummary } from '@/types/files';

export type WorkspaceTableRow =
  | { kind: 'folder'; folder: FolderSummary }
  | { kind: 'file'; file: FileItem };

export type InlineRenameState = {
  rowKey: string;
  kind: 'folder' | 'file';
  id: string;
  originalName: string;
  value: string;
};

export function getWorkspaceRowKey(row: WorkspaceTableRow): string {
  return row.kind === 'folder'
    ? `folder:${row.folder.id}`
    : `file:${row.file.id}`;
}

export function isRowSelectable(row: WorkspaceTableRow): boolean {
  if (row.kind === 'folder') return true;
  return row.file.upload_state !== 'pending' && !row.file.optimistic;
}

/**
 * Rows/cards are full click targets (Google Drive parity), but inner controls such as
 * action icons, checkboxes, menus, and rename inputs must not trigger row selection.
 * The row name button is deliberately allowed so clicking the name selects the row.
 */
export function isRowControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-row-name-trigger="true"]')) return false;
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [role="menu"], [role="checkbox"], [data-workspace-row-trigger="true"]'
    )
  );
}
