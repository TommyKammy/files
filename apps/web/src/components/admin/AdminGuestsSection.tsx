'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Trash2,
  UserCheck,
  UserX,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ADMIN_GUEST_SORT_LABELS,
  ariaSortForGuestColumn,
  buildAdminGuestQuery,
  canManageGuestLifecycle,
  canSuspendGuest,
  canViewAdminGuests,
  createGuestIdempotencyKey,
  filterAdminGuests,
  formatGuestDomainSummary,
  formatGuestInviterSummary,
  guestLifecyclePermissionNotice,
  guestStatusSummaryCards,
  sortAdminGuestRows,
  toggleAdminGuestSort,
} from '@/lib/admin-guests';
import {
  ApiClientError,
  fetchAdminGuestDetail,
  fetchAdminGuests,
  offboardAdminGuest,
  resendAdminGuestInvite,
  resumeAdminGuest,
  suspendAdminGuest,
} from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminGuestDetailResponse,
  AdminGuestListQuery,
  AdminGuestListResponse,
  AdminGuestSortBy,
  AuthUser,
} from '@/types/files';
import {
  AdminGuestActionModal,
  type ActionGuest,
  type GuestAction,
} from './guests/AdminGuestActionModal';
import { GuestStatusBadge } from './guests/AdminGuestBadges';
import { AdminGuestDetailModal } from './guests/AdminGuestDetailModal';
import {
  AdminGuestFilterBar,
  type GuestDraftFilters,
} from './guests/AdminGuestFilterBar';
import { AdminGuestSummarySection } from './guests/AdminGuestSummarySection';

const PAGE_SIZE = 25;

const DEFAULT_QUERY: AdminGuestListQuery = {
  status: 'all',
  sortBy: 'createdAt',
  sortDir: 'desc',
  limit: PAGE_SIZE,
  offset: 0,
};

const DEFAULT_DRAFT: GuestDraftFilters = {
  query: '',
  status: 'all',
  domain: '',
  invitedBy: '',
  expiresBefore: '',
};

