import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  WORKSPACE_CLIPBOARD_STORAGE_KEY,
  WorkspaceClipboardStore,
} from '@/lib/workspace-clipboard';
import type { SyncPersistenceAdapter } from '@/lib/sync-idb';
import type {
  AuthUser,
  BootstrapResponse,
  FileItem,
  FolderChildrenResponse,
  FolderSummary,
  TenantPolicyRow,
} from '@/types/files';

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-a',
    tenantId: 'tenant-1',
    email: 'a@example.com',
    displayName: 'User A',
    role: 'member',
    ipAddress: '127.0.0.1',
    userType: 'member',
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

function makeFolder(id: string, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id,
    parent_id: null,
    name: `Folder ${id}`,
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-11-15T00:00:00.000Z',
    effectiveRole: 'editor',
    ...overrides,
  };
}

function makeFile(
  id: string,
  folderId: string | null,
  overrides: Partial<FileItem> = {}
): FileItem {
  return {
    id,
    folder_id: folderId,
    name: `${id}.pdf`,
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    current_version_num: 1,
    meta_version: 1,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-11-15T00:00:00.000Z',
    upload_state: 'active',
    ...overrides,
  };
}

class MemoryPersistence implements SyncPersistenceAdapter {
  async loadScope() {
    return null;
  }
  async saveSnapshot() {}
  async loadOutbox() {
    return [];
  }
  async saveOutbox() {}
  async purgeScope() {}
  async purgeAllScopes() {}
}

test('WorkspaceClipboardStore syncs cut/copy across tabs cleanly and enforces user/tenant isolation', () => {
  const rawStorage = new Map<string, string>();
  const storage = {
    getItem: (k: string) => rawStorage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      rawStorage.set(k, v);
    },
    removeItem: (k: string) => {
      rawStorage.delete(k);
    },
  };

  type Listener = (ev: { data: unknown }) => void;
  const channels = new Set<{ listeners: Set<Listener> }>();
  const createChannel = () => {
    const ch = {
      listeners: new Set<Listener>(),
      postMessage(data: unknown) {
        for (const peer of channels) {
          if (peer === ch) continue;
          for (const fn of peer.listeners) {
            fn({ data });
          }
        }
      },
      addEventListener(_type: 'message', fn: Listener) {
        ch.listeners.add(fn);
      },
      removeEventListener(_type: 'message', fn: Listener) {
        ch.listeners.delete(fn);
      },
      close() {
        channels.delete(ch);
      },
    };
    channels.add(ch);
    return ch;
  };

  const tabA = new WorkspaceClipboardStore({
    storage,
    createChannel,
    registerPurgeHook: () => () => {},
  });
  const tabB = new WorkspaceClipboardStore({
    storage,
    createChannel,
    registerPurgeHook: () => () => {},
  });
  const tabOtherUser = new WorkspaceClipboardStore({
    storage,
    createChannel,
    registerPurgeHook: () => () => {},
  });

  tabA.setScope({ id: 'user-a', tenantId: 'tenant-1' });
  tabB.setScope({ id: 'user-a', tenantId: 'tenant-1' });
  tabOtherUser.setScope({ id: 'user-b', tenantId: 'tenant-1' });

  tabA.setClipboard('cut', [
    {
      type: 'file',
      id: 'f-1',
      name: 'contract.pdf',
      parentId: 'dir-1',
      classification: 'confidential',
      version: 2,
    },
  ]);

  assert.equal(tabB.getItemCount(), 1);
  assert.equal(tabB.getState()?.mode, 'cut');
  assert.equal(tabB.isCutPending('file', 'f-1'), true);

  // Other user tab must NEVER see user-a clipboard items
  assert.equal(tabOtherUser.getState(), null);
  assert.equal(tabOtherUser.isCutPending('file', 'f-1'), false);

  // Pasting in cut mode clears BOTH Tab A and Tab B via BroadcastChannel
  tabB.completePaste();
  assert.equal(tabB.getState(), null);
  assert.equal(tabA.getState(), null);
  assert.equal(tabA.isCutPending('file', 'f-1'), false);
  assert.equal(rawStorage.get(WORKSPACE_CLIPBOARD_STORAGE_KEY), undefined);

  // Copy mode stays intact after paste for repeat pasting
  tabA.setClipboard('copy', [
    {
      type: 'folder',
      id: 'fld-1',
      name: 'Templates',
      parentId: null,
      classification: 'internal',
      version: 1,
    },
  ]);
  assert.equal(tabB.isCutPending('folder', 'fld-1'), false);
  tabB.completePaste();
  assert.equal(tabB.getItemCount(), 1);

  tabA.dispose();
  tabB.dispose();
  tabOtherUser.dispose();
});

