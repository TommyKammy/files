import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSearchQueryString,
  hasActiveSearchFilters,
  mergeSearchPages,
  type SearchWorkspaceResponse,
} from '@/lib/files-api/search';
import { mergePaletteEntries } from '@/lib/keyboard/palette';

test('buildSearchQueryString encodes filters, normalizes extension, and clamps limit', () => {
  assert.equal(buildSearchQueryString({ q: '  ', type: 'all', offset: 0 }), '');

  const qs = buildSearchQueryString({
    q: '契約書',
    type: 'folder',
    classification: 'confidential',
    extension: ' .PDF ',
    folderId: 'fld-1',
    updatedFrom: '2026-10-01',
    updatedTo: '2026-10-31',
    minSize: 1024,
    maxSize: 4096,
    ownerId: 'usr-1',
    limit: 500,
    offset: 25,
  });

  const params = new URLSearchParams(qs);
  assert.equal(params.get('q'), '契約書');
  assert.equal(params.get('type'), 'folder');
  assert.equal(params.get('classification'), 'confidential');
  assert.equal(params.get('extension'), 'pdf');
  assert.equal(params.get('folderId'), 'fld-1');
  assert.equal(params.get('updatedFrom'), '2026-10-01');
  assert.equal(params.get('updatedTo'), '2026-10-31');
  assert.equal(params.get('minSize'), '1024');
  assert.equal(params.get('maxSize'), '4096');
  assert.equal(params.get('ownerId'), 'usr-1');
  assert.equal(params.get('limit'), '100');
  assert.equal(params.get('offset'), '25');
});

test('hasActiveSearchFilters detects filter-only searches', () => {
  assert.equal(hasActiveSearchFilters({}), false);
  assert.equal(hasActiveSearchFilters({ q: '   ', type: 'all' }), false);
  assert.equal(hasActiveSearchFilters({ type: 'folder' }), true);
  assert.equal(hasActiveSearchFilters({ classification: 'internal' }), true);
  assert.equal(hasActiveSearchFilters({ extension: 'pdf' }), true);
  assert.equal(hasActiveSearchFilters({ updatedFrom: '2026-10-01' }), true);
  assert.equal(hasActiveSearchFilters({ minSize: 0 }), true);
});

test('mergeSearchPages deduplicates folder and file IDs across paginated responses', () => {
  const page1: SearchWorkspaceResponse = {
    query: 'alpha',
    limit: 25,
    offset: 0,
    hasMore: true,
    nextOffset: 25,
    folders: [
      {
        id: 'fld-1',
        parentId: null,
        parentName: null,
        name: 'Alpha',
        depth: 0,
        classification: 'internal',
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ],
    results: [
      {
        id: 'file-1',
        folderId: 'fld-1',
        folderName: 'Alpha',
        name: 'a.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
        sizeBytes: 100,
        classification: 'internal',
        aiSuggestedLabel: null,
        aiConfidence: null,
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ],
  };

  const page2: SearchWorkspaceResponse = {
    query: 'alpha',
    limit: 25,
    offset: 25,
    hasMore: false,
    nextOffset: null,
    folders: [
      page1.folders[0],
      {
        id: 'fld-2',
        parentId: 'fld-1',
        parentName: 'Alpha',
        name: 'Alpha Sub',
        depth: 1,
        classification: 'confidential',
        updatedAt: '2026-10-02T00:00:00Z',
      },
    ],
    results: [
      page1.results[0],
      {
        id: 'file-2',
        folderId: 'fld-2',
        folderName: 'Alpha Sub',
        name: 'b.pdf',
        extension: 'pdf',
        mimeType: 'application/pdf',
        sizeBytes: 200,
        classification: 'confidential',
        aiSuggestedLabel: null,
        aiConfidence: null,
        updatedAt: '2026-10-02T00:00:00Z',
      },
    ],
  };

  const merged = mergeSearchPages(page1, page2);
  assert.deepEqual(
    merged.folders.map((f) => f.id),
    ['fld-1', 'fld-2']
  );
  assert.deepEqual(
    merged.results.map((r) => r.id),
    ['file-1', 'file-2']
  );
  assert.equal(merged.hasMore, false);
  assert.equal(merged.nextOffset, null);
});

test('mergePaletteEntries surfaces remoteFolders and deduplicates against localFolders', () => {
  const entries = mergePaletteEntries({
    query: 'alpha',
    commands: [],
    localFolders: [
      {
        folder: {
          id: 'fld-local',
          parent_id: null,
          name: 'Alpha Local',
          classification: 'internal',
          is_pinned: 0,
          version: 1,
          updated_at: '2026-10-01T00:00:00Z',
        },
        pathHint: 'マイファイル',
      },
    ],
    localFiles: [],
    remoteFolders: [
      {
        id: 'fld-local',
        parentId: null,
        parentName: null,
        name: 'Alpha Local',
        depth: 0,
        classification: 'internal',
        updatedAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 'fld-remote',
        parentId: 'fld-local',
        parentName: 'Alpha Local',
        name: 'Alpha Remote',
        depth: 1,
        classification: 'confidential',
        updatedAt: '2026-10-02T00:00:00Z',
      },
    ],
    remoteResults: [],
  });

  assert.deepEqual(
    entries.map((e) => e.key),
    ['local-folder:fld-local', 'remote-folder:fld-remote']
  );
});
