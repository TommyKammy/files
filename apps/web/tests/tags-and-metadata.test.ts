import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSearchQueryString,
  hasActiveSearchFilters,
} from '@/lib/files-api/search';
import {
  addItemTag,
  createMetadataTemplate,
  deleteMetadataTemplate,
  listItemMetadata,
  listItemTags,
  listMetadataTemplates,
  listTenantTags,
  MAX_TAG_LENGTH,
  normalizeTagInput,
  removeItemTag,
  saveItemMetadata,
  updateMetadataTemplate,
  validateTagInput,
} from '@/lib/files-api/tags-metadata';

test('normalizeTagInput and validateTagInput trim, lowercase, and enforce 1..40 chars', () => {
  assert.equal(normalizeTagInput('  Urgent-2026  '), 'urgent-2026');
  assert.equal(validateTagInput('   ').valid, false);
  assert.equal(validateTagInput('a'.repeat(MAX_TAG_LENGTH + 1)).valid, false);
  assert.deepEqual(validateTagInput('  Contract  '), {
    valid: true,
    tag: 'contract',
  });
});

test('buildSearchQueryString and hasActiveSearchFilters support tag-only searches', () => {
  assert.equal(hasActiveSearchFilters({}), false);
  assert.equal(hasActiveSearchFilters({ tag: '   ' }), false);
  assert.equal(hasActiveSearchFilters({ tag: 'Urgent' }), true);
  assert.equal(buildSearchQueryString({ tag: '  Urgent-2026  ' }), 'tag=urgent-2026');
});

test('tags and metadata API client functions call expected endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });
    return new Response(
      JSON.stringify({ ok: true, tags: [], templates: [], metadata: [] }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }) as typeof fetch;

  try {
    await listTenantTags('Urg');
    await listItemTags('file', 'f-1');
    await addItemTag('folder', 'fld-1', 'urgent');
    await removeItemTag('file', 'f-1', 'urgent');
    await listMetadataTemplates();
    await createMetadataTemplate({
      key: 'contract',
      displayName: '契約',
      fields: [{ key: 'vendor', label: '取引先', type: 'text', required: true }],
    });
    await updateMetadataTemplate('tpl-1', { displayName: '契約v2' });
    await deleteMetadataTemplate('tpl-1');
    await listItemMetadata('file', 'f-1');
    await saveItemMetadata('file', 'f-1', 'tpl-1', { vendor: 'Acme' });

    assert.equal(calls.length, 10);
    assert.deepEqual(calls[0], {
      url: '/api/tags?q=urg',
      method: 'GET',
      body: undefined,
    });
    assert.deepEqual(calls[1], {
      url: '/api/items/file/f-1/tags',
      method: 'GET',
      body: undefined,
    });
    assert.deepEqual(calls[2], {
      url: '/api/items/folder/fld-1/tags',
      method: 'POST',
      body: JSON.stringify({ tag: 'urgent' }),
    });
    assert.deepEqual(calls[3], {
      url: '/api/items/file/f-1/tags/urgent',
      method: 'DELETE',
      body: undefined,
    });
    assert.deepEqual(calls[4], {
      url: '/api/metadata-templates',
      method: 'GET',
      body: undefined,
    });
    assert.deepEqual(calls[5], {
      url: '/api/admin/metadata-templates',
      method: 'POST',
      body: JSON.stringify({
        key: 'contract',
        displayName: '契約',
        fields: [{ key: 'vendor', label: '取引先', type: 'text', required: true }],
      }),
    });
    assert.deepEqual(calls[6], {
      url: '/api/admin/metadata-templates/tpl-1',
      method: 'PATCH',
      body: JSON.stringify({ displayName: '契約v2' }),
    });
    assert.deepEqual(calls[7], {
      url: '/api/admin/metadata-templates/tpl-1',
      method: 'DELETE',
      body: undefined,
    });
    assert.deepEqual(calls[8], {
      url: '/api/items/file/f-1/metadata',
      method: 'GET',
      body: undefined,
    });
    assert.deepEqual(calls[9], {
      url: '/api/items/file/f-1/metadata/tpl-1',
      method: 'PUT',
      body: JSON.stringify({ values: { vendor: 'Acme' } }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
