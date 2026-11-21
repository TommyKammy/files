import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addFavorite,
  buildFavoriteKey,
  clampRecentsLimit,
  filterFavoriteRecentItems,
  listFavorites,
  listRecents,
  recentActionLabel,
  removeFavorite,
  touchRecentItem,
} from '@/lib/files-api/favorites-recents';

test('buildFavoriteKey builds deterministic type:id keys', () => {
  assert.equal(buildFavoriteKey('file', 'f1'), 'file:f1');
  assert.equal(buildFavoriteKey('folder', 'fld-9'), 'folder:fld-9');
});

test('clampRecentsLimit defaults to 50 and clamps to 1..200', () => {
  assert.equal(clampRecentsLimit(undefined), 50);
  assert.equal(clampRecentsLimit(Number.NaN), 50);
  assert.equal(clampRecentsLimit(0), 1);
  assert.equal(clampRecentsLimit(-10), 1);
  assert.equal(clampRecentsLimit(25), 25);
  assert.equal(clampRecentsLimit(999), 200);
});

test('recentActionLabel returns Japanese labels for all actions', () => {
  assert.equal(recentActionLabel('view'), '閲覧');
  assert.equal(recentActionLabel('edit'), '編集');
  assert.equal(recentActionLabel('download'), 'ダウンロード');
  assert.equal(recentActionLabel('upload'), 'アップロード');
});

test('filterFavoriteRecentItems filters case-insensitively by name or pathLabel', () => {
  const items = [
    { name: 'Roadmap_2026.pdf', pathLabel: 'マイファイル / Projects / Q4' },
    { name: 'Budget.xlsx', pathLabel: 'マイファイル / Finance' },
  ];

  assert.equal(filterFavoriteRecentItems(items, '').length, 2);
  assert.equal(filterFavoriteRecentItems(items, '  ').length, 2);
  assert.deepEqual(
    filterFavoriteRecentItems(items, 'roadmap').map((i) => i.name),
    ['Roadmap_2026.pdf']
  );
  assert.deepEqual(
    filterFavoriteRecentItems(items, 'finance').map((i) => i.name),
    ['Budget.xlsx']
  );
  assert.deepEqual(filterFavoriteRecentItems(items, 'missing'), []);
});

test('favorites and recents API client functions call expected endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });
    return new Response(JSON.stringify({ ok: true, items: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await listFavorites();
    await addFavorite('file', 'f-1');
    await removeFavorite('folder', 'fld-2');
    await listRecents(250);
    await touchRecentItem('file', 'f-1', 'download');

    assert.equal(calls.length, 5);
    assert.deepEqual(calls[0], { url: '/api/favorites', method: 'GET', body: undefined });
    assert.deepEqual(calls[1], {
      url: '/api/favorites',
      method: 'POST',
      body: JSON.stringify({ itemType: 'file', itemId: 'f-1' }),
    });
    assert.deepEqual(calls[2], {
      url: '/api/favorites/folder/fld-2',
      method: 'DELETE',
      body: undefined,
    });
    assert.deepEqual(calls[3], {
      url: '/api/recents?limit=200',
      method: 'GET',
      body: undefined,
    });
    assert.deepEqual(calls[4], {
      url: '/api/recents/touch',
      method: 'POST',
      body: JSON.stringify({ itemType: 'file', itemId: 'f-1', action: 'download' }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
