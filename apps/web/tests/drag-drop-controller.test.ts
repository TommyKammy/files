import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeEdgeAutoScrollDelta,
  decodeDropFolderId,
  type DragWorkspaceItem,
  EDGE_SCROLL_MAX_STEP_PX,
  EDGE_SCROLL_ZONE_PX,
  encodeDropFolderId,
  evaluateDropTarget,
  hasOsFilesDataTransfer,
  ROOT_DROP_ID,
} from '@/lib/drag-drop-controller';

function makeItem(overrides: Partial<DragWorkspaceItem> = {}): DragWorkspaceItem {
  return {
    type: 'file',
    id: 'file-1',
    name: 'proposal.pdf',
    parentId: 'fld-src',
    classification: 'internal',
    effectiveRole: 'editor',
    ...overrides,
  };
}

test('evaluateDropTarget rejects same-directory drops, cycles, and insufficient permissions', () => {
  const fileItem = makeItem({ parentId: 'fld-src' });
  const sameFolder = evaluateDropTarget({
    dragItems: [fileItem],
    targetFolderId: 'fld-src',
    targetClassification: 'internal',
    targetEffectiveRole: 'editor',
    isAncestorOf: () => false,
    resolveItemRole: (it) => it.effectiveRole ?? 'viewer',
  });
  assert.equal(sameFolder.allowed, false);
  assert.match(sameFolder.reason ?? '', /同じフォルダ/);

  const folderItem = makeItem({
    type: 'folder',
    id: 'fld-parent',
    name: 'Parent',
    parentId: null,
  });
  const cycleSelf = evaluateDropTarget({
    dragItems: [folderItem],
    targetFolderId: 'fld-parent',
    targetClassification: 'internal',
    targetEffectiveRole: 'editor',
    isAncestorOf: (ancestor, candidate) => ancestor === candidate,
    resolveItemRole: () => 'owner',
  });
  assert.equal(cycleSelf.allowed, false);
  assert.match(cycleSelf.reason ?? '', /配下/);

  const cycleDescendant = evaluateDropTarget({
    dragItems: [folderItem],
    targetFolderId: 'fld-child',
    targetClassification: 'internal',
    targetEffectiveRole: 'editor',
    isAncestorOf: (ancestor, candidate) =>
      ancestor === 'fld-parent' && candidate === 'fld-child',
    resolveItemRole: () => 'owner',
  });
  assert.equal(cycleDescendant.allowed, false);

  const readOnlyDest = evaluateDropTarget({
    dragItems: [fileItem],
    targetFolderId: 'fld-dest',
    targetClassification: 'internal',
    targetEffectiveRole: 'viewer',
    isAncestorOf: () => false,
    resolveItemRole: () => 'editor',
  });
  assert.equal(readOnlyDest.allowed, false);
  assert.match(readOnlyDest.reason ?? '', /Editor/);

  const nestedFolder = makeItem({
    type: 'folder',
    id: 'fld-nested',
    name: 'Nested',
    parentId: 'fld-parent',
  });
  const rootPromotionDenied = evaluateDropTarget({
    dragItems: [nestedFolder],
    targetFolderId: null,
    targetClassification: 'unset',
    isSysAdmin: false,
    isAncestorOf: () => false,
    resolveItemRole: () => 'editor',
  });
  assert.equal(rootPromotionDenied.allowed, false);
  assert.match(rootPromotionDenied.reason ?? '', /Owner/);

  const rootPromotionSysAdmin = evaluateDropTarget({
    dragItems: [nestedFolder],
    targetFolderId: null,
    targetClassification: 'unset',
    isSysAdmin: true,
    isAncestorOf: () => false,
    resolveItemRole: () => 'editor',
  });
  assert.equal(rootPromotionSysAdmin.allowed, true);
  assert.equal(rootPromotionSysAdmin.promotesToConfidential, false);

  const looseFileToRootOpen = evaluateDropTarget({
    dragItems: [fileItem],
    targetFolderId: null,
    targetClassification: 'unset',
    isSysAdmin: true,
    isAncestorOf: () => false,
    resolveItemRole: () => 'owner',
  });
  assert.equal(looseFileToRootOpen.allowed, true);

  const looseFileToRootClosedMember = evaluateDropTarget({
    dragItems: [fileItem],
    targetFolderId: null,
    targetClassification: 'unset',
    isSysAdmin: false,
    folderStructureMode: 'closed',
    isAncestorOf: () => false,
    resolveItemRole: () => 'owner',
  });
  assert.equal(looseFileToRootClosedMember.allowed, false);
  assert.match(looseFileToRootClosedMember.reason ?? '', /Closed 構成/);
});

