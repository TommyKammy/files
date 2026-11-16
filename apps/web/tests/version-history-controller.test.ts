import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClientError } from '@/lib/files-api/core';
import type {
  FileVersionContentGrant,
  FileVersionRestoreResponse,
} from '@/lib/files-api';
import {
  VersionHistoryController,
  type FileVersionHistoryApi,
} from '@/lib/version-history-controller';
import type { FileItem, FileVersionItem } from '@/types/files';

function version(
  versionNum: number,
  overrides: Partial<FileVersionItem> = {}
): FileVersionItem {
  return {
    id: `ver-${versionNum}`,
    versionNum,
    sizeBytes: versionNum * 100,
    mimeType: 'text/plain',
    uploadedBy: 'dev-admin-001',
    uploadedByName: 'Dev Admin',
    createdAt: `2026-11-16T0${Math.min(versionNum, 9)}:00:00.000Z`,
    uploadStatus: 'completed',
    isCurrent: false,
    ...overrides,
  };
}

function apiFileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    tenant_id: 'tenant-default',
    folder_id: 'folder-1',
    name: 'spec.txt',
    extension: 'txt',
    mime_type: 'text/plain',
    size_bytes: 100,
    upload_state: 'active',
    current_version_id: 'ver-3',
    current_version_num: 3,
    meta_version: 8,
    classification: 'internal',
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    deleted_at: null,
    created_by: 'dev-admin-001',
    updated_by: 'dev-admin-001',
    created_at: '2026-11-16T00:00:00.000Z',
    updated_at: '2026-11-16T03:00:00.000Z',
    ...overrides,
  };
}

const previewGrant: FileVersionContentGrant = {
  url: 'https://storage.example/preview',
  requireWatermark: false,
  watermarkText: null,
};

test('controller loads newest-first, paginates with cursor, and dedupes rows', async () => {
  const calls: Array<{ limit: number; cursor: string | null }> = [];
  const v3 = version(3, { isCurrent: true });
  const v2 = version(2);
  const v1 = version(1);
  const pages = [
    { versions: [v3, v2], nextCursor: 'cursor-2', hasMore: true },
    { versions: [v2, v1], nextCursor: null, hasMore: false },
  ];
  const api: FileVersionHistoryApi = {
    list: async (_fileId, options) => {
      calls.push({ limit: options.limit, cursor: options.cursor });
      return pages.shift()!;
    },
    contentUrl: async () => previewGrant,
    restore: async () => {
      throw new Error('not used');
    },
    fileInfo: async () => ({ file: apiFileRow() }),
  };

  const controller = new VersionHistoryController({
    fileId: 'file-1',
    initialCurrentVersionNum: 2,
    initialMetaVersion: 2,
    pageSize: 2,
    api,
  });

  await controller.loadInitial();
  let state = controller.getState();
  assert.equal(state.loading, false);
  assert.deepEqual(
    state.versions.map((v) => v.versionNum),
    [3, 2]
  );
  assert.equal(state.currentVersionNum, 3);
  assert.equal(state.hasMore, true);
  assert.equal(state.nextCursor, 'cursor-2');

  await controller.loadMore();
  state = controller.getState();
  assert.deepEqual(
    state.versions.map((v) => v.versionNum),
    [3, 2, 1]
  );
  assert.equal(state.hasMore, false);
  assert.equal(state.nextCursor, null);
  assert.deepEqual(calls, [
    { limit: 2, cursor: null },
    { limit: 2, cursor: 'cursor-2' },
  ]);
});

