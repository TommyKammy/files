import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiClientError,
  MULTIPART_THRESHOLD_BYTES,
} from '@/lib/files-api/core';
import {
  isRetryablePartUploadError,
  uploadPartWithRetry,
  uploadWorkspaceFile,
} from '@/lib/files-api/upload';
import {
  collectOrderedFolderPaths,
  ensureFolderTree,
  extractUploadEntriesFromEntries,
  extractUploadEntriesFromFileList,
  readAllDirectoryEntries,
  type FileSystemDirectoryReaderLike,
  type FileSystemEntryLike,
} from '@/lib/folder-upload-tree';
import type { FileItem, FolderChildrenResponse, FolderSummary } from '@/types/files';

function makeFileEntry(name: string, content = 'hello'): FileSystemEntryLike {
  const file = new File([content], name, { type: 'text/plain' });
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb) => cb(file),
  };
}

function makeBatchedDirEntry(
  name: string,
  batches: FileSystemEntryLike[][]
): FileSystemEntryLike {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: (): FileSystemDirectoryReaderLike => {
      let idx = 0;
      return {
        readEntries: (cb) => {
          const next = idx < batches.length ? batches[idx] : [];
          idx += 1;
          cb(next);
        },
      };
    },
  };
}

function makeFolderSummary(id: string, parentId: string | null, name: string): FolderSummary {
  return {
    id,
    parent_id: parentId,
    name,
    classification: 'internal',
    is_pinned: 0,
    version: 1,
    updated_at: '2026-11-21T00:00:00Z',
  };
}

test('readAllDirectoryEntries reads all batches until readEntries returns []', async () => {
  const batch1 = Array.from({ length: 100 }, (_, i) => makeFileEntry(`file-${i}.txt`));
  const batch2 = [makeFileEntry('file-100.txt'), makeFileEntry('file-101.txt')];
  const dir = makeBatchedDirEntry('root', [batch1, batch2]);
  const reader = dir.createReader!();

  const entries = await readAllDirectoryEntries(reader);
  assert.equal(entries.length, 102);
  assert.equal(entries[0].name, 'file-0.txt');
  assert.equal(entries[101].name, 'file-101.txt');
});

test('extractUploadEntriesFromEntries recursively extracts nested folder-relative paths', async () => {
  const nestedDir = makeBatchedDirEntry('2026', [
    [makeFileEntry('q1.pdf'), makeFileEntry('q2.pdf')],
  ]);
  const rootDir = makeBatchedDirEntry('reports', [
    [nestedDir, makeFileEntry('readme.md')],
  ]);
  const topFile = makeFileEntry('loose.txt');

  const tree = await extractUploadEntriesFromEntries([rootDir, topFile]);

  assert.deepEqual(tree.folderPaths, ['reports', 'reports/2026']);
  assert.deepEqual(
    tree.files.map((f) => ({ relativePath: f.relativePath, folderPath: f.folderPath })),
    [
      { relativePath: 'reports/2026/q1.pdf', folderPath: 'reports/2026' },
      { relativePath: 'reports/2026/q2.pdf', folderPath: 'reports/2026' },
      { relativePath: 'reports/readme.md', folderPath: 'reports' },
      { relativePath: 'loose.txt', folderPath: '' },
    ]
  );
});

test('extractUploadEntriesFromFileList handles webkitRelativePath and plain files', () => {
  const f1 = new File(['a'], 'a.txt');
  Object.defineProperty(f1, 'webkitRelativePath', { value: 'project/src/a.txt' });
  const f2 = new File(['b'], 'b.txt');
  Object.defineProperty(f2, 'webkitRelativePath', { value: 'project/b.txt' });
  const f3 = new File(['c'], 'c.txt');

  const tree = extractUploadEntriesFromFileList([f1, f2, f3]);
  assert.deepEqual(tree.folderPaths, ['project', 'project/src']);
  assert.deepEqual(
    tree.files.map((f) => ({ relativePath: f.relativePath, folderPath: f.folderPath })),
    [
      { relativePath: 'project/src/a.txt', folderPath: 'project/src' },
      { relativePath: 'project/b.txt', folderPath: 'project' },
      { relativePath: 'c.txt', folderPath: '' },
    ]
  );
});

test('collectOrderedFolderPaths deduplicates and sorts strictly parent before child', () => {
  const ordered = collectOrderedFolderPaths([
    'a/b/c',
    'x/y',
    'a/b',
    'a/b/c',
    '/x/y/z/',
  ]);

  assert.deepEqual(ordered, ['a', 'x', 'a/b', 'x/y', 'a/b/c', 'x/y/z']);
});