test('evaluateDropTarget allows sys_admin root placement in closed mode', () => {
  const folderItem = makeItem({
    type: 'folder',
    id: 'fld-closed-root',
    name: 'Closed Root Move',
    parentId: 'fld-parent',
  });
  const sysAdminRoot = evaluateDropTarget({
    dragItems: [folderItem],
    targetFolderId: null,
    targetClassification: 'unset',
    isSysAdmin: true,
    folderStructureMode: 'closed',
    isAncestorOf: () => false,
    resolveItemRole: () => 'editor',
  });
  assert.equal(sysAdminRoot.allowed, true);

  const memberRoot = evaluateDropTarget({
    dragItems: [folderItem],
    targetFolderId: null,
    targetClassification: 'unset',
    isSysAdmin: false,
    folderStructureMode: 'closed',
    isAncestorOf: () => false,
    resolveItemRole: () => 'owner',
  });
  assert.equal(memberRoot.allowed, false);
  assert.match(memberRoot.reason ?? '', /sys_admin 専用/);
});

test('evaluateDropTarget detects 0ms Confidential promotion warning cleanly', () => {
  const internalFile = makeItem({ classification: 'internal' });
  const confidentialFile = makeItem({
    id: 'file-2',
    classification: 'confidential',
  });

  const viaDirectFolder = evaluateDropTarget({
    dragItems: [internalFile],
    targetFolderId: 'fld-secret',
    targetClassification: 'confidential',
    targetEffectiveRole: 'editor',
    isAncestorOf: () => false,
    resolveItemRole: () => 'editor',
  });
  assert.equal(viaDirectFolder.allowed, true);
  assert.equal(viaDirectFolder.promotesToConfidential, true);

  const viaAncestorFloor = evaluateDropTarget({
    dragItems: [internalFile],
    targetFolderId: 'fld-sub',
    targetClassification: 'internal',
    targetAncestorClassifications: ['confidential'],
    targetEffectiveRole: 'editor',
    isAncestorOf: () => false,
    resolveItemRole: () => 'editor',
  });
  assert.equal(viaAncestorFloor.allowed, true);
  assert.equal(viaAncestorFloor.promotesToConfidential, true);

  const alreadyConfidential = evaluateDropTarget({
    dragItems: [confidentialFile],
    targetFolderId: 'fld-secret',
    targetClassification: 'confidential',
    targetEffectiveRole: 'editor',
    isAncestorOf: () => false,
    resolveItemRole: () => 'editor',
  });
  assert.equal(alreadyConfidential.allowed, true);
  assert.equal(alreadyConfidential.promotesToConfidential, false);
});

test('computeEdgeAutoScrollDelta scrolls near 48px edges within viewport bounds', () => {
  const rect = { top: 100, bottom: 500, left: 200, right: 900 };

  assert.equal(computeEdgeAutoScrollDelta(250, rect, 400), 0);
  assert.equal(computeEdgeAutoScrollDelta(102, rect, 100), 0);

  const nearTop = computeEdgeAutoScrollDelta(102, rect, 400);
  assert.ok(nearTop < 0 && nearTop >= -EDGE_SCROLL_MAX_STEP_PX);

  const outerTop = computeEdgeAutoScrollDelta(100 + EDGE_SCROLL_ZONE_PX, rect, 400);
  assert.equal(outerTop, 0);

  const nearBottom = computeEdgeAutoScrollDelta(498, rect, 400);
  assert.ok(nearBottom > 0 && nearBottom <= EDGE_SCROLL_MAX_STEP_PX);

  const tinyRect = { top: 100, bottom: 160, left: 0, right: 400 };
  assert.equal(computeEdgeAutoScrollDelta(105, tinyRect, 200), 0);
});

test('hasOsFilesDataTransfer & drop ID encoding separate OS file drops from internal DnD', () => {
  assert.equal(
    hasOsFilesDataTransfer({ types: ['Files'], files: {} as FileList }, false),
    true
  );
  assert.equal(
    hasOsFilesDataTransfer({ types: ['Files'], files: {} as FileList }, true),
    false
  );
  assert.equal(
    hasOsFilesDataTransfer({ types: ['text/plain'], files: {} as FileList }, false),
    false
  );
  assert.equal(hasOsFilesDataTransfer(null, false), false);

  assert.equal(encodeDropFolderId(null), ROOT_DROP_ID);
  assert.equal(decodeDropFolderId(ROOT_DROP_ID), null);
  assert.equal(encodeDropFolderId('fld-123'), 'fld-123');
  assert.equal(decodeDropFolderId('fld-123'), 'fld-123');
  assert.equal(decodeDropFolderId(undefined), undefined);
});
