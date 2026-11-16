import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTrashEmptyConfirmState,
  buildTrashPurgeConfirmState,
  canPurgeTrashItem,
  canRestoreTrashItem,
  chunkTrashBulkItems,
  createTrashBulkGuard,
  formatTrashBulkFailureReason,
  getTrashBulkActionResultMessage,
  getTrashBulkCapabilities,
  summarizeTrashBulkResults,
  toTrashBulkItemRefs,
  TRASH_EMPTY_CONFIRMATION,
  TRASH_PURGE_WARNINGS,
} from '@/lib/trash-bulk';
import {
  applyDeltaChangesToCache,
  type DeltaCacheContext,
} from '@/lib/sync-store/delta';
import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import type {
  FileItem,
  FolderSummary,
  SyncDeltaItem,
  TrashBulkItemResult,
  TrashFileItem,
  TrashFolderItem,
  TrashItem,
} from '@/types/files';

function fileItem(
  overrides: Partial<TrashFileItem> & { id: string; name: string }
): TrashFileItem {
  return {
    type: 'file',
    folder_id: 'folder-1',
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: 10,
    current_version_num: 1,
    meta_version: 1,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-11-16T00:00:00.000Z',
    deleted_at: '2026-11-16T00:00:00.000Z',
    deleted_by: 'user-1',
    deleted_by_name: 'Dev Admin',
    deletedAt: '2026-11-16T00:00:00.000Z',
    deletedBy: 'user-1',
    deletedByName: 'Dev Admin',
    purgeAt: '2026-12-16T00:00:00.000Z',
    daysRemaining: 30,
    effectiveRole: 'editor',
    ...overrides,
  };
}

function folderItem(
  overrides: Partial<TrashFolderItem> & { id: string; name: string }
): TrashFolderItem {
  return {
    type: 'folder',
    parent_id: 'folder-root',
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-11-16T00:00:00.000Z',
    deleted_at: '2026-11-16T00:00:00.000Z',
    deleted_by: 'user-1',
    deleted_by_name: 'Dev Admin',
    deletedAt: '2026-11-16T00:00:00.000Z',
    deletedBy: 'user-1',
    deletedByName: 'Dev Admin',
    purgeAt: '2026-12-16T00:00:00.000Z',
    daysRemaining: 30,
    effectiveRole: 'editor',
    ...overrides,
  };
}

test('Trash bulk capabilities: editor can restore, only owner/co_owner/sys_admin can purge', () => {
  const editorFile = fileItem({
    id: 'f-editor',
    name: 'editor.txt',
    effectiveRole: 'editor',
  });
  const viewerFile = fileItem({
    id: 'f-viewer',
    name: 'viewer.txt',
    effectiveRole: 'viewer',
  });
  const ownerFolder = folderItem({
    id: 'folder-owner',
    name: 'Owner',
    effectiveRole: 'owner',
  });
  const coOwnerFolder = folderItem({
    id: 'folder-co',
    name: 'CoOwner',
    effectiveRole: 'co_owner',
  });

  assert.equal(canRestoreTrashItem(editorFile, { role: 'member' }), true);
  assert.equal(canPurgeTrashItem(editorFile, { role: 'member' }), false);
  assert.equal(canRestoreTrashItem(viewerFile, { role: 'member' }), false);
  assert.equal(canPurgeTrashItem(viewerFile, { role: 'member' }), false);
  assert.equal(canRestoreTrashItem(ownerFolder, { role: 'member' }), true);
  assert.equal(canPurgeTrashItem(ownerFolder, { role: 'member' }), true);
  assert.equal(canPurgeTrashItem(coOwnerFolder, { role: 'member' }), true);

  // sys_admin may permanently delete any visible item and can use the existing
  // single-file admin restore override; folder restore still requires editor.
  assert.equal(canPurgeTrashItem(viewerFile, { role: 'sys_admin' }), true);
  assert.equal(canRestoreTrashItem(viewerFile, { role: 'sys_admin' }), true);
  assert.equal(
    canRestoreTrashItem(viewerFile, { role: 'sec_admin' }),
    true
  );
  assert.equal(
    canRestoreTrashItem(
      folderItem({ id: 'f-no-role', name: 'No role', effectiveRole: undefined }),
      { role: 'sys_admin' }
    ),
    false
  );

  const capabilities = getTrashBulkCapabilities(
    [editorFile, viewerFile, ownerFolder, coOwnerFolder],
    { role: 'member' }
  );
  assert.equal(capabilities.restorableCount, 3);
  assert.equal(capabilities.purgableCount, 2);
  assert.deepEqual(
    capabilities.purgableItems.map((item) => item.id).sort(),
    ['folder-co', 'folder-owner']
  );
});

