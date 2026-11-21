import type { OidcEnv } from '../types/oidc';
import { createMailProvider } from './mail-provider';

export type UserNotificationType =
  | 'mention'
  | 'task_assigned'
  | 'task_resolved'
  | 'share_granted';

export interface NotificationPreferences {
  emailOnMention: boolean;
  emailOnTaskAssigned: boolean;
  emailOnTaskResolved: boolean;
  emailOnShareGranted: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  emailOnMention: true,
  emailOnTaskAssigned: true,
  emailOnTaskResolved: true,
  emailOnShareGranted: true,
};

export type NotificationMailEnv = Pick<
  OidcEnv,
  'DB' | 'ENVIRONMENT' | 'MAIL_WEBHOOK_URL' | 'MAIL_API_KEY' | 'MAIL_FROM' | 'APP_ORIGIN'
>;

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

interface PreferenceRow {
  email_on_mention: number;
  email_on_task_assigned: number;
  email_on_task_resolved: number;
  email_on_share_granted: number;
}

interface RecipientPreferenceRow {
  email: string | null;
  display_name: string | null;
  status: string;
  email_on_mention: number | null;
  email_on_task_assigned: number | null;
  email_on_task_resolved: number | null;
  email_on_share_granted: number | null;
}

function rowToPreferences(row: PreferenceRow | null | undefined): NotificationPreferences {
  if (!row) {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
  return {
    emailOnMention: row.email_on_mention !== 0,
    emailOnTaskAssigned: row.email_on_task_assigned !== 0,
    emailOnTaskResolved: row.email_on_task_resolved !== 0,
    emailOnShareGranted: row.email_on_share_granted !== 0,
  };
}

function isEmailEnabledForType(
  prefs: NotificationPreferences,
  type: UserNotificationType
): boolean {
  switch (type) {
    case 'mention':
      return prefs.emailOnMention;
    case 'task_assigned':
      return prefs.emailOnTaskAssigned;
    case 'task_resolved':
      return prefs.emailOnTaskResolved;
    case 'share_granted':
      return prefs.emailOnShareGranted;
  }
}

function resolveNotificationTargetUrl(
  appOrigin: string | undefined,
  targetType?: 'file' | 'folder' | 'task' | null,
  targetId?: string | null
): string | null {
  const origin = appOrigin?.trim().replace(/\/+$/, '');
  if (!origin) return null;

  if (targetType === 'file' && targetId) {
    return `${origin}/workspace/file/${encodeURIComponent(targetId)}`;
  }
  if (targetType === 'folder' && targetId) {
    return `${origin}/workspace?folderId=${encodeURIComponent(targetId)}`;
  }
  if (targetType === 'task') {
    return `${origin}/workspace?view=tasks`;
  }
  return null;
}

async function maybeSendNotificationEmail(
  db: D1Database,
  input: CreateUserNotificationInput,
  title: string,
  body: string | null,
  env: NotificationMailEnv
): Promise<void> {
  try {
    const row = await db
      .prepare(
        `SELECT u.email,
                u.display_name,
                u.status,
                p.email_on_mention,
                p.email_on_task_assigned,
                p.email_on_task_resolved,
                p.email_on_share_granted
           FROM users u
           LEFT JOIN user_notification_preferences p
             ON p.tenant_id = u.tenant_id AND p.user_id = u.id
          WHERE u.tenant_id = ? AND u.id = ?`
      )
      .bind(input.tenantId, input.userId)
      .first<RecipientPreferenceRow>();

    if (!row || row.status !== 'active' || !row.email?.trim()) {
      return;
    }

    const prefs: NotificationPreferences = {
      emailOnMention: row.email_on_mention !== 0,
      emailOnTaskAssigned: row.email_on_task_assigned !== 0,
      emailOnTaskResolved: row.email_on_task_resolved !== 0,
      emailOnShareGranted: row.email_on_share_granted !== 0,
    };

    if (!isEmailEnabledForType(prefs, input.type)) {
      return;
    }

    const recipientName = row.display_name?.trim() || row.email.trim();
    const targetUrl = resolveNotificationTargetUrl(
      env.APP_ORIGIN,
      input.targetType,
      input.targetId
    );

    const lines = [`${recipientName} さん`, '', title];
    if (body) {
      lines.push('', `内容: ${body}`);
    }
    if (targetUrl) {
      lines.push('', `確認する: ${targetUrl}`);
    }
    lines.push(
      '',
      '※ メール通知の設定は、通知センター内の「通知設定」から変更できます。'
    );

    const provider = createMailProvider(env);
    await provider.send({
      tenantId: input.tenantId,
      kind: 'notification',
      to: row.email.trim(),
      subject: `[Files] ${title}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.warn('[notifications] failed to send notification email:', err);
  }
}

export async function getUserNotificationPreferences(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<NotificationPreferences> {
  const row = await db
    .prepare(
      `SELECT email_on_mention,
              email_on_task_assigned,
              email_on_task_resolved,
              email_on_share_granted
         FROM user_notification_preferences
        WHERE tenant_id = ? AND user_id = ?`
    )
    .bind(tenantId, userId)
    .first<PreferenceRow>();

  return rowToPreferences(row);
}

export async function updateUserNotificationPreferences(
  db: D1Database,
  tenantId: string,
  userId: string,
  patch: Partial<NotificationPreferences>
): Promise<NotificationPreferences> {
  const current = await getUserNotificationPreferences(db, tenantId, userId);
  const next: NotificationPreferences = {
    emailOnMention: patch.emailOnMention ?? current.emailOnMention,
    emailOnTaskAssigned: patch.emailOnTaskAssigned ?? current.emailOnTaskAssigned,
    emailOnTaskResolved: patch.emailOnTaskResolved ?? current.emailOnTaskResolved,
    emailOnShareGranted: patch.emailOnShareGranted ?? current.emailOnShareGranted,
  };

  await db
    .prepare(
      `INSERT INTO user_notification_preferences (
         tenant_id,
         user_id,
         email_on_mention,
         email_on_task_assigned,
         email_on_task_resolved,
         email_on_share_granted,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tenant_id, user_id) DO UPDATE SET
         email_on_mention = excluded.email_on_mention,
         email_on_task_assigned = excluded.email_on_task_assigned,
         email_on_task_resolved = excluded.email_on_task_resolved,
         email_on_share_granted = excluded.email_on_share_granted,
         updated_at = datetime('now')`
    )
    .bind(
      tenantId,
      userId,
      next.emailOnMention ? 1 : 0,
      next.emailOnTaskAssigned ? 1 : 0,
      next.emailOnTaskResolved ? 1 : 0,
      next.emailOnShareGranted ? 1 : 0
    )
    .run();

  return next;
}

/**
 * Insert a user notification into `user_notifications` and optionally dispatch
 * an email notification when `env` is provided.
 * Skips self-notifications (`actorId === userId`) and never throws so caller
 * mutations remain resilient even if notification delivery fails.
 */
export async function createUserNotification(
  db: D1Database,
  input: CreateUserNotificationInput,
  env?: NotificationMailEnv
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
  } catch (err) {
    console.warn('[notifications] failed to create user notification:', err);
    return null;
  }

  if (env) {
    await maybeSendNotificationEmail(db, input, title, body, env);
  }

  return id;
}
