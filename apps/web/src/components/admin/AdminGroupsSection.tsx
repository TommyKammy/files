'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ModalShell } from '@/components/ModalShell';
import {
  ADMIN_MEMBER_ROLE_LABELS,
} from '@/lib/admin-users';
import {
  canEditAdminGroup,
  canManageAdminGroups,
  canViewAdminGroups,
  groupPermissionNotice,
  groupReadOnlyReason,
  groupSourceBadgeClass,
  groupSourceLabel,
  groupSourceSummaryCards,
  isScimManagedGroup,
  selectableGroupMembers,
} from '@/lib/admin-groups';
import { ROLE_META } from '@/lib/capabilities';
import {
  ApiClientError,
  addAdminGroupMembers,
  createAdminGroup,
  deleteAdminGroup,
  fetchAdminGroupDetail,
  fetchAdminGroups,
  fetchAdminMembers,
  removeAdminGroupMember,
  renameAdminGroup,
} from '@/lib/files-api';
import { formatAuditDateTime } from '@/lib/formatters';
import type {
  AdminGroupDetailResponse,
  AdminGroupListQuery,
  AdminGroupListResponse,
  AdminMemberRow,
  AuthUser,
} from '@/types/files';

const PAGE_SIZE = 200;

const DEFAULT_QUERY: AdminGroupListQuery = {
  source: 'all',
  limit: PAGE_SIZE,
  offset: 0,
};

interface DraftFilters {
  query: string;
  source: NonNullable<AdminGroupListQuery['source']>;
}

const DEFAULT_DRAFT: DraftFilters = { query: '', source: 'all' };

