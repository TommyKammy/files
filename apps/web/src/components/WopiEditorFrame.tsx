'use client';

import { AlertTriangle, Loader2, Lock, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiClientError, createWopiSession } from '@/lib/files-api';
import { keyboardScopes } from '@/lib/keyboard-shortcuts';
import type { WopiEditorFile } from '@/lib/wopi';
import type { WopiSessionResponse } from '@/types/files';

function parsePostMessage(data: unknown): Record<string, unknown> | null {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return data && typeof data === 'object'
    ? (data as Record<string, unknown>)
    : null;
}

export function WopiEditorFrame({
  file,
  onClose,
}: {
  file: WopiEditorFile;
  onClose: () => void;
}) {
  const [session, setSession] = useState<WopiSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentLoaded, setDocumentLoaded] = useState(false);
  const [statusText, setStatusText] = useState('エディタを準備中...');
  const formRef = useRef<HTMLFormElement>(null);
  const iframeName = useRef(
    `wopi-editor-${Math.random().toString(36).slice(2)}`
  ).current;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDocumentLoaded(false);
    setStatusText('エディタを準備中...');

    createWopiSession(file.id)
      .then((res) => {
        if (cancelled) return;
        setSession(res);
        setStatusText(
          res.canWrite
            ? '同時編集セッションを開始しています...'
            : '閲覧専用で開いています...'
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'WOPIセッションの作成に失敗しました'
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file.id]);

  useEffect(() => {
    const token = keyboardScopes.pushScope('modal');
    return () => keyboardScopes.popScope(token);
  }, []);

  useEffect(() => {
    if (!session?.wopiActionUrl) return;
    const form = formRef.current;
    if (!form) return;
    const timer = window.setTimeout(() => form.submit(), 0);
    return () => window.clearTimeout(timer);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const actionOrigin = session.wopiActionUrl
      ? new URL(session.wopiActionUrl).origin
      : session.collaboraOrigin;
    if (!actionOrigin) return;

    function handleMessage(event: MessageEvent) {
      if (event.origin !== actionOrigin) return;
      const payload = parsePostMessage(event.data);
      if (!payload) return;
      const msgId = String(
        payload.msgId ?? payload.messageId ?? payload.MessageId ?? ''
      );
      const values =
        payload.values && typeof payload.values === 'object'
          ? (payload.values as Record<string, unknown>)
          : payload.Values && typeof payload.Values === 'object'
            ? (payload.Values as Record<string, unknown>)
            : {};

      if (msgId === 'App_LoadingStatus') {
        if (
          values.Status === 'Document_Loaded' ||
          values.Status === 'Initialized'
        ) {
          setDocumentLoaded(true);
          setStatusText('接続済み');
        }
        return;
      }
      if (msgId === 'Action_Load_Resp' && values.success === true) {
        setDocumentLoaded(true);
        setStatusText('接続済み');
        return;
      }
      if (msgId === 'Document_Saved' || msgId === 'Action_Save_Resp') {
        setStatusText('保存しました');
        return;
      }
      if (
        msgId.toLowerCase() === 'close' ||
        values.Action === 'close' ||
        values.Type === 'close' ||
        values.Close === true
      ) {
        onClose();
      }
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [session, onClose]);

  const canEmbed = Boolean(session?.wopiActionUrl);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">
            {file.name}
          </div>
          <div
            data-testid="wopi-session-status"
            data-can-write={session?.canWrite ? 'true' : 'false'}
            data-read-only={session?.readOnly ? 'true' : 'false'}
            className="text-[0.6875rem] text-slate-500"
          >
            {session?.readOnly
              ? session.readOnlyReason === 'desktop_lock'
                ? '閲覧専用（Files Drive 編集中）'
                : session.readOnlyReason === 'dlp'
                  ? '閲覧専用（DLP保護）'
                  : '閲覧専用'
              : 'Collabora Online 同時編集'}
            {' / '}
            {statusText}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {session && (
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium ${
                session.readOnly
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-emerald-50 text-emerald-700'
              }`}
            >
              <Lock className="h-3 w-3" />
              {session.readOnly ? 'Read-only' : 'Editing'}
            </span>
          )}
          <button
            type="button"
            aria-label="エディタを閉じる"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 bg-slate-100">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-50/90 text-sm text-slate-600">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            セッションを作成中...
          </div>
        )}

        {!loading && (error || !canEmbed) && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-50 p-6">
            <div className="max-w-md space-y-3 text-center">
              <AlertTriangle className="mx-auto h-8 w-8 text-amber-500" />
              <h2 className="text-sm font-semibold text-slate-900">
                {error ? 'エディタを開けませんでした' : 'Collabora Online が未設定です'}
              </h2>
              <p className="text-xs leading-relaxed text-slate-600">
                {error ??
                  'COLLABORA_URL をAPIとWebの両方に設定し、Collaboraコンテナを起動してください。'}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                閉じる
              </button>
            </div>
          </div>
        )}

        {session?.wopiActionUrl && (
          <>
            <form
              ref={formRef}
              action={session.wopiActionUrl}
              method="POST"
              target={iframeName}
              className="hidden"
            >
              <input
                type="hidden"
                name="access_token"
                value={session.accessToken}
              />
              <input type="hidden" name="WOPISrc" value={session.wopiSrc} />
            </form>
            <iframe
              name={iframeName}
              title={`${file.name} の Collabora エディタ`}
              className="h-full w-full border-0 bg-white"
              allow="clipboard-read; clipboard-write; fullscreen"
              referrerPolicy="no-referrer"
            />
            {!documentLoaded && !loading && (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
                <span className="rounded-full bg-slate-900/80 px-3 py-1 text-[0.6875rem] text-white">
                  エディタ読み込み中...
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
