'use client';

import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Folder,
  Loader2,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  UserX,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ModalShell } from '@/components/ModalShell';
import { AdminMemberOffboardingModal } from '@/components/admin/AdminMemberOffboardingModal';
import {
  memberCanOpenOffboarding,
  memberOffboardingOpenGuardReason,
} from '@/lib/admin-offboarding';
import {
  ADMIN_MEMBER_BULK_ACTION_LABELS,
  ADMIN_MEMBER_CSV_SAMPLE,
  ADMIN_MEMBER_ROLE_LABELS,
  ADMIN_MEMBER_SORT_LABELS,
  ariaSortForMemberColumn,
  buildAdminMemberQuery,
  bulkRowLabel,
  canAdministrateMembers,
  canViewAdminMembers,
  createMemberIdempotencyKey,
  departmentLabel,
  filterAdminMembers,
  formatBulkImportSummary,
  formatMemberUsage,
  formatOptionalBytes,
  memberCanBeResumed,
  memberCanBeSuspended,
  memberPermissionNotice,
  memberQuotaState,
  memberRoleBadgeClass,
  memberRoleSummaryCards,
  memberStatusBadgeClass,
  memberStatusSummaryCards,
  parseMemberQuotaInput,
  sortAdminMemberRows,
  toggleAdminMemberSort,
} from '@/lib/admin-users';
import {
  ADMIN_SESSION_USER_TYPE_LABELS,
  adminSessionTargetGuardReason,
  canRevokeAdminSession,
  shortAdminSessionId,
  validateAdminSessionReasonInput,
} from '@/lib/admin-sessions';
import {
  ApiClientError,
  bulkImportAdminMembers,
  createAdminMember,
  fetchAdminMemberDetail,
  fetchAdminMembers,
  fetchAdminSessions,
  resumeAdminMember,
  revokeAdminSession,
  revokeAdminUserSessions,
  suspendAdminMember,
  updateAdminMember,
} from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminMemberBulkImportResponse,
  AdminMemberDetailResponse,
  AdminMemberListQuery,
  AdminMemberListResponse,
  AdminMemberRoleFilter,
  AdminMemberRow,
  AdminMemberSortBy,
  AdminMemberStatusFilter,
  AdminMemberUpdateInput,
  AdminOffboardingResponse,
  AdminSessionRow,
  AuthUser,
  UserRole,
} from '@/types/files';

type MemberAction = 'suspend' | 'resume';

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

interface CreateFormState {
  email: string;
  displayName: string;
  department: string;
  role: UserRole;
  quota: string;
}

const DEFAULT_CREATE_FORM: CreateFormState = {
  email: '',
  displayName: '',
  department: '',
  role: 'member',
  quota: '',
};

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

function MemberStatusBadge({ status }: { status: AdminMemberRow['status'] }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${memberStatusBadgeClass(
        status
      )}`}
    >
      {status === 'active' ? '有効' : '停止中'}
    </span>
  );
}

function MemberRoleBadge({ role }: { role: UserRole }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${memberRoleBadgeClass(
        role
      )}`}
    >
      {ADMIN_MEMBER_ROLE_LABELS[role]}
    </span>
  );
}

