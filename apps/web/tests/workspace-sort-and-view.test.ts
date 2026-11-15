import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chunkItemsIntoGridRows,
  DEFAULT_WORKSPACE_VIEW_PREFS,
  getAriaSortValue,
  loadWorkspaceViewPrefs,
  nextSortDirection,
  saveWorkspaceViewPrefs,
  sortWorkspaceFoldersAndFiles,
} from '@/lib/workspace-sort-and-view';
import type { FileItem, FolderSummary } from '@/types/files';

function makeFolder(
  overrides: Partial<FolderSummary> & { id: string; name: string }
): FolderSummary {
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

function makeFile(
  overrides: Partial<FileItem> & { id: string; name: string }
): FileItem {
  return {
    folder_id: 'f-root',
    extension: 'pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
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

test('nextSortDirection and getAriaSortValue follow natural column defaults and toggle directions', () => {
  // Switching to updated_at / classification / size_bytes starts descending
  assert.deepEqual(nextSortDirection('name', 'asc', 'updated_at'), {
    sortBy: 'updated_at',
    sortDir: 'desc',
  });
  // Clicking the active column flips direction
  assert.deepEqual(nextSortDirection('updated_at', 'desc', 'updated_at'), {
    sortBy: 'updated_at',
    sortDir: 'asc',
  });
  // Switching to name starts ascending
  assert.deepEqual(nextSortDirection('updated_at', 'desc', 'name'), {
    sortBy: 'name',
    sortDir: 'asc',
  });

  assert.equal(getAriaSortValue('name', 'name', 'asc'), 'ascending');
  assert.equal(getAriaSortValue('name', 'name', 'desc'), 'descending');
  assert.equal(getAriaSortValue('size_bytes', 'name', 'asc'), 'none');
});

test('sortWorkspaceFoldersAndFiles sorts folders and files independently with ja numeric collation and Trash deleted_at support', () => {
  const folders = [
    makeFolder({
      id: 'fld-10',
      name: '第10回議事録',
      classification: 'unset',
      updated_at: '2026-11-10T00:00:00.000Z',
      deleted_at: '2026-11-15T08:00:00.000Z',
    }),
    makeFolder({
      id: 'fld-2',
      name: '第2回議事録',
      classification: 'confidential',
      updated_at: '2026-11-14T00:00:00.000Z',
      deleted_at: '2026-11-15T03:00:00.000Z',
    }),
  ];
  const files = [
    makeFile({
      id: 'fil-a',
      name: 'レポート10.pdf',
      classification: 'public',
      size_bytes: 500,
      updated_at: '2026-11-12T00:00:00.000Z',
      deleted_at: '2026-11-15T01:00:00.000Z',
    }),
    makeFile({
      id: 'fil-b',
      name: 'レポート2.pdf',
      classification: 'confidential',
      size_bytes: 50000,
      updated_at: '2026-11-14T12:00:00.000Z',
      deleted_at: '2026-11-15T09:00:00.000Z',
    }),
    makeFile({
      id: 'fil-c',
      name: 'レポート2.pdf',
      classification: 'confidential',
      size_bytes: 50000,
      updated_at: '2026-11-14T12:00:00.000Z',
      deleted_at: '2026-11-15T09:00:00.000Z',
    }),
  ];

  // Name asc uses Japanese natural numeric ordering (2 before 10) + deterministic ID tie-break
  const byNameAsc = sortWorkspaceFoldersAndFiles({
    folders,
    files,
    sortBy: 'name',
    sortDir: 'asc',
  });
  assert.deepEqual(
    byNameAsc.folders.map((f) => f.id),
    ['fld-2', 'fld-10']
  );
  assert.deepEqual(
    byNameAsc.files.map((f) => f.id),
    ['fil-b', 'fil-c', 'fil-a']
  );

  // Classification desc ranks confidential > internal > public > unset
  const byClassDesc = sortWorkspaceFoldersAndFiles({
    folders,
    files,
    sortBy: 'classification',
    sortDir: 'desc',
  });
  assert.deepEqual(
    byClassDesc.folders.map((f) => f.id),
    ['fld-2', 'fld-10']
  );
  assert.deepEqual(
    byClassDesc.files.map((f) => f.id),
    ['fil-b', 'fil-c', 'fil-a']
  );

  // Size desc puts largest files first while folders stay sorted by name above files
  const bySizeDesc = sortWorkspaceFoldersAndFiles({
    folders,
    files,
    sortBy: 'size_bytes',
    sortDir: 'desc',
  });
  assert.deepEqual(
    bySizeDesc.folders.map((f) => f.id),
    ['fld-2', 'fld-10']
  );
  assert.equal(bySizeDesc.files[2]?.id, 'fil-a');

  // Trash updated_at sort reads deleted_at rather than updated_at
  const byDeletedDesc = sortWorkspaceFoldersAndFiles({
    folders,
    files,
    sortBy: 'updated_at',
    sortDir: 'desc',
    isTrashView: true,
  });
  assert.deepEqual(
    byDeletedDesc.folders.map((f) => f.id),
    ['fld-10', 'fld-2']
  );
  assert.deepEqual(
    byDeletedDesc.files.map((f) => f.id),
    ['fil-b', 'fil-c', 'fil-a']
  );
});

test('chunkItemsIntoGridRows and SSR view preference helpers handle edge cases safely', () => {
  assert.deepEqual(chunkItemsIntoGridRows(['a', 'b', 'c', 'd', 'e'], 4), [
    ['a', 'b', 'c', 'd'],
    ['e'],
  ]);
  assert.deepEqual(chunkItemsIntoGridRows([], 4), []);
  assert.deepEqual(chunkItemsIntoGridRows(['x', 'y'], 0), [['x'], ['y']]);

  // Without window object in Node, preferences safely fall back and ignore writes
  saveWorkspaceViewPrefs('t1', 'u1', {
    sortBy: 'size_bytes',
    sortDir: 'desc',
    viewMode: 'grid',
  });
  assert.deepEqual(loadWorkspaceViewPrefs('t1', 'u1'), DEFAULT_WORKSPACE_VIEW_PREFS);
});
