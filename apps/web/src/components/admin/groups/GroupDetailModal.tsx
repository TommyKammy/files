'use client';

import {
  Folder,
  Loader2,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { ModalShell } from '@/components/ModalShell';
import { GroupSourceBadge } from '@/components/admin/groups/GroupSourceBadge';
import { ADMIN_MEMBER_ROLE_LABELS } from '@/lib/admin-users';
import { ROLE_META } from '@/lib/capabilities';
import type {
  AdminGroupDetailResponse,
  AdminMemberRow,
} from '@/types/files';

export function GroupDetailModal({
  baseId,
  detailId,
  detail,
  detailLoading,
  detailError,
  detailNotice,
  detailBusy,
  canEditOpenGroup,
  openGroupReadOnlyReason,
  renameName,
  renameError,
  candidates,
  memberCandidatesLoading,
  selectedMemberIds,
  memberError,
  onClose,
  onChangeRenameName,
  onSubmitRename,
  onRemoveMember,
  onChangeSelectedMemberIds,
  onSubmitAddMembers,
  onOpenDelete,
}: {
  baseId: string;
  detailId: string;
  detail: AdminGroupDetailResponse | null;
  detailLoading: boolean;
  detailError: string | null;
  detailNotice: string | null;
  detailBusy: boolean;
  canEditOpenGroup: boolean;
  openGroupReadOnlyReason: string | null;
  renameName: string;
  renameError: string | null;
  candidates: AdminMemberRow[];
  memberCandidatesLoading: boolean;
  selectedMemberIds: string[];
  memberError: string | null;
  onClose: () => void;
  onChangeRenameName: (name: string) => void;
  onSubmitRename: () => void;
  onRemoveMember: (userId: string) => void;
  onChangeSelectedMemberIds: (ids: string[]) => void;
  onSubmitAddMembers: () => void;
  onOpenDelete: () => void;
}) {
  return (
    <ModalShell
      label="グループ詳細"
      labelledBy={`${baseId}-detail-heading`}
      onClose={onClose}
      className="w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div
        data-testid="group-detail-modal"
        className="flex max-h-[88vh] flex-col"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <h3
              id={`${baseId}-detail-heading`}
              className="text-sm font-semibold text-slate-900"
            >
              グループ詳細
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              {detail?.group.name ?? detailId}
            </p>
          </div>
          <button
            type="button"
            data-testid="group-detail-close"
            aria-label="グループ詳細を閉じる"
            onClick={onClose}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4 text-xs">
          {detailLoading && (
            <p className="flex items-center gap-1.5 text-slate-500">
              <Loader2
                className="h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
              グループ詳細を読み込み中...
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
              <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-[0.625rem] text-slate-500">種別</p>
                  <GroupSourceBadge source={detail.group.source} />
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">
                    メンバー数
                  </p>
                  <p className="font-medium text-slate-900">
                    {detail.members.length} 人
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">権限数</p>
                  <p className="font-medium text-slate-900">
                    {detail.permissions.length} 件
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">
                    IdP 外部 ID
                  </p>
                  <p className="break-all font-mono text-[0.6875rem] text-slate-700">
                    {detail.group.externalIdpId ?? '—'}
                  </p>
                </div>
              </div>

              {openGroupReadOnlyReason && (
                <p
                  data-testid={
                    detail.scimManaged
                      ? 'group-detail-scim-notice'
                      : 'group-detail-readonly'
                  }
                  role="note"
                  className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-900"
                >
                  <ShieldCheck
                    className="mr-1 inline h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  {openGroupReadOnlyReason}
                </p>
              )}

              {detailNotice && (
                <div
                  role="status"
                  data-testid="group-detail-notice"
                  className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
                >
                  {detailNotice}
                </div>
              )}

              <form
                className="space-y-2 rounded-xl border border-slate-200 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  onSubmitRename();
                }}
              >
                <h4 className="text-[0.75rem] font-semibold text-slate-900">
                  グループ名
                </h4>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-[16rem] flex-1 text-[0.6875rem] font-medium text-slate-700">
                    名前
                    <input
                      type="text"
                      data-testid="group-rename-name"
                      value={renameName}
                      maxLength={120}
                      disabled={!canEditOpenGroup || detailBusy}
                      onChange={(event) => onChangeRenameName(event.target.value)}
                      className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900 disabled:bg-slate-100"
                    />
                  </label>
                  <button
                    type="submit"
                    data-testid="group-rename-submit"
                    disabled={!canEditOpenGroup || detailBusy}
                    className="inline-flex h-9 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    改名
                  </button>
                </div>
                {renameError && (
                  <p
                    role="alert"
                    data-testid="group-rename-error"
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                  >
                    {renameError}
                  </p>
                )}
              </form>

              <div>
                <h4 className="mb-1 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                  <Users className="h-3.5 w-3.5" aria-hidden="true" />
                  所属メンバー
                </h4>
                <div
                  data-testid="group-detail-members"
                  className="overflow-x-auto rounded-lg border border-slate-200"
                >
                  <table className="w-full min-w-[34rem] text-left text-[0.6875rem]">
                    <caption className="sr-only">
                      グループに所属する内部メンバー
                    </caption>
                    <thead className="bg-slate-50 text-[0.625rem] text-slate-500">
                      <tr>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          メール
                        </th>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          表示名
                        </th>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          部署
                        </th>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          ロール
                        </th>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          状態
                        </th>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          操作
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.members.length === 0 ? (
                        <tr>
                          <td
                            colSpan={6}
                            data-testid="group-detail-members-empty"
                            className="px-2 py-4 text-center text-slate-500"
                          >
                            所属メンバーはいません。
                          </td>
                        </tr>
                      ) : (
                        detail.members.map((member) => (
                          <tr
                            key={member.id}
                            data-testid="group-detail-member-row"
                            className="border-t border-slate-100"
                          >
                            <td className="px-2 py-1.5 font-mono text-slate-700">
                              {member.email}
                            </td>
                            <td className="px-2 py-1.5 text-slate-900">
                              {member.displayName}
                            </td>
                            <td className="px-2 py-1.5 text-slate-600">
                              {member.department ?? '部署未設定'}
                            </td>
                            <td className="px-2 py-1.5 text-slate-600">
                              {ADMIN_MEMBER_ROLE_LABELS[member.role]}
                            </td>
                            <td className="px-2 py-1.5 text-slate-600">
                              {member.status === 'active'
                                ? '有効'
                                : '停止中'}
                            </td>
                            <td className="px-2 py-1.5">
                              <button
                                type="button"
                                data-testid="group-member-remove"
                                disabled={!canEditOpenGroup || detailBusy}
                                onClick={() => onRemoveMember(member.id)}
                                className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <UserMinus
                                  className="h-2.5 w-2.5"
                                  aria-hidden="true"
                                />
                                削除
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="mt-2 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2 md:grid-cols-[1fr_auto]">
                  <label className="block text-[0.625rem] font-medium text-slate-600">
                    メンバーを追加
                    <select
                      multiple
                      size={5}
                      data-testid="group-member-add-select"
                      value={selectedMemberIds}
                      disabled={
                        !canEditOpenGroup ||
                        detailBusy ||
                        memberCandidatesLoading
                      }
                      onChange={(event) =>
                        onChangeSelectedMemberIds(
                          Array.from(
                            event.target.selectedOptions,
                            (option) => option.value
                          )
                        )
                      }
                      className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-1 py-1 text-[0.6875rem] text-slate-900 disabled:bg-slate-100"
                    >
                      {candidates.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.displayName} — {member.email}
                        </option>
                      ))}
                    </select>
                    {memberCandidatesLoading ? (
                      <span className="mt-1 inline-flex items-center gap-1 text-[0.625rem] text-slate-500">
                        <Loader2
                          className="h-3 w-3 animate-spin"
                          aria-hidden="true"
                        />
                        追加可能なメンバーを読み込み中...
                      </span>
                    ) : candidates.length === 0 ? (
                      <span className="mt-1 block text-[0.625rem] text-slate-500">
                        追加可能な内部メンバーはいません。
                      </span>
                    ) : (
                      <span className="mt-1 block text-[0.625rem] text-slate-500">
                        Ctrl / ⌘
                        キーで複数選択できます。ゲストは追加できません。
                      </span>
                    )}
                  </label>
                  <button
                    type="button"
                    data-testid="group-member-add-submit"
                    disabled={
                      !canEditOpenGroup ||
                      detailBusy ||
                      selectedMemberIds.length === 0
                    }
                    onClick={onSubmitAddMembers}
                    className="mt-4 inline-flex h-8 items-center gap-1 self-start rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {detailBusy ? (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <UserPlus
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    )}
                    追加
                  </button>
                </div>
                {memberError && (
                  <p
                    role="alert"
                    data-testid="group-member-error"
                    className="mt-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                  >
                    {memberError}
                  </p>
                )}
              </div>

              <div>
                <h4 className="mb-1 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                  <Folder className="h-3.5 w-3.5" aria-hidden="true" />
                  付与済みフォルダ / ファイル権限
                </h4>
                <div
                  data-testid="group-detail-permissions"
                  className="overflow-x-auto rounded-lg border border-slate-200"
                >
                  <table className="w-full min-w-[32rem] text-left text-[0.6875rem]">
                    <caption className="sr-only">
                      グループに直接付与された権限
                    </caption>
                    <thead className="bg-slate-50 text-[0.625rem] text-slate-500">
                      <tr>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          種別
                        </th>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          対象
                        </th>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          パス
                        </th>
                        <th scope="col" className="px-2 py-1.5 font-medium">
                          ロール
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.permissions.length === 0 ? (
                        <tr>
                          <td
                            colSpan={4}
                            data-testid="group-detail-permissions-empty"
                            className="px-2 py-4 text-center text-slate-500"
                          >
                            このグループに付与された権限はありません。
                          </td>
                        </tr>
                      ) : (
                        detail.permissions.map((permission) => (
                          <tr
                            key={permission.id}
                            data-testid="group-detail-permission-row"
                            className="border-t border-slate-100"
                          >
                            <td className="px-2 py-1.5 text-slate-600">
                              {permission.targetType === 'folder'
                                ? 'フォルダ'
                                : 'ファイル'}
                            </td>
                            <td className="px-2 py-1.5 text-slate-900">
                              {permission.targetName}
                            </td>
                            <td className="px-2 py-1.5 font-mono text-[0.625rem] text-slate-600">
                              {permission.targetPath}
                            </td>
                            <td className="px-2 py-1.5 text-slate-600">
                              {ROLE_META[permission.role]?.label ??
                                permission.role}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50/50 p-3">
                <p className="text-[0.6875rem] text-red-800">
                  グループを削除すると、このグループに付与された権限と所属情報も削除されます。最後の有効オーナーになる場合は拒否されます。
                </p>
                <button
                  type="button"
                  data-testid="group-delete-open"
                  disabled={!canEditOpenGroup || detailBusy}
                  onClick={onOpenDelete}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-red-300 bg-white px-3 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  グループを削除
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
