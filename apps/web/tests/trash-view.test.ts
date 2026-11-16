import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTrashQueryString,
  buildTrashRequestParams,
  DEFAULT_TRASH_FILTERS,
  getTrashEmptyState,
  getTrashRetentionBadge,
  isTrashFilterActive,
  mergeTrashItems,
  nextTrashSortForField,
  removeTrashItem,
  trashItemKey,
  trashSortToTableSort,
} from '@/lib/trash-view';
import type { TrashFileItem, TrashFolderItem } from '@/types/files';

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
    ...overrides,
  };
}

function fileItem(
  overrides: Partial<TrashFileItem> & { id: string; name: string }
): TrashFileItem {
  return {
    type: 'file',
    folder_id: 'folder-root',
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
    ...overrides,
  };
}

test('retention badge boundaries map to calm/normal/warning/urgent levels', () => {
  const cases: Array<{
    days: number;
    level: string;
    label: string;
  }> = [
    { days: 30, level: 'calm', label: '残り 30日' },
    { days: 29, level: 'normal', label: '残り 29日' },
    { days: 8, level: 'normal', label: '残り 8日' },
    { days: 7, level: 'warning', label: '残り 7日（注意）' },
    { days: 2, level: 'warning', label: '残り 2日（注意）' },
    { days: 1, level: 'urgent', label: '期限切れ間近（残り1日）' },
    { days: 0, level: 'urgent', label: '本日削除予定' },
    { days: -1, level: 'urgent', label: '期限超過' },
  ];

  for (const { days, level, label } of cases) {
    const badge = getTrashRetentionBadge(days);
    assert.equal(badge.level, level, `days=${days} level`);
    assert.equal(badge.label, label, `days=${days} label`);
    assert.ok(badge.className.length > 0);
  }

  assert.equal(getTrashRetentionBadge(null).level, 'unknown');
  assert.equal(getTrashRetentionBadge(Number.NaN).level, 'unknown');
});

test('buildTrashRequestParams trims query, preserves cursor and defaults to 50', () => {
  assert.deepEqual(buildTrashRequestParams(DEFAULT_TRASH_FILTERS), {
    limit: 50,
    cursor: null,
    query: '',
    type: 'all',
    deletedBy: null,
    deletedFrom: null,
    deletedTo: null,
    sort: 'deletedAt_desc',
  });

  const params = buildTrashRequestParams(
    {
      query: '  quarterly report  ',
      type: 'file',
      deletedBy: 'dev-member-001',
      deletedFrom: '2026-11-01T00:00:00.000Z',
      deletedTo: '2026-11-30T23:59:59.000Z',
      sort: 'name_desc',
    },
    { cursor: 'abc', limit: 200 }
  );
  assert.equal(params.query, 'quarterly report');
  assert.equal(params.type, 'file');
  assert.equal(params.deletedBy, 'dev-member-001');
  assert.equal(params.sort, 'name_desc');
  assert.equal(params.cursor, 'abc');
  assert.equal(params.limit, 200);
});

test('buildTrashQueryString encodes filters, dates, cursor and keeps sort explicit', () => {
  const params = buildTrashRequestParams(
    {
      query: 'a&b=c',
      type: 'folder',
      deletedBy: 'unknown',
      deletedFrom: '2026-11-01T00:00:00.000Z',
      deletedTo: '2026-11-30T23:59:59.000Z',
      sort: 'name_desc',
    },
    { cursor: 'cursor+/=', limit: 200 }
  );
  const qs = new URLSearchParams(buildTrashQueryString(params));
  assert.equal(qs.get('limit'), '200');
  assert.equal(qs.get('query'), 'a&b=c');
  assert.equal(qs.get('type'), 'folder');
  assert.equal(qs.get('deletedBy'), 'unknown');
  assert.equal(qs.get('deletedFrom'), '2026-11-01T00:00:00.000Z');
  assert.equal(qs.get('deletedTo'), '2026-11-30T23:59:59.000Z');
  assert.equal(qs.get('cursor'), 'cursor+/=');
  assert.equal(qs.get('sort'), 'name_desc');

  assert.equal(
    buildTrashQueryString(buildTrashRequestParams(DEFAULT_TRASH_FILTERS)),
    'limit=50&sort=deletedAt_desc'
  );
});

