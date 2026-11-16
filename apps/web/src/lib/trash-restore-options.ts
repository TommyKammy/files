import {
  hasRoleAtLeast,
  pickStricterClassification,
} from '@/lib/formatters';
import type {
  ClassificationLabel,
  ResourceRole,
  RestoreDestinationContext,
  TrashRestoreConflict,
  TrashRestoreContextResponse,
} from '@/types/files';

const CLASSIFICATION_SEVERITY: Record<ClassificationLabel, number> = {
  confidential: 3,
  internal: 2,
  public: 1,
  unset: 0,
};

function isStricter(
  candidate: ClassificationLabel,
  baseline: ClassificationLabel
): boolean {
  return CLASSIFICATION_SEVERITY[candidate] > CLASSIFICATION_SEVERITY[baseline];
}

export type TrashRestoreMode = 'original' | 'custom';
export type TrashRestoreConflictPolicy = 'fail' | 'rename';

export interface TrashRestoreDialogState {
  mode: TrashRestoreMode;
  targetId: string | null;
  targetName: string;
  targetPath: string;
  targetBreadcrumbs: RestoreDestinationContext['breadcrumbs'];
  targetClassification: ClassificationLabel;
  targetIsDeleted: boolean;
  targetDeletedAncestorCount: number;
  targetAccessible: boolean;
  restoreParentChainAvailable: boolean;
  restoreParentChain: boolean;
  conflictPolicy: TrashRestoreConflictPolicy;
  conflict: TrashRestoreConflict;
  willUpgradeClassification: boolean;
  upgradeCount: number;
  circular: boolean;
  maxDepthExceeded: boolean;
  error: string | null;
  errorCode: string | null;
}

export interface TrashRestoreDestinationEvaluation {
  allowed: boolean;
  reason?: string;
  circular: boolean;
}

function destinationFields(destination: RestoreDestinationContext) {
  return {
    targetId: destination.id,
    targetName: destination.name,
    targetPath: destination.path,
    targetBreadcrumbs: destination.breadcrumbs,
    targetClassification: destination.classification,
    targetIsDeleted: destination.isDeleted,
    targetDeletedAncestorCount: destination.deletedAncestorCount,
    targetAccessible: destination.accessible,
  };
}

/** Safe defaults for the confirmation dialog: original location + parent chain. */
export function buildInitialTrashRestoreDialogState(
  context: TrashRestoreContextResponse
): TrashRestoreDialogState {
  return {
    mode: 'original',
    ...destinationFields(context.originalLocation),
    restoreParentChainAvailable: context.restoreParentChainAvailable,
    // The API guarantees this is true when any ancestor is deleted.
    restoreParentChain:
      context.restoreParentChainAvailable &&
      context.restoreParentChainDefault,
    conflictPolicy: 'fail',
    conflict: context.conflict,
    willUpgradeClassification: context.classification.willUpgrade,
    upgradeCount: context.classification.upgradeCount,
    circular: false,
    maxDepthExceeded: false,
    error: null,
    errorCode: null,
  };
}

/** Return to “restore to original location” without losing conflict policy. */
export function selectOriginalTrashRestoreDestination(
  state: TrashRestoreDialogState,
  context: TrashRestoreContextResponse
): TrashRestoreDialogState {
  return {
    ...state,
    mode: 'original',
    ...destinationFields(context.originalLocation),
    restoreParentChain:
      context.restoreParentChainAvailable &&
      context.restoreParentChainDefault,
    conflict: context.conflict,
    willUpgradeClassification: context.classification.willUpgrade,
    upgradeCount: context.classification.upgradeCount,
    circular: false,
    maxDepthExceeded: false,
    error: null,
    errorCode: null,
  };
}

/** Switch to a chosen destination row. Parent-chain restore only applies to
 * the original location, so it is always disabled in custom mode. */
