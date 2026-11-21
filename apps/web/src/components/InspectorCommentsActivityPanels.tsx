'use client';

import {
  Activity,
  Check,
  Loader2,
  MessageSquare,
  Pencil,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  createItemComment,
  deleteComment,
  listItemActivity,
  listItemComments,
  MAX_COMMENT_LENGTH,
  parseMentionSegments,
  updateComment,
  validateCommentBody,
  type ItemActivityEntry,
  type ItemComment,
  type ItemTargetType,
} from '@/lib/files-api/comments-activity';
import { formatDateTime } from '@/lib/formatters';

function MentionText({ body }: { body: string }) {
  const segments = parseMentionSegments(body);
  return (
    <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-slate-800">
      {segments.map((seg, idx) =>
        seg.isMention ? (
          <span
            key={idx}
            className="rounded bg-blue-50 px-1 py-0.5 font-medium text-blue-700"
          >
            {seg.text}
          </span>
        ) : (
          <span key={idx}>{seg.text}</span>
        )
      )}
    </p>
  );
}

export function InspectorCommentsPanel({
  itemType,
  itemId,
  currentUserId,
  isPrivilegedAdmin,
}: {
  itemType: ItemTargetType;
  itemId: string;
  currentUserId: string | null;
  isPrivilegedAdmin: boolean;
}) {
  const [comments, setComments] = useState<ItemComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerBody, setComposerBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadComments = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const res = await listItemComments(itemType, itemId, undefined, signal);
        setComments(res.comments);
      } catch (err) {
        if (signal?.aborted) return;
        setError(
          err instanceof Error ? err.message : 'コメントの読み込みに失敗しました。'
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [itemType, itemId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadComments(controller.signal);
    return () => controller.abort();
  }, [loadComments]);

  const handleSubmit = async () => {
    const check = validateCommentBody(composerBody);
    if (!check.valid) {
      setError(check.error);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await createItemComment(itemType, itemId, check.body);
      setComments((prev) => [...prev, res.comment]);
      setComposerBody('');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'コメントの投稿に失敗しました。'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveEdit = async (commentId: string) => {
    const check = validateCommentBody(editingBody);
    if (!check.valid) {
      setError(check.error);
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      const res = await updateComment(commentId, check.body);
      setComments((prev) =>
        prev.map((c) => (c.id === commentId ? res.comment : c))
      );
      setEditingId(null);
      setEditingBody('');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'コメントの更新に失敗しました。'
      );
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async (commentId: string) => {
    setDeletingId(commentId);
    setError(null);
    try {
      await deleteComment(commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'コメントの削除に失敗しました。'
      );
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-3" data-testid="inspector-comments-panel">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-6 text-xs text-slate-500">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          コメントを読み込み中...
        </div>
      ) : comments.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-4 text-center text-xs text-slate-500">
          <MessageSquare className="mx-auto mb-1.5 h-5 w-5 text-slate-400" />
          <p>まだコメントはありません。</p>
          <p className="mt-0.5 text-[0.6875rem] text-slate-400">
            @ユーザー名 でメンションできます
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {comments.map((comment) => {
            const canModify =
              (currentUserId !== null && comment.authorId === currentUserId) ||
              isPrivilegedAdmin;
            const isEditing = editingId === comment.id;
            const isEdited = comment.updatedAt !== comment.createdAt;

            return (
              <li
                key={comment.id}
                data-testid={`comment-item-${comment.id}`}
                className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-slate-800">
                      {comment.authorDisplayName}
                    </span>
                    <span className="text-[0.625rem] text-slate-400">
                      {formatDateTime(comment.createdAt)}
                      {isEdited ? ' (編集済み)' : ''}
                    </span>
                  </div>
                  {canModify && !isEditing && (
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label="コメントを編集"
                        onClick={() => {
                          setEditingId(comment.id);
                          setEditingBody(comment.body);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-slate-200/70 hover:text-slate-700"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        aria-label="コメントを削除"
                        disabled={deletingId === comment.id}
                        onClick={() => void handleDelete(comment.id)}
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                      >
                        {deletingId === comment.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Trash2 className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  )}
                </div>

                {isEditing ? (
                  <div className="space-y-1.5 pt-1">
                    <textarea
                      value={editingBody}
                      onChange={(e) => setEditingBody(e.target.value)}
                      rows={3}
                      maxLength={MAX_COMMENT_LENGTH}
                      className="w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-800 focus:border-blue-500 focus:outline-none"
                    />
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setEditingBody('');
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[0.6875rem] text-slate-600 hover:bg-slate-50"
                      >
                        <X className="h-3 w-3" />
                        キャンセル
                      </button>
                      <button
                        type="button"
                        disabled={savingEdit}
                        onClick={() => void handleSaveEdit(comment.id)}
                        className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-[0.6875rem] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        {savingEdit ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Check className="h-3 w-3" />
                        )}
                        保存
                      </button>
                    </div>
                  </div>
                ) : (
                  <MentionText body={comment.body} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-1.5 border-t border-slate-100 pt-3">
        <textarea
          value={composerBody}
          onChange={(e) => setComposerBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder="コメントを入力... (@でメンション)"
          rows={3}
          maxLength={MAX_COMMENT_LENGTH}
          data-testid="comment-composer-input"
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
        />
        <div className="flex items-center justify-between">
          <span className="text-[0.625rem] text-slate-400">
            {composerBody.trim().length} / {MAX_COMMENT_LENGTH}
          </span>
          <button
            type="button"
            disabled={submitting || !composerBody.trim()}
            onClick={() => void handleSubmit()}
            data-testid="comment-submit-button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            投稿
          </button>
        </div>
      </div>
    </div>
  );
}

export function InspectorActivityPanel({
  itemType,
  itemId,
}: {
  itemType: ItemTargetType;
  itemId: string;
}) {
  const [activities, setActivities] = useState<ItemActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    listItemActivity(itemType, itemId, controller.signal)
      .then((res) => {
        setActivities(res.activities);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof Error
            ? err.message
            : 'アクティビティの読み込みに失敗しました。'
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [itemType, itemId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-xs text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        アクティビティを読み込み中...
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
      >
        {error}
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div
        data-testid="inspector-activity-empty"
        className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-4 text-center text-xs text-slate-500"
      >
        <Activity className="mx-auto mb-1.5 h-5 w-5 text-slate-400" />
        <p>最近のアクティビティはありません。</p>
      </div>
    );
  }

  return (
    <ul className="space-y-2" data-testid="inspector-activity-panel">
      {activities.map((entry) => (
        <li
          key={entry.id}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-slate-800 truncate">
              {entry.actorDisplayName}
            </span>
            {entry.status === 'blocked' && (
              <span className="shrink-0 rounded-full bg-red-50 px-2 py-0.5 text-[0.625rem] font-medium text-red-700">
                ブロック
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[0.6875rem] text-slate-700">
            {entry.actionLabel}
          </p>
          <p className="mt-1 text-[0.625rem] text-slate-400">
            {formatDateTime(entry.createdAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}
