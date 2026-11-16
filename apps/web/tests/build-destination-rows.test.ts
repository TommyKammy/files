import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDestinationRows } from '@/lib/build-destination-rows';
import type { FolderSummary, ResourceRole } from '@/types/files';

function folder(
  id: string,
  overrides: Partial<FolderSummary> = {}
): FolderSummary {
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

function makeSource(options: {
  search?: Array<{ folder: FolderSummary; pathHint: string }>;
  views: Record<string, { folder?: FolderSummary | null; folders?: FolderSummary[]; effectiveRole?: ResourceRole }>;
}) {
  return {
    searchCachedWorkspaceItems() {
      return { folders: options.search ?? [] };
    },
    getDirectoryView(folderId: string | null) {
      const key = folderId ?? '__ROOT__';
      const view = options.views[key] ?? {};
      return {
        folder: view.folder ?? null,
        folders: view.folders ?? [],
        effectiveRole: view.effectiveRole ?? 'editor',
      };
    },
  };
}

test('buildDestinationRows returns search matches with path hints', () => {
  const rows = buildDestinationRows({
    query: 'alpha',
    recentList: [],
    expandedIds: new Set(),
    source: makeSource({
      search: [{ folder: folder('a', { name: 'Alpha' }), pathHint: 'Root / Team' }],
      views: {},
    }),
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.rowKey, 'tree:__ROOT__');
  assert.equal(rows[1]!.name, 'Alpha (Root / Team)');
  assert.equal(rows[1]!.effectiveRole, 'editor');
});

test('buildDestinationRows sorts tree nodes and expands selected folders', () => {
  const rows = buildDestinationRows({
    query: '',
    recentList: [],
    expandedIds: new Set(['a']),
    source: makeSource({
      views: {
        __ROOT__: {
          folders: [folder('b', { name: 'Beta' }), folder('a', { name: 'Alpha' })],
        },
        a: {
          folders: [
            folder('a-child', {
              name: 'Child',
              parent_id: 'a',
              effectiveRole: undefined,
            }),
          ],
          effectiveRole: 'owner',
        },
        'a-child': { effectiveRole: 'viewer' },
      },
    }),
  });

  const treeRows = rows.filter((r) => r.section === 'tree');
  assert.deepEqual(
    treeRows.map((r) => r.name),
    ['マイファイル (ルート)', 'Alpha', 'Child', 'Beta']
  );
  const alpha = treeRows.find((r) => r.folderId === 'a')!;
  const child = treeRows.find((r) => r.folderId === 'a-child')!;
  assert.equal(alpha.isExpanded, true);
  assert.equal(child.depth, 2);
  assert.equal(child.effectiveRole, 'viewer');
});

test('buildDestinationRows keeps valid recents and skips deleted folders', () => {
  const rows = buildDestinationRows({
    query: '',
    recentList: [
      {
        id: null,
        name: 'マイファイル',
        classification: 'unset',
        usedAt: 0,
      },
      {
        id: 'recent-ok',
        name: 'Recent',
        classification: 'internal',
        usedAt: 0,
      },
      {
        id: 'deleted',
        name: 'Deleted',
        classification: 'internal',
        usedAt: 0,
      },
    ],
    expandedIds: new Set(),
    source: makeSource({
      views: {
        'recent-ok': {
          folder: folder('recent-ok', { name: 'Recent' }),
          effectiveRole: 'co_owner',
        },
        deleted: {
          folder: folder('deleted', { deleted_at: '2026-11-15T00:00:00.000Z' }),
        },
      },
    }),
  });

  const recentRows = rows.filter((r) => r.section === 'recent');
  assert.equal(recentRows.length, 2);
  assert.equal(recentRows[0]!.folderId, null);
  assert.equal(recentRows[1]!.name, 'Recent');
  assert.equal(recentRows[1]!.effectiveRole, 'co_owner');
  assert.equal(rows.some((r) => r.folderId === 'deleted'), false);
});