export function selectTrashRestoreDestination(
  state: TrashRestoreDialogState,
  context: TrashRestoreContextResponse,
  destination: RestoreDestinationContext
): TrashRestoreDialogState {
  const contextMatches = context.destination.id === destination.id;
  return {
    ...state,
    mode: 'custom',
    ...destinationFields(destination),
    restoreParentChain: false,
    conflict: contextMatches ? context.conflict : { hasConflict: false, suggestedName: null },
    willUpgradeClassification: contextMatches
      ? context.classification.willUpgrade
      : isStricter(destination.classification, context.item.classification),
    upgradeCount: contextMatches ? context.classification.upgradeCount : 0,
    circular: contextMatches ? context.destinationChecks.circular : false,
    maxDepthExceeded: contextMatches
      ? context.destinationChecks.maxDepthExceeded
      : false,
    error: null,
    errorCode: null,
  };
}

/** Merge a freshly fetched destination context (409 recovery / re-selection). */
export function applyTrashRestoreContext(
  state: TrashRestoreDialogState,
  context: TrashRestoreContextResponse
): TrashRestoreDialogState {
  if (state.mode === 'original') {
    return {
      ...state,
      ...destinationFields(context.originalLocation),
      restoreParentChainAvailable: context.restoreParentChainAvailable,
      conflict: context.conflict,
      willUpgradeClassification: context.classification.willUpgrade,
      upgradeCount: context.classification.upgradeCount,
    };
  }
  if (context.destination.id !== state.targetId) return state;
  return {
    ...state,
    ...destinationFields(context.destination),
    conflict: context.conflict,
    willUpgradeClassification: context.classification.willUpgrade,
    upgradeCount: context.classification.upgradeCount,
    circular: context.destinationChecks.circular,
    maxDepthExceeded: context.destinationChecks.maxDepthExceeded,
  };
}

export function evaluateTrashRestoreDestination(input: {
  context: TrashRestoreContextResponse;
  targetId: string | null;
  targetEffectiveRole?: ResourceRole | null;
  itemEffectiveRole?: ResourceRole | null;
  isSysAdmin?: boolean;
  isDescendantOfItem?: boolean;
}): TrashRestoreDestinationEvaluation {
  const {
    context,
    targetId,
    targetEffectiveRole,
    itemEffectiveRole,
    isSysAdmin = false,
    isDescendantOfItem = false,
  } = input;

  if (
    targetId !== null &&
    context.type === 'folder' &&
    (targetId === context.item.id || isDescendantOfItem)
  ) {
    return {
      allowed: false,
      circular: true,
      reason: '自分自身または配下のフォルダへは復元できません',
    };
  }

  if (targetId === null) {
    if (
      context.type === 'folder' &&
      context.item.parentId !== null &&
      !hasRoleAtLeast(itemEffectiveRole, 'owner') &&
      !isSysAdmin
    ) {
      return {
        allowed: false,
        circular: false,
        reason: 'ルートへ復元するには Owner 権限が必要です',
      };
    }
    return { allowed: true, circular: false };
  }

  if (!isSysAdmin && !hasRoleAtLeast(targetEffectiveRole, 'editor')) {
    return {
      allowed: false,
      circular: false,
      reason: '復元先フォルダへの書き込み権限 (Editor 以上) がありません',
    };
  }

  return { allowed: true, circular: false };
}

