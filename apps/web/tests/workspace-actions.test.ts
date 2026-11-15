import assert from 'node:assert/strict';
import test from 'node:test';
import type { DragWorkspaceItem } from '@/lib/drag-drop-controller';
import {
  buildContextMenuCapabilities,
  clampPopoverPosition,
  type ContextRowTarget,
  evaluateCopyDestination,
  resolveTargetRows,
} from '@/lib/workspace-actions';
import type { FileItem, FolderSummary } from '@/types/files';

function makeFolder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id: 'fld-1',
    parent_id: null,
    name: 'Folder 1',
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    effectiveRole: 'editor',
    ...overrides,
  };
}

function makeFile(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 'file-1',
    folder_id: 'fld-1',
    name: 'spec.pdf',
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    current_version_num: 1,
    meta_version: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

test('evaluateCopyDestination blocks previewer DLP, root loose files, cycles, and warns on Confidential promotion', () => {
  const dragFile: DragWorkspaceItem = {
    type: 'file',
    id: 'file-1',
    name: 'spec.pdf',
    parentId: 'fld-1',
    classification: 'internal',
    effectiveRole: 'viewer',
  };

  const previewerBlocked = evaluateCopyDestination({
    items: [{ ...dragFile, effectiveRole: 'previewer' }],
    targetFolderId: 'fld-dest',
    targetClassification: 'internal',
    targetEffectiveRole: 'editor',
    isAncestorOf: () => false,
    resolveItemRole: (it) => it.effectiveRole ?? 'previewer',
  });
  assert.equal(previewerBlocked.allowed, false);
  assert.match(previewerBlocked.reason ?? '', /Previewer/);

  const rootFileBlocked = evaluateCopyDestination({
    items: [dragFile],
    targetFolderId: null,
    targetClassification: 'unset',
    isAncestorOf: () => false,
    resolveItemRole: () => 'viewer',
  });
  assert.equal(rootFileBlocked.allowed, false);
  assert.match(rootFileBlocked.reason ?? '', /ルート/);

  const folderCycleBlocked = evaluateCopyDestination({
    items: [
      {
        type: 'folder',
        id: 'fld-src',
        name: 'Source',
        parentId: null,
        classification: 'internal',
        effectiveRole: 'editor',
      },
    ],
    targetFolderId: 'fld-sub',
    targetClassification: 'internal',
    targetEffectiveRole: 'editor',
    isAncestorOf: (anc, cand) => anc === 'fld-src' && cand === 'fld-sub',
    resolveItemRole: () => 'editor',
  });
  assert.equal(folderCycleBlocked.allowed, false);

  const promotes = evaluateCopyDestination({
    items: [dragFile],
    targetFolderId: 'fld-secret',
    targetClassification: 'confidential',
    targetEffectiveRole: 'editor',
    isAncestorOf: () => false,
    resolveItemRole: () => 'viewer',
  });
  assert.equal(promotes.allowed, true);
  assert.equal(promotes.promotesToConfidential, true);
});

test('clampPopoverPosition keeps context menu strictly inside viewport bounds', () => {
  const bottomRight = clampPopoverPosition(1250, 780, 256, 400, 1280, 800, 8);
  assert.equal(bottomRight.left, 1280 - 256 - 8);
  assert.equal(bottomRight.top, 800 - 400 - 8);

  const topLeft = clampPopoverPosition(-20, -10, 256, 400, 1280, 800, 8);
  assert.equal(topLeft.left, 8);
  assert.equal(topLeft.top, 8);
});

test('resolveTargetRows and buildContextMenuCapabilities distinguish single vs multi selection and roles', () => {
  const f1: ContextRowTarget = { kind: 'file', file: makeFile({ id: 'f1' }) };
  const f2: ContextRowTarget = { kind: 'file', file: makeFile({ id: 'f2' }) };
  const f3: ContextRowTarget = { kind: 'file', file: makeFile({ id: 'f3' }) };
  const fld: ContextRowTarget = { kind: 'folder', folder: makeFolder({ id: 'fld-a' }) };

  // Right clicking inside multi-selection operates on the multi-selection
  assert.deepEqual(resolveTargetRows(f2, [f1, f2]), [f1, f2]);
  // Right clicking outside multi-selection switches target to that row alone
  assert.deepEqual(resolveTargetRows(f3, [f1, f2]), [f3]);

  const multiCaps = buildContextMenuCapabilities({
    targets: [f1, f2],
    primaryRow: f2,
    currentFolderId: 'fld-1',
    folderRole: 'editor',
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: true,
    clipboardHasFiles: true,
    resolveRowRole: () => 'editor',
  });
  assert.equal(multiCaps.isMulti, true);
  assert.equal(multiCaps.canOpen, false);
  assert.equal(multiCaps.canRename, false);
  assert.equal(multiCaps.canCopy, true);
  assert.equal(multiCaps.canCut, true);
  assert.equal(multiCaps.canPaste, true);
  assert.equal(multiCaps.canClassify, true);
  assert.equal(multiCaps.canTrash, true);

  // Previewer cannot copy, cut, or duplicate
  const previewerCaps = buildContextMenuCapabilities({
    targets: [f1],
    primaryRow: f1,
    currentFolderId: 'fld-1',
    folderRole: 'previewer',
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: true,
    clipboardHasFiles: true,
    resolveRowRole: () => 'previewer',
  });
  assert.equal(previewerCaps.canOpen, true);
  assert.equal(previewerCaps.canDownload, false);
  assert.equal(previewerCaps.canCopy, false);
  assert.equal(previewerCaps.canCut, false);
  assert.equal(previewerCaps.canDuplicate, false);
  assert.equal(previewerCaps.canPaste, false);

  // Right clicking folder row at root permits pasting clipboard files INTO that folder
  const rootFolderPaste = buildContextMenuCapabilities({
    targets: [fld],
    primaryRow: fld,
    currentFolderId: null,
    folderRole: 'editor',
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: true,
    clipboardHasFiles: true,
    resolveRowRole: () => 'editor',
  });
  assert.equal(rootFolderPaste.canPaste, true);
});