test('WorkspaceSyncStore executes 0ms optimistic batch-move + Undo + rollback + idempotent WS merge', async () => {
  const dirSrc = makeFolder('dir-src', { effectiveRole: 'editor', name: 'Source' });
  const dirChild = makeFolder('dir-child', {
    parent_id: 'dir-src',
    effectiveRole: 'editor',
    name: 'NestedFolder',
  });
  const dirConfDest = makeFolder('dir-conf', {
    effectiveRole: 'editor',
    name: 'ConfidentialDest',
    classification: 'confidential',
  });
  const fileInSrc = makeFile('f-1', 'dir-src', { name: 'budget.xlsx', meta_version: 2 });

  const dirState: Record<string, { folders: FolderSummary[]; files: FileItem[] }> = {
    'dir-src': { folders: [dirChild], files: [fileInSrc] },
    'dir-conf': { folders: [], files: [] },
  };

  let failNextBatchMove: Error | null = null;
  let deliverDuplicateMoveDelta = false;
  const batchMoveCalls: Array<{
    items: Array<{ type: string; id: string; expectedVersion?: number }>;
    targetParentId: string | null;
  }> = [];

  const store = new WorkspaceSyncStore({
    persistence: new MemoryPersistence(),
    outboxCoalesceMs: 5,
    fetchBootstrap: async (): Promise<BootstrapResponse> => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [dirSrc, dirConfDest],
      pinnedFolders: [],
      currentSeq: 10,
      purgedBeforeSeq: 0,
    }),
    fetchDelta: async () => ({
      currentSeq: deliverDuplicateMoveDelta ? 11 : 10,
      nextSeq: deliverDuplicateMoveDelta ? 11 : 10,
      purgedBeforeSeq: 0,
      resetRequired: false,
      hasMore: false,
      changes: deliverDuplicateMoveDelta
        ? [
            {
              seq: 11,
              entityType: 'file',
              entityId: 'f-1',
              folderId: 'dir-src',
              action: 'file.moved_out',
              targetUserId: null,
              payload: { toFolderId: 'dir-conf', metaVersion: 3 },
              createdAt: '2026-11-15T01:00:00.000Z',
            },
            {
              seq: 11,
              entityType: 'file',
              entityId: 'f-1',
              folderId: 'dir-conf',
              action: 'file.update',
              targetUserId: null,
              payload: {
                name: 'budget.xlsx',
                extension: 'xlsx',
                folderId: 'dir-conf',
                previousFolderId: 'dir-src',
                classification: 'confidential',
                metaVersion: 3,
              },
              createdAt: '2026-11-15T01:00:00.000Z',
            },
            {
              seq: 11,
              entityType: 'folder',
              entityId: 'dir-child',
              folderId: 'dir-conf',
              action: 'folder.move',
              targetUserId: null,
              payload: {
                fromParentId: 'dir-src',
                toParentId: 'dir-conf',
                classification: 'confidential',
                version: 2,
              },
              createdAt: '2026-11-15T01:00:00.000Z',
            },
          ]
        : [],
    }),
    fetchFolderChildren: async (folderId): Promise<FolderChildrenResponse> => {
      const target = folderId === 'dir-conf' ? dirConfDest : dirSrc;
      return {
        folder: target,
        effectiveRole: 'editor',
        folders: dirState[folderId]?.folders ?? [],
        files: dirState[folderId]?.files ?? [],
        nextCursor: null,
        breadcrumbs: [
          {
            id: target.id,
            name: target.name,
            classification: target.classification,
            depth: 0,
          },
        ],
      };
    },
    batchMoveFn: async (payload) => {
      batchMoveCalls.push(payload);
      if (failNextBatchMove) {
        const err = failNextBatchMove;
        failNextBatchMove = null;
        throw err;
      }
      const movingTo = payload.targetParentId;
      const movedFolders = payload.items
        .filter((i) => i.type === 'folder')
        .map((i) => ({
          ...dirChild,
          id: i.id,
          parent_id: movingTo,
          classification:
            movingTo === 'dir-conf' ? ('confidential' as const) : ('internal' as const),
          version: (i.expectedVersion ?? 1) + 1,
        }));
      const movedFiles = payload.items
        .filter((i) => i.type === 'file')
        .map((i) => ({
          ...fileInSrc,
          id: i.id,
          folder_id: movingTo,
          classification:
            movingTo === 'dir-conf' ? ('confidential' as const) : ('internal' as const),
          meta_version: (i.expectedVersion ?? 2) + 1,
        }));
      return {
        ok: true,
        movedFolders,
        movedFiles,
        skippedIds: [],
        classificationJobQueued: false,
      };
    },
  });

  await store.bootstrap({ force: true });
  await store.ensureDirectoryLoaded('dir-src', { force: true });
  await store.ensureDirectoryLoaded('dir-conf', { force: true });

  // 1. Cycle check & root-owner guard at 0ms
  const cycleRes = store.optimisticMoveItems({
    items: [{ type: 'folder', id: 'dir-src' }],
    targetParentId: 'dir-src',
  });
  assert.equal(cycleRes.ok, false);

  const rootPromoteByEditor = store.optimisticMoveItems({
    items: [{ type: 'folder', id: 'dir-child' }],
    targetParentId: null,
  });
  assert.equal(rootPromoteByEditor.ok, false);

  // 2. Mixed batch move dir-child + f-1 from dir-src -> dir-conf at 0ms!
  const moveRes = store.optimisticMoveItems({
    items: [
      { type: 'folder', id: 'dir-child' },
      { type: 'file', id: 'f-1' },
    ],
    targetParentId: 'dir-conf',
  });
  assert.equal(moveRes.ok, true);
  assert.equal(moveRes.movedCount, 2);

  // Synchronous 0ms UI state BEFORE flushOutbox
  assert.equal(store.getDirectoryView('dir-src').folders.length, 0);
  assert.equal(store.getDirectoryView('dir-src').files.length, 0);
  assert.equal(store.getDirectoryView('dir-conf').folders[0]?.id, 'dir-child');
  assert.equal(store.getDirectoryView('dir-conf').folders[0]?.classification, 'confidential');
  assert.equal(store.getDirectoryView('dir-conf').files[0]?.id, 'f-1');
  assert.equal(store.getDirectoryView('dir-conf').files[0]?.classification, 'confidential');

  await store.flushOutbox();
  assert.equal(batchMoveCalls.length, 1);
  assert.equal(store.getDirectoryView('dir-conf').folders[0]?.version, 2);
  assert.equal(store.getDirectoryView('dir-conf').files[0]?.meta_version, 3);

  // 3. Duplicate WS delta delivery must stay idempotent without duplicating entries or overwriting version
  deliverDuplicateMoveDelta = true;
  await store.syncDelta();
  deliverDuplicateMoveDelta = false;
  assert.equal(store.getDirectoryView('dir-conf').folders.length, 1);
  assert.equal(store.getDirectoryView('dir-conf').folders[0]?.version, 2);
  assert.equal(store.getDirectoryView('dir-conf').files.length, 1);
  assert.equal(store.getDirectoryView('dir-conf').files[0]?.meta_version, 3);

  // 4. Undo (Cmd+Z) moves both items back to dir-src using server-bumped versions
  const undone = await store.undoLatest();
  assert.equal(undone, true);
  assert.equal(store.getDirectoryView('dir-conf').folders.length, 0);
  assert.equal(store.getDirectoryView('dir-conf').files.length, 0);
  assert.equal(store.getDirectoryView('dir-src').folders[0]?.id, 'dir-child');
  assert.equal(store.getDirectoryView('dir-src').files[0]?.id, 'f-1');
  await store.flushOutbox();
  assert.equal(batchMoveCalls[1]?.targetParentId, 'dir-src');

  // 5. Server 403 error rolls back moved items from target directory back to source + emits toast
  failNextBatchMove = Object.assign(new Error('Forbidden move'), { status: 403 });
  store.optimisticMoveItems({
    items: [{ type: 'file', id: 'f-1' }],
    targetParentId: 'dir-conf',
  });
  assert.equal(store.getDirectoryView('dir-conf').files.length, 1);
  await store.flushOutbox();
  assert.equal(store.getDirectoryView('dir-conf').files.length, 0);
  assert.equal(store.getDirectoryView('dir-src').files.length, 1);
  assert.ok(store.getSnapshot().toasts.some((t) => t.kind === 'error'));
});