test('restore sends expectedVersion, refreshes history, and syncs the file callback', async () => {
  const listCalls: Array<string | null> = [];
  const restoreCalls: Array<{ versionId: string; expectedVersion?: number }> = [];
  const updated: FileItem[] = [];
  const restored: Array<{ from: number; to: number | null }> = [];
  let restoredOnce = false;

  const v1 = version(1);
  const v2 = version(2, { isCurrent: true });
  const v3 = version(3, {
    isCurrent: true,
    sizeBytes: 100,
    comment: 'Restored from v1',
    restoredFromVersionId: v1.id,
    restoredFromVersionNum: 1,
  });
  const restoreResponse: FileVersionRestoreResponse = {
    ok: true,
    file: apiFileRow(),
    version: v3,
    restoredFromVersionId: v1.id,
    restoredFromVersionNum: 1,
  };
  const api: FileVersionHistoryApi = {
    list: async (_fileId, options) => {
      listCalls.push(options.cursor);
      return restoredOnce
        ? {
            versions: [
              { ...v3, comment: undefined, restoredFromVersionId: undefined, restoredFromVersionNum: undefined },
              v2,
              v1,
            ],
            nextCursor: null,
            hasMore: false,
          }
        : {
            versions: [v2, v1],
            nextCursor: null,
            hasMore: false,
          };
    },
    contentUrl: async () => previewGrant,
    restore: async (_fileId, versionId, expectedVersion) => {
      restoreCalls.push({ versionId, expectedVersion });
      restoredOnce = true;
      return restoreResponse;
    },
    fileInfo: async () => ({ file: apiFileRow() }),
  };

  const controller = new VersionHistoryController({
    fileId: 'file-1',
    initialCurrentVersionNum: 2,
    initialMetaVersion: 7,
    api,
    onFileUpdated: (file) => updated.push(file),
    onRestored: (result) =>
      restored.push({
        from: result.restoredFromVersionNum,
        to: result.version?.versionNum ?? null,
      }),
  });

  await controller.loadInitial();
  const outcome = await controller.restore(v1);

  assert.equal(outcome.ok, true);
  assert.deepEqual(restoreCalls, [{ versionId: v1.id, expectedVersion: 7 }]);
  assert.equal(listCalls.length, 2, 'history must be re-fetched after restore');
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.current_version_num, 3);
  assert.equal(updated[0]?.meta_version, 8);
  assert.deepEqual(restored, [{ from: 1, to: 3 }]);

  const state = controller.getState();
  assert.equal(state.metaVersion, 8);
  assert.equal(state.currentVersionNum, 3);
  assert.equal(state.restoringVersionId, null);
  assert.equal(state.restoreError, null);
  assert.deepEqual(
    state.versions.map((v) => v.versionNum),
    [3, 2, 1]
  );
  assert.equal(state.versions[0]?.comment, 'Restored from v1');
});

test('FILE_LOCKED restores surface owner info, resync meta_version, and reload history', async () => {
  const lock = {
    fileId: 'file-1',
    tenantId: 'tenant-default',
    mode: 'desktop_exclusive' as const,
    lockId: 'lock-1',
    ownerId: 'dev-admin-001',
    ownerName: 'Dev Admin',
    ownerEmail: 'dev-admin@example.com',
    sessionId: null,
    acquiredAt: 1,
    expiresAt: 2,
    updatedAt: 2,
  };
  const updated: FileItem[] = [];
  let listCalls = 0;
  let fileInfoCalls = 0;
  const v1 = version(1);
  const v2 = version(2, { isCurrent: true });

  const api: FileVersionHistoryApi = {
    list: async () => {
      listCalls += 1;
      return { versions: [v2, v1], nextCursor: null, hasMore: false };
    },
    contentUrl: async () => previewGrant,
    restore: async () => {
      throw new ApiClientError(409, 'File is locked', 'FILE_LOCKED', { lock });
    },
    fileInfo: async () => {
      fileInfoCalls += 1;
      return {
        file: apiFileRow({ meta_version: 9, current_version_num: 2 }),
      };
    },
  };

  const controller = new VersionHistoryController({
    fileId: 'file-1',
    initialCurrentVersionNum: 2,
    initialMetaVersion: 2,
    api,
    onFileUpdated: (file) => updated.push(file),
  });

  await controller.loadInitial();
  const outcome = await controller.restore(v1);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;

  assert.equal(outcome.error.code, 'FILE_LOCKED');
  assert.equal(outcome.error.lock?.ownerName, 'Dev Admin');
  assert.match(outcome.error.message, /ロック保有者: Dev Admin/);
  assert.match(outcome.error.message, /Files Drive 排他ロック/);

  const state = controller.getState();
  assert.equal(state.restoreError?.code, 'FILE_LOCKED');
  assert.equal(state.restoringVersionId, null);
  assert.equal(state.metaVersion, 9);
  assert.equal(updated.at(-1)?.meta_version, 9);
  assert.equal(fileInfoCalls, 1);
  assert.equal(listCalls, 2, 'lock failure must re-read the latest history');
});

