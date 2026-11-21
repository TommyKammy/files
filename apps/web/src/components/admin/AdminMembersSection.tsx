'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Upload,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  UserX,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AdminMemberOffboardingModal } from '@/components/admin/AdminMemberOffboardingModal';
import {
  AdminMemberActionModal,
  type MemberAction,
} from '@/components/admin/members/AdminMemberActionModal';
import {
  MemberRoleBadge,
  MemberStatusBadge,
} from '@/components/admin/members/AdminMemberBadges';
import { AdminMemberCreateModal } from '@/components/admin/members/AdminMemberCreateModal';
import { AdminMemberDetailDrawer } from '@/components/admin/members/AdminMemberDetailDrawer';
import { AdminMembersCsvImportModal } from '@/components/admin/members/AdminMembersCsvImportModal';
import {
  memberCanOpenOffboarding,
  memberOffboardingOpenGuardReason,
} from '@/lib/admin-offboarding';
import {
  ADMIN_MEMBER_SORT_LABELS,
  ariaSortForMemberColumn,
  buildAdminMemberQuery,
  canAdministrateMembers,
  canViewAdminMembers,
  departmentLabel,
  filterAdminMembers,
  formatMemberUsage,
  memberCanBeResumed,
  memberCanBeSuspended,
  memberPermissionNotice,
  memberQuotaState,
  memberRoleSummaryCards,
  memberStatusSummaryCards,
  sortAdminMemberRows,
  toggleAdminMemberSort,
} from '@/lib/admin-users';
import { ApiClientError, fetchAdminMembers } from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminMemberListQuery,
  AdminMemberListResponse,
  AdminMemberRoleFilter,
  AdminMemberRow,
  AdminMemberSortBy,
  AdminMemberStatusFilter,
  AdminOffboardingResponse,
  AuthUser,
} from '@/types/files';

const PAGE_SIZE = 25;

const DEFAULT_QUERY: AdminMemberListQuery = {
  role: 'all',
  status: 'all',
  sortBy: 'createdAt',
  sortDir: 'desc',
  limit: PAGE_SIZE,
  offset: 0,
};

interface DraftFilters {
  query: string;
  role: AdminMemberRoleFilter;
  status: AdminMemberStatusFilter;
  department: string;
}

const DEFAULT_DRAFT: DraftFilters = {
  query: '',
  role: 'all',
  status: 'all',
  department: '',
};

