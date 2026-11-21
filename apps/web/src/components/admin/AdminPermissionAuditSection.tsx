'use client';

import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Loader2,
  RefreshCw,
  ShieldAlert,
  UserCog,
  Users,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  AdminPermissionBulkModal,
  type BulkAction,
} from '@/components/admin/permission-audit/AdminPermissionBulkModal';
import {
  AdminPermissionEntriesPanel,
  type DraftFilters,
} from '@/components/admin/permission-audit/AdminPermissionEntriesPanel';
import {
  DEFAULT_PERMISSION_AUDIT_QUERY,
  permissionRootWarnings,
  summarizePermissionRoots,
  togglePermissionSort,
} from '@/lib/admin-permission-audit';
import { formatAuditDateTime } from '@/lib/formatters';
import { ApiClientError, fetchAdminPermissionAudit } from '@/lib/files-api';
import type {
  AdminPermissionAuditQuery,
  AdminPermissionAuditResponse,
  AdminPermissionRootSummary,
  AdminPermissionSortBy,
  AuthUser,
  ResourceRole,
} from '@/types/files';

const PAGE_SIZE = 50;

type AuditTab = 'roots' | 'permissions';

const DEFAULT_DRAFT: DraftFilters = {
  targetType: 'all',
  rootFolderId: '',
  role: '',
  source: 'all',
  inheritedFromId: '',
  grantee: '',
  grantedBy: '',
  from: '',
  to: '',
  granteeStatus: '',
  health: 'all',
};

const DEFAULT_QUERY: AdminPermissionAuditQuery = {
  ...DEFAULT_PERMISSION_AUDIT_QUERY,
};