test('Trash bulk confirmation copy includes target count, irreversibility and link/permission warnings', () => {
  const purge = buildTrashPurgeConfirmState(3);
  assert.equal(purge.kind, 'purge');
  assert.equal(purge.count, 3);
  assert.match(purge.summary, /3 件/);
  assert.equal(purge.confirmLabel, '完全削除');
  assert.ok(purge.warnings.some((line) => line.includes('復元できません')));
  assert.ok(purge.warnings.some((line) => line.includes('共有リンク')));
  assert.ok(purge.warnings.some((line) => line.includes('アクセス権限')));
  assert.deepEqual(purge.warnings, [...TRASH_PURGE_WARNINGS]);

  const empty = buildTrashEmptyConfirmState(7);
  assert.equal(empty.kind, 'empty');
  assert.equal(empty.count, 7);
  assert.match(empty.summary, /7 件/);
  assert.equal(empty.confirmLabel, 'ゴミ箱を空にする');
  assert.deepEqual(empty.warnings, [...TRASH_PURGE_WARNINGS]);
  assert.equal(TRASH_EMPTY_CONFIRMATION, 'EMPTY_TRASH');
});

test('Trash bulk request normalization dedupes type:id and chunks more than 100 items', () => {
  const refs = toTrashBulkItemRefs([
    { type: 'file', id: 'a' },
    { type: 'file', id: 'a' },
    { type: 'folder', id: 'a' },
    { type: 'file', id: 'b' },
  ]);
  assert.deepEqual(refs, [
    { type: 'file', id: 'a' },
    { type: 'folder', id: 'a' },
    { type: 'file', id: 'b' },
  ]);

  const chunks = chunkTrashBulkItems(
    Array.from({ length: 205 }, (_, index) => index)
  );
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [100, 100, 5]
  );
  assert.deepEqual(chunkTrashBulkItems([]), []);
});

test('Trash bulk guard blocks concurrent double execution synchronously', async () => {
  const guard = createTrashBulkGuard();
  let release!: () => void;
  const firstTask = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;

  const first = guard.run(async () => {
    runs += 1;
    await firstTask;
    return 'first';
  });
  const second = await guard.run(async () => {
    runs += 2;
    return 'second';
  });

  assert.deepEqual(second, { started: false });
  assert.equal(runs, 1);
  assert.equal(guard.isRunning(), true);

  release();
  const firstResult = await first;
  assert.deepEqual(firstResult, { started: true, value: 'first' });
  assert.equal(guard.isRunning(), false);

  const third = await guard.run(async () => {
    runs += 4;
    return 'third';
  });
  assert.deepEqual(third, { started: true, value: 'third' });
  assert.equal(runs, 5);
});

test('Trash bulk result summary preserves partial failure and skip reasons', () => {
  const selected: TrashItem[] = [
    fileItem({ id: 'ok', name: 'ok.txt' }),
    fileItem({ id: 'forbidden', name: 'forbidden.txt' }),
    fileItem({ id: 'locked', name: 'locked.txt' }),
  ];
  const results: TrashBulkItemResult[] = [
    {
      type: 'file',
      id: 'ok',
      ok: true,
      status: 'succeeded',
      name: 'ok.txt',
    },
    {
      type: 'file',
      id: 'forbidden',
      ok: false,
      status: 'failed',
      code: 'FORBIDDEN',
    },
    {
      type: 'file',
      id: 'locked',
      ok: false,
      status: 'skipped',
      code: 'FILE_LOCKED',
    },
  ];

  const summary = summarizeTrashBulkResults(results, selected);
  assert.equal(summary.succeeded.length, 1);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.skipped.length, 1);
  assert.deepEqual([...summary.succeededKeys], ['file:ok']);
  assert.equal(summary.failed[0].name, 'forbidden.txt');
  assert.equal(summary.failed[0].message, '完全削除の権限がありません');
  assert.equal(
    summary.skipped[0].message,
    '他のユーザーが編集中のためスキップしました'
  );
  assert.equal(
    formatTrashBulkFailureReason('PARENT_FOLDER_DELETED'),
    '親フォルダが削除済みです'
  );
  assert.equal(
    formatTrashBulkFailureReason(undefined, 'server reason'),
    'server reason'
  );
  assert.equal(getTrashBulkActionResultMessage('purge', summary), '1 件を完全削除しました');
  assert.equal(getTrashBulkActionResultMessage('restore', summary), '1 件を復元しました');
  assert.equal(
    getTrashBulkActionResultMessage('empty', summary),
    '1 件をゴミ箱から完全削除しました'
  );
});

