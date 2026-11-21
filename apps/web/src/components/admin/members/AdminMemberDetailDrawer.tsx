'use client';

import {
  Folder,
  Loader2,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserMinus,
  X,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  MemberRoleBadge,
  MemberStatusBadge,
} from '@/components/admin/members/AdminMemberBadges';
import {
  memberCanOpenOffboarding,
  memberOffboardingOpenGuardReason,
} from '@/lib/admin-offboarding';
import {
  ADMIN_SESSION_USER_TYPE_LABELS,
  adminSessionTargetGuardReason,
  canRevokeAdminSession,
  shortAdminSessionId,
  validateAdminSessionReasonInput,
} from '@/lib/admin-sessions';
import {
  formatMemberUsage,
  formatOptionalBytes,
  memberCanBeResumed,
  memberCanBeSuspended,
  parseMemberQuotaInput,
} from '@/lib/admin-users';
import {
  ApiClientError,
  fetchAdminMemberDetail,
  fetchAdminSessions,
  revokeAdminSession,
  revokeAdminUserSessions,
  updateAdminMember,
} from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminMemberDetailResponse,
  AdminMemberRow,
  AdminMemberUpdateInput,
  AdminSessionRow,
  AuthUser,
  UserRole,
} from '@/types/files';
import type { MemberAction } from './AdminMemberActionModal';

interface EditFormState {
  displayName: string;
  department: string;
  role: UserRole;
  quota: string;
}

const DEFAULT_EDIT_FORM: EditFormState = {
  displayName: '',
  department: '',
  role: 'member',
  quota: '',
};

interface AdminMemberDetailDrawerProps {
  memberId: string;
  viewer: AuthUser | null;
  canAdministrate: boolean;
  activeSysAdminCount: number;
  rbacNoticeId: string;
  refreshToken: number;
  onClose: () => void;
  onUpdated: (notice: string | null) => void;
  onRefreshList: () => void;
  onOpenAction: (action: MemberAction, member: AdminMemberRow) => void;
  onOpenOffboarding: (member: AdminMemberRow) => void;
}

