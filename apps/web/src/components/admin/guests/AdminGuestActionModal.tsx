'use client';

import { Loader2, Trash2, UserCheck, UserX } from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';
import type { AdminGuestLifecycleStatus } from '@/types/files';

export type GuestAction = 'suspend' | 'resume' | 'resend' | 'offboard';

export interface ActionGuest {
  id: string;
  email: string;
  status: AdminGuestLifecycleStatus;
  offboardedAt: string | null;
  pendingInvitationCount?: number;
}

const ACTION_TITLES: Record<GuestAction, string> = {
  suspend: 'ゲストを停止しますか？',
  resume: 'ゲストアカウントを再開しますか？',
  resend: '招待メールを再送しますか？',
  offboard: 'ゲストを完全にオフボーディングしますか？',
};

const ACTION_EXPLANATIONS: Record<GuestAction, string> = {
  suspend:
    '対象ゲストを suspended にし、すべての有効セッションを即時失効させます。監査ログ admin.guest.suspend と同期通知を記録します。',
  resume:
    '停止中のゲストを再び有効化します。期限切れの場合は延長日数が必要です。監査ログ admin.guest.resume を記録します。',
  resend:
    '最新の保留中招待のトークンをローテートして再送します。以前の招待 URL は無効になります。',
  offboard:
    'セッション・招待・OTP・権限を原子的に無効化し、users 行は FK 整合性のため保持したまま再ログイン・再開を恒久拒否します。',
};

interface AdminGuestActionModalProps {
  action: GuestAction;
  actionGuest: ActionGuest;
  modalBusy: boolean;
  modalError: string | null;
  modalResult: string | null;
  extendDays: string;
  onExtendDaysChange: (value: string) => void;
  onClose: () => void;
  onExecute: () => void;
}

export function AdminGuestActionModal({
  action,
  actionGuest,
  modalBusy,
  modalError,
  modalResult,
  extendDays,
  onExtendDaysChange,
  onClose,
  onExecute,
}: AdminGuestActionModalProps) {
  return (
    <ModalShell
      label={ACTION_TITLES[action]}
      onClose={onClose}
      className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div data-testid="guest-confirm-modal" className="space-y-3 px-5 py-4">
        <div className="flex items-start gap-2">
          <span
            className={`flex h-8 w-8 items-center justify-center rounded-lg ${
              action === 'offboard'
                ? 'bg-red-50 text-red-700'
                : action === 'suspend'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-blue-50 text-blue-700'
            }`}
          >
            {action === 'offboard' ? (
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            ) : action === 'suspend' ? (
              <UserX className="h-4 w-4" aria-hidden="true" />
            ) : (
              <UserCheck className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {ACTION_TITLES[action]}
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              対象: {actionGuest.email}
            </p>
          </div>
        </div>
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-700">
          {ACTION_EXPLANATIONS[action]}
        </p>
        {action === 'resume' && (
          <label className="block text-[0.6875rem] font-medium text-slate-700">
            有効期限の延長日数
            <input
              type="number"
              min={1}
              max={3650}
              step={1}
              required
              value={extendDays}
              disabled={modalBusy}
              onChange={(event) => onExtendDaysChange(event.target.value)}
              className="mt-1 h-8 w-32 rounded-md border border-slate-300 px-2 text-xs"
            />
            <span className="mt-0.5 block text-[0.625rem] font-normal text-slate-500">
              1〜3650 日。期限切れのゲストは延長しない限り再開できません。
            </span>
          </label>
        )}
        {modalError && (
          <div
            role="alert"
            data-testid="guest-confirm-error"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
          >
            {modalError}
          </div>
        )}
        {modalResult && (
          <div
            role="status"
            data-testid="guest-confirm-result"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
          >
            {modalResult}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            data-autofocus
            data-testid="guest-confirm-cancel"
            disabled={modalBusy}
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {modalResult ? '閉じる' : 'キャンセル'}
          </button>
          {!modalResult && (
            <button
              type="button"
              data-testid="guest-confirm-execute"
              disabled={modalBusy}
              onClick={onExecute}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3.5 text-xs font-semibold text-white disabled:opacity-50 ${
                action === 'offboard'
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-[#5e6ad2] hover:bg-[#4f5ac2]'
              }`}
            >
              {modalBusy && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
              実行する
            </button>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