test('VERSION_CONFLICT and VERSION_ALREADY_CURRENT resync then report Japanese errors', async () => {
  for (const [code, pattern] of [
    ['VERSION_CONFLICT', /別の操作で更新/],
    ['VERSION_ALREADY_CURRENT', /既に現在版/],
  ] as const) {
    const v1 = version(1);
    const v2 = version(2, { isCurrent: true });
    let fileInfoCalls = 0;
    let listCalls = 0;
    const api: FileVersionHistoryApi = {
      list: async () => {
        listCalls += 1;
        return { versions: [v2, v1], nextCursor: null, hasMore: false };
      },
      contentUrl: async () => previewGrant,
      restore: async () => {
        throw new ApiClientError(409, code, code);
      },
      fileInfo: async () => {
        fileInfoCalls += 1;
        return { file: apiFileRow({ meta_version: 10 }) };
      },
    };
    const controller = new VersionHistoryController({
      fileId: 'file-1',
      initialCurrentVersionNum: 2,
      initialMetaVersion: 2,
      api,
    });
    await controller.loadInitial();
    const outcome = await controller.restore(v1);
    assert.equal(outcome.ok, false);
    if (outcome.ok) continue;
    assert.equal(outcome.error.code, code);
    assert.match(outcome.error.message, pattern);
    assert.equal(fileInfoCalls, 1);
    assert.equal(listCalls, 2);
    assert.equal(controller.getState().metaVersion, 10);
  }
});

test('preview grant and download use historical version content-url with DLP errors', async () => {
  const v1 = version(1);
  const v2 = version(2, { isCurrent: true });
  const contentCalls: Array<{ versionId: string; intent: string }> = [];
  const opened: string[] = [];
  let downloadForbidden = false;

  const api: FileVersionHistoryApi = {
    list: async () => ({
      versions: [v2, v1],
      nextCursor: null,
      hasMore: false,
    }),
    contentUrl: async (_fileId, versionId, intent) => {
      contentCalls.push({ versionId, intent });
      if (intent === 'download' && downloadForbidden) {
        throw new ApiClientError(403, 'Forbidden');
      }
      return previewGrant;
    },
    restore: async () => {
      throw new Error('not used');
    },
    fileInfo: async () => ({ file: apiFileRow() }),
  };

  const controller = new VersionHistoryController({
    fileId: 'file-1',
    initialCurrentVersionNum: 2,
    initialMetaVersion: 2,
    api,
    openUrl: (url) => opened.push(url),
  });

  await controller.loadInitial();
  const preview = await controller.preparePreview(v1);
  assert.equal(preview?.version.id, v1.id);
  assert.equal(controller.getState().preview?.grant.url, previewGrant.url);
  assert.deepEqual(contentCalls[0], {
    versionId: v1.id,
    intent: 'preview',
  });

  await controller.download(v1);
  assert.equal(opened.length, 1);
  assert.deepEqual(contentCalls[1], {
    versionId: v1.id,
    intent: 'download',
  });

  downloadForbidden = true;
  await assert.rejects(() => controller.download(v1), /Previewer.*DLP/);
  assert.equal(opened.length, 1, 'a 403 must not open a bogus URL');
  assert.match(
    controller.getState().error?.message ?? '',
    /Previewer.*DLP/
  );

  controller.closePreview();
  assert.equal(controller.getState().preview, null);
});

test('loadInitial list failures are exposed without throwing', async () => {
  const controller = new VersionHistoryController({
    fileId: 'file-1',
    initialCurrentVersionNum: 1,
    initialMetaVersion: 1,
    api: {
      list: async () => {
        throw new ApiClientError(403, 'Forbidden');
      },
      contentUrl: async () => previewGrant,
      restore: async () => {
        throw new Error('not used');
      },
      fileInfo: async () => ({ file: apiFileRow() }),
    },
  });

  await controller.loadInitial();
  const state = controller.getState();
  assert.equal(state.loading, false);
  assert.equal(state.versions.length, 0);
  assert.match(state.error?.message ?? '', /版履歴を表示する権限/);
});
