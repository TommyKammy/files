import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdminAiBatchCoalescer,
  type AdminAiBatchItem,
  MutationOutbox,
} from '@/lib/mutation-outbox';
import type { SyncPersistenceAdapter, WorkingSetSnapshot } from '@/lib/sync-idb';
import { WorkspaceSyncStore } from '@/lib/sync-store';
import type {
  AuthUser,
  BootstrapResponse,
  FileItem,
  FolderChildrenResponse,
  FolderSummary,
  OutboxMutationRecord,
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

function makeFile(id: string, folderId: string | null, overrides: Partial<FileItem> = {}): FileItem {
  return {
    id,
    folder_id: folderId,
    name: `${id}.pdf`,
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 2048,
    current_version_num: 1,
    meta_version: 1,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-11-15T00:00:00.000Z',
    ...overrides,
  };
}

class MemoryPersistence implements SyncPersistenceAdapter {
  snapshots = new Map<string, WorkingSetSnapshot>();
  outboxes = new Map<string, OutboxMutationRecord[]>();

  async loadScope(tenantId: string, userId: string): Promise<WorkingSetSnapshot | null> {
    return this.snapshots.get(`${tenantId}:${userId}`) ?? null;
  }

  async saveSnapshot(tenantId: string, userId: string, snapshot: WorkingSetSnapshot): Promise<void> {
    this.snapshots.set(`${tenantId}:${userId}`, structuredClone(snapshot));
  }

  async loadOutbox(tenantId: string, userId: string): Promise<OutboxMutationRecord[]> {
    return structuredClone(this.outboxes.get(`${tenantId}:${userId}`) ?? []);
  }

  async saveOutbox(tenantId: string, userId: string, items: OutboxMutationRecord[]): Promise<void> {
    this.outboxes.set(`${tenantId}:${userId}`, structuredClone(items));
  }

  async purgeScope(tenantId: string, userId: string): Promise<void> {
    this.snapshots.delete(`${tenantId}:${userId}`);
    this.outboxes.delete(`${tenantId}:${userId}`);
  }

  async purgeAllScopes(): Promise<void> {
    this.snapshots.clear();
    this.outboxes.clear();
  }
}

test('Client guardrails block unauthorized edits and confidential ancestor downgrades synchronously at 0ms', async () => {
  const secretParent = makeFolder('sec-folder', {
    classification: 'confidential',
    effectiveRole: 'editor',
  });
  const secretFile = makeFile('f-sec', 'sec-folder', {
    classification: 'confidential',
  });
  const viewerFolder = makeFolder('view-folder', {
    classification: 'internal',
    effectiveRole: 'viewer',
  });
  const viewerFile = makeFile('f-view', 'view-folder', {
    classification: 'internal',
  });

  let apiCalls = 0;
  const store = new WorkspaceSyncStore({
    persistence: new MemoryPersistence(),
    outboxCoalesceMs: 10,
    fetchBootstrap: async (): Promise<BootstrapResponse> => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [secretParent, viewerFolder],
      pinnedFolders: [],
      currentSeq: 1,
      purgedBeforeSeq: 0,
    }),
    fetchFolderChildren: async (folderId): Promise<FolderChildrenResponse> => {
      if (folderId === 'sec-folder') {
        return {
          folder: secretParent,
          effectiveRole: 'editor',
          folders: [],
          files: [secretFile],
          nextCursor: null,
          breadcrumbs: [
            { id: 'sec-folder', name: secretParent.name, classification: 'confidential', depth: 0 },
          ],
        };
      }
      return {
        folder: viewerFolder,
        effectiveRole: 'viewer',
        folders: [],
        files: [viewerFile],
        nextCursor: null,
        breadcrumbs: [
          { id: 'view-folder', name: viewerFolder.name, classification: 'internal', depth: 0 },
        ],
      };
    },
    updateFileClassificationFn: async () => {
      apiCalls += 1;
      return { ok: true, file: secretFile };
    },
    updateFolderFn: async () => {
      apiCalls += 1;
      return { folder: viewerFolder };
    },
    updateFileMetadataFn: async () => {
      apiCalls += 1;
      return { file: viewerFile };
    },
  });

  await store.bootstrap({ force: true });
  await store.ensureDirectoryLoaded('sec-folder', { force: true });
  await store.ensureDirectoryLoaded('view-folder', { force: true });

  // Downgrade beneath confidential parent is rejected before queueing/network
  const floorRes = store.optimisticUpdateFileClassification(secretFile, {
    classification: 'public',
  });
  assert.equal(floorRes.ok, false);
  assert.match(floorRes.error ?? '', /Confidential/);

  // Viewer role is blocked before queueing/network
  const renameFolderRes = store.optimisticRenameFolder(viewerFolder, 'Should Fail');
  assert.equal(renameFolderRes.ok, false);

  const renameFileRes = store.optimisticRenameFile(viewerFile, 'fail.pdf', 'viewer');
  assert.equal(renameFileRes.ok, false);

  await store.flushOutbox();
  assert.equal(apiCalls, 0);
  await store.flushPersistence();
});

