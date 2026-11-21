import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createItemComment,
  deleteComment,
  listItemActivity,
  listItemComments,
  MAX_COMMENT_LENGTH,
  parseMentionSegments,
  updateComment,
  validateCommentBody,
} from '@/lib/files-api/comments-activity';

test('parseMentionSegments splits @mentions safely without HTML injection', () => {
  assert.deepEqual(parseMentionSegments(''), []);
  assert.deepEqual(parseMentionSegments('Plain text only'), [
    { text: 'Plain text only', isMention: false },
  ]);

  assert.deepEqual(
    parseMentionSegments('@alice 確認お願いします @bob@example.com です'),
    [
      { text: '@alice', isMention: true },
      { text: ' 確認お願いします ', isMention: false },
      { text: '@bob@example.com', isMention: true },
      { text: ' です', isMention: false },
    ]
  );

  // Email address mid-word should not be treated as a @mention
  assert.deepEqual(parseMentionSegments('contact foo@bar.com please'), [
    { text: 'contact foo@bar.com please', isMention: false },
  ]);

  // Script tags remain plain text segments
  assert.deepEqual(parseMentionSegments('<script>alert(1)</script> @alice'), [
    { text: '<script>alert(1)</script> ', isMention: false },
    { text: '@alice', isMention: true },
  ]);
});

test('validateCommentBody trims and enforces 1..2000 character bounds', () => {
  assert.equal(validateCommentBody('   ').valid, false);
  assert.equal(validateCommentBody('').valid, false);
  assert.equal(validateCommentBody('a'.repeat(MAX_COMMENT_LENGTH + 1)).valid, false);

  const ok = validateCommentBody('  こんにちは @alice  ');
  assert.deepEqual(ok, { valid: true, body: 'こんにちは @alice' });
});

test('comments and activity API client functions call expected endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });
    return new Response(JSON.stringify({ ok: true, comments: [], activities: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await listItemComments('file', 'f-1', { limit: 20, offset: 10 });
    await createItemComment('folder', 'fld-2', 'Hello @alice');
    await updateComment('c-1', 'Updated');
    await deleteComment('c-1');
    await listItemActivity('file', 'f-1');

    assert.equal(calls.length, 5);
    assert.deepEqual(calls[0], {
      url: '/api/items/file/f-1/comments?limit=20&offset=10',
      method: 'GET',
      body: undefined,
    });
    assert.deepEqual(calls[1], {
      url: '/api/items/folder/fld-2/comments',
      method: 'POST',
      body: JSON.stringify({ body: 'Hello @alice' }),
    });
    assert.deepEqual(calls[2], {
      url: '/api/comments/c-1',
      method: 'PATCH',
      body: JSON.stringify({ body: 'Updated' }),
    });
    assert.deepEqual(calls[3], {
      url: '/api/comments/c-1',
      method: 'DELETE',
      body: undefined,
    });
    assert.deepEqual(calls[4], {
      url: '/api/items/file/f-1/activity',
      method: 'GET',
      body: undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
