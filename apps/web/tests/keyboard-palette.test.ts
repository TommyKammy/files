import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPaletteCommands,
  isEditableTarget,
  isImeComposingEvent,
  isTrashShortcut,
  KeyboardScopeStack,
  mergePaletteEntries,
  parseSearchQuery,
  selectKeyRange,
  shouldHandleWorkspaceKey,
  toggleKeySelection,
} from '@/lib/keyboard-shortcuts';
import type { SyncPersistenceAdapter, WorkingSetSnapshot } from '@/lib/sync-idb';
import { WorkspaceSyncStore } from '@/lib/sync-store';
import type {
  AuthUser,
  BootstrapResponse,
  FileItem,
  FolderChildrenResponse,
  FolderSummary,
  OutboxMutationRecord,
  SearchResultItem,
  TenantPolicyRow,
} from '@/types/files';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    email: 'alice@example.com',
    displayName: 'Alice',
    role: 'member',
    ipAddress: '127.0.0.1',
    ...overrides,
  };
}

function makePolicy(tenantId = 'tenant-1'): TenantPolicyRow {
  return {
    tenant_id: tenantId,
    enforce_company_only_links: 1,
    require_watermark_confidential: 1,
    max_link_expiration_days: 30,
    session_max_hours: 12,
    trash_retention_days: 30,
    ai_classification_mode: 'metadata_only',
    ai_auto_apply_threshold: 0.9,
    updated_by: null,
    updated_at: '2026-11-15T00:00:00.000Z',
  };
}

function makeMemoryPersistence(): SyncPersistenceAdapter {
  const snapshots = new Map<string, WorkingSetSnapshot>();
  const outboxes = new Map<string, OutboxMutationRecord[]>();
  return {
    async loadScope(tenantId, userId) {
      return snapshots.get(`${tenantId}:${userId}`) ?? null;
    },
    async saveSnapshot(tenantId, userId, snapshot) {
      snapshots.set(`${tenantId}:${userId}`, structuredClone(snapshot));
    },
    async loadOutbox(tenantId, userId) {
      return structuredClone(outboxes.get(`${tenantId}:${userId}`) ?? []);
    },
    async saveOutbox(tenantId, userId, records) {
      outboxes.set(`${tenantId}:${userId}`, structuredClone(records));
    },
    async purgeScope(tenantId, userId) {
      snapshots.delete(`${tenantId}:${userId}`);
      outboxes.delete(`${tenantId}:${userId}`);
    },
    async purgeAllScopes() {
      snapshots.clear();
      outboxes.clear();
    },
  };
}

function makeFolder(overrides: Partial<FolderSummary> & { id: string; name: string }): FolderSummary {
  return {
    parent_id: null,
    version: 1,
    classification: 'internal',
    is_pinned: 0,
    deleted_at: null,
    updated_at: '2026-11-15T01:00:00.000Z',
    effectiveRole: 'editor',
    ...overrides,
  };
}

function makeFile(overrides: Partial<FileItem> & { id: string; name: string }): FileItem {
  return {
    folder_id: 'f-root',
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 2048,
    current_version_num: 1,
    meta_version: 1,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    deleted_at: null,
    updated_at: '2026-11-15T01:00:00.000Z',
    ...overrides,
  };
}

