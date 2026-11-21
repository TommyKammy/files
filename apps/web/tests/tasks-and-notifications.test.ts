import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createItemTask,
  formatUnreadBadgeCount,
  getUnreadNotificationCount,
  listItemTasks,
  listMyTasks,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_TYPE_LABELS,
  resolveNotificationHref,
  TASK_STATUS_LABELS,
  updateTaskStatus,
  validateTaskTitle,
} from '@/lib/files-api/tasks-notifications';

test('validateTaskTitle trims and enforces length limits', () => {
  assert.deepEqual(validateTaskTitle('   '), {
    valid: false,
    error: 'タスクのタイトルを入力してください。',
  });
  assert.deepEqual(validateTaskTitle('  承認依頼  '), {
    valid: true,
    title: '承認依頼',
  });
  const tooLong = 'a'.repeat(201);
  assert.equal(validateTaskTitle(tooLong).valid, false);
});

test('formatUnreadBadgeCount formats 0, 1..99, and 100+ counts', () => {
  assert.equal(formatUnreadBadgeCount(0), null);
  assert.equal(formatUnreadBadgeCount(-2), null);
  assert.equal(formatUnreadBadgeCount(1), '1');
  assert.equal(formatUnreadBadgeCount(99), '99');
  assert.equal(formatUnreadBadgeCount(100), '99+');
});

test('resolveNotificationHref maps file, folder, and task targets', () => {
  assert.equal(
    resolveNotificationHref({ targetType: 'file', targetId: 'f-1' }),
    '/workspace/file/f-1'
  );
  assert.equal(
    resolveNotificationHref({ targetType: 'folder', targetId: 'fld-1' }),
    '/workspace?folderId=fld-1'
  );
  assert.equal(
    resolveNotificationHref({ targetType: 'task', targetId: 't-1' }),
    '/workspace?view=tasks'
  );
  assert.equal(
    resolveNotificationHref({ targetType: null, targetId: null }),
    null
  );
});

test('status and notification type labels are complete', () => {
  assert.equal(TASK_STATUS_LABELS.open, '未対応');
  assert.equal(TASK_STATUS_LABELS.approved, '承認済み');
  assert.equal(TASK_STATUS_LABELS.rejected, '差し戻し');
  assert.equal(TASK_STATUS_LABELS.completed, '完了');

  assert.equal(NOTIFICATION_TYPE_LABELS.mention, 'メンション');
  assert.equal(NOTIFICATION_TYPE_LABELS.task_assigned, 'タスク割当');
  assert.equal(NOTIFICATION_TYPE_LABELS.task_resolved, 'タスク結果');
  assert.equal(NOTIFICATION_TYPE_LABELS.share_granted, '共有権限');
});

test('tasks & notifications API client functions call expected endpoints', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const origFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify({ ok: true, tasks: [], notifications: [], count: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    await listItemTasks('file', 'f-1');
    await createItemTask('file', 'f-1', {
      title: 'Confirm',
      assigneeId: 'u-2',
    });
    await updateTaskStatus('t-1', { status: 'approved', resolutionNote: 'LGTM' });
    await listMyTasks('open');
    await listNotifications({ limit: 20, unreadOnly: true });
    await getUnreadNotificationCount();
    await markNotificationRead('n-1');
    await markAllNotificationsRead();

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      [
        'GET /api/items/file/f-1/tasks',
        'POST /api/items/file/f-1/tasks',
        'PATCH /api/tasks/t-1',
        'GET /api/tasks/my?status=open',
        'GET /api/notifications?limit=20&unreadOnly=true',
        'GET /api/notifications/unread-count',
        'POST /api/notifications/n-1/read',
        'POST /api/notifications/read-all',
      ]
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
