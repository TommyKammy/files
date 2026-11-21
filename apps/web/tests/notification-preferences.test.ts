import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from '@/lib/files-api/tasks-notifications';

test('getNotificationPreferences and updateNotificationPreferences call expected endpoints', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const origFetch = globalThis.fetch;

  const currentPrefs: NotificationPreferences = {
    emailOnMention: true,
    emailOnTaskAssigned: true,
    emailOnTaskResolved: true,
    emailOnShareGranted: true,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method, body });

    if (method === 'PATCH' && body) {
      const patch = JSON.parse(body) as Partial<NotificationPreferences>;
      Object.assign(currentPrefs, patch);
    }

    return new Response(JSON.stringify({ preferences: { ...currentPrefs } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const initial = await getNotificationPreferences();
    assert.deepEqual(initial.preferences, {
      emailOnMention: true,
      emailOnTaskAssigned: true,
      emailOnTaskResolved: true,
      emailOnShareGranted: true,
    });

    const updated = await updateNotificationPreferences({
      emailOnMention: false,
      emailOnShareGranted: false,
    });
    assert.deepEqual(updated.preferences, {
      emailOnMention: false,
      emailOnTaskAssigned: true,
      emailOnTaskResolved: true,
      emailOnShareGranted: false,
    });

    assert.deepEqual(calls, [
      {
        url: '/api/notifications/preferences',
        method: 'GET',
        body: undefined,
      },
      {
        url: '/api/notifications/preferences',
        method: 'PATCH',
        body: JSON.stringify({
          emailOnMention: false,
          emailOnShareGranted: false,
        }),
      },
    ]);
  } finally {
    globalThis.fetch = origFetch;
  }
});
