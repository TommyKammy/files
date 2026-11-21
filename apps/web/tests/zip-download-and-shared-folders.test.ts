import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiClientError,
  downloadPublicShareZip,
  downloadWorkspaceZip,
  getPublicShareMeta,
  parseContentDispositionFilename,
} from '@/lib/files-api';

test('parseContentDispositionFilename decodes UTF-8 filename* and falls back cleanly', () => {
  assert.equal(
    parseContentDispositionFilename(
      `attachment; filename="__________.zip"; filename*=UTF-8''${encodeURIComponent('共有プロジェクト.zip')}`
    ),
    '共有プロジェクト.zip'
  );
  assert.equal(
    parseContentDispositionFilename('attachment; filename="archive.zip"'),
    'archive.zip'
  );
  assert.equal(
    parseContentDispositionFilename(null, 'fallback.zip'),
    'fallback.zip'
  );
});

test('downloadWorkspaceZip posts items, parses filename, and surfaces 413/403 ApiClientError', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let seenUrl = '';
    let seenMethod = '';
    let seenBody = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = init?.method ?? 'GET';
      seenBody = String(init?.body ?? '');
      return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="project.zip"; filename*=UTF-8''${encodeURIComponent('案件資料.zip')}`,
        },
      });
    }) as typeof fetch;

    const result = await downloadWorkspaceZip({
      items: [{ type: 'folder', id: 'fld-1' }],
    });
    assert.equal(seenUrl, '/api/workspace/download-zip');
    assert.equal(seenMethod, 'POST');
    assert.deepEqual(JSON.parse(seenBody), {
      items: [{ type: 'folder', id: 'fld-1' }],
    });
    assert.equal(result.filename, '案件資料.zip');
    assert.equal(result.blob.size, 4);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'ZIPダウンロードの上限を超えています',
          code: 'ZIP_LIMIT_EXCEEDED',
        }),
        { status: 413, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;

    await assert.rejects(
      () => downloadWorkspaceZip({ items: [{ type: 'folder', id: 'fld-1' }] }),
      (err: unknown) =>
        err instanceof ApiClientError &&
        err.status === 413 &&
        err.code === 'ZIP_LIMIT_EXCEEDED'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getPublicShareMeta and downloadPublicShareZip forward folderId and unlockToken', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const calls: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.includes('/meta')) {
        return new Response(JSON.stringify({ targetType: 'folder', folderFiles: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(new Uint8Array([0x50, 0x4b]), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': 'attachment; filename="sub.zip"',
          'X-Download-Count': '3',
        },
      });
    }) as typeof fetch;

    await getPublicShareMeta('tok-123');
    await getPublicShareMeta('tok-123', 'sub-456');
    const zip = await downloadPublicShareZip('tok-123', {
      folderId: 'sub-456',
      unlockToken: 'unlock-abc',
    });

    assert.equal(calls[0]!.url, '/api/s/tok-123/meta');
    assert.equal(calls[1]!.url, '/api/s/tok-123/meta?folderId=sub-456');
    assert.equal(calls[2]!.url, '/api/s/tok-123/zip?folderId=sub-456');
    assert.equal(calls[2]!.headers.get('X-Share-Unlock'), 'unlock-abc');
    assert.equal(zip.filename, 'sub.zip');
    assert.equal(zip.downloadCount, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
