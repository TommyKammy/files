import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContextMenuCapabilities,
  type ContextRowTarget,
  resolveContextSelection,
  resolvePointerSelection,
} from '@/lib/workspace-actions';
import type { FileItem, FolderSummary } from '@/types/files';

const orderedKeys = ['a', 'b', 'c', 'd'];

function mods(overrides: Partial<{ shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) {
  return { shiftKey: false, metaKey: false, ctrlKey: false, ...overrides };
}

test('resolvePointerSelection implements Drive click / cmd-click / shift-click semantics', () => {
  const plain = resolvePointerSelection({
    orderedKeys,
    selectedKeys: new Set(['a', 'b']),
    anchorKey: 'a',
    rowKey: 'c',
    modifiers: mods(),
  });
  assert.deepEqual([...plain.selectedKeys], ['c']);
  assert.equal(plain.anchorKey, 'c');

  const toggleOn = resolvePointerSelection({
    orderedKeys,
    selectedKeys: new Set(['a']),
    anchorKey: 'a',
    rowKey: 'c',
    modifiers: mods({ metaKey: true }),
  });
  assert.deepEqual([...toggleOn.selectedKeys].sort(), ['a', 'c']);
  assert.equal(toggleOn.anchorKey, 'c');

  const toggleOff = resolvePointerSelection({
    orderedKeys,
    selectedKeys: new Set(['a', 'c']),
    anchorKey: 'c',
    rowKey: 'a',
    modifiers: mods({ ctrlKey: true }),
  });
  assert.deepEqual([...toggleOff.selectedKeys], ['c']);
  assert.equal(toggleOff.anchorKey, 'a');

  const range = resolvePointerSelection({
    orderedKeys,
    selectedKeys: new Set(['a']),
    anchorKey: 'a',
    rowKey: 'c',
    modifiers: mods({ shiftKey: true }),
  });
  assert.deepEqual([...range.selectedKeys], ['a', 'b', 'c']);
  assert.equal(range.anchorKey, 'a');

  const rangeWithoutAnchor = resolvePointerSelection({
    orderedKeys,
    selectedKeys: new Set(),
    anchorKey: null,
    rowKey: 'b',
    modifiers: mods({ shiftKey: true }),
  });
  assert.deepEqual([...rangeWithoutAnchor.selectedKeys], ['b']);
  assert.equal(rangeWithoutAnchor.anchorKey, 'b');
});

test('resolveContextSelection normalizes unselected right-clicks and preserves selected multi-selection', () => {
  const inside = resolveContextSelection(new Set(['a', 'b']), 'b');
  assert.equal(inside.changed, false);
  assert.deepEqual([...inside.selectedKeys].sort(), ['a', 'b']);

  const outside = resolveContextSelection(new Set(['a', 'b']), 'c');
  assert.equal(outside.changed, true);
  assert.deepEqual([...outside.selectedKeys], ['c']);
  assert.equal(outside.anchorKey, 'c');
});

test('buildContextMenuCapabilities exposes permissions and internal-link actions only for a single row', () => {
  const file: ContextRowTarget = {
    kind: 'file',
    file: {
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
    } as FileItem,
  };
  const folder: ContextRowTarget = {
    kind: 'folder',
    folder: {
      id: 'fld-1',
      parent_id: null,
      name: 'Folder 1',
      classification: 'internal',
      is_pinned: 0,
      version: 1,
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: null,
      effectiveRole: 'co_owner',
    } as FolderSummary,
  };

  const single = buildContextMenuCapabilities({
    targets: [file],
    primaryRow: file,
    currentFolderId: 'fld-1',
    folderRole: 'co_owner',
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: false,
    clipboardHasFiles: false,
    resolveRowRole: () => 'co_owner',
  });
  assert.equal(single.canPermissions, true);
  assert.equal(single.canCopyLink, true);

  const multi = buildContextMenuCapabilities({
    targets: [file, folder],
    primaryRow: file,
    currentFolderId: 'fld-1',
    folderRole: 'co_owner',
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: false,
    clipboardHasFiles: false,
    resolveRowRole: () => 'co_owner',
  });
  assert.equal(multi.canPermissions, false);
  assert.equal(multi.canCopyLink, false);
});