test('MutationOutbox coalesces rapid edits on the same entity within 100ms window and merges folder.create+delete', async () => {
  const executed: OutboxMutationRecord[] = [];
  const folder = makeFolder('f-1', { name: 'Initial', is_pinned: 0, version: 3 });

  const persistence = new MemoryPersistence();
  const store = new WorkspaceSyncStore({
    persistence,
    outboxCoalesceMs: 30,
    fetchBootstrap: async () => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [folder],
      pinnedFolders: [],
      currentSeq: 1,
      purgedBeforeSeq: 0,
    }),
    updateFolderFn: async (folderId, payload) => {
      executed.push({
        id: 'call',
        entityType: 'folder',
        entityId: folderId,
        kind: 'folder.patch',
        payload: { ...payload },
        expectedVersion: payload.expectedVersion,
        createdAt: 0,
        retryCount: 0,
      });
      return {
        folder: {
          ...folder,
          name: payload.name ?? folder.name,
          is_pinned: payload.isPinned ? 1 : 0,
          version: (payload.expectedVersion ?? folder.version) + 1,
        },
      };
    },
    createFolderFn: async () => {
      throw new Error('Cancelled temp create should never reach network');
    },
  });

  await store.bootstrap({ force: true });

  // 1. Rapid rename + pin toggle inside coalesce window -> 1 HTTP PATCH carrying both fields
  const r1 = store.optimisticRenameFolder(folder, 'Phase 5 Docs');
  assert.equal(r1.ok, true);
  assert.equal(store.getDirectoryView(null).folders[0]?.name, 'Phase 5 Docs');

  const updatedView = store.getDirectoryView(null).folders[0]!;
  const r2 = store.optimisticToggleFolderPin(updatedView);
  assert.equal(r2.ok, true);
  assert.equal(store.getPinnedFolders().length, 1);

  // 2. Create temp folder + immediate delete inside coalesce window -> 0 network calls
  const cRes = store.optimisticCreateFolder({
    parentId: null,
    name: 'Ephemeral',
    classification: 'internal',
  });
  assert.equal(cRes.ok, true);
  const createdTemp = store.getDirectoryView(null).folders.find((f) => f.id === cRes.tempId);
  assert.ok(createdTemp);
  store.optimisticSoftDeleteFolder(createdTemp);

  await store.flushOutbox();
  assert.equal(executed.length, 1);
  assert.equal(executed[0]?.expectedVersion, 3);
  assert.equal(executed[0]?.payload.name, 'Phase 5 Docs');
  assert.equal(executed[0]?.payload.isPinned, true);
  assert.equal(store.getDirectoryView(null).folders[0]?.version, 4);
  await store.flushPersistence();
});