test('ensureFolderTree creates folders parent-before-child, deduplicates siblings, and handles 409 NAME_CONFLICT', async () => {
  const createCalls: Array<{ parentId: string | null; name: string }> = [];
  const listCalls: string[] = [];
  let seq = 1;

  const folderMap = await ensureFolderTree({
    rootFolderId: 'root-1',
    folderPaths: ['docs/2026/q1', 'docs/2026/q2', 'docs/2025'],
    createFolderFn: async (payload) => {
      createCalls.push({ parentId: payload.parentId, name: payload.name });
      // Simulate "docs" already existing on server (409 NAME_CONFLICT)
      if (payload.parentId === 'root-1' && payload.name === 'docs') {
        throw new ApiClientError(409, 'Folder already exists', 'NAME_CONFLICT');
      }
      seq += 1;
      return {
        folder: makeFolderSummary(`fld-${seq}`, payload.parentId, payload.name),
      };
    },
    listFolderChildrenFn: async (folderId): Promise<FolderChildrenResponse> => {
      listCalls.push(folderId);
      return {
        folder: makeFolderSummary(folderId, null, 'root'),
        effectiveRole: 'editor',
        folders: [
          makeFolderSummary('existing-docs', 'root-1', 'docs'),
          makeFolderSummary('existing-2025', 'existing-docs', '2025'),
        ],
        files: [],
        nextCursor: null,
      };
    },
  });

  // "docs" is attempted once, 409 triggers listFolderChildren('root-1'),
  // then children under 'existing-docs' are created in parent-before-child order.
  assert.deepEqual(createCalls, [
    { parentId: 'root-1', name: 'docs' },
    { parentId: 'existing-docs', name: '2025' },
    { parentId: 'existing-docs', name: '2026' },
    { parentId: 'fld-3', name: 'q1' },
    { parentId: 'fld-3', name: 'q2' },
  ]);
  assert.deepEqual(listCalls, ['root-1']);
  assert.equal(folderMap.get(''), 'root-1');
  assert.equal(folderMap.get('docs'), 'existing-docs');
  assert.equal(folderMap.get('docs/2025'), 'fld-2');
  assert.equal(folderMap.get('docs/2026'), 'fld-3');
  assert.equal(folderMap.get('docs/2026/q1'), 'fld-4');
  assert.equal(folderMap.get('docs/2026/q2'), 'fld-5');
});

test('ensureFolderTree reuses cached children on multiple 409 siblings without re-fetching', async () => {
  const listCalls: string[] = [];
  const folderMap = await ensureFolderTree({
    rootFolderId: 'root-1',
    folderPaths: ['alpha', 'beta'],
    createFolderFn: async () => {
      throw new ApiClientError(409, 'Conflict', 'NAME_CONFLICT');
    },
    listFolderChildrenFn: async (folderId): Promise<FolderChildrenResponse> => {
      listCalls.push(folderId);
      return {
        folder: makeFolderSummary(folderId, null, 'root'),
        effectiveRole: 'editor',
        folders: [
          makeFolderSummary('id-alpha', 'root-1', 'alpha'),
          makeFolderSummary('id-beta', 'root-1', 'beta'),
        ],
        files: [],
        nextCursor: null,
      };
    },
  });

  assert.deepEqual(listCalls, ['root-1']);
  assert.equal(folderMap.get('alpha'), 'id-alpha');
  assert.equal(folderMap.get('beta'), 'id-beta');
});

test('isRetryablePartUploadError classifies transient vs non-retryable errors', () => {
  assert.equal(isRetryablePartUploadError(new Error('Network error')), true);
  assert.equal(isRetryablePartUploadError(new ApiClientError(503, 'Unavailable')), true);
  assert.equal(isRetryablePartUploadError(new ApiClientError(429, 'Rate limit')), true);

  assert.equal(isRetryablePartUploadError(new ApiClientError(403, 'DLP blocked')), false);
  assert.equal(isRetryablePartUploadError(new ApiClientError(400, 'Bad request')), false);
  assert.equal(
    isRetryablePartUploadError(new DOMException('Upload aborted', 'AbortError')),
    false
  );
});

test('uploadPartWithRetry retries transient failures with exponential backoff and succeeds', async () => {
  const sleepDelays: number[] = [];
  let attempts = 0;

  const result = await uploadPartWithRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Network error');
      if (attempts === 2) throw new ApiClientError(502, 'Bad Gateway');
      return { etag: '"ok"' };
    },
    {
      maxAttempts: 3,
      baseDelayMs: 100,
      sleepFn: async (ms) => {
        sleepDelays.push(ms);
      },
    }
  );

  assert.deepEqual(result, { etag: '"ok"' });
  assert.equal(attempts, 3);
  assert.deepEqual(sleepDelays, [100, 200]);
});