export function AdminMemberDetailDrawer({
  memberId,
  viewer,
  canAdministrate,
  activeSysAdminCount,
  rbacNoticeId,
  refreshToken,
  onClose,
  onUpdated,
  onRefreshList,
  onOpenAction,
  onOpenOffboarding,
}: AdminMemberDetailDrawerProps) {
  const baseId = useId();
  const role = viewer?.role;

  const [detail, setDetail] = useState<AdminMemberDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [memberSessions, setMemberSessions] = useState<AdminSessionRow[]>([]);
  const [memberSessionsLoading, setMemberSessionsLoading] = useState(false);
  const [memberSessionsError, setMemberSessionsError] = useState<string | null>(
    null
  );
  const [memberSessionsNotice, setMemberSessionsNotice] = useState<
    string | null
  >(null);
  const [memberSessionsReloadToken, setMemberSessionsReloadToken] = useState(0);
  const [memberSessionReason, setMemberSessionReason] = useState('');
  const [pendingMemberSession, setPendingMemberSession] =
    useState<AdminSessionRow | null>(null);
  const [memberSessionBusy, setMemberSessionBusy] = useState(false);
  const [memberSessionAllOpen, setMemberSessionAllOpen] = useState(false);
  const [memberSessionKeepCurrent, setMemberSessionKeepCurrent] =
    useState(true);
  const [memberSessionAllBusy, setMemberSessionAllBusy] = useState(false);
  const [memberSessionAllResult, setMemberSessionAllResult] = useState<
    string | null
  >(null);

  const [editForm, setEditForm] = useState<EditFormState>(DEFAULT_EDIT_FORM);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editResult, setEditResult] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    setEditError(null);
    setEditResult(null);
    setMemberSessionsNotice(null);
    setMemberSessionAllResult(null);
    setMemberSessionsError(null);
    setDetailLoading(true);
    fetchAdminMemberDetail(memberId)
      .then((response) => {
        if (!cancelled) setDetail(response);
      })
      .catch((err) => {
        if (cancelled) return;
        setDetailError(
          err instanceof ApiClientError
            ? err.message
            : 'メンバー詳細の読み込みに失敗しました'
        );
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [memberId, refreshToken]);

  useEffect(() => {
    if (!detail) return;
    setEditForm({
      displayName: detail.user.displayName,
      department: detail.user.department ?? '',
      role: detail.user.role,
      quota:
        detail.user.storageQuotaBytes === null
          ? ''
          : String(detail.user.storageQuotaBytes),
    });
  }, [detail]);

  // TOM-71: the member drawer lists real D1 sessions (not just a count) so
  // admins can revoke a single device or every session for the member.
  useEffect(() => {
    let cancelled = false;
    setMemberSessionsLoading(true);
    setMemberSessionsError(null);
    setPendingMemberSession(null);
    setMemberSessionAllOpen(false);
    setMemberSessionReason('');
    fetchAdminSessions({ userId: memberId, limit: 100 })
      .then((response) => {
        if (cancelled) return;
        setMemberSessions(response.sessions);
      })
      .catch((err) => {
        if (cancelled) return;
        setMemberSessionsError(
          err instanceof ApiClientError
            ? err.message
            : 'アクティブセッションの読み込みに失敗しました'
        );
      })
      .finally(() => {
        if (!cancelled) setMemberSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [memberId, memberSessionsReloadToken]);

  function closeDetail() {
    if (editBusy) return;
    onClose();
  }

  const memberSessionGuard = detail
    ? adminSessionTargetGuardReason(role, detail.user.role)
    : null;
  const canRevokeMemberSessions = detail
    ? canRevokeAdminSession(
        role,
        detail.user.role,
        viewer?.adminCapabilities
      ) && !(role === 'member' && detail.user.id === viewer?.id)
    : false;

  async function refreshDetailQuietly(id: string) {
    try {
      const response = await fetchAdminMemberDetail(id);
      setDetail(response);
    } catch {
      // The session mutation already succeeded; keep the visible drawer and
      // let the next explicit open surface any stale detail error.
    }
  }

  async function executeMemberSessionRevoke() {
    if (!detail || !pendingMemberSession || memberSessionBusy) return;
    if (!canRevokeMemberSessions) return;
    const validation = validateAdminSessionReasonInput(memberSessionReason);
    if (!validation.ok) {
      setMemberSessionsError(validation.error);
      return;
    }
    setMemberSessionBusy(true);
    setMemberSessionsError(null);
    try {
      const result = await revokeAdminSession(
        pendingMemberSession.id,
        validation.reason
      );
      setPendingMemberSession(null);
      setMemberSessionReason('');
      setMemberSessionsNotice(
        `セッション ${shortAdminSessionId(result.sessionId)} を強制失効しました。`
      );
      setMemberSessionsReloadToken((value) => value + 1);
      void refreshDetailQuietly(detail.user.id);
      onRefreshList();
    } catch (err) {
      setMemberSessionsError(
        err instanceof ApiClientError
          ? err.message
          : 'セッションの強制失効に失敗しました'
      );
    } finally {
      setMemberSessionBusy(false);
    }
  }

  async function executeMemberSessionsRevokeAll() {
    if (!detail || memberSessionAllBusy) return;
    if (!canRevokeMemberSessions) return;
    const validation = validateAdminSessionReasonInput(memberSessionReason);
    if (!validation.ok) {
      setMemberSessionsError(validation.error);
      return;
    }
    setMemberSessionAllBusy(true);
    setMemberSessionsError(null);
    try {
      const result = await revokeAdminUserSessions(detail.user.id, {
        reason: validation.reason,
        keepCurrentSession: memberSessionKeepCurrent,
      });
      setMemberSessionAllResult(
        `${result.revokedCount} 件のセッションを強制失効しました。${
          result.keepCurrentSession && detail.user.id === viewer?.id
            ? '操作中の現在セッションは維持されています。'
            : ''
        }`
      );
      setMemberSessionsNotice(
        `${detail.user.displayName} さんの全セッションを強制サインアウトしました。`
      );
      setMemberSessionAllOpen(false);
      setMemberSessionReason('');
      setMemberSessionsReloadToken((value) => value + 1);
      void refreshDetailQuietly(detail.user.id);
      onRefreshList();
    } catch (err) {
      setMemberSessionsError(
        err instanceof ApiClientError
          ? err.message
          : '全セッションの強制失効に失敗しました。'
      );
    } finally {
      setMemberSessionAllBusy(false);
    }
  }

  async function submitEdit() {
    if (!detail || editBusy) return;
    const quota = parseMemberQuotaInput(editForm.quota);
    if (!quota.ok) {
      setEditError(quota.message);
      return;
    }
    const payload: AdminMemberUpdateInput = {
      displayName: editForm.displayName.trim(),
      department: editForm.department.trim() || null,
      role: editForm.role,
      storageQuotaBytes: quota.value,
    };
    setEditBusy(true);
    setEditError(null);
    setEditResult(null);
    try {
      const response = await updateAdminMember(detail.user.id, payload);
      setEditResult(response.notice ?? 'メンバー情報を更新しました。');
      onUpdated(response.notice ?? null);
      const refreshed = await fetchAdminMemberDetail(detail.user.id);
      setDetail(refreshed);
    } catch (err) {
      setEditError(
        err instanceof ApiClientError
          ? err.message
          : 'メンバー情報の更新に失敗しました'
      );
    } finally {
      setEditBusy(false);
    }
  }

  function offboardingGuard(member: AdminMemberRow): string | null {
    return memberOffboardingOpenGuardReason({
      viewerRole: role,
      viewerId: viewer?.id,
      member,
      activeSysAdminCount,
    });
  }

  return (
    <ModalShell
      label="メンバー詳細"
      labelledBy={`${baseId}-detail-heading`}
      onClose={closeDetail}
      className="w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div
        data-testid="member-edit-modal"
        className="flex max-h-[85vh] flex-col"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <div>
            <h3
              id={`${baseId}-detail-heading`}
              className="text-sm font-semibold text-slate-900"
            >
              メンバー詳細・編集
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-slate-500">
              {detail?.user.email ?? memberId}
            </p>
          </div>
          <button
            type="button"
            data-testid="member-edit-close"
            aria-label="メンバー詳細を閉じる"
            onClick={closeDetail}
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
              メンバー詳細を読み込み中...
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
                  <p className="text-[0.625rem] text-slate-500">ロール</p>
                  <MemberRoleBadge role={detail.user.role} />
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">状態</p>
                  <MemberStatusBadge status={detail.user.status} />
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">使用量</p>
                  <p
                    data-testid="member-detail-usage"
                    className="font-medium text-slate-900"
                  >
                    {formatMemberUsage(detail.user)}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">
                    個人クォータ
                  </p>
                  <p className="font-medium text-slate-900">
                    {formatOptionalBytes(detail.user.storageQuotaBytes)}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">ファイル数</p>
                  <p className="font-medium text-slate-900">
                    {detail.user.fileCount}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">
                    最終ログイン
                  </p>
                  <p className="font-medium text-slate-900">
                    {detail.user.lastLoginAt
                      ? formatAuditDateTime(detail.user.lastLoginAt)
                      : '未ログイン'}
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">
                    有効セッション
                  </p>
                  <p
                    data-testid="member-detail-sessions"
                    className="font-medium text-slate-900"
                  >
                    {memberSessionsLoading
                      ? detail.activeSessionCount
                      : Math.max(
                          detail.activeSessionCount,
                          memberSessions.length
                        )}{' '}
                    件
                  </p>
                </div>
                <div>
                  <p className="text-[0.625rem] text-slate-500">
                    所属グループ
                  </p>
                  <div
                    data-testid="member-detail-groups"
                    className="font-medium text-slate-900"
                  >
                    {detail.groups.length === 0
                      ? 'なし'
                      : detail.groups.map((group) => group.name).join(', ')}
                  </div>
                </div>
              </div>

              <div
                data-testid="member-sessions-panel"
                className="space-y-3 rounded-xl border border-slate-200 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 className="flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                      <MonitorSmartphone
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                      アクティブセッション
                    </h4>
                    <p className="text-[0.6875rem] text-slate-500">
                      端末紛失・乗っ取り疑いの端末だけを個別に、または全端末を即時サインアウトできます。
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="member-sessions-refresh"
                    onClick={() =>
                      setMemberSessionsReloadToken((value) => value + 1)
                    }
                    disabled={memberSessionsLoading}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-[0.6875rem] text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3 w-3 ${
                        memberSessionsLoading ? 'animate-spin' : ''
                      }`}
                      aria-hidden="true"
                    />
                    更新
                  </button>
                </div>

                {memberSessionGuard && (
                  <p
                    data-testid="member-sessions-protected"
                    className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[0.6875rem] text-amber-900"
                  >
                    <ShieldAlert
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    {memberSessionGuard}
                  </p>
                )}

                {memberSessionsError && (
                  <div
                    role="alert"
                    data-testid="member-sessions-error"
                    className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-[0.6875rem] text-red-700"
                  >
                    {memberSessionsError}
                  </div>
                )}
                {memberSessionsNotice && (
                  <div
                    role="status"
                    data-testid="member-sessions-notice"
                    className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[0.6875rem] text-emerald-800"
                  >
                    {memberSessionsNotice}
                  </div>
                )}

                {memberSessionsLoading && memberSessions.length === 0 && (
                  <p className="flex items-center gap-1.5 text-[0.6875rem] text-slate-500">
                    <Loader2
                      className="h-3 w-3 animate-spin"
                      aria-hidden="true"
                    />
                    セッションを読み込み中...
                  </p>
                )}

                {!memberSessionsLoading && memberSessions.length === 0 && (
                  <p
                    data-testid="member-sessions-empty"
                    className="text-[0.6875rem] text-slate-500"
                  >
                    有効なセッションはありません。
                  </p>
                )}

                {memberSessions.length > 0 && (
                  <ul className="space-y-1.5">
                    {memberSessions.map((session) => (
                      <li
                        key={session.id}
                        data-testid="member-session-row"
                        data-session-id={session.id}
                        className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[0.625rem] text-slate-700">
                              {shortAdminSessionId(session.id)}
                            </span>
                            {session.isCurrent && (
                              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[0.5625rem] font-semibold text-emerald-700">
                                このセッション
                              </span>
                            )}
                            <span className="rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[0.5625rem] text-slate-600">
                              {
                                ADMIN_SESSION_USER_TYPE_LABELS[
                                  session.userType
                                ]
                              }
                            </span>
                          </div>
                          <p className="font-mono text-[0.625rem] text-slate-600">
                            {session.ipAddress ?? 'IP 不明'}
                          </p>
                          <p
                            className="truncate text-[0.625rem] text-slate-500"
                            title={session.userAgent ?? undefined}
                          >
                            {session.userAgent ?? 'ユーザーエージェント不明'}
                          </p>
                          <p className="text-[0.625rem] text-slate-500">
                            開始 {formatAuditDateTime(session.createdAt)} / 期限{' '}
                            {formatAuditDateTime(session.expiresAt)}
                          </p>
                        </div>
                        <button
                          type="button"
                          data-testid="member-session-revoke"
                          disabled={
                            !canRevokeMemberSessions || memberSessionBusy
                          }
                          onClick={() => {
                            setPendingMemberSession(session);
                            setMemberSessionReason('');
                            setMemberSessionsError(null);
                          }}
                          className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-red-200 bg-red-50 px-2 text-[0.625rem] font-medium text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <LogOut className="h-3 w-3" aria-hidden="true" />
                          強制失効
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {pendingMemberSession && (
                  <div
                    data-testid="member-session-confirm"
                    className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5"
                  >
                    <p className="text-[0.6875rem] font-semibold text-amber-950">
                      セッション {shortAdminSessionId(pendingMemberSession.id)}{' '}
                      を強制失効しますか？
                    </p>
                    <label className="block text-[0.6875rem] font-medium text-amber-950">
                      失効理由（任意・300 文字以内）
                      <input
                        type="text"
                        data-testid="member-session-reason"
                        value={memberSessionReason}
                        onChange={(event) =>
                          setMemberSessionReason(event.target.value)
                        }
                        placeholder="例: 端末紛失の報告"
                        className="mt-1 h-8 w-full rounded-md border border-amber-300 bg-white px-2 text-xs"
                      />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        data-testid="member-session-confirm-cancel"
                        onClick={() => setPendingMemberSession(null)}
                        className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[0.6875rem] text-slate-600"
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        data-testid="member-session-confirm-execute"
                        onClick={() => void executeMemberSessionRevoke()}
                        disabled={memberSessionBusy}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                      >
                        {memberSessionBusy && (
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        強制失効を実行
                      </button>
                    </div>
                  </div>
                )}

                {!memberSessionAllOpen && (
                  <button
                    type="button"
                    data-testid="member-sessions-revoke-all"
                    disabled={
                      !canRevokeMemberSessions ||
                      memberSessionAllBusy ||
                      memberSessions.length === 0
                    }
                    onClick={() => {
                      setMemberSessionAllOpen(true);
                      setMemberSessionAllResult(null);
                      setMemberSessionsError(null);
                    }}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-red-300 bg-white px-2.5 text-[0.6875rem] font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <LogOut className="h-3 w-3" aria-hidden="true" />
                    このユーザーの全セッションを強制サインアウト
                  </button>
                )}

                {memberSessionAllOpen && (
                  <div
                    data-testid="member-sessions-revoke-all-confirm"
                    className="space-y-2 rounded-lg border border-red-300 bg-white p-2.5"
                  >
                    <p className="text-[0.6875rem] font-semibold text-red-800">
                      {detail.user.displayName}{' '}
                      さんの全セッションを失効しますか？
                    </p>
                    <label className="flex items-center gap-2 text-[0.6875rem] font-medium text-slate-700">
                      <input
                        type="checkbox"
                        data-testid="member-sessions-keep-current"
                        checked={memberSessionKeepCurrent}
                        onChange={(event) =>
                          setMemberSessionKeepCurrent(event.target.checked)
                        }
                      />
                      操作中の現在セッションを維持する（本人操作時）
                    </label>
                    <label className="block text-[0.6875rem] font-medium text-slate-700">
                      失効理由（任意・300 文字以内）
                      <input
                        type="text"
                        data-testid="member-sessions-revoke-all-reason"
                        value={memberSessionReason}
                        onChange={(event) =>
                          setMemberSessionReason(event.target.value)
                        }
                        className="mt-1 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
                      />
                    </label>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        data-testid="member-sessions-revoke-all-cancel"
                        onClick={() => setMemberSessionAllOpen(false)}
                        className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[0.6875rem] text-slate-600"
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        data-testid="member-sessions-revoke-all-execute"
                        onClick={() => void executeMemberSessionsRevokeAll()}
                        disabled={memberSessionAllBusy}
                        className="inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                      >
                        {memberSessionAllBusy && (
                          <Loader2
                            className="h-3 w-3 animate-spin"
                            aria-hidden="true"
                          />
                        )}
                        全セッションを失効
                      </button>
                    </div>
                  </div>
                )}

                {memberSessionAllResult && (
                  <p
                    role="status"
                    data-testid="member-sessions-revoke-all-result"
                    className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[0.6875rem] text-emerald-800"
                  >
                    {memberSessionAllResult}
                  </p>
                )}
              </div>

              <div>
                <h4 className="mb-1 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                  <Folder className="h-3.5 w-3.5" aria-hidden="true" />
                  所有ルートフォルダ
                </h4>
                <p
                  data-testid="member-detail-root-folders"
                  className="text-[0.6875rem] text-slate-600"
                >
                  {detail.rootFolders.length === 0
                    ? '所有しているルートフォルダはありません。'
                    : detail.rootFolders
                        .map((folder) => folder.name)
                        .join(', ')}
                </p>
              </div>

              <form
                className="space-y-3 rounded-xl border border-slate-200 p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitEdit();
                }}
              >
                <h4 className="text-[0.75rem] font-semibold text-slate-900">
                  プロフィール・権限
                </h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-[0.6875rem] font-medium text-slate-700">
                    表示名
                    <input
                      type="text"
                      data-testid="member-edit-display-name"
                      data-autofocus
                      value={editForm.displayName}
                      onChange={(event) =>
                        setEditForm((current) => ({
                          ...current,
                          displayName: event.target.value,
                        }))
                      }
                      disabled={!canAdministrate || editBusy}
                      className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900 disabled:bg-slate-100"
                    />
                  </label>
                  <label className="block text-[0.6875rem] font-medium text-slate-700">
                    部署
                    <input
                      type="text"
                      data-testid="member-edit-department"
                      value={editForm.department}
                      onChange={(event) =>
                        setEditForm((current) => ({
                          ...current,
                          department: event.target.value,
                        }))
                      }
                      disabled={!canAdministrate || editBusy}
                      className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900 disabled:bg-slate-100"
                    />
                  </label>
                  <label className="block text-[0.6875rem] font-medium text-slate-700">
                    ロール
                    <select
                      data-testid="member-edit-role"
                      value={editForm.role}
                      onChange={(event) =>
                        setEditForm((current) => ({
                          ...current,
                          role: event.target.value as UserRole,
                        }))
                      }
                      disabled={!canAdministrate || editBusy}
                      className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900 disabled:bg-slate-100"
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
                      data-testid="member-edit-quota"
                      value={editForm.quota}
                      onChange={(event) =>
                        setEditForm((current) => ({
                          ...current,
                          quota: event.target.value,
                        }))
                      }
                      placeholder="空欄 = 上限なし"
                      disabled={!canAdministrate || editBusy}
                      className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900 disabled:bg-slate-100"
                    />
                  </label>
                </div>
                {editError && (
                  <div
                    role="alert"
                    data-testid="member-edit-error"
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                  >
                    {editError}
                  </div>
                )}
                {editResult && (
                  <div
                    role="status"
                    data-testid="member-edit-result"
                    className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
                  >
                    {editResult}
                  </div>
                )}
                {canAdministrate ? (
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      data-testid="member-edit-submit"
                      disabled={editBusy}
                      className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                    >
                      {editBusy && (
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin"
                          aria-hidden="true"
                        />
                      )}
                      更新
                    </button>
                  </div>
                ) : (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] text-amber-900">
                    ロール・クォータの変更は sys_admin 専用です。
                  </p>
                )}
              </form>

              <div>
                <h4 className="mb-1 flex items-center gap-1.5 text-[0.75rem] font-semibold text-slate-900">
                  <ShieldCheck
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  最近のメンバー監査ログ
                </h4>
                <div
                  data-testid="member-detail-audit-logs"
                  className="max-h-40 space-y-1 overflow-auto rounded-lg border border-slate-200 p-2 font-mono text-[0.625rem] text-slate-600"
                >
                  {detail.recentAuditLogs.length === 0 ? (
                    <p className="font-sans text-slate-500">
                      監査ログはありません。
                    </p>
                  ) : (
                    detail.recentAuditLogs.map((log) => (
                      <p key={log.id}>
                        {formatAuditDateTime(log.createdAt)} — {log.action}
                      </p>
                    ))
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  data-testid="member-action-suspend"
                  disabled={!memberCanBeSuspended(role, viewer?.id, detail.user)}
                  aria-describedby={rbacNoticeId}
                  onClick={() => onOpenAction('suspend', detail.user)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-[0.6875rem] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-40"
                >
                  停止
                </button>
                <button
                  type="button"
                  data-testid="member-action-resume"
                  disabled={!memberCanBeResumed(role, viewer?.id, detail.user)}
                  aria-describedby={rbacNoticeId}
                  onClick={() => onOpenAction('resume', detail.user)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 text-[0.6875rem] font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-40"
                >
                  再開
                </button>
                <button
                  type="button"
                  data-testid="member-action-offboard"
                  disabled={
                    !memberCanOpenOffboarding({
                      viewerRole: role,
                      viewerId: viewer?.id,
                      member: detail.user,
                      activeSysAdminCount,
                    })
                  }
                  title={
                    offboardingGuard(detail.user) ??
                    '退職/移管 (オフボーディング)'
                  }
                  aria-describedby={rbacNoticeId}
                  onClick={() => onOpenOffboarding(detail.user)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-300 bg-white px-2.5 text-[0.6875rem] font-medium text-rose-800 hover:bg-rose-50 disabled:opacity-40"
                >
                  <UserMinus className="h-3 w-3" aria-hidden="true" />
                  退職/移管
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
