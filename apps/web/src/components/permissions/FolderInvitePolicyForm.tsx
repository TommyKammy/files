'use client';

import { Loader2 } from 'lucide-react';
import {
  INVITE_POLICY_DESCRIPTION,
  INVITE_POLICY_LABEL,
  invitePolicyStrictness,
} from '@/lib/invite-policy';
import type { InvitePolicy } from '@/types/files';

export function FolderInvitePolicyForm({
  inheritedInviteFloor,
  folderPolicyChoice,
  setFolderPolicyChoice,
  folderPolicyDirty,
  policySaving,
  policyNotice,
  setPolicyNotice,
  onSave,
}: {
  inheritedInviteFloor: InvitePolicy;
  folderPolicyChoice: InvitePolicy | null;
  setFolderPolicyChoice: (policy: InvitePolicy | null) => void;
  folderPolicyDirty: boolean;
  policySaving: boolean;
  policyNotice: string | null;
  setPolicyNotice: (notice: string | null) => void;
  onSave: (policy: InvitePolicy | null) => Promise<unknown> | void;
}) {
  const folderPolicyOptions: Array<{
    value: InvitePolicy | null;
    label: string;
    description: string;
  }> = [
    {
      value: null,
      label: `継承する（既定: ${INVITE_POLICY_LABEL[inheritedInviteFloor]}）`,
      description:
        '上位フォルダまたはテナント既定の招待ポリシーをそのまま適用します。',
    },
    ...(['editors', 'owners', 'admins'] as InvitePolicy[]).map((policy) => ({
      value: policy,
      label: INVITE_POLICY_LABEL[policy],
      description: INVITE_POLICY_DESCRIPTION[policy],
    })),
  ];

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(folderPolicyChoice);
      }}
      aria-labelledby="folder-invite-policy-heading"
      data-testid="folder-invite-policy-section"
      className="space-y-3 rounded-xl border border-violet-200 bg-white p-4"
    >
      <div>
        <h3
          id="folder-invite-policy-heading"
          className="text-xs font-semibold text-slate-800"
        >
          フォルダ招待ポリシー（上書き設定）
        </h3>
        <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-slate-600">
          このフォルダと配下のフォルダに適用する招待ポリシーです。上位の「
          {INVITE_POLICY_LABEL[inheritedInviteFloor]}」より緩めることはできません。
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="sr-only">フォルダ招待ポリシーを選択</legend>
        {folderPolicyOptions.map((option) => {
          const optionKey = option.value ?? 'inherit';
          const tooWeak =
            option.value !== null &&
            invitePolicyStrictness(option.value) <
              invitePolicyStrictness(inheritedInviteFloor);
          return (
            <label
              key={optionKey}
              data-testid={`folder-invite-policy-option-${optionKey}`}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition ${
                folderPolicyChoice === option.value
                  ? 'border-violet-400 bg-violet-50'
                  : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
              } ${tooWeak ? 'cursor-not-allowed opacity-60' : ''}`}
            >
              <input
                type="radio"
                name="folderInvitePolicy"
                value={optionKey}
                checked={folderPolicyChoice === option.value}
                disabled={tooWeak || policySaving}
                aria-describedby={`folder-invite-policy-${optionKey}-description`}
                onChange={() => {
                  setPolicyNotice(null);
                  setFolderPolicyChoice(option.value);
                }}
                className="mt-0.5 h-4 w-4 accent-violet-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
              />
              <span className="min-w-0">
                <span className="block text-[0.75rem] font-medium text-slate-900">
                  {option.label}
                </span>
                <span
                  id={`folder-invite-policy-${optionKey}-description`}
                  className="mt-0.5 block text-[0.6875rem] leading-relaxed text-slate-600"
                >
                  {tooWeak
                    ? `上位の「${INVITE_POLICY_LABEL[inheritedInviteFloor]}」より緩めることはできません`
                    : option.description}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div aria-live="polite" className="min-h-0 text-[0.6875rem]">
          {policyNotice && (
            <p
              role="status"
              data-testid="folder-invite-policy-notice"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-emerald-800"
            >
              {policyNotice}
            </p>
          )}
        </div>
        <button
          type="submit"
          disabled={!folderPolicyDirty || policySaving}
          className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[0.75rem] font-medium text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
        >
          {policySaving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <span>{policySaving ? '保存中...' : '上書き設定を保存'}</span>
        </button>
      </div>
    </form>
  );
}
