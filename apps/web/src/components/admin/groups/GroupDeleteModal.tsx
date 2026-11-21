'use client';

import { Loader2 } from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';

export function GroupDeleteModal({
  baseId,
  groupName,
  memberCount,
  permissionCount,
  detailBusy,
  deleteError,
  onCancel,
  onConfirm,
}: {
  baseId: string;
  groupName: string;
  memberCount: number;
  permissionCount: number;
  detailBusy: boolean;
  deleteError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell
      label="グループを削除"
      labelledBy={`${baseId}-delete-heading`}
      onClose={() => {
        if (!detailBusy) onCancel();
      }}
      className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div data-testid="group-delete-modal">
        <div className="border-b border-slate-200 px-5 py-3">
          <h3
            id={`${baseId}-delete-heading`}
            className="text-sm font-semibold text-slate-900"
          >
            グループ「{groupName}」を削除しますか？
          </h3>
          <p className="mt-1 text-[0.6875rem] text-slate-500">
            所属メンバー {memberCount} 人、付与済み権限 {permissionCount} 件も同時に削除されます。
          </p>
        </div>
        <div className="space-y-3 px-5 py-4 text-xs text-slate-700">
          <p>
            この操作は取り消せません。削除後は
            TenantSyncHub 経由で接続中のクライアントに権限変更が通知されます。
          </p>
          {deleteError && (
            <div
              role="alert"
              data-testid="group-delete-error"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
            >
              {deleteError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-testid="group-delete-cancel"
              disabled={detailBusy}
              onClick={onCancel}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              data-testid="group-delete-confirm"
              disabled={detailBusy}
              onClick={onConfirm}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {detailBusy && (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              )}
              削除する
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
