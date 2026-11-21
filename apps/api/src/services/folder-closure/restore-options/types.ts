import type { RestoreDestinationContext, AdminRestoreDelegation } from '../../trash-restore-context';
import type { FolderRow } from '../shared';

export interface FolderRestoreOptions {
  conflictPolicy?: 'fail' | 'rename';
  /**
   * `undefined` keeps the folder's original parent. `null` explicitly restores
   * into the workspace root. A different id performs a subtree move.
   */
  targetParentId?: string | null;
  /** Restore deleted ancestors (row-only) before restoring this folder. */
  restoreParentChain?: boolean;
  /** Tenant admin restoring for the owner; bypasses folder ACL checks. */
  adminDelegation?: AdminRestoreDelegation;
}

export interface RestoreFolderWithOptionsResult {
  folder: FolderRow;
  restoredAt: string;
  syncSeq: number | null;
  destination: RestoreDestinationContext;
  restoredAncestorIds: string[];
  affectedFolderIds: Array<string | null>;
  scopeFolderIds: Array<string | null>;
}