function GroupSourceBadge({ source }: { source: 'scim' | 'manual' }) {
  return (
    <span
      data-testid="group-source-badge"
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold ${groupSourceBadgeClass(
        source
      )}`}
    >
      {groupSourceLabel(source)}
    </span>
  );
}

export function AdminGroupsSection({ user }: { user: AuthUser | null }) {
  const baseId = useId();
  const role = user?.role;
  const canView = canViewAdminGroups(role, user?.adminCapabilities);
  const canManage = canManageAdminGroups(role, user?.adminCapabilities);
  const canCreateGroup = canManage && !user?.adminScope?.groupId;

  const [query, setQuery] = useState<AdminGroupListQuery>(DEFAULT_QUERY);
  const [draft, setDraft] = useState<DraftFilters>(DEFAULT_DRAFT);
  const [data, setData] = useState<AdminGroupListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<string | null>(null);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminGroupDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNotice, setDetailNotice] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const [memberCandidates, setMemberCandidates] = useState<AdminMemberRow[]>([]);
  const [memberCandidatesLoading, setMemberCandidatesLoading] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [memberError, setMemberError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const loadList = useCallback(
    async (nextQuery: AdminGroupListQuery) => {
      if (!canView) return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      try {
        const response = await fetchAdminGroups(nextQuery);
        if (requestIdRef.current !== requestId) return;
        setData(response);
        setError(null);
      } catch (err) {
        if (requestIdRef.current !== requestId) return;
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'グループ一覧の読み込みに失敗しました'
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
    if (!detail) {
      setRenameName('');
      return;
    }
    setRenameName(detail.group.name);
  }, [detail]);

  useEffect(() => {
    if (!detail) {
      setMemberCandidates([]);
      return;
    }
    if (!canManage || isScimManagedGroup(detail.group)) {
      setMemberCandidates([]);
      return;
    }
    let cancelled = false;
    setMemberCandidatesLoading(true);
    fetchAdminMembers({ limit: 200, status: 'active' })
      .then((response) => {
        if (cancelled) return;
        setMemberCandidates(response.users);
      })
      .catch(() => {
        if (cancelled) return;
        setMemberCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setMemberCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, detail]);

  const summaryCards = useMemo(
    () => groupSourceSummaryCards(data?.summary),
    [data?.summary]
  );

  const candidates = useMemo(() => {
    if (!detail) return [];
    return selectableGroupMembers(
      memberCandidates,
      detail.members.map((member) => member.id)
    );
  }, [detail, memberCandidates]);

  if (!canView) return null;

  function applyFilters() {
    setQuery((current) => ({
      ...current,
      query: draft.query.trim() || undefined,
      source: draft.source,
      offset: 0,
    }));
  }

  function resetFilters() {
    setDraft(DEFAULT_DRAFT);
    setQuery((current) => ({
      ...DEFAULT_QUERY,
      limit: current.limit,
    }));
  }

  function openCreate() {
    if (!canManage) return;
    setCreateOpen(true);
    setCreateName('');
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
    if (createBusy || !canManage) return;
    const name = createName.trim();
    if (!name) {
      setCreateError('グループ名を入力してください。');
      return;
    }
    setCreateBusy(true);
    setCreateError(null);
    setCreateResult(null);
    try {
      const response = await createAdminGroup(name);
      setCreateResult(response.notice);
      setNotice(response.notice);
      void loadList(query);
    } catch (err) {
      setCreateError(
        err instanceof ApiClientError
          ? err.message
          : 'グループの作成に失敗しました'
      );
    } finally {
      setCreateBusy(false);
    }
  }

  async function openDetail(groupId: string) {
    setDetailId(groupId);
    setDetail(null);
    setDetailError(null);
    setDetailNotice(null);
    setRenameError(null);
    setMemberError(null);
    setDeleteOpen(false);
    setDeleteError(null);
    setSelectedMemberIds([]);
    setDetailLoading(true);
    try {
      setDetail(await fetchAdminGroupDetail(groupId));
    } catch (err) {
      setDetailError(
        err instanceof ApiClientError
          ? err.message
          : 'グループ詳細の読み込みに失敗しました'
      );
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail() {
    if (detailBusy) return;
    setDetailId(null);
    setDetail(null);
    setDetailError(null);
    setDetailNotice(null);
    setRenameError(null);
    setMemberError(null);
    setDeleteOpen(false);
    setDeleteError(null);
    setSelectedMemberIds([]);
  }

  async function refreshDetail(groupId: string) {
    const next = await fetchAdminGroupDetail(groupId);
    setDetail(next);
  }

  async function submitRename() {
    if (!detail || detailBusy) return;
    const name = renameName.trim();
    if (!name) {
      setRenameError('グループ名を入力してください。');
      return;
    }
    setDetailBusy(true);
    setRenameError(null);
    setDetailNotice(null);
    try {
      const response = await renameAdminGroup(detail.group.id, name);
      setDetailNotice(response.notice);
      setNotice(response.notice);
      await refreshDetail(detail.group.id);
      void loadList(query);
    } catch (err) {
      setRenameError(
        err instanceof ApiClientError
          ? err.message
          : 'グループ名の変更に失敗しました'
      );
    } finally {
      setDetailBusy(false);
    }
  }

  async function submitAddMembers() {
    if (!detail || detailBusy) return;
    if (selectedMemberIds.length === 0) {
      setMemberError('追加するメンバーを選択してください。');
      return;
    }
    setDetailBusy(true);
    setMemberError(null);
    setDetailNotice(null);
    try {
      const response = await addAdminGroupMembers(
        detail.group.id,
        selectedMemberIds
      );
      setDetailNotice(response.notice);
      setNotice(response.notice);
      setSelectedMemberIds([]);
      await refreshDetail(detail.group.id);
      void loadList(query);
    } catch (err) {
      setMemberError(
        err instanceof ApiClientError
          ? err.message
          : 'メンバーの追加に失敗しました'
      );
    } finally {
      setDetailBusy(false);
    }
  }

  async function submitRemoveMember(userId: string) {
    if (!detail || detailBusy) return;
    setDetailBusy(true);
    setMemberError(null);
    setDetailNotice(null);
    try {
      const response = await removeAdminGroupMember(detail.group.id, userId);
      setDetailNotice(response.notice);
      setNotice(response.notice);
      await refreshDetail(detail.group.id);
      void loadList(query);
    } catch (err) {
      setMemberError(
        err instanceof ApiClientError
          ? err.message
          : 'メンバーの削除に失敗しました'
      );
    } finally {
      setDetailBusy(false);
    }
  }

  async function executeDelete() {
    if (!detail || detailBusy) return;
    setDetailBusy(true);
    setDeleteError(null);
    try {
      const response = await deleteAdminGroup(detail.group.id);
      setNotice(response.notice);
      setDeleteOpen(false);
      setDetailId(null);
      setDetail(null);
      void loadList(query);
    } catch (err) {
      setDeleteError(
        err instanceof ApiClientError
          ? err.message
          : 'グループの削除に失敗しました'
      );
    } finally {
      setDetailBusy(false);
    }
  }

  const rows = data?.groups ?? [];
  const canEditOpenGroup = detail
    ? canEditAdminGroup(role, detail.group, user?.adminCapabilities)
    : false;
  const openGroupReadOnlyReason = detail
    ? groupReadOnlyReason(role, detail.group, user?.adminCapabilities)
    : null;

  return (
    <section
      id="admin-groups"
      data-testid="admin-groups-section"
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
              グループ管理
            </h2>
            <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
              手動グループと SCIM
              同期グループのメンバー・付与済み権限を確認し、手動グループを管理します。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="group-open-create"
            onClick={openCreate}
            disabled={!canCreateGroup}
            title={
              canCreateGroup
                ? 'グループを作成'
                : user?.adminScope?.groupId
                  ? 'グループスコープ付き Co-Admin は新規グループを作成できません'
                  : 'グループ作成は sys_admin 専用です'
            }
            className="inline-flex h-7 items-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <UserPlus className="h-3 w-3" aria-hidden="true" />
            グループ作成
          </button>
          <button
            type="button"
            data-testid="group-refresh"
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

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p
          id={`${baseId}-rbac`}
          data-testid="group-rbac-notice"
          className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-[0.6875rem] ${
            canManage
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          {groupPermissionNotice(role, user?.adminCapabilities)}
        </p>
        <Link
          href="/admin/settings?tab=integrations"
          data-testid="group-scim-integration-link"
          className="inline-flex h-7 shrink-0 items-center rounded-md border border-[#d7d7dc] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
        >
          SCIM トークン管理 (統合)
        </Link>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {summaryCards.map((card) => (
          <div
            key={card.key}
            data-testid={`group-summary-${card.key}`}
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

      <search>
        <form
          aria-label="グループ一覧のフィルタ"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilters();
          }}
          className="mb-3 grid gap-2 rounded-xl border border-[#e7e7ea] bg-[#f9f9fa] p-3 md:grid-cols-2 lg:grid-cols-4"
        >
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            検索
            <input
              type="search"
              name="groupQuery"
              data-testid="group-filter-query"
              value={draft.query}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  query: event.target.value,
                }))
              }
              placeholder="グループ名 / ID / IdP ID"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            />
          </label>
          <label className="block text-[0.625rem] font-medium text-[#3c3f46]">
            種別
            <select
              name="groupSource"
              data-testid="group-filter-source"
              value={draft.source}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  source: event.target.value as DraftFilters['source'],
                }))
              }
              className="mt-1 h-8 w-full rounded-md border border-[#d7d7dc] bg-white px-2 text-[0.75rem] text-[#111214]"
            >
              <option value="all">すべて</option>
              <option value="manual">手動</option>
              <option value="scim">SCIM 同期</option>
            </select>
          </label>
          <div className="flex items-end gap-1.5 md:col-span-2">
            <button
              type="submit"
              data-testid="group-filter-apply"
              className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white transition hover:bg-[#4f5ac2]"
            >
              <Search className="h-3.5 w-3.5" aria-hidden="true" />
              絞り込む
            </button>
            <button
              type="button"
              data-testid="group-filter-reset"
              onClick={resetFilters}
              className="inline-flex h-8 items-center justify-center rounded-md border border-[#d7d7dc] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
            >
              リセット
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
          data-testid="group-notice"
          className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
        >
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      <div
        role="region"
        aria-label="グループ一覧"
        tabIndex={0}
        className="overflow-x-auto rounded-xl border border-[#e7e7ea]"
      >
        <table
          data-testid="admin-groups-table"
          className="w-full min-w-[52rem] border-collapse text-left text-[0.6875rem]"
        >
          <caption className="sr-only">
            テナント内の手動グループと SCIM 同期グループ。
          </caption>
          <thead className="bg-[#f4f4f6] text-[0.625rem] text-[#55565a]">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                グループ
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                種別
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                メンバー
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                権限
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                IdP 外部 ID
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                作成日時
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                操作
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-[#55565a]">
                  <Loader2
                    className="mr-1.5 inline h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                  グループを読み込み中...
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  data-testid="group-empty"
                  className="px-3 py-6 text-center text-[#55565a]"
                >
                  条件に一致するグループはありません。
                </td>
              </tr>
            ) : (
              rows.map((group) => (
                <tr
                  key={group.id}
                  data-testid="admin-group-row"
                  data-group-id={group.id}
                  className="border-t border-[#f2f2f4]"
                >
                  <td className="px-3 py-2">
                    <p className="font-medium text-[#111214]">{group.name}</p>
                    <p className="font-mono text-[0.5625rem] text-[#8a8b90]">
                      {group.id}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <GroupSourceBadge source={group.source} />
                  </td>
                  <td className="px-3 py-2 text-[#3c3f46]">
                    {group.memberCount} 人
                  </td>
                  <td className="px-3 py-2 text-[#3c3f46]">
                    {group.permissionCount} 件
                  </td>
                  <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-[0.625rem] text-[#55565a]">
                    {group.externalIdpId ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-[#55565a]">
                    {formatAuditDateTime(group.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      data-testid="group-open-detail"
                      onClick={() => void openDetail(group.id)}
                      className="inline-flex items-center gap-1 rounded border border-[#d7d7dc] bg-white px-1.5 py-0.5 text-[0.5625rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
                    >
                      詳細
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <ModalShell
          label="グループを作成"
          labelledBy={`${baseId}-create-heading`}
          onClose={closeCreate}
          className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <div data-testid="group-create-modal">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3">
              <div>
                <h3
                  id={`${baseId}-create-heading`}
                  className="text-sm font-semibold text-slate-900"
                >
                  手動グループを作成
                </h3>
                <p className="mt-0.5 text-[0.6875rem] text-slate-500">
                  同一テナント内で重複するグループ名は作成できません。
                </p>
              </div>
              <button
                type="button"
                data-testid="group-create-close"
                aria-label="グループ作成を閉じる"
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
                グループ名
                <input
                  type="text"
                  required
                  data-testid="group-create-name"
                  data-autofocus
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  maxLength={120}
                  className="mt-1 h-9 w-full rounded-md border border-slate-300 px-2 text-xs text-slate-900"
                />
              </label>
              {createError && (
                <div
                  role="alert"
                  data-testid="group-create-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                >
                  {createError}
                </div>
              )}
              {createResult && (
                <div
                  role="status"
                  data-testid="group-create-result"
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
                  data-testid="group-create-submit"
                  disabled={createBusy}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                >
                  {createBusy && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  作成
                </button>
              </div>
            </form>
          </div>
        </ModalShell>
      )}

      {detailId && (
        <ModalShell
          label="グループ詳細"
          labelledBy={`${baseId}-detail-heading`}
          onClose={closeDetail}
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
                      void submitRename();
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
                          onChange={(event) => setRenameName(event.target.value)}
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
                                    onClick={() =>
                                      void submitRemoveMember(member.id)
                                    }
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
                            setSelectedMemberIds(
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
                        onClick={() => void submitAddMembers()}
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
                      onClick={() => {
                        setDeleteOpen(true);
                        setDeleteError(null);
                      }}
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
      )}

      {deleteOpen && detail && (
        <ModalShell
          label="グループを削除"
          labelledBy={`${baseId}-delete-heading`}
          onClose={() => {
            if (!detailBusy) setDeleteOpen(false);
          }}
          className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <div data-testid="group-delete-modal">
            <div className="border-b border-slate-200 px-5 py-3">
              <h3
                id={`${baseId}-delete-heading`}
                className="text-sm font-semibold text-slate-900"
              >
                グループ「{detail.group.name}」を削除しますか？
              </h3>
              <p className="mt-1 text-[0.6875rem] text-slate-500">
                所属メンバー {detail.members.length} 人、付与済み権限{' '}
                {detail.permissions.length} 件も同時に削除されます。
              </p>
            </div>
            <div className="space-y-3 px-5 py-4 text-xs text-slate-700">
              <p>
                この操作は取り消せません。削除後は
                TenantSyncHub 経由で接続中のクライアントに権限変更が通知されます。
              </p>
              {deleteError && (
                <div
                  role="alert"
                  data-testid="group-delete-error"
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-700"
                >
                  {deleteError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="group-delete-cancel"
                  disabled={detailBusy}
                  onClick={() => setDeleteOpen(false)}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  data-testid="group-delete-confirm"
                  disabled={detailBusy}
                  onClick={() => void executeDelete()}
                  className="inline-flex h-8 items-center gap-1 rounded-md bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {detailBusy && (
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  削除する
                </button>
              </div>
            </div>
          </div>
        </ModalShell>
      )}
    </section>
  );
}
