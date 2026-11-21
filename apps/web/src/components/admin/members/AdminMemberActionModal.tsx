'use client';

import { Loader2 } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import { createMemberIdempotencyKey } from '@/lib/admin-users';
import {
  ApiClientError,
  resumeAdminMember,
  suspendAdminMember,
} from '@/lib/files-api';
import type { AdminMemberRow } from '@/types/files';

export type MemberAction = 'suspend' | 'resume';

interface AdminMemberActionModalProps {
  action: MemberAction;
  member: AdminMemberRow;
  onClose: () => void;
  onCompleted: (message: string, memberId: string) => void;
}

export function AdminMemberActionModal({
  action,
  member,
  onClose,
  onCompleted,
}: AdminMemberActionModalProps) {
  const baseId = useId();
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalResult, setModalResult] = useState<string | null>(null);
  const [idempotencyKey] = useState(() =>
    createMemberIdempotencyKey(action, member.id)
  );
  const busyRef = useRef(false);

  function closeActionModal() {
    if (busyRef.current) return;
    onClose();
  }

  async function executeAction() {
    if (busyRef.current) return;
    busyRef.current = true;
    setModalBusy(true);
    setModalError(null);
    try {
      const response =
        action === 'suspend'
          ? await suspendAdminMember(member.id, { idempotencyKey })
          : await resumeAdminMember(member.id, { idempotencyKey });
      const message =
        response.notice ??
        (action === 'suspend'
          ? 'メンバーを停止しました。'
          : 'メンバーアカウントを再開しました。');
      setModalResult(message);
      onCompleted(message, member.id);
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : 'メンバー操作に失敗しました'
      );
    } finally {
      busyRef.current = false;
      setModalBusy(false);
    }
  }

  return (
    <ModalShell
      label={action === 'suspend' ? 'メンバーを停止' : 'メンバーを再開'}
      labelledBy={`${baseId}-confirm-heading`}
      onClose={closeActionModal}
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div data-testid="member-confirm-modal">
        <div className="border-b border-slate-200 px-5 py-3">
          <h3
            id={`${baseId}-confirm-heading`}
            data-testid="member-confirm-title"
            className="text-sm font-semibold text-slate-900"
          >
            {action === 'suspend'
              ? 'メンバーを停止しますか？'
              : 'メンバーアカウントを再開しますか？'}
          </h3>
          <p className="mt-1 text-[0.6875rem] text-slate-500">
            {member.email}
          </p>
        </div>
        <div className="space-y-3 px-5 py-4 text-xs text-slate-700">
          <p>
            {action === 'suspend'
              ? '対象メンバーを suspended にし、すべての有効セッションを即時失効させます。TenantSyncHub の user.suspended 通知で接続中のクライアントも追い出されます。'
              : '停止中のメンバーを再び有効化します。失効済みセッションは復元されないため再ログインが必要です。'}
          </p>
          <p className="font-mono text-[0.625rem] text-slate-500">
            Idempotency-Key: {idempotencyKey}
          </p>
          {modalError && (
            <div
              role="alert"
              data-testid="member-confirm-error"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
            >
              {modalError}
            </div>
          )}
          {modalResult && (
            <div
              role="status"
              data-testid="member-confirm-result"
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
            >
              {modalResult}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-testid="member-confirm-cancel"
              onClick={closeActionModal}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              閉じる
            </button>
            <button
              type="button"
              data-testid="member-confirm-execute"
              disabled={modalBusy || Boolean(modalResult)}
              onClick={() => void executeAction()}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {modalBusy && (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              )}
              実行
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
