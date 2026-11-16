import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTrashRestoreContext,
  applyTrashRestoreError,
  buildDestinationFromCachedFolder,
  buildInitialTrashRestoreDialogState,
  canSubmitTrashRestore,
  evaluateTrashRestoreDestination,
  formatTrashRestoreSuccessMessage,
  isTrashRestoreParentToggleAvailable,
  selectOriginalTrashRestoreDestination,
  selectTrashRestoreDestination,
  type TrashRestoreDialogState,
} from '@/lib/trash-restore-options';
import type {
  RestoreDestinationContext,
  TrashRestoreContextResponse,
} from '@/types/files';

function destination(
  overrides: Partial<RestoreDestinationContext> = {}
): RestoreDestinationContext {
  return {
    id: 'folder-dest',
    name: 'Destination',
    path: '全社共有 / Destination',
    breadcrumbs: [
      {
        id: 'root-general',
        name: '全社共有',
        classification: 'internal',
        depth: 0,
        version: 1,
      },
      {
        id: 'folder-dest',
        name: 'Destination',
        classification: 'internal',
        depth: 1,
        version: 1,
      },
    ],
    classification: 'internal',
    isDeleted: false,
    deletedAncestorCount: 0,
    accessible: true,
    ...overrides,
  };
}

function context(
  overrides: Partial<TrashRestoreContextResponse> = {}
): TrashRestoreContextResponse {
  const baseDestination = destination();
  return {
    type: 'file',
    item: {
      id: 'file-1',
      type: 'file',
      name: 'report.txt',
      classification: 'internal',
      folderId: 'folder-dest',
      parentId: null,
    },
    itemEffectiveRole: 'editor',
    originalLocation: baseDestination,
    destination: baseDestination,
    conflict: { hasConflict: false, suggestedName: null },
    classification: {
      floor: 'internal',
      willUpgrade: false,
      upgradeCount: 0,
    },
    restoreParentChainAvailable: false,
    restoreParentChainDefault: false,
    destinationChecks: {
      circular: false,
      maxDepthExceeded: false,
      targetDeleted: false,
      canRestoreToRoot: true,
    },
    ...overrides,
  };
}

test('initial dialog state restores to the original location and enables parent chain only when an ancestor is deleted', () => {
  const deletedParent = destination({
    name: 'Deleted Parent',
    path: '全社共有 / Deleted Parent',
    isDeleted: true,
    deletedAncestorCount: 2,
    classification: 'confidential',
  });
  const deletedContext = context({
    originalLocation: deletedParent,
    destination: deletedParent,
    restoreParentChainAvailable: true,
    restoreParentChainDefault: true,
    classification: {
      floor: 'confidential',
      willUpgrade: true,
      upgradeCount: 3,
    },
  });

  const state = buildInitialTrashRestoreDialogState(deletedContext);
  assert.equal(state.mode, 'original');
  assert.equal(state.targetId, deletedParent.id);
  assert.equal(state.targetPath, '全社共有 / Deleted Parent');
  assert.equal(state.restoreParentChain, true);
  assert.equal(state.conflictPolicy, 'fail');
  assert.equal(state.willUpgradeClassification, true);
  assert.equal(
    isTrashRestoreParentToggleAvailable(state),
    true,
    'deleted parent must expose the chain toggle'
  );

  const activeParent = buildInitialTrashRestoreDialogState(
    context({ restoreParentChainAvailable: false })
  );
  assert.equal(activeParent.restoreParentChain, false);
  assert.equal(isTrashRestoreParentToggleAvailable(activeParent), false);
});

test('switching destination updates breadcrumb, floor, upgrade warning and disables parent-chain restore', () => {
  const ctx = context({ type: 'folder' });
  const initial = buildInitialTrashRestoreDialogState(ctx);
  const confidential = destination({
    id: 'folder-secret',
    name: '極秘プロジェクト',
    path: '機密プロジェクト',
    classification: 'confidential',
    breadcrumbs: [
      {
        id: 'folder-secret',
        name: '機密プロジェクト',
        classification: 'confidential',
        depth: 0,
        version: 1,
      },
    ],
  });

  const selected = selectTrashRestoreDestination(initial, ctx, confidential);
  assert.equal(selected.mode, 'custom');
  assert.equal(selected.targetId, 'folder-secret');
  assert.equal(selected.targetPath, '機密プロジェクト');
  assert.equal(selected.targetClassification, 'confidential');
  assert.equal(selected.willUpgradeClassification, true);
  assert.equal(selected.restoreParentChain, false);

  const returned = selectOriginalTrashRestoreDestination(selected, ctx);
  assert.equal(returned.mode, 'original');
  assert.equal(returned.targetId, ctx.originalLocation.id);
});

