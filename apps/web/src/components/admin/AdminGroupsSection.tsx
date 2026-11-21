'use client';

import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Search,
  UserPlus,
  Users,
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
import { GroupCreateModal } from '@/components/admin/groups/GroupCreateModal';
import { GroupDeleteModal } from '@/components/admin/groups/GroupDeleteModal';
import { GroupDetailModal } from '@/components/admin/groups/GroupDetailModal';
import { GroupsTable } from '@/components/admin/groups/GroupsTable';
import {
  canEditAdminGroup,
  canManageAdminGroups,
  canViewAdminGroups,
  groupPermissionNotice,
  groupReadOnlyReason,
  groupSourceSummaryCards,
  isScimManagedGroup,
  selectableGroupMembers,
} from '@/lib/admin-groups';
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

      <GroupsTable
        rows={rows}
        loading={loading}
        onOpenDetail={(groupId) => void openDetail(groupId)}
      />

      {createOpen && (
        <GroupCreateModal
          baseId={baseId}
          createName={createName}
          createBusy={createBusy}
          createError={createError}
          createResult={createResult}
          onChangeName={setCreateName}
          onClose={closeCreate}
          onSubmit={() => void submitCreate()}
        />
      )}

      {detailId && (
        <GroupDetailModal
          baseId={baseId}
          detailId={detailId}
          detail={detail}
          detailLoading={detailLoading}
          detailError={detailError}
          detailNotice={detailNotice}
          detailBusy={detailBusy}
          canEditOpenGroup={canEditOpenGroup}
          openGroupReadOnlyReason={openGroupReadOnlyReason}
          renameName={renameName}
          renameError={renameError}
          candidates={candidates}
          memberCandidatesLoading={memberCandidatesLoading}
          selectedMemberIds={selectedMemberIds}
          memberError={memberError}
          onClose={closeDetail}
          onChangeRenameName={setRenameName}
          onSubmitRename={() => void submitRename()}
          onRemoveMember={(userId) => void submitRemoveMember(userId)}
          onChangeSelectedMemberIds={setSelectedMemberIds}
          onSubmitAddMembers={() => void submitAddMembers()}
          onOpenDelete={() => {
            setDeleteOpen(true);
            setDeleteError(null);
          }}
        />
      )}

      {deleteOpen && detail && (
        <GroupDeleteModal
          baseId={baseId}
          groupName={detail.group.name}
          memberCount={detail.members.length}
          permissionCount={detail.permissions.length}
          detailBusy={detailBusy}
          deleteError={deleteError}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => void executeDelete()}
        />
      )}
    </section>
  );
}
