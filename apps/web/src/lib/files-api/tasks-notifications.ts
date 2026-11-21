import type { ItemTargetType } from './comments-activity';
import { apiFetch } from './core';

export type TaskStatus = 'open' | 'approved' | 'rejected' | 'completed';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: '未対応',
  approved: '承認済み',
  rejected: '差し戻し',
  completed: '完了',
};

export interface ItemTask {
  id: string;
  itemType: ItemTargetType;
  itemId: string;
  itemName?: string | null;
  title: string;
  message: string | null;
  assigneeId: string;
  assigneeDisplayName: string;
  assigneeEmail: string | null;
  createdBy: string;
  creatorDisplayName: string;
  creatorEmail: string | null;
  status: TaskStatus;
  dueAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolverDisplayName: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NotificationType =
  | 'mention'
  | 'task_assigned'
  | 'task_resolved'
  | 'share_granted';

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  mention: 'メンション',
  task_assigned: 'タスク割当',
  task_resolved: 'タスク結果',
  share_granted: '共有権限',
};

export interface UserNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  targetType: string | null;
  targetId: string | null;
  actorId: string | null;
  actorDisplayName: string;
  readAt: string | null;
  createdAt: string;
}

export function validateTaskTitle(
  raw: string
): { valid: true; title: string } | { valid: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'タスクのタイトルを入力してください。' };
  }
  if (trimmed.length > 200) {
    return {
      valid: false,
      error: 'タイトルは 200 文字以内で入力してください。',
    };
  }
  return { valid: true, title: trimmed };
}

export function formatUnreadBadgeCount(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count > 99) return '99+';
  return String(Math.floor(count));
}

export function resolveNotificationHref(
  notification: Pick<UserNotification, 'targetType' | 'targetId'>
): string | null {
  if (!notification.targetId) {
    return notification.targetType === 'task' ? '/workspace?view=tasks' : null;
  }
  if (notification.targetType === 'file') {
    return `/workspace/file/${encodeURIComponent(notification.targetId)}`;
  }
  if (notification.targetType === 'folder') {
    return `/workspace?folderId=${encodeURIComponent(notification.targetId)}`;
  }
  if (notification.targetType === 'task') {
    return '/workspace?view=tasks';
  }
  return null;
}

export function listItemTasks(
  itemType: ItemTargetType,
  itemId: string,
  signal?: AbortSignal
): Promise<{ tasks: ItemTask[] }> {
  return apiFetch(
    `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/tasks`,
    { signal }
  );
}

export function createItemTask(
  itemType: ItemTargetType,
  itemId: string,
  input: {
    title: string;
    message?: string | null;
    assigneeId: string;
    dueAt?: string | null;
  }
): Promise<{ task: ItemTask }> {
  return apiFetch(
    `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/tasks`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    }
  );
}

export function updateTaskStatus(
  taskId: string,
  input: {
    status: TaskStatus;
    resolutionNote?: string | null;
  }
): Promise<{ task: ItemTask }> {
  return apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function listMyTasks(
  status: 'open' | 'all' = 'open',
  signal?: AbortSignal
): Promise<{ tasks: ItemTask[] }> {
  const params = new URLSearchParams({ status });
  return apiFetch(`/api/tasks/my?${params.toString()}`, { signal });
}

export function listNotifications(
  opts?: { limit?: number; unreadOnly?: boolean },
  signal?: AbortSignal
): Promise<{
  notifications: UserNotification[];
  limit: number;
  unreadOnly: boolean;
}> {
  const params = new URLSearchParams();
  if (typeof opts?.limit === 'number') {
    params.set('limit', String(opts.limit));
  }
  if (opts?.unreadOnly) {
    params.set('unreadOnly', 'true');
  }
  const qs = params.toString();
  return apiFetch(`/api/notifications${qs ? `?${qs}` : ''}`, { signal });
}

export function getUnreadNotificationCount(
  signal?: AbortSignal
): Promise<{ count: number }> {
  return apiFetch('/api/notifications/unread-count', { signal });
}

export function markNotificationRead(
  notificationId: string
): Promise<{ ok: boolean; id: string; readAt: string }> {
  return apiFetch(
    `/api/notifications/${encodeURIComponent(notificationId)}/read`,
    { method: 'POST' }
  );
}

export function markAllNotificationsRead(): Promise<{
  ok: boolean;
  updatedCount: number;
}> {
  return apiFetch('/api/notifications/read-all', { method: 'POST' });
}
