import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDeltaChangesToCache,
  type DeltaCacheContext,
} from '@/lib/sync-store/delta';
import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import type { FileItem, FolderSummary } from '@/types/files';

function file(id: string): FileItem {
  return {
    id,
    folder_id: 'folder-1',
    name: `${id}.docx`,
    extension: 'docx',
    mime_type:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size_bytes: 1024,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    current_version_num: 1,
    meta_version: 2,
    updated_at: '2026-11-16T00:00:00.000Z',
  };
}

function directory(): PersistedDirectoryRecord {
  return {
    dirKey: 'folder-1',
    folderId: 'folder-1',
    effectiveRole: 'editor',
    folderIds: [],
    fileIds: ['file-1'],
    nextCursor: null,
    breadcrumbs: [],
    lastAccessedAt: 0,
    revalidatedAt: 0,
    stale: false,
  };
}

function createContext(): DeltaCacheContext {
  const filesById = new Map<string, FileItem>([['file-1', file('file-1')]]);
  return {
    userId: 'user-1',
    foldersById: new Map<string, FolderSummary>(),
    filesById,
    directoriesByKey: new Map([['folder-1', directory()]]),
    rootFolderIds: [],
    pinnedFolderIds: [],
    activeDirKey: 'folder-1',
    setActiveDirectoryNotice: () => undefined,
    evictSubtreeFromCache: () => false,
    bootstrapForce: () => undefined,
    upsertFolderInCache: () => undefined,
    upsertFileInCache: (item: FileItem) => {
      filesById.set(item.id, item);
    },
  };
}

test('file.version_finalized updates cached size/version from the WOPI UNLOCK payload', () => {
  const ctx = createContext();
  const outcome = applyDeltaChangesToCache(
    [
      {
        seq: 10,
        entityType: 'file',
        entityId: 'file-1',
        folderId: 'folder-1',
        targetUserId: null,
        action: 'file.version_finalized',
        payload: {
          name: 'file-1.docx',
          sizeBytes: 4096,
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          currentVersionNum: 2,
          metaVersion: 3,
          source: 'wopi',
          updatedAt: '2026-11-16T01:00:00.000Z',
        },
        createdAt: '2026-11-16T01:00:00.000Z',
      },
    ],
    ctx
  );

  const updated = ctx.filesById.get('file-1');
  assert.equal(updated?.size_bytes, 4096);
  assert.equal(updated?.current_version_num, 2);
  assert.equal(updated?.meta_version, 3);
  assert.equal(updated?.updated_at, '2026-11-16T01:00:00.000Z');
  assert.equal(outcome.shouldRevalidateActive, false);
});

test('file.version_finalized revalidates the active folder when the file is not cached', () => {
  const ctx = createContext();
  ctx.filesById.clear();
  const outcome = applyDeltaChangesToCache(
    [
      {
        seq: 11,
        entityType: 'file',
        entityId: 'file-uncached',
        folderId: 'folder-1',
        targetUserId: null,
        action: 'file.version_finalized',
        payload: {
          sizeBytes: 2048,
          currentVersionNum: 2,
          metaVersion: 3,
          updatedAt: '2026-11-16T01:00:00.000Z',
        },
        createdAt: '2026-11-16T01:00:00.000Z',
      },
    ],
    ctx
  );

  assert.equal(outcome.shouldRevalidateActive, true);
  assert.equal(ctx.directoriesByKey.get('folder-1')?.stale, true);
});

test('file.version_restored shares the finalized projection and applies a negative size delta', () => {
  const ctx = createContext();
  ctx.filesById.set('file-1', {
    ...file('file-1'),
    size_bytes: 4096,
    current_version_num: 4,
    meta_version: 6,
  });
  const outcome = applyDeltaChangesToCache(
    [
      {
        seq: 12,
        entityType: 'file',
        entityId: 'file-1',
        folderId: 'folder-1',
        targetUserId: null,
        action: 'file.version_restored',
        payload: {
          name: 'file-1.docx',
          sizeBytes: 64,
          mimeType: 'text/plain',
          currentVersionNum: 5,
          metaVersion: 7,
          versionId: 'version-5',
          restoredFromVersionId: 'version-1',
          restoredFromVersionNum: 1,
          updatedAt: '2026-11-16T02:00:00.000Z',
        },
        createdAt: '2026-11-16T02:00:00.000Z',
      },
    ],
    ctx
  );

  const updated = ctx.filesById.get('file-1');
  assert.equal(updated?.size_bytes, 64);
  assert.equal(updated?.mime_type, 'text/plain');
  assert.equal(updated?.current_version_num, 5);
  assert.equal(updated?.meta_version, 7);
  assert.equal(updated?.updated_at, '2026-11-16T02:00:00.000Z');
  assert.equal(outcome.shouldRevalidateActive, false);
});

test('file.version_restored revalidates the active folder when the file is not cached', () => {
  const ctx = createContext();
  ctx.filesById.clear();
  const outcome = applyDeltaChangesToCache(
    [
      {
        seq: 13,
        entityType: 'file',
        entityId: 'file-uncached',
        folderId: 'folder-1',
        targetUserId: null,
        action: 'file.version_restored',
        payload: {
          sizeBytes: 64,
          currentVersionNum: 5,
          metaVersion: 7,
          restoredFromVersionNum: 1,
          updatedAt: '2026-11-16T02:00:00.000Z',
        },
        createdAt: '2026-11-16T02:00:00.000Z',
      },
    ],
    ctx
  );

  assert.equal(outcome.shouldRevalidateActive, true);
  assert.equal(ctx.directoriesByKey.get('folder-1')?.stale, true);
});
