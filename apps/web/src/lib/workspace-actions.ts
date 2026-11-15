import {
  type DragWorkspaceItem,
  type DropTargetEvaluation,
} from '@/lib/drag-drop-controller';
import {
  hasRoleAtLeast,
  pickStricterClassification,
} from '@/lib/formatters';
import type {
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
  isSysAdmin?: boolean;
  isAncestorOf: (ancestorId: string, candidateId: string | null) => boolean;
  resolveItemRole: (item: DragWorkspaceItem) => ResourceRole;
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
    isSysAdmin = false,
    isAncestorOf,
    resolveItemRole,
  } = input;

  if (items.length === 0) {
    return { allowed: false, promotesToConfidential: false };
  }

  for (const item of items) {
    const role = resolveItemRole(item);
    if (!isSysAdmin && !hasRoleAtLeast(role, 'viewer')) {
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
    !hasRoleAtLeast(targetEffectiveRole, 'editor')
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

export interface ContextMenuCapabilities {
  isMulti: boolean;
  canOpen: boolean;
  canDownload: boolean;
  canRename: boolean;
  canCopy: boolean;
  canCut: boolean;
  canPaste: boolean;
  canDuplicate: boolean;
  canMoveCopy: boolean;
  canClassify: boolean;
  canShare: boolean;
  canPin: boolean;
  canTrash: boolean;
  canInspector: boolean;
}

export function buildContextMenuCapabilities(options: {
  targets: readonly ContextRowTarget[];
  primaryRow: ContextRowTarget | null;
  currentFolderId: string | null;
  folderRole: ResourceRole;
  isPrivilegedAdmin: boolean;
  isSysAdmin: boolean;
  hasClipboardItems: boolean;
  clipboardHasFiles: boolean;
  resolveRowRole: (row: ContextRowTarget) => ResourceRole;
}): ContextMenuCapabilities {
  const {
    targets,
    primaryRow,
    currentFolderId,
    folderRole,
    isPrivilegedAdmin,
    isSysAdmin,
    hasClipboardItems,
    clipboardHasFiles,
    resolveRowRole,
  } = options;

  const isMulti = targets.length > 1;
  const targetRoles = targets.map(resolveRowRole);
  const allViewerPlus =
    targets.length > 0 &&
    (isSysAdmin || targetRoles.every((r) => hasRoleAtLeast(r, 'viewer')));
  const allEditorPlus =
    targets.length > 0 &&
    (isSysAdmin || targetRoles.every((r) => hasRoleAtLeast(r, 'editor')));

  const primaryIsFolder = primaryRow?.kind === 'folder';
  const primaryIsFile = primaryRow?.kind === 'file';
  const primaryRole = primaryRow ? resolveRowRole(primaryRow) : folderRole;

  const pasteDestRole =
    !isMulti && primaryIsFolder && primaryRow.kind === 'folder'
      ? primaryRole
      : folderRole;
  const pasteDestIsRoot = !isMulti && primaryIsFolder ? false : currentFolderId === null;
  const canWritePasteDest =
    isSysAdmin || hasRoleAtLeast(pasteDestRole, 'editor');
  const canPaste =
    hasClipboardItems &&
    canWritePasteDest &&
    !(pasteDestIsRoot && clipboardHasFiles);

  const canWriteCurrentOrParents =
    allEditorPlus && (currentFolderId === null || isSysAdmin || hasRoleAtLeast(folderRole, 'editor'));

  const hasAnyFile = targets.some((t) => t.kind === 'file');

  return {
    isMulti,
    canOpen: !isMulti && Boolean(primaryRow),
    canDownload:
      !isMulti &&
      primaryIsFile &&
      (isSysAdmin || hasRoleAtLeast(primaryRole, 'viewer')),
    canRename: !isMulti && Boolean(primaryRow) && (isSysAdmin || hasRoleAtLeast(primaryRole, 'editor')),
    canCopy: allViewerPlus,
    canCut: allEditorPlus,
    canPaste,
    canDuplicate:
      allViewerPlus &&
      (isSysAdmin ||
        targets.every((t) =>
          t.kind === 'folder' && currentFolderId === null
            ? hasRoleAtLeast(resolveRowRole(t), 'editor')
            : canWriteCurrentOrParents || hasRoleAtLeast(folderRole, 'editor')
        )),
    canMoveCopy: targets.length > 0 && (allViewerPlus || allEditorPlus),
    canClassify:
      hasAnyFile &&
      (isPrivilegedAdmin || hasRoleAtLeast(folderRole, 'editor')),
    canShare:
      !isMulti &&
      Boolean(primaryRow) &&
      (isSysAdmin || hasRoleAtLeast(primaryRole, 'editor')),
    canPin:
      !isMulti &&
      primaryIsFolder &&
      (isSysAdmin || hasRoleAtLeast(primaryRole, 'editor')),
    canTrash: allEditorPlus,
    canInspector: !isMulti && Boolean(primaryRow),
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