test('Outbox rolls back to authoritative 409 latest or 403 snapshot, supports Cmd+Z Undo, and locks pending uploads', async () => {
  const parent = makeFolder('dir-1', { effectiveRole: 'editor' });
  const fileA = makeFile('file-a', 'dir-1', {
    name: 'spec.pdf',
    classification: 'internal',
    meta_version: 2,
  });
  const serverLatestFile: FileItem = {
    ...fileA,
    classification: 'confidential',
    meta_version: 5,
    updated_at: '2026-11-15T05:00:00.000Z',
  };

  let deltaCalls = 0;
  let restoreCalledWith: string | null = null;
  const persistence = new MemoryPersistence();

  const store = new WorkspaceSyncStore({
    persistence,
    outboxCoalesceMs: 10,
    outboxRetryDelayBaseMs: 5,
    fetchBootstrap: async () => ({
      user: makeUser(),
      policy: makePolicy(),
      rootFolders: [parent],
      pinnedFolders: [],
      currentSeq: 10,
      purgedBeforeSeq: 0,
    }),
    fetchDelta: async () => {
      deltaCalls += 1;
      return {
        currentSeq: 10,
        nextSeq: 10,
        purgedBeforeSeq: 0,
        resetRequired: false,
        hasMore: false,
        changes: [],
      };
    },
    fetchFolderChildren: async () => ({
      folder: parent,
      effectiveRole: 'editor',
      folders: [],
      files: [fileA],
      nextCursor: null,
      breadcrumbs: [
        { id: 'dir-1', name: parent.name, classification: 'internal', depth: 0 },
      ],
    }),
    updateFileClassificationFn: async () => {
      throw Object.assign(new Error('Version conflict'), {
        status: 409,
        details: { latest: serverLatestFile },
      });
    },
    softDeleteFileFn: async () => ({ ok: true }),
    restoreFileFn: async (fileId) => {
      restoreCalledWith = fileId;
      return { ok: true, file: serverLatestFile };
    },
    softDeleteFolderFn: async () => {
      throw Object.assign(new Error('Forbidden on root folder'), { status: 403 });
    },
  });

  await store.bootstrap({ force: true });
  await store.ensureDirectoryLoaded('dir-1', { force: true });
  store.setActiveFolder('dir-1');

  // 1. Upload row enters as pending -> locks classification/rename/delete until promoted
  store.startOptimisticUpload('dir-1', 'pending:up-1', {
    name: 'large-report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 50_000,
  });
  const pendingRow = store.getDirectoryView('dir-1').files.find((f) => f.id === 'pending:up-1');
  assert.equal(pendingRow?.upload_state, 'pending');
  assert.equal(
    store.optimisticRenameFile(pendingRow!, 'blocked.pdf', 'editor').ok,
    false
  );
  assert.equal(
    store.optimisticUpdateFileClassification(pendingRow!, { classification: 'public' }).ok,
    false
  );

  // Verify pending upload row is NOT written into persisted IDB snapshot
  await store.flushPersistence();
  const persistedSnap = await persistence.loadScope('tenant-1', 'user-1');
  assert.equal(persistedSnap?.files.some((f) => f.id === 'pending:up-1'), false);

  // Promoting completed upload swaps pending row seamlessly without full reload
  const promotedFile = makeFile('srv-up-1', 'dir-1', { name: 'large-report.pdf' });
  store.completeOptimisticUpload('pending:up-1', promotedFile);
  assert.equal(
    store.getDirectoryView('dir-1').files.some((f) => f.id === 'pending:up-1'),
    false
  );
  assert.equal(
    store.getDirectoryView('dir-1').files.some((f) => f.id === 'srv-up-1' && f.upload_state === 'active'),
    true
  );

  // 2. 409 Conflict rolls back fileA to `serverLatestFile` (v5, confidential) & emits toast + syncDelta
  store.optimisticUpdateFileClassification(fileA, { classification: 'public' });
  assert.equal(
    store.getDirectoryView('dir-1').files.find((f) => f.id === 'file-a')?.classification,
    'public'
  );
  await store.flushOutbox();
  const rolledBack = store.getDirectoryView('dir-1').files.find((f) => f.id === 'file-a');
  assert.equal(rolledBack?.classification, 'confidential');
  assert.equal(rolledBack?.meta_version, 5);
  assert.ok(store.getSnapshot().toasts.some((t) => t.kind === 'warning'));
  assert.ok(deltaCalls >= 1);

  // 3. Soft-delete file -> disappears immediately -> Undo (`Cmd+Z`) restores & invokes restoreFileFn
  const delRes = store.optimisticSoftDeleteFile(rolledBack!, 'dir-1', 'editor');
  assert.equal(delRes.ok, true);
  assert.equal(
    store.getDirectoryView('dir-1').files.some((f) => f.id === 'file-a'),
    false
  );
  assert.equal(store.getSnapshot().canUndo, true);

  await store.undoLatest();
  assert.equal(
    store.getDirectoryView('dir-1').files.some((f) => f.id === 'file-a'),
    true
  );
  await store.flushOutbox();
  assert.equal(restoreCalledWith, 'file-a');

  // 4. 403 Forbidden on folder soft-delete puts folder back cleanly
  store.optimisticSoftDeleteFolder(parent);
  assert.equal(store.getDirectoryView(null).folders.length, 0);
  await store.flushOutbox();
  assert.equal(store.getDirectoryView(null).folders.length, 1);
  assert.ok(store.getSnapshot().toasts.some((t) => t.kind === 'error'));

  await store.purgeCurrentScope();
  assert.equal(store.getSnapshot().toasts.length, 0);
  assert.equal(store.getSnapshot().canUndo, false);
});

test('AdminAiBatchCoalescer batches rapid approvals into one request and reports errors cleanly', async () => {
  const batches: AdminAiBatchItem[][] = [];
  const failed: AdminAiBatchItem[][] = [];

  const coalescer = new AdminAiBatchCoalescer({
    windowMs: 20,
    submit: async (items) => {
      batches.push(items);
      if (items.some((i) => i.fileId === 'fail-me')) {
        throw new Error('Permission denied');
      }
    },
    onError: (items) => {
      failed.push(items);
    },
  });

  coalescer.enqueue([{ fileId: 'f1' }]);
  coalescer.enqueue([{ fileId: 'f2', label: 'confidential' }]);
  coalescer.enqueue([{ fileId: 'f1', label: 'internal' }]); // deduplicates f1 with latest label
  await coalescer.flush();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [
    { fileId: 'f1', label: 'internal' },
    { fileId: 'f2', label: 'confidential' },
  ]);

  coalescer.enqueue([{ fileId: 'fail-me' }]);
  await coalescer.flush();
  assert.equal(failed.length, 1);
  assert.equal(failed[0][0]?.fileId, 'fail-me');
});

// Keep reference used cleanly so TS never treats import as unused
assert.equal(typeof MutationOutbox, 'function');