function deltaFile(id: string): FileItem {
  return {
    id,
    folder_id: 'folder-1',
    name: `${id}.txt`,
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: 10,
    current_version_num: 1,
    meta_version: 1,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: '2026-11-16T00:00:00.000Z',
  };
}

function deltaDirectory(): PersistedDirectoryRecord {
  return {
    dirKey: 'folder-1',
    folderId: 'folder-1',
    effectiveRole: 'editor',
    folderIds: ['folder-child'],
    fileIds: ['file-1'],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 0,
    revalidatedAt: 0,
    stale: false,
  };
}

function deltaChange(
  input: Partial<SyncDeltaItem> & Pick<SyncDeltaItem, 'action' | 'entityId'>
): SyncDeltaItem {
  return {
    seq: 100,
    entityType: 'file',
    folderId: 'folder-1',
    targetUserId: null,
    payload: {},
    createdAt: '2026-11-16T00:00:00.000Z',
    ...input,
  };
}

function createDeltaContext(): DeltaCacheContext & {
  notices: string[];
  evicted: string[];
} {
  const notices: string[] = [];
  const evicted: string[] = [];
  const filesById = new Map<string, FileItem>([
    ['file-1', deltaFile('file-1')],
  ]);
  const foldersById = new Map<string, FolderSummary>([
    [
      'folder-child',
      {
        id: 'folder-child',
        parent_id: 'folder-1',
        name: 'Child',
        classification: 'internal',
        is_pinned: 0,
        version: 1,
        updated_at: '2026-11-16T00:00:00.000Z',
      },
    ],
  ]);
  return {
    notices,
    evicted,
    userId: 'user-1',
    foldersById,
    filesById,
    directoriesByKey: new Map([['folder-1', deltaDirectory()]]),
    rootFolderIds: [],
    pinnedFolderIds: [],
    activeDirKey: 'folder-1',
    setActiveDirectoryNotice: (notice) => {
      if (notice) notices.push(notice);
    },
    evictSubtreeFromCache: (folderId) => {
      evicted.push(folderId);
      return folderId === 'folder-1';
    },
    bootstrapForce: () => undefined,
    upsertFolderInCache: () => undefined,
    upsertFileInCache: (file) => {
      filesById.set(file.id, file);
    },
  };
}

test('file.purged removes cached metadata and directory references', () => {
  const ctx = createDeltaContext();
  const outcome = applyDeltaChangesToCache(
    [deltaChange({ action: 'file.purged', entityId: 'file-1' })],
    ctx
  );
  assert.equal(ctx.filesById.has('file-1'), false);
  assert.deepEqual(ctx.directoriesByKey.get('folder-1')?.fileIds, []);
  assert.equal(outcome.shouldRevalidateActive, true);
});

test('folder.purged evicts the cached subtree and revalidates an active descendant', () => {
  const ctx = createDeltaContext();
  const outcome = applyDeltaChangesToCache(
    [
      deltaChange({
        action: 'folder.purged',
        entityId: 'folder-1',
        entityType: 'folder',
      }),
    ],
    ctx
  );
  assert.deepEqual(ctx.evicted, ['folder-1']);
  assert.deepEqual(ctx.notices, ['このフォルダは完全削除されました']);
  assert.equal(outcome.shouldRevalidateActive, true);
  assert.equal(ctx.foldersById.has('folder-child'), false);
  assert.equal(ctx.filesById.has('file-1'), false);
  assert.deepEqual(ctx.directoriesByKey.get('folder-1')?.fileIds, []);
  assert.deepEqual(ctx.directoriesByKey.get('folder-1')?.folderIds, []);
});