test('KeyboardScopeStack enforces LIFO topmost overlay isolation and clean unwind', () => {
  const stack = new KeyboardScopeStack();
  assert.equal(stack.getTopScope(), 'workspace');

  const previewToken = stack.pushScope('preview');
  assert.equal(stack.getTopScope(), 'preview');
  assert.equal(stack.isTopToken(previewToken), true);

  const paletteToken = stack.pushScope('palette');
  assert.equal(stack.getTopScope(), 'palette');
  assert.equal(stack.isTopToken(previewToken), false);
  assert.equal(stack.isTopToken(paletteToken), true);

  stack.popScope(paletteToken);
  assert.equal(stack.getTopScope(), 'preview');
  assert.equal(stack.isTopToken(previewToken), true);

  stack.popScope(previewToken);
  assert.equal(stack.getTopScope(), 'workspace');
  assert.equal(stack.getDepth(), 0);

  // Phase 6 overlays: contextMenu and moveCopyModal must isolate workspace hotkeys cleanly in LIFO order
  const menuToken = stack.pushScope('contextMenu');
  assert.equal(stack.getTopScope(), 'contextMenu');
  assert.equal(shouldHandleWorkspaceKey({ key: 'm', target: { tagName: 'DIV' } }, stack.getTopScope()), false);

  const modalToken = stack.pushScope('moveCopyModal');
  assert.equal(stack.getTopScope(), 'moveCopyModal');
  assert.equal(shouldHandleWorkspaceKey({ key: 'v', target: { tagName: 'DIV' } }, stack.getTopScope()), false);

  stack.popScope(modalToken);
  assert.equal(stack.getTopScope(), 'contextMenu');
  stack.popScope(menuToken);
  assert.equal(stack.getTopScope(), 'workspace');
});

test('IME composition and editable targets strictly block single-key shortcuts and bare Backspace delete', () => {
  // Japanese IME composition frames (Enter/Escape/r/Delete during kana->kanji conversion)
  assert.equal(isImeComposingEvent({ key: 'Enter', isComposing: true }), true);
  assert.equal(isImeComposingEvent({ key: 'Process' }), true);
  assert.equal(isImeComposingEvent({ key: 'Escape', keyCode: 229 }), true);
  assert.equal(isImeComposingEvent({ key: 'r', isComposing: false }), false);

  assert.equal(
    shouldHandleWorkspaceKey({ key: 'r', isComposing: true }, 'workspace'),
    false
  );
  assert.equal(
    shouldHandleWorkspaceKey({ key: 'Escape', keyCode: 229 }, 'workspace'),
    false
  );
  assert.equal(
    shouldHandleWorkspaceKey(
      { key: 'x', target: { tagName: 'INPUT' } },
      'workspace'
    ),
    false
  );
  assert.equal(
    shouldHandleWorkspaceKey(
      { key: 'j', target: { tagName: 'DIV', isContentEditable: true } },
      'workspace'
    ),
    false
  );
  assert.equal(
    shouldHandleWorkspaceKey({ key: 'j', target: { tagName: 'DIV' } }, 'modal'),
    false
  );
  assert.equal(
    shouldHandleWorkspaceKey({ key: 'j', target: { tagName: 'DIV' } }, 'inlineRename'),
    false
  );
  assert.equal(
    shouldHandleWorkspaceKey({ key: 'j', target: { tagName: 'DIV' } }, 'workspace'),
    true
  );

  // Editable target helper recognizes form fields cleanly
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true);
  assert.equal(isEditableTarget({ tagName: 'select' }), true);
  assert.equal(isEditableTarget({ tagName: 'button' }), false);

  // Backspace navigates up, never deletes; Delete or Cmd/Ctrl+Backspace trashes unless IME composing
  assert.equal(isTrashShortcut({ key: 'Backspace' }), false);
  assert.equal(isTrashShortcut({ key: 'Backspace', metaKey: true }), true);
  assert.equal(isTrashShortcut({ key: 'Backspace', ctrlKey: true }), true);
  assert.equal(isTrashShortcut({ key: 'Delete' }), true);
  assert.equal(
    isTrashShortcut({ key: 'Backspace', metaKey: true, isComposing: true }),
    false
  );
});

