import {
  hasRoleAtLeast,
  pickStricterClassification,
} from '@/lib/formatters';
import type { ClassificationLabel, ResourceRole } from '@/types/files';

export const DRAG_THRESHOLD_PX = 6;
export const SPRING_PREFETCH_DELAY_MS = 100;
export const SPRING_OPEN_DELAY_MS = 650;
export const EDGE_SCROLL_ZONE_PX = 48;
export const EDGE_SCROLL_MAX_STEP_PX = 16;

export const ROOT_DROP_ID = '__ROOT__';

export interface DragWorkspaceItem {
  type: 'file' | 'folder';
  id: string;
  name: string;
  parentId: string | null;
  classification: ClassificationLabel;
  effectiveRole?: ResourceRole;
}

export interface DropTargetEvaluation {
  allowed: boolean;
  reason?: string;
  promotesToConfidential: boolean;
}

export interface EvaluateDropTargetInput {
  dragItems: readonly DragWorkspaceItem[];
  targetFolderId: string | null;
  targetClassification: ClassificationLabel;
  targetAncestorClassifications?: ClassificationLabel[];
  targetEffectiveRole?: ResourceRole;
  isSysAdmin?: boolean;
  isAncestorOf: (ancestorId: string, candidateId: string | null) => boolean;
  resolveItemRole: (item: DragWorkspaceItem) => ResourceRole;
}

/**
 * Pure 0ms drop-eligibility & DLP-escalation evaluator used while hovering
 * over rows, breadcrumbs, pinned cards, and sidebar tree items.
 */
export function evaluateDropTarget(
  input: EvaluateDropTargetInput
): DropTargetEvaluation {
  const {
    dragItems,
    targetFolderId,
    targetClassification,
    targetAncestorClassifications = [],
    targetEffectiveRole = 'editor',
    isSysAdmin = false,
    isAncestorOf,
    resolveItemRole,
  } = input;

  if (dragItems.length === 0) {
    return { allowed: false, promotesToConfidential: false };
  }

  // Filter items that would actually change directories
  const movingItems = dragItems.filter((item) => item.parentId !== targetFolderId);
  if (movingItems.length === 0) {
    return {
      allowed: false,
      reason: '同じフォルダ内には移動できません',
      promotesToConfidential: false,
    };
  }

  // Destination folder write check (root promotions checked per-folder below)
  if (targetFolderId !== null && !isSysAdmin && !hasRoleAtLeast(targetEffectiveRole, 'editor')) {
    return {
      allowed: false,
      reason: '移動先フォルダへの書き込み権限 (Editor 以上) がありません',
      promotesToConfidential: false,
    };
  }

  for (const item of movingItems) {
    if (item.type === 'folder') {
      if (item.id === targetFolderId || isAncestorOf(item.id, targetFolderId)) {
        return {
          allowed: false,
          reason: '自分自身または配下のフォルダには移動できません',
          promotesToConfidential: false,
        };
      }
      const role = resolveItemRole(item);
      if (!isSysAdmin && !hasRoleAtLeast(role, 'editor')) {
        return {
          allowed: false,
          reason: '移動には Editor 以上の権限が必要です',
          promotesToConfidential: false,
        };
      }
      if (targetFolderId === null && item.parentId !== null) {
        if (!isSysAdmin && !hasRoleAtLeast(role, 'owner')) {
          return {
            allowed: false,
            reason: 'ルートへ移動するには Owner 権限が必要です',
            promotesToConfidential: false,
          };
        }
      }
    } else {
      if (targetFolderId === null) {
        return {
          allowed: false,
          reason: 'ファイルはルート直下へ移動できません（フォルダを選択してください）',
          promotesToConfidential: false,
        };
      }
      const role = resolveItemRole(item);
      if (!isSysAdmin && !hasRoleAtLeast(role, 'editor')) {
        return {
          allowed: false,
          reason: '移動には Editor 以上の権限が必要です',
          promotesToConfidential: false,
        };
      }
    }
  }

  let effectiveTargetFloor: ClassificationLabel = targetClassification;
  for (const label of targetAncestorClassifications) {
    effectiveTargetFloor = pickStricterClassification(effectiveTargetFloor, label);
  }

  const promotesToConfidential =
    targetFolderId !== null &&
    effectiveTargetFloor === 'confidential' &&
    movingItems.some((item) => item.classification !== 'confidential');

  return {
    allowed: true,
    promotesToConfidential,
  };
}

/**
 * Compute smooth vertical edge auto-scroll delta (px/frame) when pointer nears
 * the top or bottom 48px band of the virtualized list viewport.
 */
export function computeEdgeAutoScrollDelta(
  pointerY: number,
  rect: { top: number; bottom: number; left: number; right: number },
  pointerX?: number
): number {
  if (
    pointerX !== undefined &&
    (pointerX < rect.left || pointerX > rect.right)
  ) {
    return 0;
  }
  const height = rect.bottom - rect.top;
  if (height <= EDGE_SCROLL_ZONE_PX * 2) return 0;

  const topDist = pointerY - rect.top;
  if (topDist >= 0 && topDist < EDGE_SCROLL_ZONE_PX) {
    const ratio = (EDGE_SCROLL_ZONE_PX - topDist) / EDGE_SCROLL_ZONE_PX;
    return -Math.max(2, Math.round(ratio * EDGE_SCROLL_MAX_STEP_PX));
  }

  const bottomDist = rect.bottom - pointerY;
  if (bottomDist >= 0 && bottomDist < EDGE_SCROLL_ZONE_PX) {
    const ratio = (EDGE_SCROLL_ZONE_PX - bottomDist) / EDGE_SCROLL_ZONE_PX;
    return Math.max(2, Math.round(ratio * EDGE_SCROLL_MAX_STEP_PX));
  }

  return 0;
}

/**
 * Strict OS Drag & Drop upload guard so internal Pointer DnD never triggers
 * `FileDropzoneUploader` highlights or file ingestion.
 */
export function hasOsFilesDataTransfer(
  dataTransfer: Pick<DataTransfer, 'types' | 'files'> | null | undefined,
  internalDragActive = false
): boolean {
  if (internalDragActive || !dataTransfer) return false;
  const types = Array.from(dataTransfer.types ?? []);
  return types.includes('Files');
}

export function encodeDropFolderId(folderId: string | null): string {
  return folderId ?? ROOT_DROP_ID;
}

export function decodeDropFolderId(raw: string | null | undefined): string | null | undefined {
  if (!raw) return undefined;
  return raw === ROOT_DROP_ID ? null : raw;
}