export function AdminMembersSection({
  user,
  onShowAuditLogs,
}: {
  user: AuthUser | null;
  onShowAuditLogs?: () => void;
}) {
  const baseId = useId();
  const role = user?.role;
  const canView = canViewAdminMembers(role, user?.adminCapabilities);
  const canAdministrate = canAdministrateMembers(role);

  const [query, setQuery] = useState<AdminMemberListQuery>(DEFAULT_QUERY);
  const [draft, setDraft] = useState<DraftFilters>(DEFAULT_DRAFT);
  const [data, setData] = useState<AdminMemberListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const [detailMemberId, setDetailMemberId] = useState<string | null>(null);
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [action, setAction] = useState<MemberAction | null>(null);
  const [actionMember, setActionMember] = useState<AdminMemberRow | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [offboardingMember, setOffboardingMember] =
    useState<AdminMemberRow | null>(null);

  const activeSysAdminCount =
    data?.summary.activeSysAdminCount ?? data?.summary.byRole.sys_admin ?? 0;

  const loadList = useCallback(
    async (nextQuery: AdminMemberListQuery) => {
      if (!canView) return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      try {
        const response = await fetchAdminMembers(nextQuery);
        if (requestIdRef.current !== requestId) return;
        setData(response);
        setError(null);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'メンバー一覧の読み込みに失敗しました'
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

  const displayMembers = useMemo(() => {
    const rows = data?.users ?? [];
    return sortAdminMemberRows(
      filterAdminMembers(rows, {
        query: query.query,
        role: query.role,
        status: query.status,
        department: query.department,
      }),
      query.sortBy ?? 'createdAt',
      query.sortDir ?? 'desc'
    );
  }, [data?.users, query]);

  const statusCards = useMemo(
    () => memberStatusSummaryCards(data?.summary),
    [data?.summary]
  );
  const roleCards = useMemo(
    () => memberRoleSummaryCards(data?.summary),
    [data?.summary]
  );
  const departments = useMemo(
    () => data?.summary.departments ?? [],
    [data?.summary.departments]
  );
  const departmentOptions = useMemo(
    () => departments.filter((item) => item.department),
    [departments]
  );

  const sortAnnouncement = useMemo(() => {
    if (!data) return 'メンバー一覧を読み込み中';
    const by = ADMIN_MEMBER_SORT_LABELS[query.sortBy ?? 'createdAt'];
    const dir = query.sortDir === 'asc' ? '昇順' : '降順';
    return `${data.total} 件中 ${displayMembers.length} 件を表示、${by}の${dir}で並べ替え`;
  }, [data, displayMembers.length, query.sortBy, query.sortDir]);

  if (!canView) {
    return null;
  }

  function applyFilters() {
    setQuery((current) => ({
      ...current,
      query: draft.query.trim() || undefined,
      role: draft.role,
      status: draft.status,
      department: draft.department.trim() || undefined,
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

  function handleSort(sortBy: AdminMemberSortBy) {
    setQuery((current) => ({
      ...current,
      ...toggleAdminMemberSort(
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

  function openDetail(memberId: string) {
    setDetailMemberId(memberId);
  }

  function closeDetail() {
    setDetailMemberId(null);
  }

  function openCreate() {
    if (!canAdministrate) return;
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
  }

  function handleCreated(nextNotice: string | null) {
    setNotice(nextNotice);
    void loadList(query);
  }

  function handleDetailUpdated(nextNotice: string | null) {
    setNotice(nextNotice);
    void loadList(query);
  }

  function openAction(nextAction: MemberAction, member: AdminMemberRow) {
    if (
      nextAction === 'suspend'
        ? !memberCanBeSuspended(role, user?.id, member, user?.adminCapabilities)
        : !memberCanBeResumed(role, user?.id, member, user?.adminCapabilities)
    ) {
      return;
    }
    setAction(nextAction);
    setActionMember(member);
  }

  function closeActionModal() {
    setAction(null);
    setActionMember(null);
  }

  function handleActionCompleted(message: string, memberId: string) {
    setNotice(message);
    void loadList(query);
    if (detailMemberId === memberId) {
      setDetailRefreshToken((value) => value + 1);
    }
  }

  function offboardingGuard(member: AdminMemberRow): string | null {
    return memberOffboardingOpenGuardReason({
      viewerRole: role,
      viewerId: user?.id,
      member,
      activeSysAdminCount,
    });
  }

  function openOffboarding(member: AdminMemberRow) {
    if (
      !memberCanOpenOffboarding({
        viewerRole: role,
        viewerId: user?.id,
        member,
        activeSysAdminCount,
      })
    ) {
      return;
    }
    // The offboarding wizard owns the modal surface; close the detail drawer
    // first so two native <dialog> elements never stack.
    if (detailMemberId) {
      setDetailMemberId(null);
    }
    setOffboardingMember(member);
  }

  function closeOffboarding() {
    setOffboardingMember(null);
  }

  function handleOffboardingCompleted(result: AdminOffboardingResponse) {
    setNotice(result.notice);
    void loadList(query);
  }

  function openBulk() {
    if (!canAdministrate) return;
    setBulkOpen(true);
  }

  function closeBulk() {
    setBulkOpen(false);
  }

  function handleBulkImported(nextNotice: string | null) {
    setNotice(nextNotice);
    void loadList(query);
  }

  const csvQuery = buildAdminMemberQuery({
    ...query,
    offset: 0,
    limit: 200,
    format: 'csv',
  });

  return (
    <section
      id="admin-members"
      data-testid="admin-members-section"
      aria-labelledby={`${baseId}-heading`}
      className="rounded-2xl border border-[#e7e7ea] bg-white p-5 shadow-xs"
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Users className="mt-0.5 h-4 w-4 text-[#5e6ad2]" aria-hidden="true" />
          <div>
            <h2
              id={`${baseId}-heading`}
              className="text-[0.875rem] font-semibold tracking-[-0.01em] text-[#111214]"
            >
              社内メンバー管理
            </h2>
            <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
              社内メンバーの検索・ロール/部署/個人クォータ管理・停止/再開・CSV
              一括登録を一元管理します。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="member-show-audit-logs"
            onClick={onShowAuditLogs}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            メンバー監査ログを表示
          </button>
          <a
            data-testid="member-export-csv"
            href={`/api/admin/users${csvQuery}`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
          >
            <Download className="h-3 w-3" aria-hidden="true" />
            CSV
          </a>
          <button
            type="button"
            data-testid="member-open-bulk-import"
            onClick={openBulk}
            disabled={!canAdministrate}
            title={
              canAdministrate
                ? 'CSV 一括登録'
                : 'CSV 一括登録は sys_admin 専用です'
            }
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Upload className="h-3 w-3" aria-hidden="true" />
            CSV 一括登録
          </button>
          <button
            type="button"
            data-testid="member-open-create"
            onClick={openCreate}
            disabled={!canAdministrate}
            title={
              canAdministrate
                ? 'メンバーを追加'
                : 'メンバー追加は sys_admin 専用です'
            }
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <UserPlus className="h-3 w-3" aria-hidden="true" />
            メンバー追加
          </button>
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
        data-testid="member-rbac-notice"
        className={`mb-4 rounded-xl border px-3 py-2 text-[0.6875rem] ${
          canAdministrate
            ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
            : 'border-amber-200 bg-amber-50 text-amber-900'
        }`}
      >
        {memberPermissionNotice(role, user?.adminCapabilities)}
      </p>

      <p role="status" className="sr-only">
        {sortAnnouncement}
      </p>

      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {statusCards.map((card) => (
          <div
            key={`status-${card.status}`}
            data-testid={`member-summary-status-${card.status}`}
            className="rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] px-3 py-2"
          >
            <p className="text-[0.625rem] text-[#55565a]">{card.label}</p>
            <p className="text-[1rem] font-semibold text-[#111214]">
              {card.count}
              <span className="ml-1 text-[0.625rem] font-normal text-[#55565a]">
                人
              </span>
            </p>
          </div>
        ))}
        {roleCards.map((card) => (
          <div
            key={`role-${card.role}`}
            data-testid={`member-summary-role-${card.role}`}
            className="rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] px-3 py-2"
          >
            <p className="text-[0.625rem] text-[#55565a]">{card.label}</p>
            <p className="text-[1rem] font-semibold text-[#111214]">
              {card.count}
              <span className="ml-1 text-[0.625rem] font-normal text-[#55565a]">
                人
              </span>
            </p>
          </div>
        ))}
      </div>

      {departments.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[0.75rem] font-semibold text-[#111214]">
            <Users className="h-3.5 w-3.5 text-[#5e6ad2]" aria-hidden="true" />
            部署別集計
          </h3>
          <div
            role="region"
            aria-label="メンバーの部署別集計"
            tabIndex={0}
            className="max-h-44 overflow-auto rounded-xl border border-[#e7e7ea]"
          >
            <table className="w-full text-left text-[0.6875rem]">
              <caption className="sr-only">メンバーの部署別人数</caption>
              <thead className="sticky top-0 bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
                <tr>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    部署
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    人数
                  </th>
                </tr>
              </thead>
              <tbody>
                {departments.map((row) => (
                  <tr
                    key={row.department ?? 'unset'}
                    data-testid="member-department-row"
                    className="border-t border-[#f2f2f4]"
                  >
                    <td className="px-2 py-1.5 text-[#111214]">
                      {departmentLabel(row.department)}
                    </td>
                    <td className="px-2 py-1.5 text-[#3c3f46]">
                      {row.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <search>
        <form
          aria-label="メンバー一覧のフィルタ"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
          className="mb-3 grid gap-2 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3 md:grid-cols-2 lg:grid-cols-5"
        >
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            検索
            <input
              type="search"
              name="memberQuery"
              data-testid="member-filter-query"
              value={draft.query}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  query: event.target.value,
                }))
              }
              placeholder="メール / 表示名 / 部署 / ID"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            />
          </label>
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            ロール
            <select
              name="memberRole"
              data-testid="member-filter-role"
              value={draft.role}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  role: event.target.value as AdminMemberRoleFilter,
                }))
              }
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            >
              <option value="all">すべて</option>
              <option value="sys_admin">システム管理者</option>
              <option value="sec_admin">セキュリティ管理者</option>
              <option value="member">メンバー</option>
            </select>
          </label>
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            状態
            <select
              name="memberStatus"
              data-testid="member-filter-status"
              value={draft.status}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  status: event.target.value as AdminMemberStatusFilter,
                }))
              }
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            >
              <option value="all">すべて</option>
              <option value="active">有効</option>
              <option value="suspended">停止中</option>
            </select>
          </label>
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            部署
            <select
              name="memberDepartment"
              data-testid="member-filter-department"
              value={draft.department}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  department: event.target.value,
                }))
              }
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            >
              <option value="">すべて</option>
              {draft.department &&
                !departmentOptions.some(
                  (item) => item.department === draft.department
                ) && (
                  <option value={draft.department}>{draft.department}</option>
                )}
              {departmentOptions.map((item) => (
                <option key={item.department} value={item.department ?? ''}>
                  {departmentLabel(item.department)}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-1.5">
            <button
              type="submit"
              data-testid="member-filter-apply"
              className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2]"
            >
              <Search className="h-3.5 w-3.5" aria-hidden="true" />
              絞り込む
            </button>
            <button
              type="button"
              data-testid="member-filter-reset"
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
        aria-label="メンバー一覧"
        tabIndex={0}
        className="overflow-x-auto rounded-xl border border-[#e7e7ea]"
      >
        <table
          data-testid="admin-members-table"
          className="w-full min-w-[62rem] border-collapse text-left text-[0.6875rem]"
        >
          <caption className="sr-only">
            テナント内の社内メンバー。列ヘッダのボタンで並べ替えできます。
          </caption>
          <thead className="bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
            <tr>
              {(
                [
                  ['email', 'メール'],
                  ['displayName', '表示名'],
                  ['department', '部署'],
                ] as Array<[AdminMemberSortBy, string]>
              ).map(([column, label]) => (
                <th
                  key={column}
                  scope="col"
                  aria-sort={ariaSortForMemberColumn(
                    query.sortBy ?? 'createdAt',
                    query.sortDir ?? 'desc',
                    column
                  )}
                  className="p-0 font-medium"
                >
                  <button
                    type="button"
                    data-testid={`member-sort-${column}`}
                    onClick={() => handleSort(column)}
                    className="flex min-h-6 w-full items-center px-2.5 py-2 text-left font-medium hover:bg-[#eaeaee] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#5e6ad2]"
                  >
                    {label}
                  </button>
                </th>
              ))}
              <th scope="col" className="px-2.5 py-2 font-medium">
                ロール
              </th>
              <th scope="col" className="px-2.5 py-2 font-medium">
                状態
              </th>
              <th
                scope="col"
                aria-sort={ariaSortForMemberColumn(
                  query.sortBy ?? 'createdAt',
                  query.sortDir ?? 'desc',
                  'usedBytes'
                )}
                className="p-0 font-medium"
              >
                <button
                  type="button"
                  data-testid="member-sort-usedBytes"
                  onClick={() => handleSort('usedBytes')}
                  className="flex min-h-6 w-full items-center px-2.5 py-2 text-left font-medium hover:bg-[#eaeaee] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#5e6ad2]"
                >
                  使用量 / 上限
                </button>
              </th>
              <th
                scope="col"
                aria-sort={ariaSortForMemberColumn(
                  query.sortBy ?? 'createdAt',
                  query.sortDir ?? 'desc',
                  'lastLoginAt'
                )}
                className="p-0 font-medium"
              >
                <button
                  type="button"
                  data-testid="member-sort-lastLoginAt"
                  onClick={() => handleSort('lastLoginAt')}
                  className="flex min-h-6 w-full items-center px-2.5 py-2 text-left font-medium hover:bg-[#eaeaee] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#5e6ad2]"
                >
                  最終ログイン
                </button>
              </th>
              <th scope="col" className="px-2.5 py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && displayMembers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[#55565a]">
                  <Loader2
                    className="mx-auto mb-1 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                  メンバー一覧を読み込み中...
                </td>
              </tr>
            ) : displayMembers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[#55565a]">
                  条件に一致する社内メンバーはいません。
                </td>
              </tr>
            ) : (
              displayMembers.map((member) => {
                const quotaState = memberQuotaState(member);
                const offboardingReason = offboardingGuard(member);
                return (
                  <tr
                    key={member.id}
                    data-testid="admin-member-row"
                    data-member-id={member.id}
                    className={`border-t border-[#f2f2f4] align-top ${
                      member.status === 'suspended' ? 'bg-slate-50/70' : ''
                    }`}
                  >
                    <td className="px-2.5 py-2">
                      <button
                        type="button"
                        data-testid="member-open-detail"
                        onClick={() => void openDetail(member.id)}
                        className="text-left font-medium text-[#2f4f9e] underline-offset-2 hover:underline"
                      >
                        {member.email}
                      </button>
                      <span className="mt-0.5 block text-[0.625rem] text-[#55565a]">
                        {member.fileCount} ファイル
                      </span>
                    </td>
                    <td className="px-2.5 py-2 text-[#3c3f46]">
                      {member.displayName}
                    </td>
                    <td className="px-2.5 py-2 text-[#3c3f46]">
                      {member.department ?? '—'}
                    </td>
                    <td className="px-2.5 py-2">
                      <MemberRoleBadge role={member.role} />
                    </td>
                    <td className="px-2.5 py-2">
                      <MemberStatusBadge status={member.status} />
                    </td>
                    <td className="px-2.5 py-2">
                      <span
                        data-testid="member-usage"
                        className={`block font-mono text-[0.625rem] ${
                          quotaState === 'over'
                            ? 'text-red-700'
                            : quotaState === 'warning'
                              ? 'text-amber-800'
                              : 'text-[#3c3f46]'
                        }`}
                      >
                        {formatMemberUsage(member)}
                      </span>
                      {quotaState === 'over' && (
                        <span className="mt-0.5 inline-flex rounded-full bg-red-50 px-1.5 text-[0.5625rem] font-medium text-red-700">
                          上限超過
                        </span>
                      )}
                    </td>
                    <td className="px-2.5 py-2 text-[#3c3f46]">
                      {member.lastLoginAt ? (
                        <time dateTime={member.lastLoginAt}>
                          {formatAuditDateTime(member.lastLoginAt)}
                        </time>
                      ) : (
                        '未ログイン'
                      )}
                    </td>
                    <td className="px-2.5 py-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          data-testid="member-action-edit"
                          disabled={!canAdministrate}
                          aria-describedby={`${baseId}-rbac`}
                          onClick={() => void openDetail(member.id)}
                          className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          編集
                        </button>
                        <button
                          type="button"
                          data-testid="member-action-suspend"
                          disabled={
                            !memberCanBeSuspended(role, user?.id, member)
                          }
                          aria-describedby={`${baseId}-rbac`}
                          onClick={() => openAction('suspend', member)}
                          className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <UserX className="h-2.5 w-2.5" aria-hidden="true" />
                          停止
                        </button>
                        <button
                          type="button"
                          data-testid="member-action-resume"
                          disabled={!memberCanBeResumed(role, user?.id, member)}
                          aria-describedby={`${baseId}-rbac`}
                          onClick={() => openAction('resume', member)}
                          className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <UserCheck className="h-2.5 w-2.5" aria-hidden="true" />
                          再開
                        </button>
                        <button
                          type="button"
                          data-testid="member-action-offboard"
                          disabled={!memberCanOpenOffboarding({
                            viewerRole: role,
                            viewerId: user?.id,
                            member,
                            activeSysAdminCount,
                          })}
                          title={offboardingReason ?? '退職/移管 (オフボーディング)'}
                          aria-describedby={`${baseId}-rbac`}
                          onClick={() => openOffboarding(member)}
                          className="inline-flex items-center gap-1 rounded border border-rose-300 bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-rose-800 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <UserMinus className="h-2.5 w-2.5" aria-hidden="true" />
                          退職/移管
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[0.6875rem] text-[#55565a]">
        <span>
          {data
            ? `全 ${data.total} 件中 ${data.offset + 1}〜${
                data.offset + displayMembers.length
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
            data-testid="member-page-next"
            disabled={!data?.nextOffset || loading}
            onClick={() => changePage(data?.nextOffset ?? 0)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-[#e1e1e4] bg-white px-2 font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-40"
          >
            次へ
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      </div>

      {createOpen && (
        <AdminMemberCreateModal
          onClose={closeCreate}
          onCreated={handleCreated}
        />
      )}

      {detailMemberId && (
        <AdminMemberDetailDrawer
          memberId={detailMemberId}
          viewer={user}
          canAdministrate={canAdministrate}
          activeSysAdminCount={activeSysAdminCount}
          rbacNoticeId={`${baseId}-rbac`}
          refreshToken={detailRefreshToken}
          onClose={closeDetail}
          onUpdated={handleDetailUpdated}
          onRefreshList={() => void loadList(query)}
          onOpenAction={openAction}
          onOpenOffboarding={openOffboarding}
        />
      )}

      {action && actionMember && (
        <AdminMemberActionModal
          action={action}
          member={actionMember}
          onClose={closeActionModal}
          onCompleted={handleActionCompleted}
        />
      )}

      {bulkOpen && (
        <AdminMembersCsvImportModal
          onClose={closeBulk}
          onImported={handleBulkImported}
        />
      )}
      {offboardingMember && (
        <AdminMemberOffboardingModal
          member={offboardingMember}
          viewerId={user?.id ?? null}
          viewerRole={role ?? null}
          activeSysAdminCount={activeSysAdminCount}
          onClose={closeOffboarding}
          onCompleted={handleOffboardingCompleted}
        />
      )}
    </section>
  );
}