test('toggleKeySelection and selectKeyRange handle x and Shift+Click range accurately', () => {
  const order = ['folder:1', 'folder:2', 'file:a', 'file:b', 'file:c'];
  let selected = new Set<string>();

  selected = toggleKeySelection(selected, 'folder:2');
  assert.deepEqual([...selected], ['folder:2']);

  // Forward Shift+Click range from folder:2 to file:b
  selected = selectKeyRange(order, 'folder:2', 'file:b');
  assert.deepEqual([...selected], ['folder:2', 'file:a', 'file:b']);

  // Backward / tightened Shift+Click range from file:b back to folder:1
  selected = selectKeyRange(order, 'file:b', 'folder:1');
  assert.deepEqual([...selected], ['folder:1', 'folder:2', 'file:a', 'file:b']);

  // Un-toggling with x removes individual key cleanly
  selected = toggleKeySelection(selected, 'file:a');
  assert.equal(selected.has('file:a'), false);
  assert.equal(selected.has('folder:1'), true);
});

test('0ms local cache search + > command mode + FTS5 deduplication merge consistently', async () => {
  const user = makeUser({ role: 'sec_admin' });
  const rootFolder = makeFolder({
    id: 'f-root',
    name: '経営企画',
    classification: 'confidential',
    is_pinned: 1,
  });
  const childFile = makeFile({
    id: 'file-conf',
    name: 'q4_financial_audit.pdf',
    classification: 'confidential',
    folder_id: 'f-root',
  });
  const unsetFile = makeFile({
    id: 'file-unset',
    name: 'draft_onboarding.md',
    classification: 'unset',
    ai_suggested_label: 'internal',
    folder_id: 'f-root',
  });
  const pendingUpload = makeFile({
    id: 'file-pending',
    name: 'confidential_uploading.pdf',
    classification: 'confidential',
    upload_state: 'pending',
    optimistic: true,
    folder_id: 'f-root',
  });

  const bootstrapPayload: BootstrapResponse = {
    user,
    policy: makePolicy(),
    rootFolders: [rootFolder],
    pinnedFolders: [rootFolder],
    currentSeq: 1,
    purgedBeforeSeq: 0,
  };

  const store = new WorkspaceSyncStore({
    persistence: makeMemoryPersistence(),
    readScopeHint: () => null,
    writeScopeHint: () => undefined,
    fetchBootstrap: async () => bootstrapPayload,
    fetchDelta: async () => ({
      resetRequired: false,
      currentSeq: 1,
      purgedBeforeSeq: 0,
      nextSeq: 1,
      hasMore: false,
      changes: [],
    }),
    fetchFolderChildren: async (): Promise<FolderChildrenResponse> => ({
      folder: rootFolder,
      effectiveRole: 'editor',
      breadcrumbs: [
        {
          id: 'f-root',
          name: '経営企画',
          classification: 'confidential',
          depth: 0,
        },
      ],
      folders: [],
      files: [childFile, unsetFile, pendingUpload],
      nextCursor: null,
    }),
  });

  await store.bootstrap();
  await store.ensureDirectoryLoaded('f-root');

  // Pending upload rows must stay excluded from quick search results
  const confHits = store.searchCachedWorkspaceItems('is:confidential audit');
  assert.equal(confHits.folders.length, 0);
  assert.equal(confHits.files.length, 1);
  assert.equal(confHits.files[0]?.id, 'file-conf');

  // Classification chip only matches confidential folder + active confidential file (not pending upload)
  const allConf = store.searchCachedWorkspaceItems('is:confidential');
  assert.equal(allConf.folders.map((f) => f.folder.id).includes('f-root'), true);
  assert.deepEqual(
    allConf.files.map((f) => f.id),
    ['file-conf']
  );

  // Command mode parses '>' and blocks local search hits while matching executable commands
  assert.equal(parseSearchQuery('> ガバナンス').isCommandMode, true);
  assert.deepEqual(store.searchCachedWorkspaceItems('> ガバナンス'), {
    folders: [],
    files: [],
  });

  const commands = buildPaletteCommands({
    isAdmin: true,
    isWorkspace: true,
    hasTargetItem: true,
    canClassifyTarget: true,
    canShareTarget: true,
    canTrashTarget: true,
  });

  const commandModeEntries = mergePaletteEntries({
    query: '> ガバナンス',
    commands,
    localFolders: [],
    localFiles: [],
    remoteResults: [],
  });
  assert.equal(commandModeEntries.length, 1);
  assert.equal(commandModeEntries[0]?.kind, 'command');
  if (commandModeEntries[0]?.kind === 'command') {
    assert.equal(commandModeEntries[0].command.id, 'nav:admin');
  }

  // Hybrid merge prioritizes 0ms local matches and deduplicates overlapping FTS5 IDs
  const ftsRemoteDuplicate: SearchResultItem = {
    id: 'file-conf',
    folderId: 'f-root',
    folderName: '経営企画',
    name: 'q4_financial_audit.pdf',
    extension: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    classification: 'confidential',
    aiSuggestedLabel: null,
    aiConfidence: null,
    updatedAt: '2026-11-15T01:00:00.000Z',
  };
  const ftsRemoteUnique: SearchResultItem = {
    id: 'file-remote-only',
    folderId: 'f-archive',
    folderName: '過去監査',
    name: 'q3_audit_summary.pdf',
    extension: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    classification: 'confidential',
    aiSuggestedLabel: null,
    aiConfidence: null,
    updatedAt: '2026-11-10T01:00:00.000Z',
  };

  const hybridEntries = mergePaletteEntries({
    query: 'audit',
    commands,
    localFolders: store.searchCachedWorkspaceItems('audit').folders,
    localFiles: store.searchCachedWorkspaceItems('audit').files,
    remoteResults: [ftsRemoteDuplicate, ftsRemoteUnique],
  });

  const fileEntries = hybridEntries.filter((e) => e.kind === 'file');
  assert.equal(fileEntries.length, 2);
  assert.equal(fileEntries[0]?.kind === 'file' ? fileEntries[0].source : '', 'local');
  assert.equal(
    fileEntries[0]?.kind === 'file' ? fileEntries[0].item.id : '',
    'file-conf'
  );
  assert.equal(fileEntries[1]?.kind === 'file' ? fileEntries[1].source : '', 'fts5');
  assert.equal(
    fileEntries[1]?.kind === 'file' ? fileEntries[1].item.id : '',
    'file-remote-only'
  );
});

