'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  Users,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  INVITE_POLICY_DESCRIPTION,
  INVITE_POLICY_LABEL,
  readTenantInvitePolicy,
} from '@/lib/invite-policy';
import type { InvitePolicy, TenantPolicyRow } from '@/types/files';

export function TenantInvitePolicyPanel({
  policy,
  invitePolicySaving,
  invitePolicyError,
  invitePolicyNotice,
  canManageInvitePolicy,
  onSaveInvitePolicy,
}: {
  policy: TenantPolicyRow | null;
  invitePolicySaving: boolean;
  invitePolicyError: string | null;
  invitePolicyNotice: string | null;
  canManageInvitePolicy: boolean;
  onSaveInvitePolicy: (policy: InvitePolicy) => Promise<boolean>;
}) {
  const persistedInvitePolicy = readTenantInvitePolicy(policy);
  const [desiredInvitePolicy, setDesiredInvitePolicy] =
    useState<InvitePolicy>(persistedInvitePolicy);
  const [invitePolicyDirty, setInvitePolicyDirty] = useState(false);
  const invitePolicyDirtyRef = useRef(false);

  useEffect(() => {
    if (invitePolicyDirtyRef.current) return;
    setDesiredInvitePolicy(readTenantInvitePolicy(policy));
  }, [policy]);

  function updateInvitePolicy(next: InvitePolicy) {
    setDesiredInvitePolicy(next);
    const isDirty = next !== persistedInvitePolicy;
    invitePolicyDirtyRef.current = isDirty;
    setInvitePolicyDirty(isDirty);
  }

  async function handleInvitePolicySubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    if (
      invitePolicySaving ||
      !policy ||
      !canManageInvitePolicy ||
      !invitePolicyDirty
    ) {
      return;
    }
    const ok = await onSaveInvitePolicy(desiredInvitePolicy);
    if (ok) {
      invitePolicyDirtyRef.current = false;
      setInvitePolicyDirty(false);
    }
  }

  return (
    <form
      onSubmit={handleInvitePolicySubmit}
      aria-labelledby="tenant-invite-policy-heading"
      data-testid="tenant-invite-policy-section"
      className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5 xl:col-span-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Users className="h-4 w-4 text-[#5e6ad2]" />
        <h2
          id="tenant-invite-policy-heading"
          className="text-sm font-semibold text-slate-900"
        >
          テナント招待ポリシー
        </h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
          現在: {INVITE_POLICY_LABEL[persistedInvitePolicy]}
        </span>
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-slate-600">
        新しいメンバーをフォルダ・ファイルへ招待できる人を決めます。フォルダ管理者は配下フォルダで、これより緩くない範囲の上書き設定ができます。
      </p>

      <fieldset disabled={!policy || invitePolicySaving} className="space-y-3">
        <legend className="text-xs font-semibold text-slate-700">
          招待できる人
        </legend>

        <div className="grid gap-2 sm:grid-cols-3">
          {(['editors', 'owners', 'admins'] as InvitePolicy[]).map(
            (option) => {
              const selected = desiredInvitePolicy === option;
              const descriptionId = `tenant-invite-policy-${option}-description`;
              return (
                <label
                  key={option}
                  data-testid={`tenant-invite-policy-option-${option}`}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
                    selected
                      ? 'border-[#5e6ad2] bg-[#eef0fb]'
                      : 'border-transparent bg-slate-50 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
                  } ${
                    !canManageInvitePolicy || !policy || invitePolicySaving
                      ? 'cursor-not-allowed opacity-70'
                      : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="invitePolicy"
                    value={option}
                    checked={selected}
                    disabled={!canManageInvitePolicy}
                    aria-describedby={descriptionId}
                    onChange={() => updateInvitePolicy(option)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-slate-900">
                      {INVITE_POLICY_LABEL[option]}
                    </span>
                    <span
                      id={descriptionId}
                      className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
                    >
                      {INVITE_POLICY_DESCRIPTION[option]}
                    </span>
                  </span>
                </label>
              );
            }
          )}
        </div>

        <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-[0.6875rem] leading-relaxed text-blue-900">
          <p className="flex items-start gap-1.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              ポリシー変更は即時に反映されます。既存の付与・権限は削除されませんが、新しい招待と招待フォームの表示が変わります。
              <strong>管理者のみ</strong> では、sys_admin
              でもフォルダへの所有者・共同所有者・編集者アクセスがない場合は招待できません。
            </span>
          </p>
        </div>

        {!canManageInvitePolicy && (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
            テナント招待ポリシーを変更できるのはシステム管理者（sys_admin）だけです。sec_admin
            は現在の設定を読み取り専用で確認できます。
          </p>
        )}

        <div aria-live="assertive" aria-atomic="true" className="min-h-0">
          {invitePolicyError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{invitePolicyError}</span>
            </div>
          )}
          {!invitePolicyError && invitePolicyNotice && (
            <div
              role="status"
              data-testid="tenant-invite-policy-notice"
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
            >
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{invitePolicyNotice}</span>
            </div>
          )}
          {!invitePolicyError && !invitePolicyNotice && invitePolicyDirty && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
            >
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>未保存の招待ポリシー変更があります。</span>
            </div>
          )}
        </div>

        {canManageInvitePolicy && (
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={
                !policy ||
                invitePolicySaving ||
                !invitePolicyDirty ||
                !canManageInvitePolicy
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {invitePolicySaving && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              <span>
                {invitePolicySaving ? '保存中...' : '招待ポリシーを保存'}
              </span>
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