export function AdminPermissionAuditSection({
  user,
  onShowPermissionAudit,
}: {
  user: AuthUser | null;
  onShowPermissionAudit: () => void;
}) {
  const canMutate = user?.role === 'sys_admin';
  const baseId = useId();
  const rootCaptionId = `${baseId}-roots-caption`;
  const permissionCaptionId = `${baseId}-permissions-caption`;
  const [activeTab, setActiveTab] = useState<AuditTab>('roots');

  const [data, setData] = useState<AdminPermissionAuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState<AdminPermissionAuditQuery>(DEFAULT_QUERY);
  const [draft, setDraft] = useState<DraftFilters>(DEFAULT_DRAFT);
  const requestIdRef = useRef(0);

  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(
    new Set()
  );
  const [modalAction, setModalAction] = useState<BulkAction | null>(null);
  const [modalFolderIds, setModalFolderIds] = useState<string[]>([]);

  const loadAudit = useCallback(async (nextQuery: AdminPermissionAuditQuery) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const response = await fetchAdminPermissionAudit(nextQuery);
      if (requestIdRef.current !== requestId) return;
      setData(response);
      setError(null);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      setError(
        err instanceof ApiClientError
          ? err.message
          : '権限監査データの読み込みに失敗しました'
      );
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAudit(query);
  }, [loadAudit, query]);

  const roots = data?.rootSummaries ?? [];
  const rootCounts = useMemo(() => summarizePermissionRoots(roots), [roots]);
  const entries = data?.entries ?? [];
  const anomalies = data?.anomaliesSummary;

  const inheritedFromOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const root of roots) map.set(root.id, root.name);
    for (const entry of entries) {
      if (entry.inheritedFromId) {
        map.set(entry.inheritedFromId, entry.inheritedFromName ?? entry.inheritedFromId);
      }
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'ja'));
  }, [entries, roots]);

  const sortAnnouncement = useMemo(() => {
    const sortLabel: Record<AdminPermissionSortBy, string> = {
      createdAt: '作成日時',
      role: 'ロール',
      targetName: '対象名',
      granteeName: '付与先名',
    };
    const by = sortLabel[query.sortBy ?? 'createdAt'];
    const dir = query.sortDir === 'asc' ? '昇順' : '降順';
    const offset = query.offset ?? 0;
    return `${data?.totalCount ?? 0}件中 ${data?.entries.length ?? 0}件を表示、${by}の${dir}で並べ替え`;
  }, [
    data?.entries.length,
    data?.totalCount,
    query.offset,
    query.sortBy,
    query.sortDir,
  ]);

  function applyFilters() {
    setQuery({
      ...query,
      targetType: draft.targetType,
      rootFolderId: draft.rootFolderId || null,
      role: draft.role ? [draft.role as ResourceRole] : [],
      source: draft.source,
      inheritedFromId: draft.inheritedFromId || null,
      grantee: draft.grantee.trim() || null,
      grantedBy: draft.grantedBy.trim() || null,
      from: draft.from ? `${draft.from}T00:00:00.000Z` : null,
      to: draft.to ? `${draft.to}T23:59:59.999Z` : null,
      granteeStatus: draft.granteeStatus || null,
      health: draft.health,
      offset: 0,
      limit: PAGE_SIZE,
    });
  }

  function clearFilters() {
    setDraft(DEFAULT_DRAFT);
    setQuery({
      ...DEFAULT_QUERY,
      sortBy: query.sortBy,
      sortDir: query.sortDir,
    });
  }

  function handleSort(sortBy: AdminPermissionSortBy) {
    const next = togglePermissionSort(
      {
        sortBy: query.sortBy ?? 'createdAt',
        sortDir: query.sortDir ?? 'desc',
      },
      sortBy
    );
    setQuery((current) => ({ ...current, ...next, offset: 0 }));
  }

  function toggleFolderSelection(folderId: string, checked: boolean) {
    setSelectedFolderIds((current) => {
      const next = new Set(current);
      if (checked) next.add(folderId);
      else next.delete(folderId);
      return next;
    });
  }

  function selectAllRoots(checked: boolean) {
    setSelectedFolderIds(
      checked ? new Set(roots.map((root) => root.id)) : new Set()
    );
  }

  function openBulkModal(action: BulkAction, folderIds: string[]) {
    if (!canMutate || folderIds.length === 0) return;
    setModalAction(action);
    setModalFolderIds(folderIds);
  }

  function closeModal() {
    setModalAction(null);
  }

  async function handleBulkExecuted(nextNotice: string) {
    setNotice(nextNotice);
    setSelectedFolderIds(new Set());
    await loadAudit(query);
  }

  const selectedFolderIdList = [...selectedFolderIds];
  const selectedRoots = roots.filter((root) =>
    selectedFolderIds.has(root.id)
  );
  const activeSelected = selectedRoots.filter((root) => !root.archived);
  const archivedSelected = selectedRoots.filter((root) => root.archived);

  const tabOrder: AuditTab[] = ['roots', 'permissions'];
  function handleTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: AuditTab
  ) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (tabOrder.indexOf(current) + 1) % tabOrder.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex =
        (tabOrder.indexOf(current) - 1 + tabOrder.length) % tabOrder.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = tabOrder.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabOrder[nextIndex]!;
    setActiveTab(next);
    window.requestAnimationFrame(() => {
      document.getElementById(`${baseId}-${next}-tab`)?.focus();
    });
  }

  return (
    <section
      id="admin-permission-audit"
      aria-labelledby="admin-permission-audit-heading"
      className="scroll-mt-6 overflow-hidden rounded-lg border border-[#e7e7ea] bg-white"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="min-w-0">
          <h2
            id="admin-permission-audit-heading"
            className="text-sm font-semibold text-slate-900"
          >
            アクセス権監査
          </h2>
          <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
            ルートフォルダの所有者健全性、直接/継承権限の監査、sys_admin
            による一括付与・所有者移管・アーカイブを管理します。
            {!canMutate &&
              ' sec_admin は閲覧・監査のみで、一括更新操作は無効です。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onShowPermissionAudit}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50"
          >
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            <span>権限監査ログを表示</span>
          </button>
          <button
            type="button"
            onClick={() => void loadAudit(query)}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>再読み込み</span>
          </button>
        </div>
      </div>

      <div className="px-5 py-4">
        <div
          role="tablist"
          aria-label="アクセス権監査の表示切り替え"
          className="flex flex-nowrap items-stretch gap-1 overflow-x-auto border-b border-slate-200"
        >
          {tabOrder.map((tab) => {
            const selected = activeTab === tab;
            return (
              <button
                key={tab}
                id={`${baseId}-${tab}-tab`}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveTab(tab)}
                onKeyDown={(event) => handleTabKeyDown(event, tab)}
                className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium transition ${
                  selected
                    ? 'border-[#5e6ad2] text-[#111214]'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
              >
                {tab === 'roots'
                  ? 'ルートフォルダ健全性・一括操作'
                  : 'テナント権限一覧'}
              </button>
            );
          })}
        </div>

        {error && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
          >
            {notice}
          </div>
        )}

        <div
          role="tabpanel"
          aria-labelledby={`${baseId}-roots-tab`}
          hidden={activeTab !== 'roots'}
          className="space-y-4 pt-4"
        >
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {[
              { label: 'ルート総数', value: rootCounts.total },
              { label: '所有者不在', value: rootCounts.ownerMissing },
              { label: '停止オーナー', value: rootCounts.suspendedOwner },
              { label: '削除済みオーナー', value: rootCounts.deletedOwner },
              { label: 'アーカイブ', value: rootCounts.archived },
              { label: '総付与数 (配下)', value: rootCounts.totalGrants },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
              >
                <dt className="text-[0.625rem] text-slate-500">{stat.label}</dt>
                <dd className="text-sm font-semibold text-slate-900">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>

          {anomalies &&
            (anomalies.ownerMissingCount > 0 ||
              anomalies.suspendedOwnerCount > 0 ||
              anomalies.deletedOwnerCount > 0 ||
              anomalies.inactiveGranterCount > 0) && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[0.6875rem] leading-relaxed text-amber-900"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  所有者不在 {anomalies.ownerMissingCount} 件 / 停止オーナー{' '}
                  {anomalies.suspendedOwnerCount} 件 / 削除済みオーナー{' '}
                  {anomalies.deletedOwnerCount} 件 / 非アクティブ付与者{' '}
                  {anomalies.inactiveGranterCount} 件。所有者移管または権限の見直しを検討してください。
                </span>
              </div>
            )}

          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={!canMutate || selectedFolderIdList.length === 0}
                onClick={() =>
                  openBulkModal('coowner', selectedFolderIdList)
                }
                className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                <Users className="h-3.5 w-3.5" aria-hidden="true" />
                グループ共同所有者一括付与
              </button>
              <button
                type="button"
                disabled={!canMutate || selectedFolderIdList.length === 0}
                onClick={() =>
                  openBulkModal('transfer', selectedFolderIdList)
                }
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                <UserCog className="h-3.5 w-3.5" aria-hidden="true" />
                所有者一括移管
              </button>
              <button
                type="button"
                disabled={!canMutate || activeSelected.length === 0}
                onClick={() =>
                  openBulkModal(
                    'archive',
                    activeSelected.map((root) => root.id)
                  )
                }
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-300 bg-white px-2.5 text-[0.75rem] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
              >
                <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                一括アーカイブ
              </button>
              <button
                type="button"
                disabled={!canMutate || archivedSelected.length === 0}
                onClick={() =>
                  openBulkModal(
                    'restore',
                    archivedSelected.map((root) => root.id)
                  )
                }
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-300 bg-white px-2.5 text-[0.75rem] font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
              >
                <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                一括復元
              </button>
              {canMutate ? (
                <span className="text-[0.6875rem] text-slate-500">
                  {selectedFolderIdList.length} 件選択中
                </span>
              ) : (
                <span className="text-[0.6875rem] font-medium text-slate-600">
                  sec_admin は閲覧・監査専用です。一括操作は sys_admin
                  のみ実行できます。
                </span>
              )}
            </div>
          </div>

          <div
            role="region"
            aria-labelledby={rootCaptionId}
            tabIndex={0}
            className="overflow-x-auto rounded-lg border border-slate-200"
          >
            <table className="w-full min-w-[980px] text-left text-xs">
              <caption id={rootCaptionId} className="sr-only">
                ルートフォルダ所有者・権限サマリと一括操作の選択
              </caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2.5">
                    <input
                      type="checkbox"
                      aria-label="すべてのルートフォルダを選択"
                      checked={
                        roots.length > 0 &&
                        selectedFolderIdList.length === roots.length
                      }
                      onChange={(event) =>
                        selectAllRoots(event.target.checked)
                      }
                      className="h-3.5 w-3.5 accent-[#5e6ad2]"
                    />
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    ルートフォルダ
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    所有者 / 警告
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Co-Owner
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    Editor
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    総付与数
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    状態
                  </th>
                  <th scope="col" className="px-3 py-2.5">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {roots.map((root) => {
                  const warnings = permissionRootWarnings(root);
                  return (
                    <tr
                      key={root.id}
                      data-testid="admin-permission-root-row"
                      className={root.archived ? 'bg-slate-50/70' : undefined}
                    >
                      <td className="px-3 py-2.5 align-top">
                        <input
                          type="checkbox"
                          aria-label={`${root.name} を選択`}
                          checked={selectedFolderIds.has(root.id)}
                          onChange={(event) =>
                            toggleFolderSelection(
                              root.id,
                              event.target.checked
                            )
                          }
                          className="h-3.5 w-3.5 accent-[#5e6ad2]"
                        />
                      </td>
                      <th
                        scope="row"
                        className="px-3 py-2.5 text-left align-top font-medium text-slate-900"
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate">{root.name}</span>
                          <ClassificationBadge
                            classification={root.classification}
                            compact
                          />
                        </span>
                        <span className="mt-0.5 block font-mono text-[0.625rem] text-slate-500">
                          {root.id.slice(0, 12)}
                        </span>
                      </th>
                      <td className="px-3 py-2.5 align-top">
                        <span className="block text-slate-800">
                          {root.activeOwnerCount} / {root.ownerCount} 名
                        </span>
                        <span className="mt-1 flex flex-wrap gap-1">
                          {warnings.map((warning) => (
                            <span
                              key={warning}
                              className="inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[0.625rem] font-semibold text-amber-800"
                            >
                              {warning}
                            </span>
                          ))}
                          {warnings.length === 0 && (
                            <span className="text-[0.625rem] text-emerald-700">
                              正常
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 align-top text-slate-700">
                        {root.coOwnerCount}
                      </td>
                      <td className="px-3 py-2.5 align-top text-slate-700">
                        {root.editorCount}
                      </td>
                      <td className="px-3 py-2.5 align-top text-slate-700">
                        {root.totalGrantCount}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${
                            root.archived
                              ? 'bg-slate-200 text-slate-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {root.archived ? 'アーカイブ済み' : '有効'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        {canMutate ? (
                          <button
                            type="button"
                            onClick={() =>
                              openBulkModal('transfer', [root.id])
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-50"
                          >
                            <UserCog className="h-3 w-3" aria-hidden="true" />
                            所有者移管
                          </button>
                        ) : (
                          <span className="text-[0.625rem] text-slate-500">
                            読み取りのみ
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!loading && roots.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-3 py-10 text-center text-[0.6875rem] text-slate-500"
                    >
                      ルートフォルダがありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {loading && (
            <p className="flex items-center gap-1.5 text-[0.6875rem] text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              権限監査データを読み込み中...
            </p>
          )}
        </div>

        <AdminPermissionEntriesPanel
          baseId={baseId}
          permissionCaptionId={permissionCaptionId}
          active={activeTab === 'permissions'}
          data={data}
          loading={loading}
          query={query}
          draft={draft}
          roots={roots}
          inheritedFromOptions={inheritedFromOptions}
          sortAnnouncement={sortAnnouncement}
          onDraftChange={setDraft}
          onApplyFilters={applyFilters}
          onClearFilters={clearFilters}
          onSort={handleSort}
          onPageChange={(offset) =>
            setQuery((current) => ({
              ...current,
              offset,
            }))
          }
        />
      </div>

      {modalAction && (
        <AdminPermissionBulkModal
          action={modalAction}
          folderIds={modalFolderIds}
          onClose={closeModal}
          onExecuted={handleBulkExecuted}
        />
      )}
    </section>
  );
}