test('WorkspaceSyncStore executes 0ms optimistic CoW Copy, DLP previewer block, pre-ACK & post-ACK Undo, and 413 rollback', async () => {
  const dirPreviewOnly = makeFolder('dir-prev', { effectiveRole: 'previewer', name: 'PreviewVault' });
  const dirEditable = makeFolder('dir-edit', {
    effectiveRole: 'editor',
    name: 'WorkFolder',
    classification: 'confidential',
  });
  const previewFile = makeFile('f-prev', 'dir-prev', { name: 'secret-view.pdf' });
  const srcFile = makeFile('f-src', 'dir-edit', { name: 'spec.txt', meta_version: 4 });

  let copyCallCount = 0;
  let softDeletedIds: string[] = [];
  let failCopyErr: Error | null = null;

  const store = new WorkspaceSyncStore({
    persistence: new MemoryPersistence(),
    outboxCoalesceMs: 15,
    fetchBootstrap: async (): Promise<BootstrapResponse> => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [dirPreviewOnly, dirEditable],
      pinnedFolders: [],
      currentSeq: 20,
      purgedBeforeSeq: 0,
    }),
    fetchDelta: async () => ({
      currentSeq: 20,
      nextSeq: 20,
      purgedBeforeSeq: 0,
      resetRequired: false,
      hasMore: false,
      changes: [],
    }),
    fetchFolderChildren: async (folderId): Promise<FolderChildrenResponse> => ({
      folder: folderId === 'dir-prev' ? dirPreviewOnly : dirEditable,
      effectiveRole: folderId === 'dir-prev' ? 'previewer' : 'editor',
      folders: [],
      files: folderId === 'dir-prev' ? [previewFile] : [srcFile],
      nextCursor: null,
      breadcrumbs: [],
    }),
    copyItemsFn: async (payload) => {
      copyCallCount += 1;
      if (failCopyErr) {
        const err = failCopyErr;
        failCopyErr = null;
        throw err;
      }
      return {
        ok: true,
        queued: false,
        totalItems: payload.items.length,
        copiedFolders: [],
        copiedFiles: [
          makeFile('f-real-copy', payload.targetParentId, {
            name: 'spec (コピー).txt',
            classification: 'confidential',
            meta_version: 1,
          }),
        ],
      };
    },
    softDeleteFileFn: async (fileId) => {
      softDeletedIds.push(fileId);
      return { ok: true };
    },
  });

  await store.bootstrap({ force: true });
  await store.ensureDirectoryLoaded('dir-prev', { force: true });
  await store.ensureDirectoryLoaded('dir-edit', { force: true });

  // 1. DLP Previewer block at 0ms
  const dlpBlocked = store.optimisticCopyItems({
    items: [{ type: 'file', id: 'f-prev' }],
    targetParentId: 'dir-edit',
  });
  assert.equal(dlpBlocked.ok, false);
  assert.equal(copyCallCount, 0);

  // 2. Duplicate / copy into same folder creates immediate 'spec (コピー).txt' optimistic row at 0ms
  const copyOk = store.optimisticCopyItems({
    items: [{ type: 'file', id: 'f-src' }],
    targetParentId: 'dir-edit',
  });
  assert.equal(copyOk.ok, true);
  assert.equal(copyOk.tempIds.length, 1);

  const preAckFiles = store.getDirectoryView('dir-edit').files;
  assert.equal(preAckFiles.length, 2);
  const optimisticRow = preAckFiles.find((f) => f.id === copyOk.tempIds[0]);
  assert.equal(optimisticRow?.name, 'spec (コピー).txt');
  assert.equal(optimisticRow?.optimistic, true);
  assert.equal(optimisticRow?.classification, 'confidential');

  // Reconcile server ACK -> temp ID replaced smoothly without duplicate row
  await store.flushOutbox();
  assert.equal(copyCallCount, 1);
  const postAckFiles = store.getDirectoryView('dir-edit').files;
  assert.equal(postAckFiles.length, 2);
  assert.ok(postAckFiles.some((f) => f.id === 'f-real-copy' && f.optimistic === false));
  assert.equal(
    postAckFiles.some((f) => f.id === copyOk.tempIds[0]),
    false
  );

  // 3. Undo after ACK deletes 'f-real-copy' cleanly
  await store.undoLatest();
  await store.flushOutbox();
  assert.deepEqual(softDeletedIds, ['f-real-copy']);
  assert.equal(store.getDirectoryView('dir-edit').files.length, 1);

  // 4. Undo INSIDE 100ms coalesce window cancels queued copy with ZERO network requests!
  const beforePreUndoCalls = copyCallCount;
  const quickCopy = store.optimisticCopyItems({
    items: [{ type: 'file', id: 'f-src' }],
    targetParentId: 'dir-edit',
  });
  assert.equal(quickCopy.ok, true);
  assert.equal(store.getDirectoryView('dir-edit').files.length, 2);
  await store.undoLatest();
  assert.equal(store.getDirectoryView('dir-edit').files.length, 1);
  await store.flushOutbox();
  assert.equal(copyCallCount, beforePreUndoCalls);

  // 5. Server 413 quota error removes temp placeholder and posts toast
  failCopyErr = Object.assign(new Error('Storage quota exceeded'), { status: 413 });
  const quotaCopy = store.optimisticCopyItems({
    items: [{ type: 'file', id: 'f-src' }],
    targetParentId: 'dir-edit',
  });
  assert.equal(quotaCopy.ok, true);
  assert.equal(store.getDirectoryView('dir-edit').files.length, 2);
  await store.flushOutbox();
  assert.equal(store.getDirectoryView('dir-edit').files.length, 1);
  assert.ok(store.getSnapshot().toasts.some((t) => t.kind === 'error'));
});
