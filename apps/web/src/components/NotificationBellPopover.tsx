'use client';

import { Bell, CheckCheck, Loader2, Settings } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatUnreadBadgeCount,
  getNotificationPreferences,
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_TYPE_LABELS,
  resolveNotificationHref,
  updateNotificationPreferences,
  type NotificationPreferences,
  type UserNotification,
} from '@/lib/files-api/tasks-notifications';
import { formatDateTime } from '@/lib/formatters';

const PREFERENCE_ITEMS: Array<{
  key: keyof NotificationPreferences;
  label: string;
  description: string;
}> = [
  {
    key: 'emailOnMention',
    label: '@メンション',
    description: 'コメント内でメンションされたときにメール通知を受け取る',
  },
  {
    key: 'emailOnTaskAssigned',
    label: 'タスク割当',
    description: '新しいタスクが割り当てられたときにメール通知を受け取る',
  },
  {
    key: 'emailOnTaskResolved',
    label: 'タスク完了・却下',
    description: '作成したタスクが承認・差し戻し・完了されたときにメール通知を受け取る',
  },
  {
    key: 'emailOnShareGranted',
    label: '共有招待',
    description: 'ファイルやフォルダの共有権限が付与されたときにメール通知を受け取る',
  },
];

export function NotificationBellPopover({
  enabled = true,
}: {
  enabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(
    null
  );
  const [loadingPrefs, setLoadingPrefs] = useState(false);
  const [savingPrefKey, setSavingPrefKey] = useState<
    keyof NotificationPreferences | null
  >(null);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const refreshUnreadCount = useCallback(
    async (signal?: AbortSignal) => {
      if (!enabled) return;
      try {
        const res = await getUnreadNotificationCount(signal);
        setUnreadCount(res.count);
      } catch {
        // Non-blocking background badge refresh
      }
    },
    [enabled]
  );

  const loadNotifications = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const res = await listNotifications({ limit: 30 });
      setNotifications(res.notifications);
      const unread = res.notifications.filter((n) => !n.readAt).length;
      if (res.notifications.length < 30) {
        setUnreadCount(unread);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '通知の取得に失敗しました。'
      );
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void refreshUnreadCount(controller.signal);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshUnreadCount();
      }
    }, 30_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [enabled, refreshUnreadCount]);

  useEffect(() => {
    if (!open) {
      setShowSettings(false);
      setSavedFeedback(false);
      return;
    }
    void loadNotifications();
  }, [open, loadNotifications]);

  const loadPreferences = useCallback(async () => {
    setLoadingPrefs(true);
    setError(null);
    try {
      const res = await getNotificationPreferences();
      setPreferences(res.preferences);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '通知設定の取得に失敗しました。'
      );
    } finally {
      setLoadingPrefs(false);
    }
  }, []);

  async function handleToggleSettings() {
    const next = !showSettings;
    setShowSettings(next);
    setSavedFeedback(false);
    if (next && !preferences) {
      await loadPreferences();
    }
  }

  async function handleTogglePreference(key: keyof NotificationPreferences) {
    if (!preferences || savingPrefKey) return;
    const prevValue = preferences[key];
    const nextValue = !prevValue;
    setPreferences({ ...preferences, [key]: nextValue });
    setSavingPrefKey(key);
    setSavedFeedback(false);
    setError(null);
    try {
      const res = await updateNotificationPreferences({ [key]: nextValue });
      setPreferences(res.preferences);
      setSavedFeedback(true);
    } catch (err) {
      setPreferences({ ...preferences, [key]: prevValue });
      setError(
        err instanceof Error ? err.message : '通知設定の保存に失敗しました。'
      );
    } finally {
      setSavingPrefKey(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!enabled) return null;

  const badgeText = formatUnreadBadgeCount(unreadCount);

  async function handleMarkAllRead() {
    setMarkingAll(true);
    try {
      await markAllNotificationsRead();
      const nowIso = new Date().toISOString();
      setNotifications((prev) =>
        prev.map((n) => (n.readAt ? n : { ...n, readAt: nowIso }))
      );
      setUnreadCount(0);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : '既読処理に失敗しました。'
      );
    } finally {
      setMarkingAll(false);
    }
  }

  async function handleClickNotification(notification: UserNotification) {
    if (!notification.readAt) {
      try {
        const res = await markNotificationRead(notification.id);
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === notification.id ? { ...n, readAt: res.readAt } : n
          )
        );
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } catch {
        // Still allow navigation even if mark-read fails
      }
    }
    const href = resolveNotificationHref(notification);
    setOpen(false);
    if (href) {
      router.push(href);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="通知センター"
        aria-expanded={open}
        data-testid="notification-bell-button"
        onClick={() => setOpen((prev) => !prev)}
        className="relative flex h-7 w-7 items-center justify-center rounded-md text-[#4c4f57] transition hover:bg-[#e2e2e6] hover:text-[#111214]"
      >
        <Bell className="h-4 w-4" />
        {badgeText && (
          <span
            data-testid="notification-unread-badge"
            className="absolute -right-1 -top-1 flex min-w-[16px] items-center justify-center rounded-full bg-[#5e6ad2] px-1 text-[0.5625rem] font-semibold leading-4 text-white"
          >
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="通知一覧"
          data-testid="notification-popover"
          className="fixed left-3 top-14 z-50 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5">
            <span className="text-xs font-semibold text-slate-900">
              {showSettings ? 'メール通知設定' : '通知センター'}
            </span>
            <div className="flex items-center gap-1">
              {!showSettings && (
                <button
                  type="button"
                  disabled={markingAll || unreadCount === 0}
                  onClick={() => void handleMarkAllRead()}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-40"
                >
                  {markingAll ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <CheckCheck className="h-3 w-3" />
                  )}
                  <span>すべて既読</span>
                </button>
              )}
              <button
                type="button"
                aria-label="通知設定"
                aria-pressed={showSettings}
                data-testid="notification-settings-toggle"
                onClick={() => void handleToggleSettings()}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[0.6875rem] font-medium transition ${
                  showSettings
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Settings className="h-3 w-3" />
                <span>{showSettings ? '一覧へ' : '通知設定'}</span>
              </button>
            </div>
          </div>

          {error && (
            <div className="border-b border-red-100 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700">
              {error}
            </div>
          )}

          {showSettings ? (
            <div
              data-testid="notification-settings-panel"
              className="divide-y divide-slate-100"
            >
              {loadingPrefs || !preferences ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>設定を読み込み中...</span>
                </div>
              ) : (
                <>
                  <div className="space-y-1 p-3">
                    {PREFERENCE_ITEMS.map((item) => {
                      const checked = preferences[item.key];
                      const isSaving = savingPrefKey === item.key;
                      return (
                        <label
                          key={item.key}
                          className="flex cursor-pointer items-start justify-between gap-3 rounded-lg px-2 py-2 transition hover:bg-slate-50"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium text-slate-900">
                              {item.label}
                            </div>
                            <p className="text-[0.6875rem] text-slate-500">
                              {item.description}
                            </p>
                          </div>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={Boolean(savingPrefKey)}
                            data-testid={`notif-pref-${item.key}`}
                            onChange={() => void handleTogglePreference(item.key)}
                            className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-[#5e6ad2] focus:ring-[#5e6ad2]"
                          />
                          {isSaving && (
                            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />
                          )}
                        </label>
                      );
                    })}
                  </div>
                  {savedFeedback && (
                    <div
                      data-testid="notification-settings-saved"
                      className="bg-emerald-50 px-3 py-1.5 text-[0.6875rem] font-medium text-emerald-700"
                    >
                      保存しました
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
          <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>読み込み中...</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                通知はありません。
              </div>
            ) : (
              notifications.map((n) => {
                const isUnread = !n.readAt;
                return (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => void handleClickNotification(n)}
                    className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition hover:bg-slate-50 ${
                      isUnread ? 'bg-blue-50/40' : 'bg-white'
                    }`}
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        isUnread ? 'bg-[#5e6ad2]' : 'bg-transparent'
                      }`}
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.625rem] font-medium text-slate-600">
                          {NOTIFICATION_TYPE_LABELS[n.type] ?? n.type}
                        </span>
                        <span className="text-[0.625rem] text-slate-400">
                          {formatDateTime(n.createdAt)}
                        </span>
                      </div>
                      <p className="text-xs font-medium text-slate-900">
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="line-clamp-2 text-[0.6875rem] text-slate-600">
                          {n.body}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
