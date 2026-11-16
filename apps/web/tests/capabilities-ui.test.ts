import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADVANCED_RESOURCE_ROLES,
  CAPABILITIES,
  CAPABILITY_CHIPS,
  RESOURCE_ROLES,
  ROLE_CAPABILITIES,
  ROLE_CAPABILITY_CHIPS,
  ROLE_GROUPS,
  ROLE_META,
  canAccess,
  capabilitiesForRole,
  formatRoleBreakdown,
  hasCapability,
  isAdvancedResourceRole,
  roleGroupsForTarget,
  synthesizeEffectiveAccessFromRoles,
  synthesizeEffectiveRoleFromRoles,
} from '@/lib/capabilities';
import {
  evaluateDropTarget,
  type DragWorkspaceItem,
} from '@/lib/drag-drop-controller';
import {
  buildContextMenuCapabilities,
  evaluateCopyDestination,
  type ContextRowTarget,
} from '@/lib/workspace-actions';
import type { FileItem, FolderSummary, ResourceRole } from '@/types/files';

function makeFolder(overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id: 'folder-1',
    parent_id: 'folder-parent',
    name: 'Folder 1',
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeFile(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 'file-1',
    folder_id: 'folder-1',
    name: 'spec.txt',
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: 1024,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    current_version_num: 1,
    meta_version: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function menuFor(role: ResourceRole) {
  const fileRow: ContextRowTarget = {
    kind: 'file',
    file: makeFile({ effectiveRole: role }),
  };
  return buildContextMenuCapabilities({
    targets: [fileRow],
    primaryRow: fileRow,
    currentFolderId: 'folder-1',
    folderRole: role,
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: true,
    clipboardHasFiles: true,
    resolveRowRole: () => role,
  });
}

test('capability matrix exposes all 26 capabilities and all 8 roles', () => {
  assert.equal(CAPABILITIES.length, 26);
  assert.equal(new Set(CAPABILITIES).size, 26);
  assert.deepEqual([...RESOURCE_ROLES], [
    'owner',
    'co_owner',
    'editor',
    'viewer_uploader',
    'previewer_uploader',
    'viewer',
    'previewer',
    'uploader',
  ]);
  assert.equal(ADVANCED_RESOURCE_ROLES.size, 3);

  for (const capability of CAPABILITIES) {
    assert.equal(typeof CAPABILITY_CHIPS[capability], 'string');
    assert.ok(CAPABILITY_CHIPS[capability].length > 0);
  }

  for (const role of RESOURCE_ROLES) {
    assert.ok(ROLE_META[role].label.length > 0);
    assert.ok(ROLE_META[role].description.length > 0);
    assert.ok(ROLE_CAPABILITY_CHIPS[role].length > 0);
    assert.ok(ROLE_CAPABILITIES[role].size > 0);
  }
});

test('ROLE_GROUPS groups roles into owner/edit/upload/view with Japanese labels', () => {
  assert.deepEqual(
    ROLE_GROUPS.map((group) => group.label),
    ['所有者/管理', '編集', '投稿', '閲覧']
  );
  assert.deepEqual(
    ROLE_GROUPS.map((group) => group.roles),
    [
      ['owner', 'co_owner'],
      ['editor'],
      ['viewer_uploader', 'previewer_uploader', 'uploader'],
      ['viewer', 'previewer'],
    ]
  );

  const folderAdvancedEnabled = roleGroupsForTarget('folder', {
    advancedRolesEnabled: true,
  });
  assert.equal(folderAdvancedEnabled.length, 4);

  const folderAdvancedDisabled = roleGroupsForTarget('folder', {
    advancedRolesEnabled: false,
  });
  assert.equal(folderAdvancedDisabled.length, 3);
  assert.ok(
    folderAdvancedDisabled.every((group) =>
      group.roles.every((role) => !isAdvancedResourceRole(role))
    )
  );

  const fileGroups = roleGroupsForTarget('file');
  assert.deepEqual(
    fileGroups.map((group) => group.label),
    ['所有者/管理', '編集', '閲覧']
  );
  assert.ok(
    fileGroups.every((group) =>
      group.roles.every((role) => !isAdvancedResourceRole(role))
    )
  );
});

test('canAccess/hasCapability use explicit capabilities first and role fallback second', () => {
  assert.equal(canAccess('owner', 'owner.transfer'), true);
  assert.equal(canAccess('co_owner', 'owner.transfer'), false);
  assert.equal(canAccess('co_owner', 'permission.manage'), true);
  assert.equal(canAccess('editor', 'permission.manage'), false);
  assert.equal(canAccess('editor', 'item.edit_content'), true);

  assert.equal(canAccess('uploader', 'folder.create'), true);
  assert.equal(canAccess('uploader', 'item.upload_new'), true);
  assert.equal(canAccess('uploader', 'item.preview'), false);
  assert.equal(canAccess('uploader', 'item.download'), false);
  assert.equal(canAccess('uploader', 'item.rename'), false);
  assert.equal(canAccess('uploader', 'item.move'), false);
  assert.equal(canAccess('uploader', 'item.delete'), false);
  assert.equal(canAccess('uploader', 'share_link.create'), false);
  assert.equal(canAccess('uploader', 'permission.manage'), false);
  assert.equal(canAccess('uploader', 'classification.edit'), false);

  assert.equal(canAccess('previewer_uploader', 'item.preview'), true);
  assert.equal(canAccess('previewer_uploader', 'item.upload_new'), true);
  assert.equal(canAccess('previewer_uploader', 'item.download'), false);
  assert.equal(canAccess('previewer_uploader', 'item.upload_version'), false);
  assert.equal(canAccess('previewer_uploader', 'item.edit_content'), false);

  assert.equal(canAccess('viewer_uploader', 'item.download'), true);
  assert.equal(canAccess('viewer_uploader', 'item.edit_content'), true);
  assert.equal(canAccess('viewer_uploader', 'item.upload_version'), true);
  assert.equal(canAccess('viewer_uploader', 'share_link.create'), true);
  assert.equal(canAccess('viewer_uploader', 'share_link.manage'), false);
  assert.equal(canAccess('viewer_uploader', 'item.rename'), false);
  assert.equal(canAccess('viewer_uploader', 'item.move'), false);
  assert.equal(canAccess('viewer_uploader', 'item.delete'), false);
  assert.equal(canAccess('viewer_uploader', 'permission.manage'), false);
  assert.equal(canAccess('viewer_uploader', 'classification.edit'), false);

  // Explicit arrays always win, including an empty array.
  assert.equal(
    canAccess(
      { capabilities: ['item.preview'], effectiveRole: 'owner' },
      'item.preview'
    ),
    true
  );
  assert.equal(
    canAccess(
      { capabilities: ['item.preview'], effectiveRole: 'owner' },
      'item.download'
    ),
    false
  );
  assert.equal(
    canAccess({ capabilities: [], effectiveRole: 'owner' }, 'item.preview'),
    false
  );

  assert.equal(hasCapability(undefined, 'viewer', 'item.download'), true);
  assert.equal(hasCapability([], 'viewer', 'item.download'), false);
  assert.equal(hasCapability(['item.preview'], 'viewer', 'item.preview'), true);
  assert.equal(capabilitiesForRole('previewer').includes('item.download'), false);
});

test('non-linear composition joins viewer + uploader / previewer + uploader roles', () => {
  assert.equal(
    synthesizeEffectiveRoleFromRoles(['viewer', 'uploader']),
    'viewer_uploader'
  );
  assert.equal(
    synthesizeEffectiveRoleFromRoles(['viewer_uploader', 'uploader']),
    'viewer_uploader'
  );
  assert.equal(
    synthesizeEffectiveRoleFromRoles(['uploader', 'viewer']),
    'viewer_uploader'
  );
  assert.equal(
    synthesizeEffectiveRoleFromRoles(['previewer', 'uploader']),
    'previewer_uploader'
  );
  assert.equal(
    synthesizeEffectiveRoleFromRoles(['previewer_uploader', 'previewer']),
    'previewer_uploader'
  );
  assert.equal(
    synthesizeEffectiveRoleFromRoles(['viewer', 'previewer']),
    'viewer'
  );
  assert.equal(
    synthesizeEffectiveRoleFromRoles(['previewer', 'uploader', 'viewer']),
    'viewer_uploader'
  );
  assert.equal(synthesizeEffectiveRoleFromRoles([]), null);

  const composed = synthesizeEffectiveAccessFromRoles(['viewer', 'uploader']);
  assert.equal(composed.effectiveRole, 'viewer_uploader');
  assert.ok(composed.capabilities.includes('item.download'));
  assert.ok(composed.capabilities.includes('item.upload_new'));
  assert.ok(composed.capabilities.includes('item.edit_content'));

  const previewerUploader = synthesizeEffectiveAccessFromRoles([
    'previewer',
    'uploader',
  ]);
  assert.equal(previewerUploader.effectiveRole, 'previewer_uploader');
  assert.ok(previewerUploader.capabilities.includes('item.preview'));
  assert.ok(previewerUploader.capabilities.includes('item.upload_new'));
  assert.ok(!previewerUploader.capabilities.includes('item.download'));

  assert.equal(
    formatRoleBreakdown(['viewer', 'uploader']),
    'Viewer + Uploader'
  );
  assert.equal(
    formatRoleBreakdown(['previewer', 'uploader']),
    'Previewer + Uploader'
  );
});

test('context-menu capabilities enforce zero-over-privilege for all eight roles', () => {
  const owner = menuFor('owner');
  assert.equal(owner.canOpen, true);
  assert.equal(owner.canDownload, true);
  assert.equal(owner.canRename, true);
  assert.equal(owner.canCopy, true);
  assert.equal(owner.canCut, true);
  assert.equal(owner.canShare, true);
  assert.equal(owner.canPermissions, true);
  assert.equal(owner.canTrash, true);
  assert.equal(owner.canVersionHistory, true);

  const coOwner = menuFor('co_owner');
  assert.equal(coOwner.canPermissions, true);
  assert.equal(coOwner.canTrash, true);

  const editor = menuFor('editor');
  assert.equal(editor.canRename, true);
  assert.equal(editor.canDownload, true);
  assert.equal(editor.canTrash, true);
  assert.equal(editor.canShare, true);
  assert.equal(editor.canPermissions, false);

  const viewer = menuFor('viewer');
  assert.equal(viewer.canOpen, true);
  assert.equal(viewer.canDownload, true);
  assert.equal(viewer.canCopy, true);
  assert.equal(viewer.canCut, false);
  assert.equal(viewer.canRename, false);
  assert.equal(viewer.canTrash, false);
  assert.equal(viewer.canShare, false);
  assert.equal(viewer.canPermissions, false);
  assert.equal(viewer.canVersionHistory, true);

  const previewer = menuFor('previewer');
  assert.equal(previewer.canOpen, true);
  assert.equal(previewer.canDownload, false);
  assert.equal(previewer.canCopy, false);
  assert.equal(previewer.canCut, false);
  assert.equal(previewer.canDuplicate, false);
  assert.equal(previewer.canShare, false);
  assert.equal(previewer.canTrash, false);
  assert.equal(previewer.canVersionHistory, true);

  const uploader = menuFor('uploader');
  assert.equal(uploader.canOpen, false);
  assert.equal(uploader.canDownload, false);
  assert.equal(uploader.canRename, false);
  assert.equal(uploader.canCopy, false);
  assert.equal(uploader.canCut, false);
  assert.equal(uploader.canDuplicate, false);
  assert.equal(uploader.canShare, false);
  assert.equal(uploader.canCopyLink, false);
  assert.equal(uploader.canTrash, false);
  assert.equal(uploader.canInspector, false);
  assert.equal(uploader.canVersionHistory, false);

  const previewerUploader = menuFor('previewer_uploader');
  assert.equal(previewerUploader.canOpen, true);
  assert.equal(previewerUploader.canDownload, false);
  assert.equal(previewerUploader.canCopy, false);
  assert.equal(previewerUploader.canCut, false);
  assert.equal(previewerUploader.canRename, false);
  assert.equal(previewerUploader.canShare, false);
  assert.equal(previewerUploader.canTrash, false);
  assert.equal(previewerUploader.canVersionHistory, true);

  const viewerUploader = menuFor('viewer_uploader');
  assert.equal(viewerUploader.canOpen, true);
  assert.equal(viewerUploader.canDownload, true);
  assert.equal(viewerUploader.canCopy, true);
  assert.equal(viewerUploader.canDuplicate, true);
  assert.equal(viewerUploader.canCut, false);
  assert.equal(viewerUploader.canRename, false);
  assert.equal(viewerUploader.canShare, true);
  assert.equal(viewerUploader.canPermissions, false);
  assert.equal(viewerUploader.canTrash, false);
  assert.equal(viewerUploader.canVersionHistory, true);
});

test('copy destination requires source download + destination upload_new', () => {
  const baseInput = {
    targetFolderId: 'folder-dest',
    targetClassification: 'internal' as const,
    isAncestorOf: () => false,
  };
  const itemFor = (role: ResourceRole): DragWorkspaceItem => ({
    type: 'file',
    id: 'file-1',
    name: 'spec.txt',
    parentId: 'folder-1',
    classification: 'internal',
    effectiveRole: role,
  });

  for (const role of ['previewer', 'uploader', 'previewer_uploader'] as const) {
    const result = evaluateCopyDestination({
      ...baseInput,
      items: [itemFor(role)],
      targetEffectiveRole: 'editor',
      resolveItemRole: (item) => item.effectiveRole ?? role,
    });
    assert.equal(result.allowed, false, `${role} copy must be blocked`);
    assert.match(result.reason ?? '', /DLP|Previewer/);
  }

  for (const role of ['viewer', 'viewer_uploader', 'editor', 'co_owner', 'owner'] as const) {
    const result = evaluateCopyDestination({
      ...baseInput,
      items: [itemFor(role)],
      targetEffectiveRole: 'editor',
      resolveItemRole: (item) => item.effectiveRole ?? role,
    });
    assert.equal(result.allowed, true, `${role} copy must be allowed`);
  }

  const viewerUploaderToViewer = evaluateCopyDestination({
    ...baseInput,
    items: [itemFor('viewer_uploader')],
    targetEffectiveRole: 'viewer',
    resolveItemRole: (item) => item.effectiveRole ?? 'viewer_uploader',
  });
  assert.equal(viewerUploaderToViewer.allowed, false);
  assert.match(viewerUploaderToViewer.reason ?? '', /コピー先/);

  const editorToUploader = evaluateCopyDestination({
    ...baseInput,
    items: [itemFor('editor')],
    targetEffectiveRole: 'uploader',
    resolveItemRole: (item) => item.effectiveRole ?? 'editor',
  });
  assert.equal(editorToUploader.allowed, true);

  const editorToPreviewerUploader = evaluateCopyDestination({
    ...baseInput,
    items: [itemFor('editor')],
    targetEffectiveRole: 'previewer_uploader',
    resolveItemRole: (item) => item.effectiveRole ?? 'editor',
  });
  assert.equal(editorToPreviewerUploader.allowed, true);
});

test('drag/drop movement requires source move + destination folder.create', () => {
  const folderItem = (role: ResourceRole): DragWorkspaceItem => ({
    type: 'folder',
    id: 'folder-src',
    name: 'Source',
    parentId: null,
    classification: 'internal',
    effectiveRole: role,
  });

  for (const role of ['viewer', 'previewer', 'uploader', 'previewer_uploader', 'viewer_uploader'] as const) {
    const result = evaluateDropTarget({
      dragItems: [folderItem(role)],
      targetFolderId: 'folder-dest',
      targetClassification: 'internal',
      targetEffectiveRole: 'editor',
      isAncestorOf: () => false,
      resolveItemRole: (item) => item.effectiveRole ?? role,
    });
    assert.equal(result.allowed, false, `${role} must not move folders`);
  }

  for (const role of ['editor', 'co_owner', 'owner'] as const) {
    const result = evaluateDropTarget({
      dragItems: [folderItem(role)],
      targetFolderId: 'folder-dest',
      targetClassification: 'internal',
      targetEffectiveRole: 'editor',
      isAncestorOf: () => false,
      resolveItemRole: (item) => item.effectiveRole ?? role,
    });
    assert.equal(result.allowed, true, `${role} should move folders`);
  }

  // Viewer + Uploader destination accepts creates, but source still cannot move.
  const uploaderDest = evaluateDropTarget({
    dragItems: [folderItem('viewer_uploader')],
    targetFolderId: 'folder-dest',
    targetClassification: 'internal',
    targetEffectiveRole: 'uploader',
    isAncestorOf: () => false,
    resolveItemRole: (item) => item.effectiveRole ?? 'viewer_uploader',
  });
  assert.equal(uploaderDest.allowed, false);

  const rootPromotionEditor = evaluateDropTarget({
    dragItems: [
      {
        type: 'folder',
        id: 'folder-nested',
        name: 'Nested',
        parentId: 'folder-parent',
        classification: 'internal',
        effectiveRole: 'editor',
      },
    ],
    targetFolderId: null,
    targetClassification: 'unset',
    isAncestorOf: () => false,
    resolveItemRole: () => 'editor',
  });
  assert.equal(rootPromotionEditor.allowed, false);
  assert.match(rootPromotionEditor.reason ?? '', /Owner/);

  const rootPromotionOwner = evaluateDropTarget({
    dragItems: [
      {
        type: 'folder',
        id: 'folder-nested',
        name: 'Nested',
        parentId: 'folder-parent',
        classification: 'internal',
        effectiveRole: 'owner',
      },
    ],
    targetFolderId: null,
    targetClassification: 'unset',
    isAncestorOf: () => false,
    resolveItemRole: () => 'owner',
  });
  assert.equal(rootPromotionOwner.allowed, true);
});

test('explicit server capability arrays override row role fallbacks', () => {
  const folder = makeFolder({
    effectiveRole: 'owner',
    capabilities: ['folder.list', 'item.preview'],
  });
  assert.equal(canAccess(folder, 'item.download'), false);
  assert.equal(canAccess(folder, 'item.preview'), true);

  const fileRow: ContextRowTarget = {
    kind: 'file',
    file: makeFile({ effectiveRole: 'owner' }),
  };
  const caps = buildContextMenuCapabilities({
    targets: [fileRow],
    primaryRow: fileRow,
    currentFolderId: 'folder-1',
    folderRole: 'owner',
    folderCapabilities: ['folder.list', 'item.preview'],
    isPrivilegedAdmin: false,
    isSysAdmin: false,
    hasClipboardItems: false,
    clipboardHasFiles: false,
    resolveRowRole: () => 'owner',
    resolveRowCapabilities: () => ['folder.list', 'item.preview'],
  });
  assert.equal(caps.canOpen, true);
  assert.equal(caps.canDownload, false);
  assert.equal(caps.canRename, false);
  assert.equal(caps.canCopy, false);
  assert.equal(caps.canTrash, false);
});
