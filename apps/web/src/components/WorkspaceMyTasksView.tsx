'use client';

import {
  Check,
  CheckSquare,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { TosAcceptanceModal } from '@/components/TosAcceptanceModal';
import {
  listMyTasks,
  TASK_STATUS_LABELS,
  updateTaskStatus,
  type ItemTask,
  type TaskStatus,
} from '@/lib/files-api/tasks-notifications';
import { formatDateTime } from '@/lib/formatters';
import { useTosAcceptance } from '@/lib/use-tos-acceptance';

const STATUS_BADGE_CLASSES: Record<TaskStatus, string> = {
  open: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  completed: 'bg-blue-50 text-blue-700 border-blue-200',
};

export function WorkspaceMyTasksView({
  onOpenFolder,
  onOpenFile,
}: {
  onOpenFolder: (folderId: string) => void;
  onOpenFile: (fileId: string) => void;
}) {
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [tasks, setTasks] = useState<ItemTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const tosGate = useTosAcceptance({ apiErrorCode: errorCode });

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      setErrorCode(null);
      try {
        const res = await listMyTasks(filter, signal);
        setTasks(res.tasks);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setErrorCode(
          typeof (err as { code?: unknown })?.code === 'string'
            ? (err as { code: string }).code
            : null
        );
        setError(
          err instanceof Error ? err.message : 'タスクの取得に失敗しました。'
        );
      } finally {
        setLoading(false);
      }
    },
    [filter]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleAction(taskId: string, status: TaskStatus) {
    setBusyTaskId(taskId);
    setError(null);
    try {
      const res = await updateTaskStatus(taskId, { status });
      setTasks((prev) => {
        if (filter === 'open' && status !== 'open') {
          return prev.filter((t) => t.id !== taskId);
        }
        return prev.map((t) => (t.id === taskId ? res.task : t));
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'タスクの更新に失敗しました。'
      );
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <div className="space-y-4">
      {tosGate.blocked && (
        <TosAcceptanceModal
          tos={tosGate.status}
          branding={tosGate.branding}
          accepting={tosGate.accepting}
          error={tosGate.error}
          onAccept={() => void tosGate.accept()}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e7e7ea] pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#5e6ad2]/10 text-[#5e6ad2]">
            <CheckSquare className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-[#111214]">
              マイタスク
            </h1>
            <p className="text-xs text-[#676b72]">
              あなたに割り当てられた承認・確認タスク
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setFilter('open')}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                filter === 'open'
                  ? 'bg-[#5e6ad2] text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              未対応
            </button>
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={`rounded-md px-2.5 py-1 font-medium transition ${
                filter === 'all'
                  ? 'bg-[#5e6ad2] text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              すべて
            </button>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span>更新</span>
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-xs text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>タスクを読み込み中...</span>
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white py-12 text-center text-xs text-slate-500">
          <CheckSquare className="mx-auto mb-2 h-6 w-6 text-slate-400" />
          <p>
            {filter === 'open'
              ? '未対応のタスクはありません。'
              : '割り当てられたタスクはありません。'}
          </p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {tasks.map((task) => {
            const busy = busyTaskId === task.id;
            return (
              <div
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3.5 text-xs shadow-sm"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-900">
                      {task.title}
                    </span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${
                        STATUS_BADGE_CLASSES[task.status]
                      }`}
                    >
                      {TASK_STATUS_LABELS[task.status]}
                    </span>
                  </div>

                  {task.message && (
                    <p className="text-[0.6875rem] text-slate-600">
                      {task.message}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-3 text-[0.6875rem] text-slate-500">
                    <button
                      type="button"
                      onClick={() =>
                        task.itemType === 'folder'
                          ? onOpenFolder(task.itemId)
                          : onOpenFile(task.itemId)
                      }
                      className="inline-flex items-center gap-1 font-medium text-[#5e6ad2] hover:underline"
                    >
                      {task.itemType === 'folder' ? (
                        <Folder className="h-3.5 w-3.5" />
                      ) : (
                        <FileText className="h-3.5 w-3.5" />
                      )}
                      <span>{task.itemName ?? task.itemId}</span>
                    </button>
                    <span>依頼者: {task.creatorDisplayName}</span>
                    {task.dueAt && (
                      <span>期限: {formatDateTime(task.dueAt)}</span>
                    )}
                  </div>
                </div>

                {task.status === 'open' && (
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleAction(task.id, 'approved')}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[0.6875rem] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>承認</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleAction(task.id, 'rejected')}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-[0.6875rem] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      <X className="h-3.5 w-3.5" />
                      <span>差し戻し</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleAction(task.id, 'completed')}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[0.6875rem] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      <span>完了</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
