import {
  type DragWorkspaceItem,
  type DropTargetEvaluation,
} from '@/lib/drag-drop-controller';
import { canAccess, isAdvancedResourceRole } from '@/lib/capabilities';
import { pickStricterClassification } from '@/lib/formatters';
import { selectKeyRange, toggleKeySelection } from '@/lib/keyboard-shortcuts';
import { isWopiEditableFile } from '@/lib/wopi';
import type {
  Capability,
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export const RECENT_DESTINATIONS_STORAGE_KEY = 'files.workspace.recent-dests.v1';
const MAX_RECENT_DESTINATIONS = 5;

export interface RecentDestinationEntry {
  id: string | null;
  name: string;
  classification: ClassificationLabel;
  usedAt: number;
}

export interface EvaluateCopyTargetInput {
  items: readonly DragWorkspaceItem[];
  targetFolderId: string | null;
  targetClassification: ClassificationLabel;
  targetAncestorClassifications?: ClassificationLabel[];
  targetEffectiveRole?: ResourceRole;
  targetCapabilities?: Capability[];
  isSysAdmin?: boolean;
  isAncestorOf: (ancestorId: string, candidateId: string | null) => boolean;
  resolveItemRole: (item: DragWorkspaceItem) => ResourceRole;
  resolveItemCapabilities?: (item: DragWorkspaceItem) => Capability[] | undefined;
}

/**
 * Pure 0ms CoW Copy eligibility check enforcing Zero-Trust DLP (`previewer` block),
 * anti-cycle guard, destination `editor+` permission, and `confidential` escalation notice.
 */
export function evaluateCopyDestination(
  input: EvaluateCopyTargetInput
): DropTargetEvaluation {
  const {
    items,
    targetFolderId,
    targetClassification,
    targetAncestorClassifications = [],
    targetEffectiveRole = 'editor',
    targetCapabilities,
    isSysAdmin = false,
    isAncestorOf,
    resolveItemRole,
    resolveItemCapabilities,
  } = input;

  if (items.length === 0) {
    return { allowed: false, promotesToConfidential: false };
  }

  const itemAccess = (item: DragWorkspaceItem) => ({
    capabilities: resolveItemCapabilities?.(item) ?? item.capabilities,
    effectiveRole: resolveItemRole(item),
  });
  const targetAccess = {
    capabilities: targetCapabilities,
    effectiveRole: targetEffectiveRole,
  };

  for (const item of items) {
    if (!isSysAdmin && !canAccess(itemAccess(item), 'item.download')) {
      return {
        allowed: false,
        reason: 'Previewer 権限のアイテムはコピーできません (DLP 保護)',
        promotesToConfidential: false,
      };
    }

    if (item.type === 'file' && targetFolderId === null) {
      return {
        allowed: false,
        reason: 'ファイルはルート直下へコピーできません（フォルダを選択してください）',
        promotesToConfidential: false,
      };
    }

    if (item.type === 'folder') {
      if (item.id === targetFolderId || isAncestorOf(item.id, targetFolderId)) {
        return {
          allowed: false,
          reason: '自分自身または配下のフォルダへはコピーできません',
          promotesToConfidential: false,
        };
      }
    }
  }

  if (
    targetFolderId !== null &&
    !isSysAdmin &&
    !canAccess(targetAccess, 'item.upload_new')
  ) {
    return {
      allowed: false,
      reason: 'コピー先フォルダへの書き込み権限 (Editor 以上) がありません',
      promotesToConfidential: false,
    };
  }

  let effectiveFloor: ClassificationLabel = targetClassification;
  for (const label of targetAncestorClassifications) {
    effectiveFloor = pickStricterClassification(effectiveFloor, label);
  }

  const promotesToConfidential =
    targetFolderId !== null &&
    effectiveFloor === 'confidential' &&
    items.some((item) => item.classification !== 'confidential');

  return {
    allowed: true,
    promotesToConfidential,
  };
}

/**
 * Clamps context menu popover coordinates inside viewport edges to prevent clipping.
 */
export function clampPopoverPosition(
  anchorX: number,
  anchorY: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 8
): { left: number; top: number } {
  const maxLeft = Math.max(padding, viewportWidth - menuWidth - padding);
  const maxTop = Math.max(padding, viewportHeight - menuHeight - padding);
  return {
    left: Math.min(Math.max(padding, anchorX), maxLeft),
    top: Math.min(Math.max(padding, anchorY), maxTop),
  };
}

export type ContextRowTarget =
  | { kind: 'folder'; folder: FolderSummary }
  | { kind: 'file'; file: FileItem };

export function rowToKey(row: ContextRowTarget): string {
  return row.kind === 'folder' ? `folder:${row.folder.id}` : `file:${row.file.id}`;
}

/**
 * Resolves effective action targets: if the right-clicked / focused row is already
 * in multi-selection, operates on the whole selection; otherwise focuses only that row.
 */
export function resolveTargetRows(
  primaryRow: ContextRowTarget | null,
  selectedRows: readonly ContextRowTarget[]
): ContextRowTarget[] {
  if (!primaryRow) {
    return [...selectedRows];
  }
  const primaryKey = rowToKey(primaryRow);
  const isPartOfSelection = selectedRows.some((r) => rowToKey(r) === primaryKey);
  if (isPartOfSelection && selectedRows.length > 0) {
    return [...selectedRows];
  }
  return [primaryRow];
}

export interface PointerSelectionModifiers {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/**
 * Google Drive-compatible pointer selection:
 * plain click replaces, ⌘/Ctrl+click toggles, Shift+click extends from the anchor.
 */
export function resolvePointerSelection(input: {
  orderedKeys: readonly string[];
  selectedKeys: ReadonlySet<string>;
  anchorKey: string | null;
  rowKey: string;
  modifiers: PointerSelectionModifiers;
}): { selectedKeys: Set<string>; anchorKey: string } {
  const { orderedKeys, selectedKeys, anchorKey, rowKey, modifiers } = input;
  if (modifiers.shiftKey) {
    return {
      selectedKeys: selectKeyRange(orderedKeys, anchorKey ?? rowKey, rowKey),
      anchorKey: anchorKey ?? rowKey,
    };
  }
  if (modifiers.metaKey || modifiers.ctrlKey) {
    return {
      selectedKeys: toggleKeySelection(selectedKeys, rowKey),
      anchorKey: rowKey,
    };
  }
  return { selectedKeys: new Set([rowKey]), anchorKey: rowKey };
}

/**
 * Right-click normalization: an unselected row becomes the sole selection before
 * the context menu opens, so the menu target and the highlight always agree.
 */
export function resolveContextSelection(
  selectedKeys: ReadonlySet<string>,
  rowKey: string
): { selectedKeys: Set<string>; anchorKey: string | null; changed: boolean } {
  if (selectedKeys.has(rowKey)) {
    return { selectedKeys: new Set(selectedKeys), anchorKey: null, changed: false };
  }
  return { selectedKeys: new Set([rowKey]), anchorKey: rowKey, changed: true };
}

export interface ContextMenuCapabilities {
  isMulti: boolean;
  canOpen: boolean;
  canWopiOpen: boolean;
  canDownload: boolean;
  canRename: boolean;
  canCopy: boolean;
  canCut: boolean;
  canPaste: boolean;
  canDuplicate: boolean;
  canMoveCopy: boolean;
  canClassify: boolean;
  canShare: boolean;
  canCopyLink: boolean;
  canPin: boolean;
  canPermissions: boolean;
  canTrash: boolean;
  canInspector: boolean;
  /** Single file, previewer+ (version list reads are previewer-gated). */
  canVersionHistory: boolean;
}

export function buildContextMenuCapabilities(options: {
  targets: readonly ContextRowTarget[];
  primaryRow: ContextRowTarget | null;
  currentFolderId: string | null;
  folderRole: ResourceRole;
  folderCapabilities?: Capability[];
  isPrivilegedAdmin: boolean;
  isSysAdmin: boolean;
  hasClipboardItems: boolean;
  clipboardHasFiles: boolean;
  resolveRowRole: (row: ContextRowTarget) => ResourceRole;
  resolveRowCapabilities?: (row: ContextRowTarget) => Capability[] | undefined;
}): ContextMenuCapabilities {
  const {
    targets,
    primaryRow,
    currentFolderId,
    folderRole,
    folderCapabilities,
    isPrivilegedAdmin,
    isSysAdmin,
    hasClipboardItems,
    clipboardHasFiles,
    resolveRowRole,
    resolveRowCapabilities,
  } = options;

  const isMulti = targets.length > 1;
  const rowAccess = (row: ContextRowTarget) => ({
    capabilities:
      resolveRowCapabilities?.(row) ??
      (row.kind === 'folder' ? row.folder.capabilities : row.file.capabilities) ??
      (row.kind === 'file' ? folderCapabilities : undefined),
    effectiveRole:
      row.kind === 'folder'
        ? row.folder.effectiveRole ?? resolveRowRole(row)
        : resolveRowRole(row),
  });
  const currentAccess = {
    capabilities: folderCapabilities,
    effectiveRole: folderRole,
  };

  const targetCaps = (capability: Capability) =>
    targets.length > 0 &&
    targets.every((target) => canAccess(rowAccess(target), capability));
  const targetCapsByKind = (
    folderCapability: Capability,
    fileCapability: Capability
  ) =>
    targets.length > 0 &&
    targets.every((target) =>
      canAccess(
        rowAccess(target),
        target.kind === 'folder' ? folderCapability : fileCapability
      )
    );

  const primaryIsFolder = primaryRow?.kind === 'folder';
  const primaryIsFile = primaryRow?.kind === 'file';
  const primaryAccess = primaryRow
    ? rowAccess(primaryRow)
    : currentAccess;
  const hasPrimary = Boolean(primaryRow);

  const pasteTarget = !isMulti && primaryIsFolder ? primaryRow : null;
  const pasteDestAccess = pasteTarget
    ? rowAccess(pasteTarget)
    : currentAccess;
  const pasteDestIsRoot = !isMulti && primaryIsFolder ? false : currentFolderId === null;
  const canWritePasteDest = isSysAdmin || canAccess(pasteDestAccess, 'item.upload_new');
  const canPaste =
    hasClipboardItems &&
    canWritePasteDest &&
    !(pasteDestIsRoot && clipboardHasFiles);

  const hasAnyFile = targets.some((t) => t.kind === 'file');

  return {
    isMulti,
    canOpen:
      !isMulti &&
      hasPrimary &&
      (primaryIsFolder
        ? canAccess(primaryAccess, 'folder.list')
        : canAccess(primaryAccess, 'item.preview')),
    canWopiOpen:
      !isMulti &&
      primaryRow?.kind === 'file' &&
      isWopiEditableFile(primaryRow.file) &&
      (isSysAdmin || canAccess(primaryAccess, 'item.preview')),
    canDownload:
      !isMulti &&
      primaryIsFile &&
      (isSysAdmin || canAccess(primaryAccess, 'item.download')),
    canRename:
      !isMulti &&
      hasPrimary &&
      (isSysAdmin ||
        canAccess(
          primaryAccess,
          primaryIsFolder ? 'folder.rename' : 'item.rename'
        )),
    canCopy: targetCaps('item.download'),
    canCut: targetCapsByKind('folder.move', 'item.move'),
    canPaste,
    canDuplicate:
      targets.length > 0 &&
      (isSysAdmin ||
        (targetCaps('item.download') &&
          canAccess(pasteDestAccess, 'item.upload_new'))),
    canMoveCopy:
      targets.length > 0 &&
      (targetCapsByKind('folder.move', 'item.move') ||
        targetCaps('item.download')),
    canClassify:
      hasAnyFile &&
      (isPrivilegedAdmin ||
        targets.every(
          (target) =>
            target.kind === 'file' &&
            canAccess(rowAccess(target), 'classification.edit')
        )),
    canShare:
      !isMulti &&
      hasPrimary &&
      (isSysAdmin || canAccess(primaryAccess, 'share_link.create')),
    canCopyLink:
      !isMulti &&
      hasPrimary &&
      (isSysAdmin ||
        (!isAdvancedResourceRole(primaryAccess.effectiveRole) &&
          canAccess(primaryAccess, 'item.preview'))),
    canPin:
      !isMulti &&
      primaryIsFolder &&
      (isSysAdmin || canAccess(primaryAccess, 'folder.rename')),
    canPermissions:
      !isMulti &&
      hasPrimary &&
      (isSysAdmin || canAccess(primaryAccess, 'permission.manage')),
    canTrash:
      targets.length > 0 &&
      targets.every((target) =>
        target.kind === 'folder'
          ? isSysAdmin || canAccess(rowAccess(target), 'folder.delete')
          : isSysAdmin || canAccess(rowAccess(target), 'item.delete')
      ),
    canInspector:
      !isMulti &&
      hasPrimary &&
      (isSysAdmin || canAccess(primaryAccess, 'item.preview')),
    canVersionHistory:
      !isMulti &&
      primaryIsFile &&
      (isSysAdmin || canAccess(primaryAccess, 'item.preview')),
  };
}

function makeRecentDestStorageKey(tenantId: string, userId: string): string {
  return `${RECENT_DESTINATIONS_STORAGE_KEY}:${tenantId}:${userId}`;
}

export function loadRecentDestinations(
  tenantId: string,
  userId: string
): RecentDestinationEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(makeRecentDestStorageKey(tenantId, userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is RecentDestinationEntry =>
        typeof item === 'object' &&
        item !== null &&
        (item.id === null || typeof item.id === 'string') &&
        typeof item.name === 'string' &&
        typeof item.usedAt === 'number'
    );
  } catch {
    return [];
  }
}

export function recordRecentDestination(
  tenantId: string,
  userId: string,
  dest: Omit<RecentDestinationEntry, 'usedAt'>
): RecentDestinationEntry[] {
  const existing = loadRecentDestinations(tenantId, userId);
  const filtered = existing.filter((entry) => entry.id !== dest.id);
  const next: RecentDestinationEntry[] = [
    { ...dest, usedAt: Date.now() },
    ...filtered,
  ].slice(0, MAX_RECENT_DESTINATIONS);

  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        makeRecentDestStorageKey(tenantId, userId),
        JSON.stringify(next)
      );
    } catch {
      // ignore storage errors
    }
  }
  return next;
}
