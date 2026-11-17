'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ADMIN_MEMBER_ROLE_LABELS,
  memberRoleBadgeClass,
  memberStatusBadgeClass,
} from '@/lib/admin-users';
import {
  ADMIN_SESSION_USER_TYPE_FILTER_LABELS,
  ADMIN_SESSION_USER_TYPE_LABELS,
  canRevokeAllAdminSessions,
  canViewAdminSessions,
  shortAdminSessionId,
  validateAdminSessionReasonInput,
} from '@/lib/admin-sessions';
import {
  ApiClientError,
  fetchAdminSessions,
  revokeAdminSession,
  revokeAllAdminSessions,
} from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminSessionRow,
  AdminSessionSummary,
  AdminSessionUserTypeFilter,
  AuthUser,
} from '@/types/files';

const PAGE_SIZE = 25;

const EMPTY_SUMMARY: AdminSessionSummary = {
  activeTotal: 0,
  memberSessions: 0,
  guestSessions: 0,
  distinctUsers: 0,
};

function summaryCard(
  label: string,
  value: number,
  testId: string,
  tone: string
) {
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${tone}`}
      data-testid={testId}
    >
      <p className="text-[0.625rem] font-medium text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-slate-900">
        {value.toLocaleString('ja-JP')}
      </p>
    </div>
  );
}

export function AdminSessionsSection({
  user,
}: {
  user: AuthUser | null;
}) {
  const role = user?.role;
  const canView = canViewAdminSessions(role);
  const canRevokeAll = canRevokeAllAdminSessions(role);

  const [userType, setUserType] =
    useState<AdminSessionUserTypeFilter>('all');
  const [query, setQuery] = useState('');
  const [ip, setIp] = useState('');
  const [applied, setApplied] = useState<{
    userType: AdminSessionUserTypeFilter;
    query: string;
    ip: string;
  }>({ userType: 'all', query: '', ip: '' });

  const [sessions, setSessions] = useState<AdminSessionRow[]>([]);
  const [summary, setSummary] = useState<AdminSessionSummary>(EMPTY_SUMMARY);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const requestIdRef = useRef(0);

  const [pendingRevoke, setPendingRevoke] = useState<AdminSessionRow | null>(
    null
  );
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeBusy, setRevokeBusy] = useState(false);

  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revokeAllReason, setRevokeAllReason] = useState('');
  const [keepCurrentSession, setKeepCurrentSession] = useState(true);
  const [revokeAllBusy, setRevokeAllBusy] = useState(false);
  const [revokeAllResult, setRevokeAllResult] = useState<string | null>(null);

  const loadSessions = useCallback(
    async (options: { append: boolean; cursor: string | null }) => {
      if (!canView) return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      if (options.append) setLoadingMore(true);
      else setLoading(true);
      try {
        const response = await fetchAdminSessions({
          userType: applied.userType,
          q: applied.query || undefined,
          ip: applied.ip || undefined,
          limit: PAGE_SIZE,
          cursor: options.cursor,
        });
        if (requestIdRef.current !== requestId) return;
        setSessions((prev) =>
          options.append ? [...prev, ...response.sessions] : response.sessions
        );
        setSummary(response.summary);
        setNextCursor(response.nextCursor);
        setError(null);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'アクティブセッションの読み込みに失敗しました'
        );
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [applied, canView]
  );

  useEffect(() => {
    if (!canView) return;
    void loadSessions({ append: false, cursor: null });
  }, [canView, loadSessions, reloadToken]);

  if (!canView) return null;

  function applyFilters() {
    setNotice(null);
    setApplied({
      userType,
      query: query.trim(),
      ip: ip.trim(),
    });
    setReloadToken((value) => value + 1);
  }

  function resetFilters() {
    setUserType('all');
    setQuery('');
    setIp('');
    setApplied({ userType: 'all', query: '', ip: '' });
    setReloadToken((value) => value + 1);
  }

  async function executeRevoke() {
    if (!pendingRevoke || revokeBusy) return;
    const validation = validateAdminSessionReasonInput(revokeReason);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setRevokeBusy(true);
    setError(null);
    try {
      const result = await revokeAdminSession(
        pendingRevoke.id,
        validation.reason
      );
      setPendingRevoke(null);
      setRevokeReason('');
      setNotice(
        `セッション ${shortAdminSessionId(result.sessionId)} を強制失効しました。`
      );
      setReloadToken((value) => value + 1);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'セッションの強制失効に失敗しました'
      );
    } finally {
      setRevokeBusy(false);
    }
  }

  async function executeRevokeAll() {
    if (revokeAllBusy) return;
    const validation = validateAdminSessionReasonInput(revokeAllReason);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }
    setRevokeAllBusy(true);
    setError(null);
    setRevokeAllResult(null);
    try {
      const result = await revokeAllAdminSessions({
        reason: validation.reason,
        keepCurrentSession,
      });
      setRevokeAllResult(
        `${result.revokedCount} 件のセッションを緊急失効しました。${
          result.keepCurrentSession
            ? '操作中の現在セッションは維持されています。'
            : '現在のセッションも失効対象に含まれています。'
        }`
      );
      setRevokeAllOpen(false);
      setRevokeAllReason('');
      setNotice('テナント全体の緊急セッション失効を実行しました。');
      setReloadToken((value) => value + 1);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'テナント全体のセッション失効に失敗しました'
      );
    } finally {
      setRevokeAllBusy(false);
    }
  }

  return (
    <section
      data-testid="admin-sessions-section"
      className="space-y-4 rounded-2xl border border-[#e7e7ea] bg-white px-5 py-4 shadow-xs"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-[0.875rem] font-semibold text-[#111214]">
            <ShieldCheck className="h-4 w-4 text-[#5e6ad2]" aria-hidden="true" />
            アクティブセッション監視
          </h2>
          <p className="text-[0.6875rem] text-[#55565a]">
            端末紛失・アカウント乗っ取り疑い・ポリシー変更時に、有効セッションを即時遮断します。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReloadToken((value) => value + 1)}
          disabled={loading}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
          <span>再読み込み</span>
        </button>
      </header>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {summaryCard(
          '有効セッション',
          summary.activeTotal,
          'admin-sessions-summary-active',
          'border-slate-200 bg-slate-50'
        )}
        {summaryCard(
          '社内メンバー',
          summary.memberSessions,
          'admin-sessions-summary-members',
          'border-blue-200 bg-blue-50/60'
        )}
        {summaryCard(
          '外部ゲスト',
          summary.guestSessions,
          'admin-sessions-summary-guests',
          'border-amber-200 bg-amber-50/60'
        )}
        {summaryCard(
          'ユーザー数',
          summary.distinctUsers,
          'admin-sessions-summary-users',
          'border-emerald-200 bg-emerald-50/60'
        )}
      </div>

      <div className="grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block text-[0.6875rem] font-medium text-slate-700">
          ユーザー種別
          <select
            data-testid="admin-sessions-filter-user-type"
            value={userType}
            onChange={(event) =>
              setUserType(event.target.value as AdminSessionUserTypeFilter)
            }
            className="mt-1 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
          >
            {(
              Object.keys(
                ADMIN_SESSION_USER_TYPE_FILTER_LABELS
              ) as AdminSessionUserTypeFilter[]
            ).map((value) => (
              <option key={value} value={value}>
                {ADMIN_SESSION_USER_TYPE_FILTER_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-[0.6875rem] font-medium text-slate-700">
          検索
          <input
            type="search"
            data-testid="admin-sessions-filter-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="email / 表示名 / IP / セッションID / UA"
            className="mt-1 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
          />
        </label>
        <label className="block text-[0.6875rem] font-medium text-slate-700">
          IP アドレス
          <input
            type="text"
            data-testid="admin-sessions-filter-ip"
            value={ip}
            onChange={(event) => setIp(event.target.value)}
            placeholder="例: 203.0.113.10"
            className="mt-1 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
          />
        </label>
        <div className="flex items-end gap-2">
          <button
            type="button"
            data-testid="admin-sessions-filter-apply"
            onClick={applyFilters}
            className="inline-flex h-8 flex-1 items-center justify-center rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2]"
          >
            絞り込む
          </button>
          <button
            type="button"
            data-testid="admin-sessions-filter-reset"
            onClick={resetFilters}
            className="inline-flex h-8 items-center justify-center rounded-md border border-slate-300 bg-white px-2.5 text-[0.75rem] text-slate-600 transition hover:bg-slate-100"
          >
            リセット
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="admin-sessions-error"
          className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          data-testid="admin-sessions-notice"
          className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      {pendingRevoke && (
        <div
          data-testid="admin-session-confirm"
          className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[0.75rem] font-semibold text-amber-950">
                セッション {shortAdminSessionId(pendingRevoke.id)} を強制失効しますか？
              </p>
              <p className="text-[0.6875rem] text-amber-900">
                {pendingRevoke.userEmail} / {pendingRevoke.ipAddress ?? 'IP 不明'} の
                接続は即座に切断され、再サインインが必要になります。
              </p>
            </div>
            <button
              type="button"
              aria-label="強制失効の確認を閉じる"
              onClick={() => setPendingRevoke(null)}
              className="rounded p-1 text-amber-800 hover:bg-amber-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <label className="block text-[0.6875rem] font-medium text-amber-950">
            失効理由（任意・300 文字以内）
            <input
              type="text"
              data-testid="admin-session-confirm-reason"
              value={revokeReason}
              onChange={(event) => setRevokeReason(event.target.value)}
              placeholder="例: 端末紛失の報告"
              className="mt-1 h-8 w-full rounded-md border border-amber-300 bg-white px-2 text-xs"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-testid="admin-session-confirm-cancel"
              onClick={() => setPendingRevoke(null)}
              className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[0.75rem] text-slate-600"
            >
              キャンセル
            </button>
            <button
              type="button"
              data-testid="admin-session-confirm-execute"
              onClick={() => void executeRevoke()}
              disabled={revokeBusy}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-2.5 text-[0.75rem] font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
            >
              {revokeBusy && (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              )}
              強制失効を実行
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[52rem] border-collapse text-left text-[0.6875rem]">
          <thead className="bg-slate-50 text-[0.625rem] uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">ユーザー</th>
              <th scope="col" className="px-3 py-2 font-medium">種別</th>
              <th scope="col" className="px-3 py-2 font-medium">IP / 端末</th>
              <th scope="col" className="px-3 py-2 font-medium">開始</th>
              <th scope="col" className="px-3 py-2 font-medium">有効期限</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && sessions.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-500">
                  <Loader2
                    className="mr-1.5 inline h-3.5 w-3.5 animate-spin text-[#5e6ad2]"
                    aria-hidden="true"
                  />
                  セッションを読み込み中...
                </td>
              </tr>
            )}
            {!loading && sessions.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  data-testid="admin-sessions-empty"
                  className="px-3 py-6 text-center text-slate-500"
                >
                  条件に一致する有効セッションはありません。
                </td>
              </tr>
            )}
            {sessions.map((session) => (
              <tr
                key={session.id}
                data-testid="admin-session-row"
                data-session-id={session.id}
                data-user-email={session.userEmail}
              >
                <td className="px-3 py-2 align-top">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-slate-900">
                      {session.userDisplayName}
                    </span>
                    {session.isCurrent && (
                      <span
                        data-testid="admin-session-current"
                        className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[0.5625rem] font-semibold text-emerald-700"
                      >
                        このセッション
                      </span>
                    )}
                  </div>
                  <p className="break-all text-slate-500">{session.userEmail}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span
                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[0.5625rem] font-semibold ${memberRoleBadgeClass(
                        session.userRole
                      )}`}
                    >
                      {ADMIN_MEMBER_ROLE_LABELS[session.userRole]}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[0.5625rem] font-semibold ${memberStatusBadgeClass(
                        session.userStatus
                      )}`}
                    >
                      {session.userStatus === 'active' ? '有効' : '停止中'}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-slate-600">
                  {ADMIN_SESSION_USER_TYPE_LABELS[session.userType]}
                  {session.externalOrg ? (
                    <div className="text-[0.625rem] text-slate-500">
                      {session.externalOrg}
                    </div>
                  ) : null}
                </td>
                <td className="max-w-[15rem] px-3 py-2 align-top text-slate-600">
                  <div className="font-mono text-[0.625rem]">
                    {session.ipAddress ?? '—'}
                  </div>
                  <div
                    className="truncate text-[0.625rem] text-slate-500"
                    title={session.userAgent ?? undefined}
                  >
                    {session.userAgent ?? '—'}
                  </div>
                  <div className="mt-0.5 font-mono text-[0.5625rem] text-slate-400">
                    {shortAdminSessionId(session.id)}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top text-slate-600">
                  {formatAuditDateTime(session.createdAt)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top text-slate-600">
                  {formatAuditDateTime(session.expiresAt)}
                </td>
                <td className="px-3 py-2 text-right align-top">
                  <button
                    type="button"
                    data-testid="admin-session-revoke"
                    disabled={revokeBusy}
                    onClick={() => {
                      setPendingRevoke(session);
                      setRevokeReason('');
                      setError(null);
                    }}
                    className="inline-flex h-6 items-center rounded border border-red-200 bg-red-50 px-2 text-[0.625rem] font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50"
                  >
                    強制失効
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="admin-sessions-load-more"
            disabled={loadingMore}
            onClick={() =>
              void loadSessions({ append: true, cursor: nextCursor })
            }
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-[0.75rem] font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
          >
            {loadingMore && (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            )}
            さらに読み込む
          </button>
        </div>
      )}

      <div
        className={`space-y-3 rounded-xl border p-3 ${
          canRevokeAll
            ? 'border-red-200 bg-red-50/60'
            : 'border-slate-200 bg-slate-50'
        }`}
      >
        <div className="flex items-start gap-2">
          <ShieldAlert
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              canRevokeAll ? 'text-red-600' : 'text-slate-400'
            }`}
            aria-hidden="true"
          />
          <div>
            <h3 className="text-[0.75rem] font-semibold text-slate-900">
              緊急一括失効（テナント全体）
            </h3>
            <p className="text-[0.6875rem] text-slate-600">
              テナント内の全有効セッションを即時失効します。通常は
              <code className="mx-1 rounded bg-white px-1 py-0.5 font-mono text-[0.625rem]">
                keepCurrentSession
              </code>
              を有効にして操作中の管理者を保護してください。
            </p>
          </div>
        </div>

        {!canRevokeAll && (
          <p
            data-testid="admin-sessions-revoke-all-disabled"
            className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[0.6875rem] text-slate-600"
          >
            テナント全体の緊急一括失効はシステム管理者 (sys_admin) 専用です。
          </p>
        )}

        {canRevokeAll && !revokeAllOpen && (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="block text-[0.6875rem] font-medium text-slate-700">
              失効理由（任意・300 文字以内）
              <input
                type="text"
                data-testid="admin-sessions-revoke-all-reason"
                value={revokeAllReason}
                onChange={(event) => setRevokeAllReason(event.target.value)}
                placeholder="例: インシデント初動対応"
                className="mt-1 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
              />
            </label>
            <button
              type="button"
              data-testid="admin-sessions-revoke-all-open"
              onClick={() => {
                setRevokeAllOpen(true);
                setRevokeAllResult(null);
                setError(null);
              }}
              className="mt-auto inline-flex h-8 items-center justify-center rounded-md bg-red-600 px-3 text-[0.75rem] font-medium text-white transition hover:bg-red-700"
            >
              緊急一括失効へ進む
            </button>
          </div>
        )}

        {canRevokeAll && revokeAllOpen && (
          <div
            data-testid="admin-sessions-revoke-all-confirm"
            className="space-y-2 rounded-lg border border-red-300 bg-white p-3"
          >
            <p className="text-[0.75rem] font-semibold text-red-800">
              本当にテナント内の全有効セッションを失効しますか？
            </p>
            <p className="text-[0.6875rem] text-slate-600">
              この操作は即座に反映され、全ユーザーが再サインインを求められます。
            </p>
            <label className="flex items-center gap-2 text-[0.6875rem] font-medium text-slate-700">
              <input
                type="checkbox"
                data-testid="admin-sessions-revoke-all-keep-current"
                checked={keepCurrentSession}
                onChange={(event) =>
                  setKeepCurrentSession(event.target.checked)
                }
              />
              操作中の現在セッションを維持する（推奨）
            </label>
            <label className="block text-[0.6875rem] font-medium text-slate-700">
              失効理由（任意・300 文字以内）
              <input
                type="text"
                data-testid="admin-sessions-revoke-all-confirm-reason"
                value={revokeAllReason}
                onChange={(event) => setRevokeAllReason(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="admin-sessions-revoke-all-cancel"
                onClick={() => setRevokeAllOpen(false)}
                className="inline-flex h-7 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[0.75rem] text-slate-600"
              >
                キャンセル
              </button>
              <button
                type="button"
                data-testid="admin-sessions-revoke-all-execute"
                onClick={() => void executeRevokeAll()}
                disabled={revokeAllBusy}
                className="inline-flex h-7 items-center gap-1.5 rounded-md bg-red-600 px-2.5 text-[0.75rem] font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {revokeAllBusy && (
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

        {revokeAllResult && (
          <p
            role="status"
            data-testid="admin-sessions-revoke-all-result"
            className="flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-[0.6875rem] text-emerald-800"
          >
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {revokeAllResult}
          </p>
        )}
      </div>
    </section>
  );
}
