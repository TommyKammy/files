'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldAlert,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  ADMIN_CONTENT_INSPECT_POLICY_META,
  ADMIN_CONTENT_INSPECT_POLICY_OPTIONS,
  readAdminContentInspectPolicy,
} from '@/lib/admin-content';
import type { AdminContentInspectPolicy, TenantPolicyRow } from '@/types/files';

export function AdminContentInspectPolicyPanel({
  policy,
  inspectPolicySaving,
  inspectPolicyError,
  inspectPolicyNotice,
  canManageInspectPolicy,
  onSaveAdminContentInspectPolicy,
}: {
  policy: TenantPolicyRow | null;
  inspectPolicySaving: boolean;
  inspectPolicyError: string | null;
  inspectPolicyNotice: string | null;
  canManageInspectPolicy: boolean;
  onSaveAdminContentInspectPolicy: (
    policy: AdminContentInspectPolicy
  ) => Promise<boolean>;
}) {
  const persistedInspectPolicy = readAdminContentInspectPolicy(policy);
  const [desiredInspectPolicy, setDesiredInspectPolicy] =
    useState<AdminContentInspectPolicy>(persistedInspectPolicy);
  const [inspectPolicyDirty, setInspectPolicyDirty] = useState(false);
  const inspectPolicyDirtyRef = useRef(false);

  useEffect(() => {
    if (inspectPolicyDirtyRef.current) return;
    setDesiredInspectPolicy(readAdminContentInspectPolicy(policy));
  }, [policy]);

  function updateInspectPolicy(next: AdminContentInspectPolicy) {
    setDesiredInspectPolicy(next);
    const isDirty = next !== persistedInspectPolicy;
    inspectPolicyDirtyRef.current = isDirty;
    setInspectPolicyDirty(isDirty);
  }

  async function handleInspectPolicySubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    if (
      inspectPolicySaving ||
      !policy ||
      !canManageInspectPolicy ||
      !inspectPolicyDirty
    ) {
      return;
    }
    const ok = await onSaveAdminContentInspectPolicy(desiredInspectPolicy);
    if (ok) {
      inspectPolicyDirtyRef.current = false;
      setInspectPolicyDirty(false);
    }
  }

  return (
    <form
      onSubmit={handleInspectPolicySubmit}
      aria-labelledby="admin-content-inspect-policy-heading"
      data-testid="admin-content-inspect-policy-section"
      className="space-y-4 rounded-lg border border-[#e7e7ea] bg-white p-5 xl:col-span-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-[#5e6ad2]" />
        <h2
          id="admin-content-inspect-policy-heading"
          className="text-sm font-semibold text-slate-900"
        >
          管理者コンテンツ検査ポリシー
        </h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] font-medium text-slate-700">
          現在: {ADMIN_CONTENT_INSPECT_POLICY_META[persistedInspectPolicy].label}
        </span>
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-slate-600">
        コンテンツマネージャーからファイル内容を検査するときの制限です。理由付きの監査ログは常に記録されます。
      </p>

      <fieldset disabled={!policy || inspectPolicySaving} className="space-y-3">
        <legend className="text-xs font-semibold text-slate-700">
          管理者による監査付きプレビュー
        </legend>

        <div className="grid gap-2 sm:grid-cols-3">
          {ADMIN_CONTENT_INSPECT_POLICY_OPTIONS.map((option) => {
            const meta = ADMIN_CONTENT_INSPECT_POLICY_META[option];
            const selected = desiredInspectPolicy === option;
            const descriptionId = `admin-content-inspect-policy-${option}-description`;
            return (
              <label
                key={option}
                data-testid={`admin-content-inspect-policy-option-${option}`}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 transition ${
                  selected
                    ? 'border-[#5e6ad2] bg-[#eef0fb]'
                    : 'border-transparent bg-slate-50 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
                } ${
                  !canManageInspectPolicy || !policy || inspectPolicySaving
                    ? 'cursor-not-allowed opacity-70'
                    : ''
                }`}
              >
                <input
                  type="radio"
                  name="adminContentInspectPolicy"
                  value={option}
                  checked={selected}
                  disabled={!canManageInspectPolicy}
                  aria-describedby={descriptionId}
                  onChange={() => updateInspectPolicy(option)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#5e6ad2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2]"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-slate-900">
                    {meta.label}
                  </span>
                  <span
                    id={descriptionId}
                    className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
                  >
                    {meta.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {!canManageInspectPolicy && (
          <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
            管理者コンテンツ検査ポリシーを変更できるのはシステム管理者（sys_admin）だけです。sec_admin
            は現在の設定を読み取り専用で確認できます。
          </p>
        )}

        <div aria-live="assertive" aria-atomic="true" className="min-h-0">
          {inspectPolicyError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{inspectPolicyError}</span>
            </div>
          )}
          {!inspectPolicyError && inspectPolicyNotice && (
            <div
              role="status"
              data-testid="admin-content-inspect-policy-notice"
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
            >
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{inspectPolicyNotice}</span>
            </div>
          )}
          {!inspectPolicyError && !inspectPolicyNotice && inspectPolicyDirty && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-800"
            >
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>未保存の管理者コンテンツ検査ポリシー変更があります。</span>
            </div>
          )}
        </div>

        {canManageInspectPolicy && (
          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={
                !policy ||
                inspectPolicySaving ||
                !inspectPolicyDirty ||
                !canManageInspectPolicy
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#5e6ad2] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {inspectPolicySaving && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              <span>
                {inspectPolicySaving ? '保存中...' : '検査ポリシーを保存'}
              </span>
            </button>
          </div>
        )}
      </fieldset>
    </form>
  );
}