test('buildPaletteCommands exposes Phase 6 clipboard, inspector, and view commands while enforcing DLP gating', () => {
  const fullIds = buildPaletteCommands({
    isAdmin: false,
    isWorkspace: true,
    hasTargetItem: true,
    canClassifyTarget: true,
    canShareTarget: true,
    canTrashTarget: true,
    canCopyTarget: true,
    canCutTarget: true,
    canPasteClipboard: true,
    canDuplicateTarget: true,
  }).map((c) => c.id);

  for (const expectedId of [
    'cmd:move-copy',
    'cmd:paste',
    'cmd:copy',
    'cmd:cut',
    'cmd:duplicate',
    'cmd:toggle-inspector',
    'cmd:toggle-view',
  ] as const) {
    assert.equal(fullIds.includes(expectedId), true, `Expected ${expectedId} in palette`);
  }

  // Previewer DLP gating suppresses copy/cut/paste/duplicate while preserving view & inspector toggle
  const previewerIds = buildPaletteCommands({
    isAdmin: false,
    isWorkspace: true,
    hasTargetItem: true,
    canClassifyTarget: false,
    canShareTarget: false,
    canTrashTarget: false,
    canCopyTarget: false,
    canCutTarget: false,
    canPasteClipboard: false,
    canDuplicateTarget: false,
  }).map((c) => c.id);

  assert.equal(previewerIds.includes('cmd:copy'), false);
  assert.equal(previewerIds.includes('cmd:cut'), false);
  assert.equal(previewerIds.includes('cmd:paste'), false);
  assert.equal(previewerIds.includes('cmd:duplicate'), false);
  assert.equal(previewerIds.includes('cmd:toggle-inspector'), true);
  assert.equal(previewerIds.includes('cmd:toggle-view'), true);
});
