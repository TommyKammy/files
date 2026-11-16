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
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserX,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  ADMIN_GUEST_SORT_LABELS,
  ariaSortForGuestColumn,
  buildAdminGuestQuery,
  buildGuestDetailExportHref,
  canManageGuestLifecycle,
  canSuspendGuest,
  canViewAdminGuests,
  createGuestIdempotencyKey,
  filterAdminGuests,
  formatGuestDomainSummary,
  formatGuestInviterSummary,
  guestLifecyclePermissionNotice,
  guestStatusBadgeClass,
  guestStatusLabel,
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
  AdminGuestLifecycleStatus,
  AdminGuestListQuery,
  AdminGuestListResponse,
  AdminGuestRow,
  AdminGuestSortBy,
  AdminGuestStatusFilter,
  AuthUser,
} from '@/types/files';

type GuestAction = 'suspend' | 'resume' | 'resend' | 'offboard';

interface ActionGuest {
  id: string;
  email: string;
  status: AdminGuestLifecycleStatus;
  offboardedAt: string | null;
  pendingInvitationCount?: number;
}

const PAGE_SIZE = 25;

const DEFAULT_QUERY: AdminGuestListQuery = {
  status: 'all',
  sortBy: 'createdAt',
  sortDir: 'desc',
  limit: PAGE_SIZE,
  offset: 0,
};

interface DraftFilters {
  query: string;
  status: AdminGuestStatusFilter;
  domain: string;
  invitedBy: string;
  expiresBefore: string;
}

const DEFAULT_DRAFT: DraftFilters = {
  query: '',
  status: 'all',
  domain: '',
  invitedBy: '',
  expiresBefore: '',
};

const ACTION_TITLES: Record<GuestAction, string> = {
  suspend: 'ゲストを停止しますか？',
  resume: 'ゲストアカウントを再開しますか？',
  resend: '招待メールを再送しますか？',
  offboard: 'ゲストを完全にオフボーディングしますか？',
};

const ACTION_EXPLANATIONS: Record<GuestAction, string> = {
  suspend:
    '対象ゲストを suspended にし、すべての有効セッションを即時失効させます。監査ログ admin.guest.suspend と同期通知を記録します。',
  resume:
    '停止中のゲストを再び有効化します。期限切れの場合は延長日数が必要です。監査ログ admin.guest.resume を記録します。',
  resend:
    '最新の保留中招待のトークンをローテートして再送します。以前の招待 URL は無効になります。',
  offboard:
    'セッション・招待・OTP・権限を原子的に無効化し、users 行は FK 整合性のため保持したまま再ログイン・再開を恒久拒否します。',
};