test('uploadWorkspaceFile retries transient part failures and completes multipart upload', async () => {
  const bigFile = new File(['x'], 'big.bin', { type: 'application/octet-stream' });
  Object.defineProperty(bigFile, 'size', { value: MULTIPART_THRESHOLD_BYTES });

  let part1Attempts = 0;
  let completedCalled = false;
  let abortedCalled = false;

  const result = await uploadWorkspaceFile({
    folderId: 'fld-1',
    file: bigFile,
    retryOptions: {
      maxAttempts: 3,
      baseDelayMs: 1,
      sleepFn: async () => undefined,
    },
    deps: {
      apiFetchFn: (async (path: string) => {
        if (path === '/api/files/multipart/init') {
          return {
            fileId: 'file-1',
            versionId: 'ver-1',
            partSizeBytes: 50 * 1024 * 1024,
            totalParts: 2,
            parts: [
              { partNumber: 1, url: 'https://r2.example/part1' },
              { partNumber: 2, url: 'https://r2.example/part2' },
            ],
          };
        }
        if (path === '/api/files/multipart/complete') {
          completedCalled = true;
          return {
            file: {
              id: 'file-1',
              folder_id: 'fld-1',
              name: 'big.bin',
              extension: 'bin',
              mime_type: 'application/octet-stream',
              size_bytes: MULTIPART_THRESHOLD_BYTES,
              current_version_num: 1,
              classification: 'internal',
              ai_suggested_label: null,
              ai_confidence: null,
              ai_reason: null,
              updated_at: '2026-11-21T00:00:00Z',
            } satisfies FileItem,
            aiClassificationQueued: false,
          };
        }
        if (path === '/api/files/multipart/abort') {
          abortedCalled = true;
          return {};
        }
        throw new Error(`Unexpected apiFetch path: ${path}`);
      }) as typeof import('@/lib/files-api/core').apiFetch,
      putBlobFn: async (opts) => {
        if (opts.url.endsWith('/part1')) {
          part1Attempts += 1;
          if (part1Attempts < 3) {
            throw new ApiClientError(503, 'Service Unavailable');
          }
        }
        return { etag: `"etag-${opts.url.slice(-1)}"` };
      },
    },
  });

  assert.equal(part1Attempts, 3);
  assert.equal(completedCalled, true);
  assert.equal(abortedCalled, false);
  assert.equal(result.file.id, 'file-1');
});

test('uploadWorkspaceFile immediately aborts without retry on 4xx DLP error or AbortError', async () => {
  const bigFile = new File(['x'], 'dlp.bin', { type: 'application/octet-stream' });
  Object.defineProperty(bigFile, 'size', { value: MULTIPART_THRESHOLD_BYTES });

  let partAttempts = 0;
  let abortedCalled = false;

  await assert.rejects(
    () =>
      uploadWorkspaceFile({
        folderId: 'fld-1',
        file: bigFile,
        retryOptions: {
          maxAttempts: 3,
          baseDelayMs: 1,
          sleepFn: async () => undefined,
        },
        deps: {
          apiFetchFn: (async (path: string) => {
            if (path === '/api/files/multipart/init') {
              return {
                fileId: 'file-2',
                versionId: 'ver-2',
                partSizeBytes: MULTIPART_THRESHOLD_BYTES,
                totalParts: 1,
                parts: [{ partNumber: 1, url: 'https://r2.example/part1' }],
              };
            }
            if (path === '/api/files/multipart/abort') {
              abortedCalled = true;
              return {};
            }
            throw new Error(`Unexpected apiFetch path: ${path}`);
          }) as typeof import('@/lib/files-api/core').apiFetch,
          putBlobFn: async () => {
            partAttempts += 1;
            throw new ApiClientError(403, 'DLP policy denied');
          },
        },
      }),
    (err: unknown) => err instanceof ApiClientError && err.status === 403
  );

  assert.equal(partAttempts, 1);
  assert.equal(abortedCalled, true);

  // Also verify user AbortError aborts immediately without retry
  const controller = new AbortController();
  let abortAttempts = 0;
  let abortCleanupCalled = false;

  await assert.rejects(
    () =>
      uploadWorkspaceFile({
        folderId: 'fld-1',
        file: bigFile,
        signal: controller.signal,
        retryOptions: {
          maxAttempts: 3,
          baseDelayMs: 1,
          sleepFn: async () => undefined,
        },
        deps: {
          apiFetchFn: (async (path: string) => {
            if (path === '/api/files/multipart/init') {
              return {
                fileId: 'file-3',
                versionId: 'ver-3',
                partSizeBytes: MULTIPART_THRESHOLD_BYTES,
                totalParts: 1,
                parts: [{ partNumber: 1, url: 'https://r2.example/part1' }],
              };
            }
            if (path === '/api/files/multipart/abort') {
              abortCleanupCalled = true;
              return {};
            }
            throw new Error(`Unexpected apiFetch path: ${path}`);
          }) as typeof import('@/lib/files-api/core').apiFetch,
          putBlobFn: async () => {
            abortAttempts += 1;
            controller.abort();
            throw new DOMException('Upload aborted', 'AbortError');
          },
        },
      }),
    (err: unknown) => err instanceof DOMException && err.name === 'AbortError'
  );

  assert.equal(abortAttempts, 1);
  assert.equal(abortCleanupCalled, true);
});
