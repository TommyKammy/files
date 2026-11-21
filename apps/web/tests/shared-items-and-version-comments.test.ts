import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadWorkspaceFile } from '@/lib/files-api/upload';
import {
  DEFAULT_SHARED_ITEMS_FILTER,
  DEFAULT_SHARED_ITEMS_SORT,
  filterSharedItems,
  hasActiveSharedItemsFilter,
  nextSharedItemsSort,
  sortSharedItems,
} from '@/lib/shared-items-view';
import {
  buildVersionHistoryView,
  formatVersionComment,
} from '@/lib/version-history';
import type { FileVersionItem, SharedItemEntry } from '@/types/files';

function makeSharedItem(
  overrides: Partial<SharedItemEntry> & { id: string; name: string }
): SharedItemEntry {
  return {
    itemType: 'file',
    classification: 'internal',
    folderId: 'folder-1',
    parentId: null,
    updatedAt: '2026-11-20T10:00:00.000Z',
    extension: 'txt',
    mimeType: 'text/plain',
    sizeBytes: 128,
    effectiveRole: 'viewer',
    capabilities: ['item.preview', 'item.download'],
    directRoles: ['viewer'],
    breadcrumbs: [{ id: 'folder-1', name: 'Project' }],
    pathLabel: 'Project / File',
    createdBy: 'user-1',
    grantedAt: '2026-11-20T09:00:00.000Z',
    ...overrides,
  };
}

