'use client';

import { Trash2 } from 'lucide-react';
import { CapabilityChips } from '@/components/permissions/CapabilityChips';
import { ROLE_CAPABILITY_CHIPS, ROLE_META } from '@/lib/capabilities';
import { formatDateTime } from '@/lib/formatters';
import type { PermissionEntry, PermissionInheritanceMode } from '@/types/files';

export function PermissionsList({
  permissions,
  loading,
  canManage,
  permissionInheritanceMode,
  onRevoke,
  onOpenGuestDetail,
}: {
  permissions: PermissionEntry[];
  loading: boolean;
  canManage: boolean;
  permissionInheritanceMode: PermissionInheritanceMode;
  onRevoke: (perm: PermissionEntry) => void;
  onOpenGuestDetail: (userId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-slate-600">
        割り当て済み権限 ({permissions.length})
      </div>

      {loading ? (
        <div className="py-8 text-center text-xs text-slate-500">
          読み込み中...
        </div>
      ) : permissions.length === 0 ? (
        <div className="rounded-lg border border-slate-200 py-6 text-center text-xs text-slate-500">
          表示できる権限はありません
        </div>
      ) : (
        <div className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
          {permissions.map((perm) => (
            <div
              key={perm.id}
              data-testid={
                perm.inherited
                  ? 'permission-row-inherited'
                  : 'permission-row-direct'
              }
              className="flex flex-wrap items-start justify-between gap-3 px-4 py-2.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">
                    {perm.granteeName ?? perm.granteeId}
                  </span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.625rem] text-slate-600">
                    {perm.granteeType}
                  </span>
                  {perm.granteeUserType === 'guest' && (
                    <span
                      data-testid="permission-guest-badge"
                      className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.625rem] font-medium text-amber-800"
                    >
                      外部ゲスト
                    </span>
                  )}
                  {perm.inherited && (
                    <span
                      data-testid="permission-inherited-badge"
                      className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.625rem] text-amber-700"
                    >
                      継承元: {perm.sourceName ?? '親フォルダ'}
                    </span>
                  )}
                  {perm.inherited && (
                    <span
                      data-testid="permission-inherited-guidance"
                      className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[0.625rem] text-sky-800"
                    >
                      親フォルダ「{perm.sourceName ?? '親フォルダ'}」で変更
                    </span>
                  )}
                  {!perm.inherited &&
                    perm.waterfallLocked &&
                    permissionInheritanceMode === 'waterfall' && (
                      <span
                        data-testid="permission-waterfall-locked-guidance"
                        className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.625rem] text-amber-800"
                      >
                        親フォルダ「
                        {perm.ancestorFolderName ??
                          perm.sourceName ??
                          '親フォルダ'}
                        」で変更
                      </span>
                    )}
                </div>
                {perm.granteeEmail && (
                  <div className="text-[0.6875rem] text-slate-600">
                    {perm.granteeEmail}
                  </div>
                )}
                {perm.granteeUserType === 'guest' && (
                  <div
                    data-testid="permission-guest-meta"
                    className="mt-0.5 min-w-0 space-y-0.5 break-words text-[0.625rem] leading-relaxed text-amber-900"
                  >
                    <p>
                      外部組織: {perm.granteeExternalOrg ?? '未設定'} / 有効期限:{' '}
                      {formatDateTime(perm.granteeExpiresAt)}
                    </p>
                    <p>
                      最終ログイン: {formatDateTime(perm.granteeLastLoginAt)} /
                      招待者: {perm.granteeInvitedByName ?? '不明'}
                    </p>
                  </div>
                )}
                <div className="mt-1.5">
                  <CapabilityChips
                    capabilityLabels={ROLE_CAPABILITY_CHIPS[perm.role] ?? []}
                    max={5}
                    ariaLabel={`${perm.granteeName ?? perm.granteeId} の権限`}
                  />
                </div>
                {perm.synthesizedRole && perm.synthesizedRole !== perm.role && (
                  <p className="mt-1 text-[0.625rem] text-indigo-700">
                    合成実効ロール:{' '}
                    {ROLE_META[perm.synthesizedRole]?.label ??
                      perm.synthesizedRole}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {perm.granteeUserType === 'guest' && !perm.inherited && (
                  <button
                    type="button"
                    data-testid={`permission-guest-detail-${perm.granteeId}`}
                    onClick={() => onOpenGuestDetail(perm.granteeId)}
                    className="inline-flex min-h-7 items-center rounded border border-sky-200 bg-white px-2 py-0.5 text-[0.625rem] font-medium text-sky-800 hover:bg-sky-50"
                  >
                    ゲスト詳細
                  </button>
                )}
                <span className="rounded-md bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                  {ROLE_META[perm.role]?.label ?? perm.role}
                </span>
                {canManage && !perm.inherited && (
                  <button
                    type="button"
                    onClick={() => onRevoke(perm)}
                    title="権限を削除"
                    aria-label={`${perm.granteeName ?? perm.granteeId} の権限を削除`}
                    className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-red-50 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
