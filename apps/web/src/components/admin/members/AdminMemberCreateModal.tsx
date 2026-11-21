'use client';

import { Loader2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import { parseMemberQuotaInput } from '@/lib/admin-users';
import { ApiClientError, createAdminMember } from '@/lib/files-api';
import type { UserRole } from '@/types/files';

interface CreateFormState {
  email: string;
  displayName: string;
  department: string;
  role: UserRole;
  quota: string;
}

const DEFAULT_CREATE_FORM: CreateFormState = {
  email: '',
  displayName: '',
  department: '',
  role: 'member',
  quota: '',
};

interface AdminMemberCreateModalProps {
  onClose: () => void;
  onCreated: (notice: string | null) => void;
}

export function AdminMemberCreateModal({
  onClose,
  onCreated,
}: AdminMemberCreateModalProps) {
  const baseId = useId();
  const [createForm, setCreateForm] =
    useState<CreateFormState>(DEFAULT_CREATE_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<string | null>(null);

  function closeCreate() {
    if (createBusy) return;
    onClose();
  }

  async function submitCreate() {
    if (createBusy) return;
    const quota = parseMemberQuotaInput(createForm.quota);
    if (!quota.ok) {
      setCreateError(quota.message);
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    setCreateResult(null);
    try {
      const response = await createAdminMember({
        email: createForm.email.trim(),
        displayName: createForm.displayName.trim(),
        department: createForm.department.trim() || null,
        role: createForm.role,
        storageQuotaBytes: quota.value,
      });
      setCreateResult(
        response.notice ?? `${response.user.email} を登録しました。`
      );
      onCreated(response.notice ?? null);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError
          ? err.message
          : 'メンバーの登録に失敗しました'
      );
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <ModalShell
      label="社内メンバーを追加"
      labelledBy={`${baseId}-create-heading`}
      onClose={closeCreate}
      className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div data-testid="member-create-modal" className="flex flex-col">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <h3
              id={`${baseId}-create-heading`}
              className="text-sm font-semibold text-slate-900"
            >
              社内メンバーを追加
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              sys_admin のみ登録できます。個人クォータ未入力ならテナント
              クォータのみ適用されます。
            </p>
          </div>
          <button
            type="button"
            data-testid="member-create-close"
            aria-label="メンバー追加を閉じる"
            onClick={closeCreate}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <form
          className="space-y-3 px-5 py-4 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
        >
          <label className="block text-[0.6875rem] font-medium text-slate-700">
            メールアドレス
            <input
              type="email"
              required
              data-testid="member-create-email"
              data-autofocus
              value={createForm.email}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  email: event.target.value,
                }))
              }
              autoComplete="off"
              className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
            />
          </label>
          <label className="block text-[0.6875rem] font-medium text-slate-700">
            表示名
            <input
              type="text"
              required
              data-testid="member-create-display-name"
              value={createForm.displayName}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  displayName: event.target.value,
                }))
              }
              className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
            />
          </label>
          <label className="block text-[0.6875rem] font-medium text-slate-700">
            部署
            <input
              type="text"
              data-testid="member-create-department"
              value={createForm.department}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  department: event.target.value,
                }))
              }
              className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-[0.6875rem] font-medium text-slate-700">
              ロール
              <select
                data-testid="member-create-role"
                value={createForm.role}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    role: event.target.value as UserRole,
                  }))
                }
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
              >
                <option value="member">メンバー</option>
                <option value="sec_admin">セキュリティ管理者</option>
                <option value="sys_admin">システム管理者</option>
              </select>
            </label>
            <label className="block text-[0.6875rem] font-medium text-slate-700">
              個人クォータ (バイト)
              <input
                type="text"
                inputMode="numeric"
                data-testid="member-create-quota"
                value={createForm.quota}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    quota: event.target.value,
                  }))
                }
                placeholder="空欄 = 上限なし"
                className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
              />
            </label>
          </div>
          {createError && (
            <div
              role="alert"
              data-testid="member-create-error"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
            >
              {createError}
            </div>
          )}
          {createResult && (
            <div
              role="status"
              data-testid="member-create-result"
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
            >
              {createResult}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeCreate}
              className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              閉じる
            </button>
            <button
              type="submit"
              data-testid="member-create-submit"
              disabled={createBusy || Boolean(createResult)}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              {createBusy && (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              )}
              登録
            </button>
          </div>
        </form>
      </div>
    </ModalShell>
  );
}