export function AdminMembersSection({
  user,
  onShowAuditLogs,
}: {
  user: AuthUser | null;
  onShowAuditLogs?: () => void;
}) {
  const baseId = useId();
  const role = user?.role;
  const canView = canViewAdminMembers(role);
  const canAdministrate = canAdministrateMembers(role);

  const [query, setQuery] = useState<AdminMemberListQuery>(DEFAULT_QUERY);
  const [draft, setDraft] = useState<DraftFilters>(DEFAULT_DRAFT);
  const [data, setData] = useState<AdminMemberListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const [detailMemberId, setDetailMemberId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminMemberDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
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

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] =
    useState<CreateFormState>(DEFAULT_CREATE_FORM);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<string | null>(null);

  const [action, setAction] = useState<MemberAction | null>(null);
  const [actionMember, setActionMember] = useState<AdminMemberRow | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalResult, setModalResult] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const busyRef = useRef(false);

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCsv, setBulkCsv] = useState(ADMIN_MEMBER_CSV_SAMPLE);
  const [bulkKey, setBulkKey] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] =
    useState<AdminMemberBulkImportResponse | null>(null);

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
    if (!detailMemberId) {
      setMemberSessions([]);
      setMemberSessionsError(null);
      setPendingMemberSession(null);
      setMemberSessionAllOpen(false);
      setMemberSessionAllResult(null);
      return;
    }
    let cancelled = false;
    setMemberSessionsLoading(true);
    setMemberSessionsError(null);
    setPendingMemberSession(null);
    setMemberSessionAllOpen(false);
    setMemberSessionReason('');
    fetchAdminSessions({ userId: detailMemberId, limit: 100 })
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
  }, [detailMemberId, memberSessionsReloadToken]);

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

  async function openDetail(memberId: string) {
    setDetailMemberId(memberId);
    setDetail(null);
    setDetailError(null);
    setEditError(null);
    setEditResult(null);
    setMemberSessionsNotice(null);
    setMemberSessionAllResult(null);
    setMemberSessionsError(null);
    setDetailLoading(true);
    try {
      const response = await fetchAdminMemberDetail(memberId);
      setDetail(response);
    } catch (err) {
      setDetailError(
        err instanceof ApiClientError
          ? err.message
          : 'メンバー詳細の読み込みに失敗しました'
      );
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    if (editBusy) return;
    setDetailMemberId(null);
    setDetail(null);
    setDetailError(null);
    setEditError(null);
    setEditResult(null);
    setMemberSessionsNotice(null);
    setMemberSessionAllResult(null);
  }

  const memberSessionGuard = detail
    ? adminSessionTargetGuardReason(role, detail.user.role)
    : null;
  const canRevokeMemberSessions = detail
    ? canRevokeAdminSession(role, detail.user.role)
    : false;

  async function refreshDetailQuietly(memberId: string) {
    try {
      const response = await fetchAdminMemberDetail(memberId);
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
      void loadList(query);
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
          result.keepCurrentSession && detail.user.id === user?.id
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
      void loadList(query);
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

  function openCreate() {
    if (!canAdministrate) return;
    setCreateOpen(true);
    setCreateForm(DEFAULT_CREATE_FORM);
    setCreateBusy(false);
    setCreateError(null);
    setCreateResult(null);
  }

  function closeCreate() {
    if (createBusy) return;
    setCreateOpen(false);
    setCreateError(null);
    setCreateResult(null);
  }

  async function submitCreate() {
    if (createBusy) return;
    const quota = parseMemberQuotaInput(createForm.quota);
    if (!quota.ok) {
      setCreateError(quota.message);
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    setCreateResult(null);
    try {
      const response = await createAdminMember({
        email: createForm.email.trim(),
        displayName: createForm.displayName.trim(),
        department: createForm.department.trim() || null,
        role: createForm.role,
        storageQuotaBytes: quota.value,
      });
      setCreateResult(
        response.notice ?? `${response.user.email} を登録しました。`
      );
      setNotice(response.notice ?? null);
      void loadList(query);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError
          ? err.message
          : 'メンバーの登録に失敗しました'
      );
    } finally {
      setCreateBusy(false);
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
      setNotice(response.notice ?? null);
      void loadList(query);
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

  function openAction(nextAction: MemberAction, member: AdminMemberRow) {
    if (
      nextAction === 'suspend'
        ? !memberCanBeSuspended(role, user?.id, member)
        : !memberCanBeResumed(role, user?.id, member)
    ) {
      return;
    }
    setAction(nextAction);
    setActionMember(member);
    setModalBusy(false);
    setModalError(null);
    setModalResult(null);
    busyRef.current = false;
    setIdempotencyKey(createMemberIdempotencyKey(nextAction, member.id));
  }

  function closeActionModal() {
    if (busyRef.current) return;
    setAction(null);
    setActionMember(null);
    setModalError(null);
    setModalResult(null);
    setIdempotencyKey('');
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
    if (!memberCanOpenOffboarding({
      viewerRole: role,
      viewerId: user?.id,
      member,
      activeSysAdminCount,
    })) {
      return;
    }
    // The offboarding wizard owns the modal surface; close the detail drawer
    // first so two native <dialog> elements never stack.
    if (detailMemberId) {
      setDetailMemberId(null);
      setDetail(null);
      setDetailError(null);
      setEditError(null);
      setEditResult(null);
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

  async function executeAction() {
    if (!action || !actionMember || busyRef.current) return;
    busyRef.current = true;
    setModalBusy(true);
    setModalError(null);
    try {
      const response =
        action === 'suspend'
          ? await suspendAdminMember(actionMember.id, { idempotencyKey })
          : await resumeAdminMember(actionMember.id, { idempotencyKey });
      const message =
        response.notice ??
        (action === 'suspend'
          ? 'メンバーを停止しました。'
          : 'メンバーアカウントを再開しました。');
      setModalResult(message);
      setNotice(message);
      void loadList(query);
      if (detailMemberId === actionMember.id) {
        void openDetail(actionMember.id);
      }
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : 'メンバー操作に失敗しました'
      );
    } finally {
      busyRef.current = false;
      setModalBusy(false);
    }
  }

  function openBulk() {
    if (!canAdministrate) return;
    setBulkOpen(true);
    setBulkCsv(ADMIN_MEMBER_CSV_SAMPLE);
    setBulkKey(createMemberIdempotencyKey('bulk-import'));
    setBulkBusy(false);
    setBulkError(null);
    setBulkResult(null);
  }

  function closeBulk() {
    if (bulkBusy) return;
    setBulkOpen(false);
    setBulkError(null);
    setBulkResult(null);
  }

  async function runBulk(dryRun: boolean) {
    if (bulkBusy) return;
    if (bulkCsv.trim().length === 0) {
      setBulkError('CSV テキストを入力してください。');
      return;
    }
    setBulkBusy(true);
    setBulkError(null);
    try {
      const response = await bulkImportAdminMembers({
        csv: bulkCsv,
        dryRun,
        idempotencyKey: bulkKey,
      });
      setBulkResult(response);
      if (!dryRun) {
        setNotice(response.notice);
        void loadList(query);
      }
    } catch (err) {
      setBulkError(
        err instanceof ApiClientError
          ? err.message
          : 'CSV 一括登録に失敗しました'
      );
    } finally {
      setBulkBusy(false);
    }
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
        {memberPermissionNotice(role)}
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
        <ModalShell
          label="社内メンバーを追加"
          labelledBy={`${baseId}-create-heading`}
          onClose={closeCreate}
          className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <div data-testid="member-create-modal" className="flex flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <div>
                <h3
                  id={`${baseId}-create-heading`}
                  className="text-sm font-semibold text-slate-900"
                >
                  社内メンバーを追加
                </h3>
                <p className="mt-0.5 text-[0.6875rem] text-slate-500">
                  sys_admin のみ登録できます。個人クォータ未入力ならテナント
                  クォータのみ適用されます。
                </p>
              </div>
              <button
                type="button"
                data-testid="member-create-close"
                aria-label="メンバー追加を閉じる"
                onClick={closeCreate}
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <form
              className="space-y-3 px-5 py-4 text-xs"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreate();
              }}
            >
              <label className="block text-[0.6875rem] font-medium text-slate-700">
                メールアドレス
                <input
                  type="email"
                  required
                  data-testid="member-create-email"
                  data-autofocus
                  value={createForm.email}
                  onChange={(event) =>
                    setCreateForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                  autoComplete="off"
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                />
              </label>
              <label className="block text-[0.6875rem] font-medium text-slate-700">
                表示名
                <input
                  type="text"
                  required
                  data-testid="member-create-display-name"
                  value={createForm.displayName}
                  onChange={(event) =>
                    setCreateForm((current) => ({
                      ...current,
                      displayName: event.target.value,
                    }))
                  }
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                />
              </label>
              <label className="block text-[0.6875rem] font-medium text-slate-700">
                部署
                <input
                  type="text"
                  data-testid="member-create-department"
                  value={createForm.department}
                  onChange={(event) =>
                    setCreateForm((current) => ({
                      ...current,
                      department: event.target.value,
                    }))
                  }
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-[0.6875rem] font-medium text-slate-700">
                  ロール
                  <select
                    data-testid="member-create-role"
                    value={createForm.role}
                    onChange={(event) =>
                      setCreateForm((current) => ({
                        ...current,
                        role: event.target.value as UserRole,
                      }))
                    }
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
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
                    data-testid="member-create-quota"
                    value={createForm.quota}
                    onChange={(event) =>
                      setCreateForm((current) => ({
                        ...current,
                        quota: event.target.value,
                      }))
                    }
                    placeholder="空欄 = 上限なし"
                    className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                  />
                </label>
              </div>
              {createError && (
                <div
                  role="alert"
                  data-testid="member-create-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                >
                  {createError}
                </div>
              )}
              {createResult && (
                <div
                  role="status"
                  data-testid="member-create-result"
                  className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
                >
                  {createResult}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeCreate}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  閉じる
                </button>
                <button
                  type="submit"
                  data-testid="member-create-submit"
                  disabled={createBusy || Boolean(createResult)}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                >
                  {createBusy && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  登録
                </button>
              </div>
            </form>
          </div>
        </ModalShell>
      )}

      {detailMemberId && (
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
                  {detail?.user.email ?? detailMemberId}
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
                      <p data-testid="member-detail-usage" className="font-medium text-slate-900">
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
                                開始 {formatAuditDateTime(session.createdAt)} /
                                期限 {formatAuditDateTime(session.expiresAt)}
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
                          セッション{' '}
                          {shortAdminSessionId(pendingMemberSession.id)}{' '}
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
                      disabled={!memberCanBeSuspended(role, user?.id, detail.user)}
                      aria-describedby={`${baseId}-rbac`}
                      onClick={() => openAction('suspend', detail.user)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-300 bg-white px-2.5 text-[0.6875rem] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-40"
                    >
                      停止
                    </button>
                    <button
                      type="button"
                      data-testid="member-action-resume"
                      disabled={!memberCanBeResumed(role, user?.id, detail.user)}
                      aria-describedby={`${baseId}-rbac`}
                      onClick={() => openAction('resume', detail.user)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-white px-2.5 text-[0.6875rem] font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-40"
                    >
                      再開
                    </button>
                    <button
                      type="button"
                      data-testid="member-action-offboard"
                      disabled={!memberCanOpenOffboarding({
                        viewerRole: role,
                        viewerId: user?.id,
                        member: detail.user,
                        activeSysAdminCount,
                      })}
                      title={
                        offboardingGuard(detail.user) ??
                        '退職/移管 (オフボーディング)'
                      }
                      aria-describedby={`${baseId}-rbac`}
                      onClick={() => openOffboarding(detail.user)}
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
      )}

      {action && actionMember && (
        <ModalShell
          label={
            action === 'suspend' ? 'メンバーを停止' : 'メンバーを再開'
          }
          labelledBy={`${baseId}-confirm-heading`}
          onClose={closeActionModal}
          className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <div data-testid="member-confirm-modal">
            <div className="border-b border-slate-200 px-5 py-3">
              <h3
                id={`${baseId}-confirm-heading`}
                data-testid="member-confirm-title"
                className="text-sm font-semibold text-slate-900"
              >
                {action === 'suspend'
                  ? 'メンバーを停止しますか？'
                  : 'メンバーアカウントを再開しますか？'}
              </h3>
              <p className="mt-1 text-[0.6875rem] text-slate-500">
                {actionMember.email}
              </p>
            </div>
            <div className="space-y-3 px-5 py-4 text-xs text-slate-700">
              <p>
                {action === 'suspend'
                  ? '対象メンバーを suspended にし、すべての有効セッションを即時失効させます。TenantSyncHub の user.suspended 通知で接続中のクライアントも追い出されます。'
                  : '停止中のメンバーを再び有効化します。失効済みセッションは復元されないため再ログインが必要です。'}
              </p>
              <p className="font-mono text-[0.625rem] text-slate-500">
                Idempotency-Key: {idempotencyKey}
              </p>
              {modalError && (
                <div
                  role="alert"
                  data-testid="member-confirm-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                >
                  {modalError}
                </div>
              )}
              {modalResult && (
                <div
                  role="status"
                  data-testid="member-confirm-result"
                  className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800"
                >
                  {modalResult}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="member-confirm-cancel"
                  onClick={closeActionModal}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  閉じる
                </button>
                <button
                  type="button"
                  data-testid="member-confirm-execute"
                  disabled={modalBusy || Boolean(modalResult)}
                  onClick={() => void executeAction()}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                >
                  {modalBusy && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  実行
                </button>
              </div>
            </div>
          </div>
        </ModalShell>
      )}

      {bulkOpen && (
        <ModalShell
          label="CSV 一括登録"
          labelledBy={`${baseId}-bulk-heading`}
          onClose={closeBulk}
          className="w-full max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <div data-testid="member-bulk-modal" className="flex max-h-[88vh] flex-col">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <div>
                <h3
                  id={`${baseId}-bulk-heading`}
                  className="text-sm font-semibold text-slate-900"
                >
                  CSV 一括登録 / 更新
                </h3>
                <p className="mt-0.5 text-[0.6875rem] text-slate-500">
                  最大 200 件。既存メールは更新、未登録メールは新規作成します。
                  まず dryRun でプレビューできます。
                </p>
              </div>
              <button
                type="button"
                data-testid="member-bulk-close"
                aria-label="CSV 一括登録を閉じる"
                onClick={closeBulk}
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="grid flex-1 gap-4 overflow-y-auto px-5 py-4 text-xs lg:grid-cols-2">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label
                    htmlFor={`${baseId}-bulk-csv`}
                    className="text-[0.6875rem] font-medium text-slate-700"
                  >
                    UTF-8 CSV
                  </label>
                  <button
                    type="button"
                    data-testid="member-bulk-sample"
                    onClick={() => setBulkCsv(ADMIN_MEMBER_CSV_SAMPLE)}
                    className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <FileSpreadsheet className="h-3 w-3" aria-hidden="true" />
                    サンプル CSV
                  </button>
                </div>
                <textarea
                  id={`${baseId}-bulk-csv`}
                  data-testid="member-bulk-csv"
                  data-autofocus
                  value={bulkCsv}
                  onChange={(event) => setBulkCsv(event.target.value)}
                  rows={14}
                  spellCheck={false}
                  className="w-full rounded-lg border border-slate-300 p-2 font-mono text-[0.6875rem] text-slate-900"
                />
                <p className="text-[0.625rem] text-slate-500">
                  対応ヘッダー: email, displayName, department, role,
                  storageQuotaBytes（空欄は上限なし）
                </p>
                <p
                  data-testid="member-bulk-idempotency-key"
                  className="break-all font-mono text-[0.625rem] text-slate-500"
                >
                  Idempotency-Key: {bulkKey}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="member-bulk-dry-run"
                    disabled={bulkBusy}
                    onClick={() => void runBulk(true)}
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-[#5e6ad2] bg-white px-3 text-xs font-medium text-[#3f4aa8] hover:bg-[#f2f3fb] disabled:opacity-50"
                  >
                    {bulkBusy && (
                      <Loader2
                        className="h-3.5 w-3.5 animate-spin"
                        aria-hidden="true"
                      />
                    )}
                    dryRun プレビュー
                  </button>
                  <button
                    type="button"
                    data-testid="member-bulk-execute"
                    disabled={bulkBusy}
                    onClick={() => void runBulk(false)}
                    className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                  >
                    一括登録を実行
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {bulkError && (
                  <div
                    role="alert"
                    data-testid="member-bulk-error"
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                  >
                    {bulkError}
                  </div>
                )}
                {bulkResult ? (
                  <div className="space-y-2">
                    <div
                      data-testid="member-bulk-result"
                      className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-900"
                    >
                      <p data-testid="member-bulk-summary" className="font-medium">
                        {formatBulkImportSummary(bulkResult)}
                      </p>
                      <p className="mt-0.5 text-[0.625rem]">
                        {bulkResult.dryRun
                          ? 'プレビューのためデータは変更されていません。'
                          : bulkResult.replayed
                            ? '同じ Idempotency-Key の保存済み結果を再生しました（再実行なし）。'
                            : bulkResult.notice}
                      </p>
                    </div>
                    <div className="max-h-[24rem] overflow-auto rounded-lg border border-slate-200">
                      <table className="w-full text-left text-[0.625rem]">
                        <caption className="sr-only">
                          CSV 一括登録の行別結果
                        </caption>
                        <thead className="sticky top-0 bg-slate-50 text-slate-500">
                          <tr>
                            <th scope="col" className="px-2 py-1 font-medium">
                              行
                            </th>
                            <th scope="col" className="px-2 py-1 font-medium">
                              メール
                            </th>
                            <th scope="col" className="px-2 py-1 font-medium">
                              結果
                            </th>
                            <th scope="col" className="px-2 py-1 font-medium">
                              内容
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {bulkResult.results.map((row) => (
                            <tr
                              key={`${row.rowNumber}-${row.email}`}
                              data-testid="member-bulk-row"
                              className="border-t border-slate-100"
                            >
                              <td className="px-2 py-1 text-slate-500">
                                {row.rowNumber}
                              </td>
                              <td className="px-2 py-1 font-mono text-slate-700">
                                {row.email || '—'}
                              </td>
                              <td className="px-2 py-1">
                                <span
                                  className={`inline-flex rounded-full px-1.5 py-0.5 text-[0.5625rem] font-semibold ${
                                    row.action === 'error'
                                      ? 'bg-red-50 text-red-700'
                                      : row.action === 'create'
                                        ? 'bg-emerald-50 text-emerald-700'
                                        : row.action === 'update'
                                          ? 'bg-blue-50 text-blue-700'
                                          : 'bg-slate-100 text-slate-600'
                                  }`}
                                >
                                  {ADMIN_MEMBER_BULK_ACTION_LABELS[row.action]}
                                </span>
                              </td>
                              <td className="px-2 py-1 text-slate-600">
                                {row.error
                                  ? row.code
                                    ? `${row.error} (${row.code})`
                                    : row.error
                                  : bulkRowLabel(row)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-6 text-center text-[0.6875rem] text-slate-500">
                    dryRun プレビューまたは一括登録を実行すると、行別の結果が
                    ここに表示されます。
                  </div>
                )}
              </div>
            </div>
          </div>
        </ModalShell>
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
