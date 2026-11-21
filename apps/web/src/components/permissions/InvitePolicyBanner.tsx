'use client';

import { Shield } from 'lucide-react';
import {
  INVITE_POLICY_LABEL,
  invitePolicyAudienceLabel,
  invitePolicySourceLabel,
} from '@/lib/invite-policy';
import type { InvitePolicy, InvitePolicyInfo } from '@/types/files';

export function InvitePolicyBanner({
  targetType,
  targetId,
  invitePolicy,
  effectiveInvitePolicy,
  canInvite,
}: {
  targetType: 'folder' | 'file';
  targetId: string;
  invitePolicy: InvitePolicyInfo;
  effectiveInvitePolicy: InvitePolicy;
  canInvite: boolean;
}) {
  return (
    <section
      aria-labelledby="invite-policy-heading"
      data-testid="invite-policy-banner"
      className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/70 px-3.5 py-3"
    >
      <h3
        id="invite-policy-heading"
        className="flex items-center gap-1.5 text-xs font-semibold text-violet-900"
      >
        <Shield className="h-3.5 w-3.5" />
        招待ポリシー
      </h3>
      <p
        data-testid="invite-policy-effective"
        className="text-xs text-violet-900"
      >
        {targetType === 'folder' ? 'このフォルダ' : 'このファイル'}
        の招待ポリシー:{' '}
        <strong>{INVITE_POLICY_LABEL[effectiveInvitePolicy]}</strong>
      </p>
      <dl className="grid gap-1 text-[0.6875rem] leading-relaxed text-violet-800 sm:grid-cols-2">
        <div>
          <dt className="font-semibold">設定元</dt>
          <dd data-testid="invite-policy-source">
            {invitePolicySourceLabel({
              targetType,
              targetId,
              effectivePolicy: effectiveInvitePolicy,
              sourceFolderId: invitePolicy.sourceFolderId,
              sourceFolderName: invitePolicy.sourceFolderName,
            })}
          </dd>
        </div>
        <div>
          <dt className="font-semibold">招待できる人</dt>
          <dd data-testid="invite-policy-audience">
            {invitePolicyAudienceLabel(effectiveInvitePolicy)}
          </dd>
        </div>
      </dl>
      {!canInvite && (
        <p
          role="note"
          data-testid="invite-policy-notice"
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900"
        >
          {effectiveInvitePolicy === 'admins'
            ? '現在は「管理者のみ」の招待ポリシーです。システム管理者（sys_admin）がフォルダへのアクセス権を持つ場合だけ招待できます。'
            : `現在の招待ポリシー「${INVITE_POLICY_LABEL[effectiveInvitePolicy]}」では、あなたの権限では新しいメンバーを招待できません。所有者（Owner）または共同所有者（Co-Owner）にポリシー変更を依頼してください。`}
        </p>
      )}
    </section>
  );
}