test('mergeTrashItems appends cursor pages while de-duplicating folder/file ids', () => {
  const firstPage = [
    folderItem({ id: 'f-1', name: 'alpha' }),
    fileItem({ id: '1', name: 'shared.txt' }),
  ];
  const secondPage = [
    fileItem({ id: '1', name: 'shared.txt' }),
    folderItem({ id: 'f-1', name: 'alpha' }),
    fileItem({ id: '2', name: 'beta.txt' }),
    folderItem({ id: 'f-2', name: 'gamma' }),
  ];

  const merged = mergeTrashItems(firstPage, secondPage);
  assert.deepEqual(
    merged.map(trashItemKey),
    ['folder:f-1', 'file:1', 'file:2', 'folder:f-2']
  );
});

test('removeTrashItem removes only the matching type and id', () => {
  const items = [
    folderItem({ id: 'shared-id', name: 'folder' }),
    fileItem({ id: 'shared-id', name: 'file' }),
    fileItem({ id: 'other', name: 'other' }),
  ];
  const afterFile = removeTrashItem(items, 'file', 'shared-id');
  assert.deepEqual(
    afterFile.map(trashItemKey),
    ['folder:shared-id', 'file:other']
  );
});

test('isTrashFilterActive ignores sort and detects query/type/deleter/date filters', () => {
  assert.equal(isTrashFilterActive(DEFAULT_TRASH_FILTERS), false);
  assert.equal(
    isTrashFilterActive({ ...DEFAULT_TRASH_FILTERS, sort: 'name_asc' }),
    false
  );
  assert.equal(
    isTrashFilterActive({ ...DEFAULT_TRASH_FILTERS, query: '   ' }),
    false
  );
  assert.equal(
    isTrashFilterActive({ ...DEFAULT_TRASH_FILTERS, query: 'report' }),
    true
  );
  assert.equal(
    isTrashFilterActive({ ...DEFAULT_TRASH_FILTERS, type: 'folder' }),
    true
  );
  assert.equal(
    isTrashFilterActive({
      ...DEFAULT_TRASH_FILTERS,
      deletedBy: 'user-1',
    }),
    true
  );
  assert.equal(
    isTrashFilterActive({
      ...DEFAULT_TRASH_FILTERS,
      deletedFrom: '2026-11-01T00:00:00.000Z',
    }),
    true
  );
});

test('getTrashEmptyState distinguishes empty Trash from zero-result filters', () => {
  assert.equal(getTrashEmptyState(DEFAULT_TRASH_FILTERS, 0), 'empty');
  assert.equal(getTrashEmptyState(DEFAULT_TRASH_FILTERS, 1), 'list');
  assert.equal(
    getTrashEmptyState(
      { ...DEFAULT_TRASH_FILTERS, query: 'missing' },
      0
    ),
    'filtered-empty'
  );
  assert.equal(
    getTrashEmptyState({ ...DEFAULT_TRASH_FILTERS, type: 'folder' }, 0),
    'filtered-empty'
  );
  assert.equal(
    getTrashEmptyState(
      { ...DEFAULT_TRASH_FILTERS, query: 'missing' },
      3
    ),
    'list'
  );
});

test('trash sort helpers map to table headers and toggle deterministically', () => {  assert.deepEqual(trashSortToTableSort('deletedAt_desc'), {
    sortBy: 'updated_at',
    sortDir: 'desc',
  });
  assert.deepEqual(trashSortToTableSort('deletedAt_asc'), {
    sortBy: 'updated_at',
    sortDir: 'asc',
  });
  assert.deepEqual(trashSortToTableSort('name_asc'), {
    sortBy: 'name',
    sortDir: 'asc',
  });
  assert.deepEqual(trashSortToTableSort('name_desc'), {
    sortBy: 'name',
    sortDir: 'desc',
  });

  assert.equal(nextTrashSortForField('deletedAt_desc', 'name'), 'name_asc');
  assert.equal(nextTrashSortForField('name_asc', 'name'), 'name_desc');
  assert.equal(
    nextTrashSortForField('name_desc', 'updated_at'),
    'deletedAt_desc'
  );
  assert.equal(
    nextTrashSortForField('deletedAt_desc', 'updated_at'),
    'deletedAt_asc'
  );
  assert.equal(nextTrashSortForField('deletedAt_asc', 'size_bytes'), null);
  assert.equal(
    nextTrashSortForField('deletedAt_asc', 'classification'),
    null
  );
});