function GuestStatusBadge({ status }: { status: AdminGuestLifecycleStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${guestStatusBadgeClass(
        status
      )}`}
    >
      {guestStatusLabel(status)}
    </span>
  );
}

function DlpBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[0.5625rem] font-semibold text-purple-800">
      <ShieldCheck className="h-3 w-3" aria-hidden="true" />
      DLP 保護: メタデータのみ
    </span>
  );
}

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
  const [draft, setDraft] = useState<DraftFilters>(DEFAULT_DRAFT);
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

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {statusCards.map((card) => (
          <div
            key={card.status}
            data-testid={`guest-summary-status-${card.status}`}
            className="rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] px-3 py-2"
          >
            <p className="text-[0.625rem] text-[#55565a]">{card.label}</p>
            <p className="text-[1rem] font-semibold text-[#111214]">
              {card.count}
              <span className="ml-1 text-[0.625rem] font-normal text-[#55565a]">
                件
              </span>
            </p>
          </div>
        ))}
      </div>

      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-[#111214]">
            <ShieldAlert className="h-3.5 w-3.5 text-[#5e6ad2]" aria-hidden="true" />
            ドメイン別集計
          </h3>
          <div
            role="region"
            aria-label="ゲストのドメイン別集計"
            tabIndex={0}
            className="max-h-56 overflow-auto rounded-xl border border-[#e7e7ea]"
          >
            <table className="w-full text-left text-[0.6875rem]">
              <caption className="sr-only">
                ゲストのドメイン別件数・状態・許可リスト適合
              </caption>
              <thead className="sticky top-0 bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">ドメイン</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">件数</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">有効</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">停止</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">期限切れ</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">ポリシー</th>
                </tr>
              </thead>
              <tbody>
                {domainRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-2 py-3 text-center text-[#55565a]">
                      ドメイン集計はありません。
                    </td>
                  </tr>
                ) : (
                  domainRows.map((row) => (
                    <tr
                      key={row.domain}
                      data-testid="guest-domain-summary-row"
                      className="border-t border-[#f2f2f4]"
                    >
                      <td className="px-2 py-1.5 font-mono text-[0.625rem] text-[#111214]">
                        {row.domain}
                      </td>
                      <td className="px-2 py-1.5 text-[#3c3f46]">{row.count}</td>
                      <td className="px-2 py-1.5 text-emerald-700">{row.active}</td>
                      <td className="px-2 py-1.5 text-red-700">{row.suspended}</td>
                      <td className="px-2 py-1.5 text-amber-800">{row.expired}</td>
                      <td className="px-2 py-1.5">
                        <span
                          title={row.warning ?? undefined}
                          className={`inline-flex rounded-full border px-1.5 py-0.5 text-[0.5625rem] font-semibold ${
                            row.allowedByPolicy
                              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              : 'border-red-200 bg-red-50 text-red-800'
                          }`}
                        >
                          {row.statusLabel}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-[#111214]">
            <UserCheck className="h-3.5 w-3.5 text-[#5e6ad2]" aria-hidden="true" />
            招待者別集計
          </h3>
          <div
            role="region"
            aria-label="ゲストの招待者別集計"
            tabIndex={0}
            className="max-h-56 overflow-auto rounded-xl border border-[#e7e7ea]"
          >
            <table className="w-full text-left text-[0.6875rem]">
              <caption className="sr-only">
                ゲストの招待者別件数・状態
              </caption>
              <thead className="sticky top-0 bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">招待者</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">件数</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">有効</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">停止</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">期限切れ</th>
                </tr>
              </thead>
              <tbody>
                {inviterRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-2 py-3 text-center text-[#55565a]">
                      招待者集計はありません。
                    </td>
                  </tr>
                ) : (
                  inviterRows.map((row) => (
                    <tr
                      key={row.inviterId}
                      data-testid="guest-inviter-summary-row"
                      className="border-t border-[#f2f2f4]"
                    >
                      <td className="px-2 py-1.5 text-[#111214]">{row.displayName}</td>
                      <td className="px-2 py-1.5 text-[#3c3f46]">{row.count}</td>
                      <td className="px-2 py-1.5 text-emerald-700">{row.active}</td>
                      <td className="px-2 py-1.5 text-red-700">{row.suspended}</td>
                      <td className="px-2 py-1.5 text-amber-800">{row.expired}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <search>
        <form
          aria-label="ゲスト一覧のフィルタ"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
          className="mb-3 grid gap-2 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3 md:grid-cols-2 lg:grid-cols-6"
        >
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            検索
            <input
              type="search"
              name="guestQuery"
              data-testid="guest-filter-query"
              value={draft.query}
              onChange={(event) =>
                setDraft((current) => ({ ...current, query: event.target.value }))
              }
              placeholder="メール / 表示名 / 組織 / ID"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            />
          </label>
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            ステータス
            <select
              name="guestStatus"
              data-testid="guest-filter-status"
              value={draft.status}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  status: event.target.value as AdminGuestStatusFilter,
                }))
              }
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            >
              <option value="all">すべて</option>
              <option value="active">有効</option>
              <option value="pending_invite">招待中</option>
              <option value="expired">期限切れ</option>
              <option value="suspended">停止中</option>
              <option value="offboarded">オフボーディング済み</option>
            </select>
          </label>
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            ドメイン
            <input
              type="text"
              name="guestDomain"
              data-testid="guest-filter-domain"
              value={draft.domain}
              onChange={(event) =>
                setDraft((current) => ({ ...current, domain: event.target.value }))
              }
              placeholder="partner.example"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            />
          </label>
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            招待者
            <input
              type="text"
              name="guestInvitedBy"
              data-testid="guest-filter-invited-by"
              value={draft.invitedBy}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  invitedBy: event.target.value,
                }))
              }
              placeholder="ID / メール / 表示名"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            />
          </label>
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            期限日 (以前)
            <input
              type="date"
              name="guestExpiresBefore"
              data-testid="guest-filter-expires-before"
              value={draft.expiresBefore}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  expiresBefore: event.target.value,
                }))
              }
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            />
          </label>
          <div className="flex items-end gap-1.5">
            <button
              type="submit"
              data-testid="guest-filter-apply"
              className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2]"
            >
              <Search className="h-3.5 w-3.5" aria-hidden="true" />
              絞り込む
            </button>
            <button
              type="button"
              data-testid="guest-filter-reset"
              onClick={resetFilters}
              className="inline-flex h-8 items-center justify-center rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">フィルタをリセット</span>
            </button>
          </div>
        </form>
      </search>

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
        <ModalShell
          label="ゲスト詳細"
          labelledBy={`${baseId}-detail-heading`}
          onClose={closeDetail}
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
                onClick={closeDetail}
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
                      onClick={() => openAction('suspend', detail.guest)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-[0.6875rem] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-40"
                    >
                      停止
                    </button>
                    <button
                      type="button"
                      data-testid="guest-action-resume"
                      disabled={!canManage || detail.guest.status !== 'suspended'}
                      aria-describedby={`${baseId}-rbac`}
                      onClick={() => openAction('resume', detail.guest)}
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
                      onClick={() => openAction('resend', detail.guest)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-blue-300 bg-white px-2.5 text-[0.6875rem] font-medium text-blue-800 hover:bg-blue-50 disabled:opacity-40"
                    >
                      招待再送
                    </button>
                    <button
                      type="button"
                      data-testid="guest-action-offboard"
                      disabled={!canManage || Boolean(detail.guest.offboardedAt)}
                      aria-describedby={`${baseId}-rbac`}
                      onClick={() => openAction('offboard', detail.guest)}
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
      )}

      {action && actionGuest && (
        <ModalShell
          label={ACTION_TITLES[action]}
          onClose={closeActionModal}
          className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <div data-testid="guest-confirm-modal" className="space-y-3 px-5 py-4">
            <div className="flex items-start gap-2">
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                  action === 'offboard'
                    ? 'bg-red-50 text-red-700'
                    : action === 'suspend'
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-blue-50 text-blue-700'
                }`}
              >
                {action === 'offboard' ? (
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                ) : action === 'suspend' ? (
                  <UserX className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <UserCheck className="h-4 w-4" aria-hidden="true" />
                )}
              </span>
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  {ACTION_TITLES[action]}
                </h3>
                <p className="mt-0.5 text-[0.6875rem] text-slate-500">
                  対象: {actionGuest.email}
                </p>
              </div>
            </div>
            <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-700">
              {ACTION_EXPLANATIONS[action]}
            </p>
            {action === 'resume' && (
              <label className="block text-[0.6875rem] font-medium text-slate-700">
                有効期限の延長日数
                <input
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  required
                  value={extendDays}
                  disabled={modalBusy}
                  onChange={(event) => setExtendDays(event.target.value)}
                  className="mt-1 h-8 w-32 rounded-md border border-slate-300 px-2 text-xs"
                />
                <span className="mt-0.5 block text-[0.625rem] font-normal text-slate-500">
                  1〜3650 日。期限切れのゲストは延長しない限り再開できません。
                </span>
              </label>
            )}
            {modalError && (
              <div
                role="alert"
                data-testid="guest-confirm-error"
                className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
              >
                {modalError}
              </div>
            )}
            {modalResult && (
              <div
                role="status"
                data-testid="guest-confirm-result"
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
              >
                {modalResult}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                data-autofocus
                data-testid="guest-confirm-cancel"
                disabled={modalBusy}
                onClick={closeActionModal}
                className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                {modalResult ? '閉じる' : 'キャンセル'}
              </button>
              {!modalResult && (
                <button
                  type="button"
                  data-testid="guest-confirm-execute"
                  disabled={modalBusy}
                  onClick={() => void executeAction()}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3.5 text-xs font-semibold text-white disabled:opacity-50 ${
                    action === 'offboard'
                      ? 'bg-red-600 hover:bg-red-700'
                      : 'bg-[#5e6ad2] hover:bg-[#4f5ac2]'
                  }`}
                >
                  {modalBusy && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  )}
                  実行する
                </button>
              )}
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
