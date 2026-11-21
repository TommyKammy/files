'use client';

import { FileText, Folder } from 'lucide-react';
import type { AdminTrashItem } from '@/types/files';

export const EMPTY_TENANT_TRASH_CONFIRMATION = 'EMPTY_TENANT_TRASH';

export interface RestoreFormOptions {
  target: 'original' | 'root';
  restoreParentChain: boolean;
  renameOnConflict: boolean;
}

export const DEFAULT_RESTORE_OPTIONS: RestoreFormOptions = {
  target: 'original',
  restoreParentChain: true,
  renameOnConflict: false,
};

export const FIELD_CLASS =
  'h-7 rounded-md border border-[#e1e1e4] bg-white px-2 text-[0.75rem] text-[#111214] focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]/40';

/** Renders a folder or file icon for an admin trash item. */
export function TrashIcon({ type }: { type: AdminTrashItem['type'] }) {
  return type === 'folder' ? (
    <Folder className="h-3.5 w-3.5 shrink-0 text-[#8a8c91]" aria-hidden="true" />
  ) : (
    <FileText className="h-3.5 w-3.5 shrink-0 text-[#8a8c91]" aria-hidden="true" />
  );
}