test('folder destination evaluation rejects self/descendants and tracks circular submit state', () => {
  const ctx = context({
    type: 'folder',
    item: {
      id: 'folder-folder',
      type: 'folder',
      name: 'Folder',
      classification: 'internal',
      folderId: null,
      parentId: 'root-general',
    },
    itemEffectiveRole: 'owner',
  });

  const self = evaluateTrashRestoreDestination({
    context: ctx,
    targetId: 'folder-folder',
    targetEffectiveRole: 'owner',
    itemEffectiveRole: 'owner',
  });
  assert.equal(self.allowed, false);
  assert.equal(self.circular, true);
  assert.match(self.reason ?? '', /配下/);

  const descendant = evaluateTrashRestoreDestination({
    context: ctx,
    targetId: 'folder-child',
    targetEffectiveRole: 'owner',
    itemEffectiveRole: 'owner',
    isDescendantOfItem: true,
  });
  assert.equal(descendant.allowed, false);
  assert.equal(descendant.circular, true);

  const rootWithoutOwner = evaluateTrashRestoreDestination({
    context: ctx,
    targetId: null,
    targetEffectiveRole: 'editor',
    itemEffectiveRole: 'editor',
  });
  assert.equal(rootWithoutOwner.allowed, false);
  assert.match(rootWithoutOwner.reason ?? '', /Owner/);

  const rootClosedMember = evaluateTrashRestoreDestination({
    context: ctx,
    targetId: null,
    targetEffectiveRole: 'owner',
    itemEffectiveRole: 'owner',
    isSysAdmin: false,
    folderStructureMode: 'closed',
  });
  assert.equal(rootClosedMember.allowed, false);
  assert.match(rootClosedMember.reason ?? '', /Closed 構成/);

  const rootClosedSysAdmin = evaluateTrashRestoreDestination({
    context: ctx,
    targetId: null,
    targetEffectiveRole: 'owner',
    itemEffectiveRole: 'owner',
    isSysAdmin: true,
    folderStructureMode: 'closed',
  });
  assert.equal(rootClosedSysAdmin.allowed, true);

  const inaccessible = evaluateTrashRestoreDestination({
    context: ctx,
    targetId: 'folder-private',
    targetEffectiveRole: null,
    itemEffectiveRole: 'owner',
  });
  assert.equal(inaccessible.allowed, false);
  assert.match(inaccessible.reason ?? '', /Editor/);

  const circularState: TrashRestoreDialogState = {
    ...buildInitialTrashRestoreDialogState(ctx),
    circular: true,
  };
  assert.equal(
    canSubmitTrashRestore(circularState, {
      busy: false,
      loadingDestination: false,
    }),
    false
  );
});

test('409 NAME_CONFLICT keeps the dialog open, merges suggestedName and offers rename retry', () => {
  const ctx = context();
  const initial = buildInitialTrashRestoreDialogState(ctx);
  const transition = applyTrashRestoreError(initial, {
    status: 409,
    code: 'NAME_CONFLICT',
    message: 'An active file named "report.txt" already exists in destination folder',
    details: {
      destination: destination({
        id: 'folder-other',
        name: 'Other',
        path: '全社共有 / Other',
      }),
      suggestedName: 'report (Restored).txt',
    },
  });

  assert.equal(transition.state.errorCode, 'NAME_CONFLICT');
  assert.equal(transition.state.conflict.hasConflict, true);
  assert.equal(
    transition.state.conflict.suggestedName,
    'report (Restored).txt'
  );
  assert.equal(transition.state.conflictPolicy, 'fail');
  assert.equal(transition.canRetryWithRename, true);
  assert.equal(transition.state.targetId, 'folder-other');
  assert.equal(transition.state.targetPath, '全社共有 / Other');
});