export function AdminGuestsSection({
  user,
  onShowAuditLogs,
}: {
  user: AuthUser | null;
  onShowAuditLogs?: () => void;
}) {
  const baseId = useId();
  const role = user?.role;
  const canView = canViewAdminGuests(role);
  const canSuspend = canSuspendGuest(role);
  const canManage = canManageGuestLifecycle(role);

  const [query, setQuery] = useState<AdminGuestListQuery>(DEFAULT_QUERY);
  const [draft, setDraft] = useState<GuestDraftFilters>(DEFAULT_DRAFT);
  const [data, setData] = useState<AdminGuestListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const [detailGuestId, setDetailGuestId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminGuestDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [action, setAction] = useState<GuestAction | null>(null);
  const [actionGuest, setActionGuest] = useState<ActionGuest | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalResult, setModalResult] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [extendDays, setExtendDays] = useState('30');
  const busyRef = useRef(false);

  const loadList = useCallback(
    async (nextQuery: AdminGuestListQuery) => {
      if (!canView) return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      try {
        const response = await fetchAdminGuests(nextQuery);
        if (requestIdRef.current !== requestId) return;
        setData(response);
        setError(null);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'ゲスト一覧の読み込みに失敗しました'
        );
      } finally {
        if (requestIdRef.current === requestId) setLoading(false);
      }
    },
    [canView]
  );

  useEffect(() => {
    if (canView) void loadList(query);
  }, [canView, loadList, query]);

  const loadDetail = useCallback(async (guestId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await fetchAdminGuestDetail(guestId);
      setDetail(response);
    } catch (err) {
      setDetailError(
        err instanceof ApiClientError
          ? err.message
          : 'ゲスト詳細の読み込みに失敗しました'
      );
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const displayGuests = useMemo(() => {
    const rows = data?.guests ?? [];
    return sortAdminGuestRows(
      filterAdminGuests(rows, {
        query: query.query,
        status: query.status,
        domain: query.domain,
        invitedBy: query.invitedBy,
        expiresBefore: query.expiresBefore,
      }),
      query.sortBy ?? 'createdAt',
      query.sortDir ?? 'desc'
    );
  }, [data?.guests, query]);

  const statusCards = useMemo(
    () => guestStatusSummaryCards(data?.summary),
    [data?.summary]
  );
  const domainRows = useMemo(
    () => formatGuestDomainSummary(data?.summary.byDomain ?? []),
    [data?.summary.byDomain]
  );
  const inviterRows = useMemo(
    () => formatGuestInviterSummary(data?.summary.byInviter ?? []),
    [data?.summary.byInviter]
  );

  const sortAnnouncement = useMemo(() => {
    if (!data) return 'ゲスト一覧を読み込み中';
    const by = ADMIN_GUEST_SORT_LABELS[query.sortBy ?? 'createdAt'];
    const dir = query.sortDir === 'asc' ? '昇順' : '降順';
    return `${data.total} 件中 ${displayGuests.length} 件を表示、${by}の${dir}で並べ替え`;
  }, [data, displayGuests.length, query.sortBy, query.sortDir]);

  if (!canView) {
    return null;
  }

  function applyFilters() {
    setQuery((current) => ({
      ...current,
      query: draft.query.trim() || undefined,
      status: draft.status,
      domain: draft.domain.trim() || undefined,
      invitedBy: draft.invitedBy.trim() || undefined,
      expiresBefore: draft.expiresBefore || undefined,
      offset: 0,
    }));
  }

  function resetFilters() {
    setDraft(DEFAULT_DRAFT);
    setQuery((current) => ({
      ...DEFAULT_QUERY,
      sortBy: current.sortBy,
      sortDir: current.sortDir,
      limit: current.limit,
    }));
  }

  function handleSort(sortBy: AdminGuestSortBy) {
    setQuery((current) => ({
      ...current,
      ...toggleAdminGuestSort(
        {
          sortBy: current.sortBy ?? 'createdAt',
          sortDir: current.sortDir ?? 'desc',
        },
        sortBy
      ),
      offset: 0,
    }));
  }

  function changePage(offset: number) {
    setQuery((current) => ({
      ...current,
      offset: Math.max(0, offset),
    }));
  }

  async function openDetail(guestId: string) {
    setDetailGuestId(guestId);
    setDetail(null);
    setDetailError(null);
    await loadDetail(guestId);
  }

  function closeDetail() {
    if (busyRef.current) return;
    setDetailGuestId(null);
    setDetail(null);
    setDetailError(null);
  }

  function openAction(nextAction: GuestAction, guest: ActionGuest) {
    if (nextAction === 'suspend' ? !canSuspend : !canManage) return;
    setAction(nextAction);
    setActionGuest(guest);
    setModalBusy(false);
    setModalError(null);
    setModalResult(null);
    busyRef.current = false;
    setExtendDays('30');
    setIdempotencyKey(createGuestIdempotencyKey(nextAction, guest.id));
  }

  function closeActionModal() {
    if (busyRef.current) return;
    setAction(null);
    setActionGuest(null);
    setModalError(null);
    setModalResult(null);
    setIdempotencyKey('');
  }

  async function executeAction() {
    if (!action || !actionGuest || busyRef.current) return;
    const extend = Number(extendDays);
    if (
      action === 'resume' &&
      (!Number.isInteger(extend) || extend < 1 || extend > 3650)
    ) {
      setModalError('延長日数は 1〜3650 の整数で指定してください。');
      return;
    }

    busyRef.current = true;
    setModalBusy(true);
    setModalError(null);
    try {
      let message: string;
      if (action === 'suspend') {
        const response = await suspendAdminGuest(actionGuest.id, {
          idempotencyKey,
        });
        message =
          response.notice ??
          `ゲストを停止しました（セッション ${response.sessionsRevoked ?? 0} 件を失効）。`;
      } else if (action === 'resume') {
        const response = await resumeAdminGuest(actionGuest.id, {
          idempotencyKey,
          extendDays: extend,
        });
        message =
          response.notice ?? 'ゲストアカウントを再開しました。';
      } else if (action === 'resend') {
        const response = await resendAdminGuestInvite(actionGuest.id, {
          idempotencyKey,
        });
        message =
          response.notice ??
          `招待メールを再送しました（再送回数 ${response.resendCount} 回）。`;
      } else {
        const response = await offboardAdminGuest(actionGuest.id, {
          idempotencyKey,
        });
        message =
          response.notice ??
          'ゲストを完全にオフボーディングしました。';
      }
      setModalResult(message);
      setNotice(message);
      void loadList(query);
      if (detailGuestId === actionGuest.id) {
        void loadDetail(actionGuest.id);
      }
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : 'ゲスト操作に失敗しました'
      );
    } finally {
      busyRef.current = false;
      setModalBusy(false);
    }
  }

  const exportQuery = buildAdminGuestQuery({
    ...query,
    offset: 0,
    limit: 200,
    format: 'json',
  });
  const csvQuery = buildAdminGuestQuery({
    ...query,
    offset: 0,
    limit: 200,
    format: 'csv',
  });

  return (
    <section
      id="admin-guests"
      data-testid="admin-guests-section"
      aria-labelledby={`${baseId}-heading`}
      className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <UserCheck className="mt-0.5 h-4 w-4 text-[#5e6ad2]" aria-hidden="true" />
          <div>
            <h2
              id={`${baseId}-heading`}
              className="text-[0.875rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              ゲスト管理・ライフサイクル監査
            </h2>
            <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
              外部ゲストの検索・集計・停止/再開・招待再送・完全オフボーディング・共有アイテム監査を一元管理します。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="guest-show-audit-logs"
            onClick={onShowAuditLogs}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            ゲスト監査ログを表示
          </button>
          <a
            data-testid="guest-export-csv"
            href={`/api/admin/guests${csvQuery}`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
          >
            <Download className="h-3 w-3" aria-hidden="true" />
            CSV
          </a>
          <a
            data-testid="guest-export-json"
            href={`/api/admin/guests${exportQuery}`}
            download
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
          >
            <FileSpreadsheet className="h-3 w-3" aria-hidden="true" />
            JSON
          </a>
          <button
            type="button"
            onClick={() => void loadList(query)}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            再読み込み
          </button>
        </div>
      </header>

      <p
        id={`${baseId}-rbac`}
        data-testid="guest-rbac-notice"
        className={`mb-4 rounded-xl border px-3 py-2 text-[0.6875rem] ${
          canManage
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}
      >
        {guestLifecyclePermissionNotice(role)}
      </p>

      <p role="status" className="sr-only">
        {sortAnnouncement}
      </p>

      <AdminGuestSummarySection
        statusCards={statusCards}
        domainRows={domainRows}
        inviterRows={inviterRows}
      />

      <AdminGuestFilterBar
        draft={draft}
        setDraft={setDraft}
        onApply={applyFilters}
        onReset={resetFilters}
      />

      {error && (
        <div
          role="alert"
          className="mb-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div
        role="region"
        aria-label="ゲスト一覧"
        tabIndex={0}
        className="overflow-x-auto rounded-xl border border-[#e7e7ea]"
      >
        <table
          data-testid="admin-guests-table"
          className="w-full min-w-[62rem] border-collapse text-left text-[0.6875rem]"
        >
          <caption className="sr-only">
            テナント内の外部ゲスト。列ヘッダのボタンで並べ替えできます。
          </caption>
          <thead className="bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
            <tr>
              {(
                [
                  ['email', 'メール'],
                  ['externalOrg', '外部組織'],
                  ['createdAt', '作成日時'],
                  ['lastLoginAt', '最終ログイン'],
                  ['expiresAt', '有効期限'],
                ] as Array<[AdminGuestSortBy, string]>
              ).map(([column, label]) => (
                <th
                  key={column}
                  scope="col"
                  aria-sort={ariaSortForGuestColumn(
                    query.sortBy ?? 'createdAt',
                    query.sortDir ?? 'desc',
                    column
                  )}
                  className="p-0 font-medium"
                >
                  <button
                    type="button"
                    data-testid={`guest-sort-${column}`}
                    onClick={() => handleSort(column)}
                    className="flex min-h-6 w-full items-center px-2.5 py-2 text-left font-medium hover:bg-[#eaeaee] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#5e6ad2]"
                  >
                    {label}
                  </button>
                </th>
              ))}
              <th scope="col" className="px-2.5 py-2 font-medium">ステータス</th>
              <th scope="col" className="px-2.5 py-2 font-medium">ドメイン</th>
              <th scope="col" className="px-2.5 py-2 font-medium">招待者</th>
              <th scope="col" className="px-2.5 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && displayGuests.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-[#55565a]">
                  <Loader2 className="mx-auto mb-1 h-4 w-4 animate-spin" aria-hidden="true" />
                  ゲスト一覧を読み込み中...
                </td>
              </tr>
            ) : displayGuests.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-8 text-center text-[#55565a]">
                  条件に一致するゲストはいません。
                </td>
              </tr>
            ) : (
              displayGuests.map((guest) => (
                <tr
                  key={guest.id}
                  data-testid="admin-guest-row"
                  data-guest-id={guest.id}
                  className={`border-t border-[#f2f2f4] align-top ${
                    guest.offboardedAt ? 'bg-slate-50/70' : ''
                  }`}
                >
                  <td className="px-2.5 py-2">
                    <button
                      type="button"
                      data-testid="guest-open-detail"
                      onClick={() => void openDetail(guest.id)}
                      className="text-left font-medium text-[#2f4f9e] underline-offset-2 hover:underline"
                    >
                      {guest.email}
                    </button>
                    <span className="mt-0.5 block text-[0.625rem] text-[#55565a]">
                      {guest.displayName}
                    </span>
                  </td>
                  <td className="px-2.5 py-2 text-[#3c3f46]">
                    {guest.externalOrg ?? '—'}
                  </td>
                  <td className="px-2.5 py-2 text-[#3c3f46]">
                    <time dateTime={guest.createdAt}>
                      {formatAuditDateTime(guest.createdAt)}
                    </time>
                  </td>
                  <td className="px-2.5 py-2 text-[#3c3f46]">
                    {guest.lastLoginAt ? (
                      <time dateTime={guest.lastLoginAt}>
                        {formatAuditDateTime(guest.lastLoginAt)}
                      </time>
                    ) : (
                      '未ログイン'
                    )}
                  </td>
                  <td className="px-2.5 py-2 text-[#3c3f46]">
                    {guest.expiresAt ? (
                      <time dateTime={guest.expiresAt}>
                        {formatAuditDateTime(guest.expiresAt)}
                      </time>
                    ) : (
                      '無期限'
                    )}
                  </td>
                  <td className="px-2.5 py-2">
                    <GuestStatusBadge status={guest.status} />
                  </td>
                  <td className="px-2.5 py-2">
                    <span className="block font-mono text-[0.625rem] text-[#3c3f46]">
                      {guest.domain ?? '—'}
                    </span>
                    {guest.allowedByPolicy ? (
                      <span className="mt-0.5 inline-flex rounded-full bg-emerald-50 px-1.5 text-[0.5625rem] font-medium text-emerald-700">
                        許可済み
                      </span>
                    ) : (
                      <span className="mt-0.5 inline-flex rounded-full bg-red-50 px-1.5 text-[0.5625rem] font-medium text-red-700">
                        許可外
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 py-2 text-[#3c3f46]">
                    <span className="block">{guest.invitedByName ?? '—'}</span>
                    <span className="block text-[0.5625rem] text-[#55565a]">
                      {guest.invitedByEmail ?? guest.invitedBy ?? ''}
                    </span>
                  </td>
                  <td className="px-2.5 py-2">
                    <div className="flex flex-wrap gap-1">
                      <button
                        type="button"
                        data-testid="guest-action-suspend"
                        disabled={
                          !canSuspend ||
                          guest.status === 'suspended' ||
                          guest.status === 'offboarded'
                        }
                        aria-describedby={`${baseId}-rbac`}
                        onClick={() => openAction('suspend', guest)}
                        className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <UserX className="h-2.5 w-2.5" aria-hidden="true" />
                        停止
                      </button>
                      <button
                        type="button"
                        data-testid="guest-action-resume"
                        disabled={!canManage || guest.status !== 'suspended'}
                        aria-describedby={`${baseId}-rbac`}
                        onClick={() => openAction('resume', guest)}
                        className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <UserCheck className="h-2.5 w-2.5" aria-hidden="true" />
                        再開
                      </button>
                      <button
                        type="button"
                        data-testid="guest-action-resend"
                        disabled={
                          !canManage ||
                          guest.status === 'offboarded' ||
                          guest.pendingInvitationCount === 0
                        }
                        aria-describedby={`${baseId}-rbac`}
                        onClick={() => openAction('resend', guest)}
                        className="inline-flex items-center gap-1 rounded border border-blue-300 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-blue-800 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <RefreshCw className="h-2.5 w-2.5" aria-hidden="true" />
                        再送
                      </button>
                      <button
                        type="button"
                        data-testid="guest-action-offboard"
                        disabled={!canManage || Boolean(guest.offboardedAt)}
                        aria-describedby={`${baseId}-rbac`}
                        onClick={() => openAction('offboard', guest)}
                        className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
                        完全削除
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[0.6875rem] text-[#55565a]">
        <span>
          {data
            ? `全 ${data.total} 件中 ${data.offset + 1}〜${
                data.offset + displayGuests.length
              } 件`
            : '—'}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!data || query.offset === 0 || loading}
            onClick={() => changePage((query.offset ?? 0) - PAGE_SIZE)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2 font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-40"
          >
            <ChevronLeft className="h-3 w-3" aria-hidden="true" />
            前へ
          </button>
          <button
            type="button"
            data-testid="guest-page-next"
            disabled={!data?.nextOffset || loading}
            onClick={() => changePage(data?.nextOffset ?? 0)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2 font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-40"
          >
            次へ
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>

      {detailGuestId && (
        <AdminGuestDetailModal
          detailGuestId={detailGuestId}
          detail={detail}
          detailLoading={detailLoading}
          detailError={detailError}
          baseId={baseId}
          canSuspend={canSuspend}
          canManage={canManage}
          onClose={closeDetail}
          onOpenAction={openAction}
        />
      )}

      {action && actionGuest && (
        <AdminGuestActionModal
          action={action}
          actionGuest={actionGuest}
          modalBusy={modalBusy}
          modalError={modalError}
          modalResult={modalResult}
          extendDays={extendDays}
          onExtendDaysChange={setExtendDays}
          onClose={closeActionModal}
          onExecute={() => void executeAction()}
        />
      )}
    </section>
  );
}