export interface TrashRestoreErrorInput {
  status: number;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

function isRestoreDestinationContext(
  value: unknown
): value is RestoreDestinationContext {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RestoreDestinationContext>;
  return (
    (candidate.id === null || typeof candidate.id === 'string') &&
    typeof candidate.name === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.classification === 'string' &&
    typeof candidate.accessible === 'boolean'
  );
}

export interface TrashRestoreErrorTransition {
  state: TrashRestoreDialogState;
  canRetryWithRename: boolean;
  canRetryWithParentChain: boolean;
  canChooseAnotherDestination: boolean;
}

/**
 * Deterministic 409/403 recovery transition. The dialog stays open; the API's
 * destination/suggestedName payload is merged directly into the form state.
 */
export function applyTrashRestoreError(
  state: TrashRestoreDialogState,
  error: TrashRestoreErrorInput
): TrashRestoreErrorTransition {
  const details = error.details ?? {};
  const destination = isRestoreDestinationContext(details.destination)
    ? details.destination
    : null;
  const suggestedName =
    typeof details.suggestedName === 'string' ? details.suggestedName : null;

  let next: TrashRestoreDialogState = {
    ...state,
    error: error.message,
    errorCode: error.code ?? null,
  };

  if (destination) {
    next = {
      ...next,
      ...destinationFields(destination),
    };
  }

  const nameConflict = error.code === 'NAME_CONFLICT';
  const parentDeleted =
    error.code === 'PARENT_FOLDER_DELETED' || error.code === 'PARENT_IN_TRASH';

  if (nameConflict) {
    next = {
      ...next,
      conflict: {
        hasConflict: true,
        suggestedName: suggestedName ?? state.conflict.suggestedName,
      },
    };
  }
  if (parentDeleted) {
    next = {
      ...next,
      targetIsDeleted: true,
      targetDeletedAncestorCount: Math.max(
        1,
        next.targetDeletedAncestorCount
      ),
      restoreParentChainAvailable: true,
    };
  }

  return {
    state: next,
    canRetryWithRename: nameConflict && Boolean(next.conflict.suggestedName),
    canRetryWithParentChain: parentDeleted && next.mode === 'original',
    canChooseAnotherDestination: next.mode === 'original',
  };
}

export function isTrashRestoreParentToggleAvailable(
  state: TrashRestoreDialogState
): boolean {
  return state.mode === 'original' && state.targetIsDeleted;
}

export function canSubmitTrashRestore(
  state: TrashRestoreDialogState,
  options: { busy: boolean; loadingDestination: boolean }
): boolean {
  if (options.busy || options.loadingDestination) return false;
  if (!state.targetAccessible) return false;
  if (state.circular || state.maxDepthExceeded) return false;
  return true;
}

export function buildRestoreTargetPath(
  breadcrumbs: ReadonlyArray<{ name: string }>,
  fallbackName: string
): string {
  if (breadcrumbs.length === 0) return fallbackName;
  return breadcrumbs.map((crumb) => crumb.name).join(' / ');
}

export function formatTrashRestoreSuccessMessage(input: {
  itemName: string;
  destinationPath: string;
  restoredName?: string | null;
  restoredAncestorCount?: number;
}): string {
  const { itemName, destinationPath, restoredName, restoredAncestorCount } =
    input;
  const renamed =
    restoredName && restoredName.trim().length > 0 && restoredName !== itemName;
  let message = renamed
    ? `「${itemName}」を「${destinationPath}」へ「${restoredName}」として復元しました`
    : `「${itemName}」を「${destinationPath}」へ復元しました`;
  if (restoredAncestorCount && restoredAncestorCount > 0) {
    message += `（親フォルダ ${restoredAncestorCount} 件も復元）`;
  }
  return message;
}

/** Build a destination projection from the synced folder tree (0ms preview). */
export function buildDestinationFromCachedFolder(input: {
  folderId: string | null;
  folderName: string;
  classification: ClassificationLabel;
  breadcrumbs: ReadonlyArray<{
    id: string;
    name: string;
    classification: ClassificationLabel;
    depth: number;
    version?: number;
  }>;
}): RestoreDestinationContext {
  if (input.folderId === null) {
    return {
      id: null,
      name: 'マイファイル (ルート)',
      path: 'マイファイル (ルート)',
      breadcrumbs: [],
      classification: 'unset',
      isDeleted: false,
      deletedAncestorCount: 0,
      accessible: true,
    };
  }

  let floor: ClassificationLabel = 'unset';
  for (const crumb of input.breadcrumbs) {
    floor = pickStricterClassification(floor, crumb.classification);
  }
  floor = pickStricterClassification(floor, input.classification);

  const breadcrumbs = input.breadcrumbs.map((crumb) => ({
    id: crumb.id,
    name: crumb.name,
    classification: crumb.classification,
    depth: crumb.depth,
    version: crumb.version ?? 1,
  }));

  return {
    id: input.folderId,
    name: input.folderName,
    path: buildRestoreTargetPath(breadcrumbs, input.folderName),
    breadcrumbs,
    classification: floor,
    isDeleted: false,
    deletedAncestorCount: 0,
    accessible: true,
  };
}