test('parent-deleted 409 enables the chain toggle and another-destination escape hatch', () => {
  const ctx = context({
    originalLocation: destination({
      isDeleted: true,
      deletedAncestorCount: 1,
    }),
    restoreParentChainAvailable: true,
    restoreParentChainDefault: false,
  });
  const initial = buildInitialTrashRestoreDialogState(ctx);
  assert.equal(initial.restoreParentChain, false);

  const transition = applyTrashRestoreError(initial, {
    status: 409,
    code: 'PARENT_FOLDER_DELETED',
    message: 'Parent folder is deleted; restore parent folder first',
    details: {
      destination: destination({
        isDeleted: true,
        deletedAncestorCount: 2,
      }),
    },
  });

  assert.equal(transition.state.errorCode, 'PARENT_FOLDER_DELETED');
  assert.equal(transition.state.targetIsDeleted, true);
  assert.equal(transition.state.targetDeletedAncestorCount, 2);
  assert.equal(transition.state.restoreParentChainAvailable, true);
  assert.equal(transition.canRetryWithParentChain, true);
  assert.equal(transition.canChooseAnotherDestination, true);
  assert.equal(
    isTrashRestoreParentToggleAvailable(transition.state),
    true
  );
});

test('403 destination error and context refresh update accessibility and disable submit', () => {
  const ctx = context();
  const initial = buildInitialTrashRestoreDialogState(ctx);
  const transition = applyTrashRestoreError(initial, {
    status: 403,
    code: 'FORBIDDEN',
    message: 'Editor permission required on destination folder',
    details: {
      destination: destination({
        id: 'folder-private',
        name: '（アクセス権限のないフォルダ）',
        path: '（アクセス権限のない場所）',
        accessible: false,
      }),
    },
  });

  assert.equal(transition.state.targetAccessible, false);
  assert.equal(
    canSubmitTrashRestore(transition.state, {
      busy: false,
      loadingDestination: false,
    }),
    false
  );

  const refreshed = applyTrashRestoreContext(
    {
      ...initial,
      mode: 'custom',
      targetId: 'folder-private',
      targetAccessible: true,
    },
    context({
      destination: destination({
        id: 'folder-private',
        name: 'Private',
        path: 'Private',
        accessible: false,
      }),
      conflict: { hasConflict: true, suggestedName: 'Private (Restored)' },
    })
  );
  assert.equal(refreshed.targetAccessible, false);
  assert.equal(refreshed.conflict.hasConflict, true);
});

test('cancel-state rules cover busy/loading/max-depth and success copy includes destination and rename', () => {
  const initial = buildInitialTrashRestoreDialogState(
    context({
      type: 'folder',
      item: {
        id: 'folder-1',
        type: 'folder',
        name: 'Folder',
        classification: 'internal',
        folderId: null,
        parentId: null,
      },
    })
  );
  assert.equal(
    canSubmitTrashRestore(initial, { busy: true, loadingDestination: false }),
    false
  );
  assert.equal(
    canSubmitTrashRestore(initial, { busy: false, loadingDestination: true }),
    false
  );
  assert.equal(
    canSubmitTrashRestore(
      { ...initial, maxDepthExceeded: true },
      { busy: false, loadingDestination: false }
    ),
    false
  );
  assert.equal(
    canSubmitTrashRestore(initial, { busy: false, loadingDestination: false }),
    true
  );

  assert.equal(
    formatTrashRestoreSuccessMessage({
      itemName: 'report.txt',
      destinationPath: '全社共有 / Destination',
      restoredName: 'report (Restored).txt',
      restoredAncestorCount: 2,
    }),
    '「report.txt」を「全社共有 / Destination」へ「report (Restored).txt」として復元しました（親フォルダ 2 件も復元）'
  );
  assert.equal(
    formatTrashRestoreSuccessMessage({
      itemName: 'report.txt',
      destinationPath: 'マイファイル (ルート)',
      restoredName: 'report.txt',
    }),
    '「report.txt」を「マイファイル (ルート)」へ復元しました'
  );
});

test('cached folder projection computes the strictest floor across breadcrumbs', () => {
  const root = buildDestinationFromCachedFolder({
    folderId: null,
    folderName: 'マイファイル (ルート)',
    classification: 'unset',
    breadcrumbs: [],
  });
  assert.equal(root.path, 'マイファイル (ルート)');
  assert.equal(root.classification, 'unset');

  const projected = buildDestinationFromCachedFolder({
    folderId: 'folder-deep',
    folderName: 'Deep',
    classification: 'public',
    breadcrumbs: [
      {
        id: 'root',
        name: '全社共有',
        classification: 'internal',
        depth: 0,
      },
      {
        id: 'folder-mid',
        name: 'Mid',
        classification: 'confidential',
        depth: 1,
      },
    ],
  });
  assert.equal(projected.id, 'folder-deep');
  assert.equal(projected.path, '全社共有 / Mid');
  assert.equal(projected.classification, 'confidential');
  assert.equal(projected.accessible, true);
});