test('uploadWorkspaceFile sends trimmed comment on single-part upload and omits blank comments', async () => {
  const capturedBodies: Array<Record<string, unknown>> = [];
  const mockApiFetch = (async (path: string, init?: RequestInit) => {
    if (path === '/api/files/upload-init') {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      capturedBodies.push(parsed);
      return {
        fileId: 'file-1',
        versionId: 'ver-1',
        uploadUrl: '/upload/put',
      };
    }
    if (path === '/api/files/upload-complete') {
      return {
        file: { id: 'file-1', name: 'spec.txt' },
        aiClassificationQueued: false,
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  }) as unknown as typeof import('@/lib/files-api/core').apiFetch;

  const mockPutBlob = async () => ({ etag: '"etag-1"' });
  const file = new File(['hello'], 'spec.txt', { type: 'text/plain' });

  await uploadWorkspaceFile({
    folderId: 'folder-1',
    file,
    conflictPolicy: 'new_version',
    comment: '  Updated security section  ',
    deps: { apiFetchFn: mockApiFetch, putBlobFn: mockPutBlob },
  });

  await uploadWorkspaceFile({
    folderId: 'folder-1',
    file,
    conflictPolicy: 'new_version',
    comment: '   ',
    deps: { apiFetchFn: mockApiFetch, putBlobFn: mockPutBlob },
  });

  assert.equal(capturedBodies.length, 2);
  assert.equal(capturedBodies[0].comment, 'Updated security section');
  assert.equal('comment' in capturedBodies[1], false);
});

test('version history view preserves custom upload comments and formats restore markers', () => {
  assert.equal(
    formatVersionComment('  Fixed typo in table  '),
    'Fixed typo in table'
  );
  assert.equal(formatVersionComment('Restored from v2'), 'v2 から復元');

  const versions: FileVersionItem[] = [
    {
      id: 'v2',
      versionNum: 2,
      sizeBytes: 200,
      mimeType: 'text/plain',
      uploadedBy: 'u1',
      uploadedByName: 'Alice',
      createdAt: '2026-11-21T01:00:00.000Z',
      uploadStatus: 'completed',
      isCurrent: true,
      comment: 'Added Q4 numbers',
    },
    {
      id: 'v1',
      versionNum: 1,
      sizeBytes: 100,
      mimeType: 'text/plain',
      uploadedBy: 'u1',
      uploadedByName: 'Alice',
      createdAt: '2026-11-20T01:00:00.000Z',
      uploadStatus: 'completed',
      isCurrent: false,
      comment: null,
    },
  ];

  const rows = buildVersionHistoryView(versions, {
    currentVersionNum: 2,
    effectiveRole: 'editor',
    canDownload: true,
  });
  assert.equal(rows[0].comment, 'Added Q4 numbers');
  assert.equal(rows[1].comment, null);
});

test('shared items filtering supports name/path query, item type, and classification', () => {
  const items: SharedItemEntry[] = [
    makeSharedItem({
      id: 'f-1',
      itemType: 'folder',
      name: 'Finance',
      classification: 'confidential',
      pathLabel: 'Root / Finance',
      effectiveRole: 'editor',
    }),
    makeSharedItem({
      id: 'd-1',
      itemType: 'file',
      name: 'Budget-2026.xlsx',
      classification: 'confidential',
      pathLabel: 'Root / Finance / Budget-2026.xlsx',
      effectiveRole: 'viewer',
    }),
    makeSharedItem({
      id: 'd-2',
      itemType: 'file',
      name: 'Handbook.pdf',
      classification: 'public',
      pathLabel: 'Root / HR / Handbook.pdf',
      effectiveRole: 'previewer',
    }),
  ];

  assert.equal(hasActiveSharedItemsFilter(DEFAULT_SHARED_ITEMS_FILTER), false);
  assert.equal(
    hasActiveSharedItemsFilter({ ...DEFAULT_SHARED_ITEMS_FILTER, query: 'hr' }),
    true
  );

  // Path search matches Finance folder and Budget file
  const byPath = filterSharedItems(items, {
    query: 'finance',
    type: 'all',
    classification: 'all',
  });
  assert.deepEqual(
    byPath.map((i) => i.id),
    ['f-1', 'd-1']
  );

  // Type filter + classification filter
  const filesOnly = filterSharedItems(items, {
    query: '',
    type: 'file',
    classification: 'confidential',
  });
  assert.deepEqual(
    filesOnly.map((i) => i.id),
    ['d-1']
  );

  const foldersOnly = filterSharedItems(items, {
    query: '',
    type: 'folder',
    classification: 'all',
  });
  assert.deepEqual(
    foldersOnly.map((i) => i.id),
    ['f-1']
  );
});

test('shared items sorting supports name, classification, role, updatedAt and asc/desc toggle', () => {
  const items: SharedItemEntry[] = [
    makeSharedItem({
      id: 'a',
      name: 'Alpha.txt',
      classification: 'public',
      effectiveRole: 'viewer',
      updatedAt: '2026-11-19T10:00:00.000Z',
    }),
    makeSharedItem({
      id: 'b',
      name: 'Beta.txt',
      classification: 'confidential',
      effectiveRole: 'owner',
      updatedAt: '2026-11-21T10:00:00.000Z',
    }),
    makeSharedItem({
      id: 'c',
      name: 'Gamma.txt',
      classification: 'internal',
      effectiveRole: 'editor',
      updatedAt: '2026-11-20T10:00:00.000Z',
    }),
  ];

  assert.deepEqual(
    sortSharedItems(items, DEFAULT_SHARED_ITEMS_SORT).map((i) => i.id),
    ['b', 'c', 'a']
  );

  const byNameAsc = nextSharedItemsSort(DEFAULT_SHARED_ITEMS_SORT, 'name');
  assert.deepEqual(byNameAsc, { field: 'name', direction: 'asc' });
  assert.deepEqual(
    sortSharedItems(items, byNameAsc).map((i) => i.id),
    ['a', 'b', 'c']
  );

  const byNameDesc = nextSharedItemsSort(byNameAsc, 'name');
  assert.deepEqual(byNameDesc, { field: 'name', direction: 'desc' });
  assert.deepEqual(
    sortSharedItems(items, byNameDesc).map((i) => i.id),
    ['c', 'b', 'a']
  );

  assert.deepEqual(
    sortSharedItems(items, { field: 'classification', direction: 'desc' }).map(
      (i) => i.id
    ),
    ['b', 'c', 'a']
  );

  assert.deepEqual(
    sortSharedItems(items, { field: 'role', direction: 'desc' }).map(
      (i) => i.id
    ),
    ['b', 'c', 'a']
  );
});
