'use client';

import { Download, Loader2, X } from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';
import { buildGuestDetailExportHref } from '@/lib/admin-guests';
import { formatAuditDateTime } from '@/lib/formatters';
import type { AdminGuestDetailResponse } from '@/types/files';
import type { ActionGuest, GuestAction } from './AdminGuestActionModal';
import { DlpBadge, GuestStatusBadge } from './AdminGuestBadges';

interface AdminGuestDetailModalProps {
  detailGuestId: string;
  detail: AdminGuestDetailResponse | null;
  detailLoading: boolean;
  detailError: string | null;
  baseId: string;
  canSuspend: boolean;
  canManage: boolean;
  onClose: () => void;
  onOpenAction: (action: GuestAction, guest: ActionGuest) => void;
}

export function AdminGuestDetailModal({
  detailGuestId,
  detail,
  detailLoading,
  detailError,
  baseId,
  canSuspend,
  canManage,
  onClose,
  onOpenAction,
}: AdminGuestDetailModalProps) {
  return (
    <ModalShell
      label="ゲスト詳細"
      labelledBy={`${baseId}-detail-heading`}
      onClose={onClose}
      className="w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div
        data-testid="guest-detail-modal"
        className="flex max-h-[85vh] flex-col"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <h3
              id={`${baseId}-detail-heading`}
              className="text-sm font-semibold text-slate-900"
            >
              ゲスト詳細
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              {detail?.guest.email ?? detailGuestId}
            </p>
          </div>
          <button
            type="button"
            data-autofocus
            aria-label="ゲスト詳細を閉じる"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4 text-xs">
          {detailLoading && (
            <p className="flex items-center gap-1.5 text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ゲスト詳細を読み込み中...
            </p>
          )}
          {detailError && (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
            >
              {detailError}
            </div>
          )}
          {detail && (
            <>
              <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <p className="text-[0.625rem] text-slate-500">表示名</p>
                  <p className="font-medium text-slate-900">
                    {detail.guest.displayName}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">外部組織</p>
                  <p className="font-medium text-slate-900">
                    {detail.guest.externalOrg ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">ステータス</p>
                  <GuestStatusBadge status={detail.guest.status} />
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">招待者</p>
                  <p className="font-medium text-slate-900">
                    {detail.guest.invitedByName ?? '—'}
                  </p>
                  <p className="text-[0.625rem] text-slate-500">
                    {detail.guest.invitedByEmail ?? detail.guest.invitedBy ?? ''}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">有効期限</p>
                  <p className="font-medium text-slate-900">
                    {detail.guest.expiresAt
                      ? formatAuditDateTime(detail.guest.expiresAt)
                      : '無期限'}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">最終ログイン</p>
                  <p className="font-medium text-slate-900">
                    {detail.guest.lastLoginAt
                      ? formatAuditDateTime(detail.guest.lastLoginAt)
                      : '未ログイン'}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">ドメイン</p>
                  <p className="font-mono text-[0.6875rem] font-medium text-slate-900">
                    {detail.guest.domain ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">ドメインポリシー</p>
                  <p
                    className={`font-medium ${
                      detail.guest.domainAllowedByPolicy
                        ? 'text-emerald-700'
                        : 'text-red-700'
                    }`}
                  >
                    {detail.guest.domainAllowedByPolicy ? '許可済み' : '許可外'}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">オフボーディング</p>
                  <p className="font-medium text-slate-900">
                    {detail.guest.offboardedAt
                      ? formatAuditDateTime(detail.guest.offboardedAt)
                      : '未実施'}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <a
                  data-testid="guest-detail-export-csv"
                  href={buildGuestDetailExportHref(detail.guest.id, 'csv')}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-100"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  権限・共有アイテム CSV
                </a>
                <a
                  data-testid="guest-detail-export-json"
                  href={buildGuestDetailExportHref(detail.guest.id, 'json')}
                  download
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-100"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  詳細 JSON
                </a>
                <button
                  type="button"
                  data-testid="guest-action-suspend"
                  disabled={
                    !canSuspend ||
                    detail.guest.status === 'suspended' ||
                    detail.guest.status === 'offboarded'
                  }
                  aria-describedby={`${baseId}-rbac`}
                  onClick={() => onOpenAction('suspend', detail.guest)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-[0.6875rem] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-40"
                >
                  停止
                </button>
                <button
                  type="button"
                  data-testid="guest-action-resume"
                  disabled={!canManage || detail.guest.status !== 'suspended'}
                  aria-describedby={`${baseId}-rbac`}
                  onClick={() => onOpenAction('resume', detail.guest)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 text-[0.6875rem] font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-40"
                >
                  再開
                </button>
                <button
                  type="button"
                  data-testid="guest-action-resend"
                  disabled={
                    !canManage ||
                    detail.guest.status === 'offboarded' ||
                    !detail.pendingInvitationId
                  }
                  aria-describedby={`${baseId}-rbac`}
                  onClick={() => onOpenAction('resend', detail.guest)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-blue-300 bg-white px-2.5 text-[0.6875rem] font-medium text-blue-800 hover:bg-blue-50 disabled:opacity-40"
                >
                  招待再送
                </button>
                <button
                  type="button"
                  data-testid="guest-action-offboard"
                  disabled={!canManage || Boolean(detail.guest.offboardedAt)}
                  aria-describedby={`${baseId}-rbac`}
                  onClick={() => onOpenAction('offboard', detail.guest)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-red-300 bg-white px-2.5 text-[0.6875rem] font-medium text-red-800 hover:bg-red-50 disabled:opacity-40"
                >
                  完全オフボーディング
                </button>
              </div>

              <div>
                <h4 className="mb-1.5 text-[0.75rem] font-semibold text-slate-900">
                  有効権限（直接 / 継承）
                </h4>
                <p className="mb-1.5 text-[0.625rem] text-slate-500">
                  直接 {detail.permissions.directCount} 件 / 継承{' '}
                  {detail.permissions.inheritedCount} 件。実効ロールは
                  capability 合成後の値です。
                </p>
                <div
                  role="region"
                  aria-label="ゲストの有効権限"
                  tabIndex={0}
                  className="max-h-52 overflow-auto rounded-lg border border-slate-200"
                >
                  <table
                    data-testid="guest-detail-permissions"
                    className="w-full text-left text-[0.625rem]"
                  >
                    <caption className="sr-only">ゲストの有効権限</caption>
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr>
                        <th scope="col" className="px-2 py-1 font-medium">対象</th>
                        <th scope="col" className="px-2 py-1 font-medium">種別</th>
                        <th scope="col" className="px-2 py-1 font-medium">ロール</th>
                        <th scope="col" className="px-2 py-1 font-medium">継承元</th>
                        <th scope="col" className="px-2 py-1 font-medium">実効ロール</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.effectivePermissions.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-2 py-3 text-center text-slate-500">
                            有効な権限はありません。
                          </td>
                        </tr>
                      ) : (
                        detail.effectivePermissions.map((permission, index) => (
                          <tr
                            key={`${permission.targetType}:${permission.targetId}:${permission.role}:${index}`}
                            className="border-t border-slate-100"
                          >
                            <td className="px-2 py-1 text-slate-900">
                              {permission.targetName ?? permission.targetId}
                            </td>
                            <td className="px-2 py-1 text-slate-600">
                              {permission.targetType}
                            </td>
                            <td className="px-2 py-1 font-mono text-slate-700">
                              {permission.role}
                            </td>
                            <td className="px-2 py-1 text-slate-600">
                              {permission.inherited
                                ? permission.inheritedFromName ?? '継承'
                                : '直接付与'}
                            </td>
                            <td className="px-2 py-1 font-mono text-slate-700">
                              {permission.synthesizedRole ?? '—'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                  共有アイテム
                  <span className="rounded-full bg-purple-50 px-1.5 py-0.5 text-[0.5625rem] font-semibold text-purple-800">
                    DLP: confidential はメタデータのみ
                  </span>
                </h4>
                <div
                  role="region"
                  aria-label="ゲストの共有アイテム"
                  tabIndex={0}
                  className="max-h-56 overflow-auto rounded-lg border border-slate-200"
                >
                  <table
                    data-testid="guest-detail-shared-items"
                    className="w-full text-left text-[0.625rem]"
                  >
                    <caption className="sr-only">ゲストの共有アイテム</caption>
                    <thead className="sticky top-0 bg-slate-50 text-slate-500">
                      <tr>
                        <th scope="col" className="px-2 py-1 font-medium">名前</th>
                        <th scope="col" className="px-2 py-1 font-medium">種別</th>
                        <th scope="col" className="px-2 py-1 font-medium">分類</th>
                        <th scope="col" className="px-2 py-1 font-medium">パス</th>
                        <th scope="col" className="px-2 py-1 font-medium">実効ロール</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.sharedItems.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-2 py-3 text-center text-slate-500">
                            共有アイテムはありません。
                          </td>
                        </tr>
                      ) : (
                        detail.sharedItems.map((item) => (
                          <tr
                            key={`${item.itemType}:${item.id}`}
                            className="border-t border-slate-100"
                          >
                            <td className="px-2 py-1 text-slate-900">
                              <span className="block font-medium">{item.name}</span>
                              {item.dlpProtected && (
                                <span data-testid="guest-detail-dlp-badge" className="mt-0.5 block">
                                  <DlpBadge />
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1 text-slate-600">{item.itemType}</td>
                            <td className="px-2 py-1">
                              <span
                                className={`rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold ${
                                  item.classification === 'confidential'
                                    ? 'bg-red-50 text-red-700'
                                    : 'bg-slate-100 text-slate-600'
                                }`}
                              >
                                {item.classification}
                              </span>
                            </td>
                            <td className="px-2 py-1 text-slate-600">{item.pathLabel}</td>
                            <td className="px-2 py-1 font-mono text-slate-700">
                              {item.effectiveRole ?? '—'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div>
                <h4 className="mb-1.5 text-[0.75rem] font-semibold text-slate-900">
                  ゲスト監査タイムライン
                </h4>
                {detail.recentAuditLogs.length === 0 ? (
                  <p className="text-[0.625rem] text-slate-500">
                    監査ログはまだありません。
                  </p>
                ) : (
                  <ol
                    data-testid="guest-detail-audit-timeline"
                    className="space-y-1.5 rounded-lg border border-slate-200 p-2"
                  >
                    {detail.recentAuditLogs.map((log) => (
                      <li
                        key={log.id}
                        className="flex flex-wrap items-baseline gap-2 border-b border-slate-100 pb-1.5 last:border-b-0 last:pb-0"
                      >
                        <time
                          dateTime={log.createdAt}
                          className="font-mono text-[0.625rem] text-slate-500"
                        >
                          {formatAuditDateTime(log.createdAt)}
                        </time>
                        <span className="font-mono text-[0.625rem] font-medium text-slate-900">
                          {log.action}
                        </span>
                        <span
                          className={`rounded-full px-1.5 text-[0.5625rem] font-semibold ${
                            log.status === 'blocked'
                              ? 'bg-red-100 text-red-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {log.status}
                        </span>
                        <span className="text-[0.625rem] text-slate-500">
                          {log.actorEmail ?? 'system'}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div>
                <h4 className="mb-1.5 text-[0.75rem] font-semibold text-slate-900">
                  招待プレビュー（生トークン非表示）
                </h4>
                {detail.invitations.length === 0 ? (
                  <p className="text-[0.625rem] text-slate-500">
                    招待はありません。
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {detail.invitations.slice(0, 5).map((invitation) => (
                      <li
                        key={invitation.id}
                        className="rounded-lg border border-slate-200 p-2"
                      >
                        <p className="font-medium text-slate-900">
                          {invitation.mailPreview?.subject ?? '招待メール'}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-[0.625rem] text-slate-600">
                          {invitation.mailPreview?.bodyPreview ?? '—'}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
