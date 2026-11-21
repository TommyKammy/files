export type UserNotificationType =
  | 'mention'
  | 'task_assigned'
  | 'task_resolved'
  | 'share_granted';

export interface CreateUserNotificationInput {
  tenantId: string;
  userId: string;
  type: UserNotificationType;
  title: string;
  body?: string | null;
  targetType?: 'file' | 'folder' | 'task' | null;
  targetId?: string | null;
  actorId?: string | null;
  nowIso?: string;
}

/**
 * Insert a user notification into `user_notifications`.
 * Skips self-notifications (`actorId === userId`) and never throws so caller
 * mutations remain resilient even if notification delivery fails.
 */
export async function createUserNotification(
  db: D1Database,
  input: CreateUserNotificationInput
): Promise<string | null> {
  if (!input.userId || (input.actorId && input.actorId === input.userId)) {
    return null;
  }

  const id = crypto.randomUUID();
  const createdAt = input.nowIso ?? new Date().toISOString();
  const title = input.title.trim().slice(0, 240);
  const body =
    typeof input.body === 'string' && input.body.trim().length > 0
      ? input.body.trim().slice(0, 500)
      : null;

  try {
    await db
      .prepare(
        `INSERT INTO user_notifications (
           id, tenant_id, user_id, type, title, body, target_type, target_id, actor_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        input.tenantId,
        input.userId,
        input.type,
        title,
        body,
        input.targetType ?? null,
        input.targetId ?? null,
        input.actorId ?? null,
        createdAt
      )
      .run();
    return id;
  } catch (err) {
    console.warn('[notifications] failed to create user notification:', err);
    return null;
  }
}
