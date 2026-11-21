'use client';

import {
  Check,
  CheckSquare,
  Loader2,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ItemTargetType } from '@/lib/files-api/comments-activity';
import { searchPrincipals } from '@/lib/files-api/sharing';
import {
  createItemTask,
  listItemTasks,
  TASK_STATUS_LABELS,
  updateTaskStatus,
  validateTaskTitle,
  type ItemTask,
  type TaskStatus,
} from '@/lib/files-api/tasks-notifications';
import { formatDateTime } from '@/lib/formatters';
import type { PrincipalCandidate } from '@/types/files';

const STATUS_BADGE_CLASSES: Record<TaskStatus, string> = {
  open: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  completed: 'bg-blue-50 text-blue-700 border-blue-200',
};

export function InspectorTasksPanel({
  itemType,
  itemId,
  currentUserId,
  isPrivilegedAdmin,
  canCreateTask,
}: {
  itemType: ItemTargetType;
  itemId: string;
  currentUserId: string | null;
  isPrivilegedAdmin: boolean;
  canCreateTask: boolean;
}) {
  const [tasks, setTasks] = useState<ItemTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [assigneeQuery, setAssigneeQuery] = useState('');
  const [candidates, setCandidates] = useState<PrincipalCandidate[]>([]);
  const [selectedAssignee, setSelectedAssignee] =
    useState<PrincipalCandidate | null>(null);
  const [searchingAssignee, setSearchingAssignee] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const loadTasks = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const res = await listItemTasks(itemType, itemId, signal);
        setTasks(res.tasks);
      } catch (err) {
        if (signal?.aborted) return;
        setError(
          err instanceof Error
            ? err.message
            : 'タスクの読み込みに失敗しました。'
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [itemType, itemId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadTasks(controller.signal);
    return () => controller.abort();
  }, [loadTasks]);

  useEffect(() => {
    if (!showForm) return;
    const q = assigneeQuery.trim();
    if (!q) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearchingAssignee(true);
      try {
        const res = await searchPrincipals(q, 'member');
        if (!cancelled) {
          setCandidates(res.principals.filter((p) => p.type === 'user'));
        }
      } catch {
        if (!cancelled) setCandidates([]);
      } finally {
        if (!cancelled) setSearchingAssignee(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [assigneeQuery, showForm]);

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    const titleCheck = validateTaskTitle(title);
    if (!titleCheck.valid) {
      setError(titleCheck.error);
      return;
    }
    if (!selectedAssignee) {
      setError('担当者を選択してください。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await createItemTask(itemType, itemId, {
        title: titleCheck.title,
        message: message.trim() || null,
        assigneeId: selectedAssignee.id,
        dueAt: dueAt ? new Date(`${dueAt}T23:59:59.000Z`).toISOString() : null,
      });
      setTasks((prev) => [res.task, ...prev]);
      setTitle('');
      setMessage('');
      setDueAt('');
      setAssigneeQuery('');
      setSelectedAssignee(null);
      setCandidates([]);
      setShowForm(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'タスクの作成に失敗しました。'
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdateStatus(taskId: string, status: TaskStatus) {
    setBusyTaskId(taskId);
    setError(null);
    try {
      const res = await updateTaskStatus(taskId, { status });
      setTasks((prev) => prev.map((t) => (t.id === taskId ? res.task : t)));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'タスクの更新に失敗しました。'
      );
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <div className="space-y-3" data-testid="inspector-tasks-panel">
      {canCreateTask && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-700">
            承認・確認タスク
          </span>
          <button
            type="button"
            onClick={() => setShowForm((prev) => !prev)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[0.6875rem] font-semibold text-slate-700 hover:bg-slate-50"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{showForm ? '閉じる' : 'タスクを作成'}</span>
          </button>
        </div>
      )}

      {showForm && canCreateTask && (
        <form
          onSubmit={(e) => void handleCreateTask(e)}
          className="space-y-2.5 rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-xs"
        >
          <div>
            <label className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              タイトル
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例: 契約書の最終承認"
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-slate-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              担当者
            </label>
            {selectedAssignee ? (
              <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-900">
                    {selectedAssignee.name}
                  </div>
                  {selectedAssignee.email && (
                    <div className="truncate text-[0.625rem] text-slate-500">
                      {selectedAssignee.email}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedAssignee(null)}
                  className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={assigneeQuery}
                  onChange={(e) => setAssigneeQuery(e.target.value)}
                  placeholder="名前またはメールで検索..."
                  className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-slate-400 focus:outline-none"
                />
                {(searchingAssignee || candidates.length > 0) && (
                  <div className="mt-1 max-h-36 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">
                    {searchingAssignee ? (
                      <div className="px-2.5 py-2 text-[0.6875rem] text-slate-500">
                        検索中...
                      </div>
                    ) : (
                      candidates.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setSelectedAssignee(c);
                            setAssigneeQuery('');
                            setCandidates([]);
                          }}
                          className="flex w-full flex-col px-2.5 py-1.5 text-left hover:bg-slate-50"
                        >
                          <span className="font-medium text-slate-900">
                            {c.name}
                          </span>
                          {c.email && (
                            <span className="text-[0.625rem] text-slate-500">
                              {c.email}
                            </span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              期限（任意）
            </label>
            <input
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-slate-400 focus:outline-none"
            />
          </div>

          <div>
            <label className="mb-1 block text-[0.6875rem] font-medium text-slate-700">
              メッセージ（任意）
            </label>
            <textarea
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="確認ポイントなどを記入..."
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-slate-400 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#5e6ad2] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#4e5ac0] disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <span>タスクを割り当てる</span>
          </button>
        </form>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>読み込み中...</span>
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-500">
          <CheckSquare className="mx-auto mb-1.5 h-5 w-5 text-slate-400" />
          <p>この項目にはまだタスクがありません。</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {tasks.map((task) => {
            const canAct =
              currentUserId === task.assigneeId ||
              currentUserId === task.createdBy ||
              isPrivilegedAdmin;
            const busy = busyTaskId === task.id;
            return (
              <li
                key={task.id}
                className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold text-slate-900">
                    {task.title}
                  </span>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${
                      STATUS_BADGE_CLASSES[task.status]
                    }`}
                  >
                    {TASK_STATUS_LABELS[task.status]}
                  </span>
                </div>

                {task.message && (
                  <p className="whitespace-pre-wrap text-[0.6875rem] text-slate-600">
                    {task.message}
                  </p>
                )}

                <div className="space-y-0.5 text-[0.6875rem] text-slate-500">
                  <div>担当: {task.assigneeDisplayName}</div>
                  <div>依頼者: {task.creatorDisplayName}</div>
                  {task.dueAt && <div>期限: {formatDateTime(task.dueAt)}</div>}
                  {task.resolutionNote && (
                    <div className="text-slate-700">
                      メモ: {task.resolutionNote}
                    </div>
                  )}
                </div>

                {canAct && task.status === 'open' && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleUpdateStatus(task.id, 'approved')}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[0.6875rem] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Check className="h-3 w-3" />
                      <span>承認</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleUpdateStatus(task.id, 'rejected')}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1 text-[0.6875rem] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      <X className="h-3 w-3" />
                      <span>差し戻し</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void handleUpdateStatus(task.id, 'completed')
                      }
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[0.6875rem] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <span>完了</span>
                    </button>
                  </div>
                )}

                {canAct && task.status !== 'open' && (
                  <div className="pt-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleUpdateStatus(task.id, 'open')}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[0.6875rem] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>再開する</span>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
