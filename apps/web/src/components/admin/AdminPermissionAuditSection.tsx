'use client';

import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  UserCog,
  Users,
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
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import {
  buildPermissionExportHref,
  createBulkIdempotencyKey,
  DEFAULT_PERMISSION_AUDIT_QUERY,
  formatAdminBulkSummary,
  formatGranteeStatusLabel,
  formatPermissionRoleLabel,
  formatPermissionSourceLabel,
  isPermissionAuditFilterActive,
  permissionRootWarnings,
  summarizePermissionRoots,
  togglePermissionSort,
} from '@/lib/admin-permission-audit';
import { formatAuditDateTime } from '@/lib/formatters';
import {
  ApiClientError,
  bulkArchiveAdminRootFolders,
  bulkGrantAdminRootFolderCoOwners,
  bulkRestoreAdminRootFolders,
  bulkTransferAdminRootFolderOwners,
  fetchAdminPermissionAudit,
  searchPrincipals,
} from '@/lib/files-api';
import type {
  AdminBulkResponse,
  AdminPermissionAuditEntry,
  AdminPermissionAuditQuery,
  AdminPermissionAuditResponse,
  AdminPermissionGranteeStatus,
  AdminPermissionHealth,
  AdminPermissionRootSummary,
  AdminPermissionSortBy,
  AdminPermissionSource,
  AdminPermissionTargetType,
  AuthUser,
  PrincipalCandidate,
  ResourceRole,
} from '@/types/files';

const FIELD_CLASS =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40';
const PAGE_SIZE = 50;
const ROLE_OPTIONS: Array<{ value: ResourceRole; label: string }> = [
  { value: 'owner', label: 'オーナー' },
  { value: 'co_owner', label: '共同所有者' },
  { value: 'editor', label: '編集者' },
  { value: 'viewer_uploader', label: '閲覧 + アップロード' },
  { value: 'previewer_uploader', label: 'プレビュー + アップロード' },
  { value: 'viewer', label: '閲覧者' },
  { value: 'previewer', label: 'プレビュー' },
  { value: 'uploader', label: 'アップロード' },
];

type AuditTab = 'roots' | 'permissions';
type BulkAction = 'coowner' | 'transfer' | 'archive' | 'restore';

interface DraftFilters {
  targetType: AdminPermissionTargetType;
  rootFolderId: string;
  role: string;
  source: AdminPermissionSource;
  inheritedFromId: string;
  grantee: string;
  grantedBy: string;
  from: string;
  to: string;
  granteeStatus: AdminPermissionGranteeStatus | '';
  health: AdminPermissionHealth;
}

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

function principalLabel(principal: PrincipalCandidate): string {
  return principal.email
    ? `${principal.name} (${principal.email})`
    : principal.name;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'skipped':
      return 'bg-amber-50 text-amber-800 border-amber-200';
    default:
      return 'bg-red-50 text-red-700 border-red-200';
  }
}

function PrincipalPicker({
  label,
  description,
  inputId,
  allowGroups,
  single = false,
  selected,
  onChange,
}: {
  label: string;
  description: string;
  inputId: string;
  allowGroups: boolean;
  single?: boolean;
  selected: PrincipalCandidate[];
  onChange: (next: PrincipalCandidate[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PrincipalCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const selectedKeys = useMemo(
    () => new Set(selected.map((item) => `${item.type}:${item.id}`)),
    [selected]
  );
  const listId = `${inputId}-results`;
  const descriptionId = `${inputId}-description`;

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchPrincipals(trimmed)
        .then((response) => {
          if (requestIdRef.current !== requestId) return;
          setResults(
            response.principals.filter(
              (candidate) =>
                (allowGroups || candidate.type === 'user') &&
                !selectedKeys.has(`${candidate.type}:${candidate.id}`)
            )
          );
          setError(null);
        })
        .catch((err) => {
          if (requestIdRef.current !== requestId) return;
          setResults([]);
          setError(
            err instanceof ApiClientError
              ? err.message
              : 'ユーザー・グループの検索に失敗しました'
          );
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, allowGroups, selectedKeys]);

  function addPrincipal(principal: PrincipalCandidate) {
    onChange(single ? [principal] : [...selected, principal]);
    setQuery('');
    setResults([]);
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-xs font-medium text-slate-700">
        {label}
      </label>
      <p id={descriptionId} className="text-[0.6875rem] text-slate-500">
        {description}
      </p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
        <input
          id={inputId}
          name={inputId}
          type="search"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={descriptionId}
          aria-controls={listId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            allowGroups ? '名前・メール・グループ名で検索' : '名前・メールで検索'
          }
          className={`${FIELD_CLASS} pl-8`}
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-2.5 h-3.5 w-3.5 animate-spin text-slate-400" />
        )}
      </div>
      {error && (
        <p role="alert" className="text-[0.6875rem] text-red-700">
          {error}
        </p>
      )}
      <ul
        id={listId}
        role="listbox"
        aria-label={`${label}の検索候補`}
        className="max-h-36 overflow-y-auto rounded-lg border border-slate-200 bg-white"
      >
        {results.map((principal) => (
          <li key={`${principal.type}:${principal.id}`}>
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => addPrincipal(principal)}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-blue-50 focus-visible:bg-blue-50 focus-visible:outline-none"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium text-slate-800">
                  {principal.name}
                </span>
                {principal.email && (
                  <span className="ml-1 text-slate-500">{principal.email}</span>
                )}
              </span>
              <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] text-slate-600">
                {principal.type === 'group' ? 'グループ' : 'ユーザー'}
              </span>
            </button>
          </li>
        ))}
        {!loading && query.trim().length > 0 && results.length === 0 && (
          <li className="px-2.5 py-2 text-[0.6875rem] text-slate-500">
            候補がありません
          </li>
        )}
      </ul>
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label}の選択済み`}>
          {selected.map((principal) => (
            <li
              key={`selected:${principal.type}:${principal.id}`}
              className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[0.6875rem] text-blue-900"
            >
              <span className="max-w-56 truncate">
                {principalLabel(principal)}
              </span>
              <button
                type="button"
                aria-label={`${principal.name}を選択から外す`}
                onClick={() =>
                  onChange(
                    selected.filter(
                      (item) =>
                        !(
                          item.type === principal.type &&
                          item.id === principal.id
                        )
                    )
                  )
                }
                className="rounded-full p-0.5 hover:bg-blue-100"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BulkResultTable({
  response,
  captionId,
}: {
  response: AdminBulkResponse;
  captionId: string;
}) {
  return (
    <div className="space-y-2">
      <p
        role={response.dryRun ? undefined : 'status'}
        className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] text-slate-700"
      >
        {formatAdminBulkSummary(response.summary)}
        {response.replayed ? '（保存済みの実行結果を再生しました）' : ''}
      </p>
      <div
        role="region"
        aria-labelledby={captionId}
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-lg border border-slate-200"
      >
        <table className="w-full min-w-[520px] text-left text-[0.6875rem]">
          <caption id={captionId} className="sr-only">
            一括操作の対象フォルダ別結果
          </caption>
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th scope="col" className="px-2.5 py-2">
                フォルダ
              </th>
              <th scope="col" className="px-2.5 py-2">
                状態
              </th>
              <th scope="col" className="px-2.5 py-2">
                理由 / 結果
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {response.results.map((item) => (
              <tr key={item.folderId} data-testid="admin-bulk-result-row">
                <td className="px-2.5 py-2">
                  <span className="block font-medium text-slate-800">
                    {item.folderName || '(名称不明)'}
                  </span>
                  <span className="block font-mono text-[0.625rem] text-slate-500">
                    {item.folderId}
                  </span>
                </td>
                <td className="px-2.5 py-2">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 font-semibold ${statusBadgeClass(item.status)}`}
                  >
                    {item.status}
                  </span>
                  {item.code && (
                    <span className="mt-1 block font-mono text-[0.625rem] text-slate-500">
                      {item.code}
                    </span>
                  )}
                </td>
                <td className="px-2.5 py-2 text-slate-600">
                  {item.message ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
  const [modalPreview, setModalPreview] = useState<AdminBulkResponse | null>(
    null
  );
  const [modalResult, setModalResult] = useState<AdminBulkResponse | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const busyRef = useRef(false);
  const [coOwnerGroups, setCoOwnerGroups] = useState<PrincipalCandidate[]>([]);
  const [transferOwner, setTransferOwner] = useState<PrincipalCandidate[]>([]);
  const [demotePreviousOwnersTo, setDemotePreviousOwnersTo] = useState<
    'co_owner' | 'editor' | 'revoke'
  >('co_owner');
  const [idempotencyKey, setIdempotencyKey] = useState('');

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
    setModalPreview(null);
    setModalResult(null);
    setModalError(null);
    setModalBusy(false);
    busyRef.current = false;
    setCoOwnerGroups([]);
    setTransferOwner([]);
    setDemotePreviousOwnersTo('co_owner');
    setIdempotencyKey(createBulkIdempotencyKey(action));
    if (action === 'archive' || action === 'restore') {
      void previewBulk(action, folderIds, []);
    }
  }

  function closeModal() {
    if (busyRef.current) return;
    setModalAction(null);
    setModalPreview(null);
    setModalResult(null);
    setModalError(null);
  }

  function buildPayload(
    action: BulkAction,
    folderIds: string[],
    groups: PrincipalCandidate[],
    dryRun: boolean
  ) {
    const base = {
      folderIds,
      dryRun,
      ...(dryRun ? {} : { idempotencyKey }),
    };
    if (action === 'coowner') {
      return {
        kind: 'coowner' as const,
        payload: {
          ...base,
          groupIds: groups
            .filter((principal) => principal.type === 'group')
            .map((principal) => principal.id),
        },
      };
    }
    if (action === 'transfer') {
      return {
        kind: 'transfer' as const,
        payload: {
          ...base,
          newOwnerUserId: transferOwner[0]?.id ?? '',
          demotePreviousOwnersTo,
        },
      };
    }
    return {
      kind: action as 'archive' | 'restore',
      payload: base,
    };
  }

  async function callBulk(
    action: BulkAction,
    folderIds: string[],
    groups: PrincipalCandidate[],
    dryRun: boolean
  ): Promise<AdminBulkResponse> {
    const built = buildPayload(action, folderIds, groups, dryRun);
    if (built.kind === 'coowner') {
      return bulkGrantAdminRootFolderCoOwners(built.payload);
    }
    if (built.kind === 'transfer') {
      return bulkTransferAdminRootFolderOwners(built.payload);
    }
    if (built.kind === 'archive') {
      return bulkArchiveAdminRootFolders(built.payload);
    }
    return bulkRestoreAdminRootFolders(built.payload);
  }

  async function previewBulk(
    action: BulkAction,
    folderIds: string[],
    groups: PrincipalCandidate[]
  ) {
    if (busyRef.current) return;
    if (action === 'coowner' && groups.length === 0) {
      setModalError('SCIM グループを1つ以上選択してください');
      return;
    }
    if (action === 'transfer' && !transferOwner[0]) {
      setModalError('新しい所有者を選択してください');
      return;
    }
    busyRef.current = true;
    setModalBusy(true);
    setModalError(null);
    try {
      const response = await callBulk(action, folderIds, groups, true);
      setModalPreview(response);
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : '影響プレビューの取得に失敗しました'
      );
    } finally {
      busyRef.current = false;
      setModalBusy(false);
    }
  }

  async function executeBulk() {
    if (!modalAction || !modalPreview || busyRef.current) return;
    busyRef.current = true;
    setModalBusy(true);
    setModalError(null);
    try {
      const response = await callBulk(
        modalAction,
        modalFolderIds,
        coOwnerGroups,
        false
      );
      setModalResult(response);
      setNotice(
        `${response.summary.succeeded}件成功 / ${response.summary.skipped}件スキップ / ${response.summary.failed}件失敗`
      );
      setSelectedFolderIds(new Set());
      await loadAudit(query);
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : '一括操作の実行に失敗しました'
      );
    } finally {
      busyRef.current = false;
      setModalBusy(false);
    }
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

  const modalTitle =
    modalAction === 'coowner'
      ? 'グループ共同所有者一括付与'
      : modalAction === 'transfer'
        ? '所有者一括移管'
        : modalAction === 'archive'
          ? 'ルートフォルダ一括アーカイブ'
          : modalAction === 'restore'
            ? 'ルートフォルダ一括復元'
            : '一括操作';

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

        <div
          role="tabpanel"
          aria-labelledby={`${baseId}-permissions-tab`}
          hidden={activeTab !== 'permissions'}
          className="space-y-4 pt-4"
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">対象種別</span>
              <select
                aria-label="権限監査の対象種別"
                value={draft.targetType}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    targetType: event.target.value as AdminPermissionTargetType,
                  }))
                }
                className={FIELD_CLASS}
              >
                <option value="all">すべて</option>
                <option value="folder">フォルダ</option>
                <option value="file">ファイル</option>
              </select>
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">ルートフォルダ</span>
              <select
                aria-label="権限監査のルートフォルダ"
                value={draft.rootFolderId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    rootFolderId: event.target.value,
                  }))
                }
                className={FIELD_CLASS}
              >
                <option value="">すべて</option>
                {roots.map((root) => (
                  <option key={root.id} value={root.id}>
                    {root.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">ロール</span>
              <select
                aria-label="権限監査のロール"
                value={draft.role}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    role: event.target.value,
                  }))
                }
                className={FIELD_CLASS}
              >
                <option value="">すべて</option>
                {ROLE_OPTIONS.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">直接 / 継承</span>
              <select
                aria-label="権限監査の直接継承"
                value={draft.source}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    source: event.target.value as AdminPermissionSource,
                  }))
                }
                className={FIELD_CLASS}
              >
                <option value="all">すべて</option>
                <option value="direct">直接付与</option>
                <option value="inherited">継承</option>
              </select>
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">継承元フォルダ</span>
              <select
                aria-label="権限監査の継承元フォルダ"
                value={draft.inheritedFromId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    inheritedFromId: event.target.value,
                  }))
                }
                className={FIELD_CLASS}
              >
                <option value="">すべて</option>
                {inheritedFromOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">付与先検索</span>
              <input
                type="search"
                aria-label="権限監査の付与先検索"
                value={draft.grantee}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    grantee: event.target.value,
                  }))
                }
                placeholder="名前・メール・グループ名・ID"
                className={FIELD_CLASS}
              />
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">付与者</span>
              <input
                type="search"
                aria-label="権限監査の付与者"
                value={draft.grantedBy}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    grantedBy: event.target.value,
                  }))
                }
                placeholder="ID・メール・表示名"
                className={FIELD_CLASS}
              />
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">付与先の状態</span>
              <select
                aria-label="権限監査の付与先状態"
                value={draft.granteeStatus}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    granteeStatus: event.target
                      .value as DraftFilters['granteeStatus'],
                  }))
                }
                className={FIELD_CLASS}
              >
                <option value="">すべて</option>
                <option value="active">有効</option>
                <option value="suspended">停止中</option>
                <option value="deleted">削除済み</option>
              </select>
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">健全性</span>
              <select
                aria-label="権限監査の健全性"
                value={draft.health}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    health: event.target.value as AdminPermissionHealth,
                  }))
                }
                className={FIELD_CLASS}
              >
                <option value="all">すべて</option>
                <option value="owner_missing">所有者不在</option>
                <option value="inactive_owner">停止/削除オーナー</option>
              </select>
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">付与日 from</span>
              <input
                type="date"
                aria-label="権限監査の付与日 from"
                value={draft.from}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    from: event.target.value,
                  }))
                }
                className={FIELD_CLASS}
              />
            </label>
            <label className="space-y-1 text-[0.6875rem] text-slate-600">
              <span className="block font-medium">付与日 to</span>
              <input
                type="date"
                aria-label="権限監査の付与日 to"
                value={draft.to}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    to: event.target.value,
                  }))
                }
                className={FIELD_CLASS}
              />
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={applyFilters}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-xs font-medium text-white hover:bg-[#4f5ac2]"
              >
                <Search className="h-3.5 w-3.5" aria-hidden="true" />
                フィルタを適用
              </button>
              <button
                type="button"
                onClick={clearFilters}
                disabled={
                  !isPermissionAuditFilterActive(query) &&
                  !isPermissionAuditFilterActive({
                    ...draft,
                    granteeStatus: draft.granteeStatus || null,
                  })
                }
                className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                解除
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[0.6875rem] text-slate-600">
              {data?.totalCount ?? 0} 件中 {entries.length} 件を表示
              {entries.length > 0 && (
                <>
                  {' '}
                  ({(query.offset ?? 0) + 1}–
                  {(query.offset ?? 0) + entries.length})
                </>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={buildPermissionExportHref(query, 'csv')}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                CSV
              </a>
              <a
                href={buildPermissionExportHref(query, 'json')}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                JSON
              </a>
              <button
                type="button"
                disabled={(query.offset ?? 0) === 0 || loading}
                onClick={() =>
                  setQuery((current) => ({
                    ...current,
                    offset: Math.max(0, (current.offset ?? 0) - PAGE_SIZE),
                  }))
                }
                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                前へ
              </button>
              <button
                type="button"
                disabled={!data?.nextOffset || loading}
                onClick={() =>
                  setQuery((current) => ({
                    ...current,
                    offset: data?.nextOffset ?? current.offset,
                  }))
                }
                className="inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                次へ
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div role="status" className="sr-only">
            {sortAnnouncement}
          </div>

          <div
            role="region"
            aria-labelledby={permissionCaptionId}
            tabIndex={0}
            className="overflow-x-auto rounded-lg border border-slate-200"
          >
            <table className="w-full min-w-[1180px] text-left text-xs">
              <caption id={permissionCaptionId} className="sr-only">
                テナント権限一覧（対象・付与先・ロール・直接/継承・付与者・日時）
              </caption>
              <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
                <tr>
                  <th
                    scope="col"
                    aria-sort={
                      (query.sortBy ?? 'createdAt') === 'targetName'
                        ? query.sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className="px-2 py-1"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('targetName')}
                      className="inline-flex min-h-6 w-full items-center gap-1 px-2 py-1.5 text-left font-semibold hover:text-slate-800"
                    >
                      対象
                      {(query.sortBy ?? 'createdAt') === 'targetName' &&
                        (query.sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        ))}
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      (query.sortBy ?? 'createdAt') === 'granteeName'
                        ? query.sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className="px-2 py-1"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('granteeName')}
                      className="inline-flex min-h-6 w-full items-center gap-1 px-2 py-1.5 text-left font-semibold hover:text-slate-800"
                    >
                      付与先
                      {(query.sortBy ?? 'createdAt') === 'granteeName' &&
                        (query.sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        ))}
                    </button>
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      (query.sortBy ?? 'createdAt') === 'role'
                        ? query.sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className="px-2 py-1"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('role')}
                      className="inline-flex min-h-6 w-full items-center gap-1 px-2 py-1.5 text-left font-semibold hover:text-slate-800"
                    >
                      ロール
                      {(query.sortBy ?? 'createdAt') === 'role' &&
                        (query.sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        ))}
                    </button>
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    直接 / 継承
                  </th>
                  <th scope="col" className="px-4 py-2.5">
                    付与者
                  </th>
                  <th
                    scope="col"
                    aria-sort={
                      (query.sortBy ?? 'createdAt') === 'createdAt'
                        ? query.sortDir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className="px-2 py-1"
                  >
                    <button
                      type="button"
                      onClick={() => handleSort('createdAt')}
                      className="inline-flex min-h-6 w-full items-center gap-1 px-2 py-1.5 text-left font-semibold hover:text-slate-800"
                    >
                      付与日時
                      {(query.sortBy ?? 'createdAt') === 'createdAt' &&
                        (query.sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        ))}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((entry: AdminPermissionAuditEntry) => (
                  <tr
                    key={entry.id}
                    data-testid="admin-permission-entry-row"
                    className="hover:bg-slate-50/70"
                  >
                    <td className="px-4 py-2.5 align-top">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {entry.targetType === 'folder' ? (
                          <Folder
                            className="h-3.5 w-3.5 text-slate-500"
                            aria-hidden="true"
                          />
                        ) : (
                          <FileText
                            className="h-3.5 w-3.5 text-slate-500"
                            aria-hidden="true"
                          />
                        )}
                        <span className="font-medium text-slate-900">
                          {entry.targetName}
                        </span>
                        <ClassificationBadge
                          classification={entry.classification}
                          compact
                        />
                        {entry.targetDeletedAt && (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[0.625rem] font-semibold text-slate-700">
                            削除/アーカイブ済み
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[0.625rem] text-slate-500">
                        {entry.targetType === 'folder' ? 'フォルダ' : 'ファイル'}
                        {entry.rootFolderName
                          ? ` / ルート: ${entry.rootFolderName}`
                          : ''}
                      </span>
                      {entry.classification === 'confidential' && (
                        <span className="mt-1 inline-flex rounded-full bg-purple-50 px-2 py-0.5 text-[0.625rem] font-semibold text-purple-800">
                          メタデータのみ (DLP)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <span className="block font-medium text-slate-800">
                        {entry.granteeName}
                      </span>
                      {entry.granteeEmail && (
                        <span className="block text-[0.625rem] text-slate-500">
                          {entry.granteeEmail}
                        </span>
                      )}
                      <span className="mt-1 flex flex-wrap items-center gap-1">
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[0.625rem] text-slate-600">
                          {entry.granteeType === 'group' ? 'グループ' : 'ユーザー'}
                        </span>
                        {entry.granteeStatus !== 'active' && (
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[0.625rem] font-semibold text-red-700">
                            {formatGranteeStatusLabel(entry.granteeStatus)}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[0.625rem] font-semibold text-blue-800">
                        {formatPermissionRoleLabel(entry.role)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${
                          entry.source === 'direct'
                            ? 'bg-emerald-50 text-emerald-700'
                            : 'bg-indigo-50 text-indigo-700'
                        }`}
                      >
                        {entry.source === 'direct' ? '直接付与' : '継承'}
                      </span>
                      <span className="mt-1 block text-[0.625rem] text-slate-500">
                        {formatPermissionSourceLabel(entry)}
                      </span>
                      {entry.source === 'inherited' &&
                        entry.inheritedDepth > 0 && (
                          <span className="block text-[0.625rem] text-slate-400">
                            深さ {entry.inheritedDepth}
                          </span>
                        )}
                    </td>
                    <td className="px-4 py-2.5 align-top text-[0.6875rem] text-slate-600">
                      <span className="block">
                        {entry.grantedByName ?? entry.grantedBy}
                      </span>
                      {entry.grantedByEmail && (
                        <span className="block text-[0.625rem] text-slate-500">
                          {entry.grantedByEmail}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 align-top whitespace-nowrap text-[0.6875rem] text-slate-600">
                      <time dateTime={entry.createdAt}>
                        {formatAuditDateTime(entry.createdAt)}
                      </time>
                    </td>
                  </tr>
                ))}
                {!loading && entries.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-10 text-center text-[0.6875rem] text-slate-500"
                    >
                      条件に一致する権限がありません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {loading && (
            <p className="flex items-center gap-1.5 text-[0.6875rem] text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              権限一覧を読み込み中...
            </p>
          )}
        </div>
      </div>

      {modalAction && (
        <ModalShell
          label={modalTitle}
          onClose={closeModal}
          className="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <ModalHeader
            icon={
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                {modalAction === 'coowner' ? (
                  <Users className="h-4 w-4" />
                ) : modalAction === 'transfer' ? (
                  <UserCog className="h-4 w-4" />
                ) : modalAction === 'archive' ? (
                  <Archive className="h-4 w-4" />
                ) : (
                  <ArchiveRestore className="h-4 w-4" />
                )}
              </span>
            }
            title={modalTitle}
            subtitle={`対象 ${modalFolderIds.length} 件。プレビューを確認してから実行します。`}
            onClose={closeModal}
          />
          <div className="max-h-[70vh] space-y-3 overflow-y-auto px-5 py-4 text-xs">
            <ModalError message={modalError} />
            {modalAction === 'coowner' && (
              <PrincipalPicker
                label="SCIM グループ"
                description="選択したすべてのルートフォルダに co_owner として一括付与します。既存の owner は降格されません。"
                inputId={`${baseId}-bulk-group-search`}
                allowGroups
                selected={coOwnerGroups}
                onChange={setCoOwnerGroups}
              />
            )}
            {modalAction === 'transfer' && (
              <>
                <PrincipalPicker
                  label="新しい所有者"
                  description="テナント内のアクティブユーザーを1名選択します。"
                  inputId={`${baseId}-bulk-transfer-owner-search`}
                  allowGroups={false}
                  single
                  selected={transferOwner}
                  onChange={setTransferOwner}
                />
                <label className="block space-y-1 text-xs font-medium text-slate-700">
                  <span>以前の所有者の扱い</span>
                  <select
                    aria-label="以前の所有者の扱い"
                    value={demotePreviousOwnersTo}
                    onChange={(event) =>
                      setDemotePreviousOwnersTo(
                        event.target.value as
                          | 'co_owner'
                          | 'editor'
                          | 'revoke'
                      )
                    }
                    className={FIELD_CLASS}
                  >
                    <option value="co_owner">共同所有者へ降格</option>
                    <option value="editor">編集者へ降格</option>
                    <option value="revoke">権限を削除</option>
                  </select>
                </label>
              </>
            )}
            {(modalAction === 'archive' || modalAction === 'restore') && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900">
                {modalAction === 'archive'
                  ? '配下のフォルダ・ファイルもまとめてアーカイブされます。ファイルロックがある場合は失敗します。'
                  : 'アーカイブ済みの配下フォルダ・ファイルもまとめて復元されます。'}
              </p>
            )}

            {!modalPreview && !modalResult && (
              <button
                type="button"
                disabled={modalBusy}
                onClick={() =>
                  void previewBulk(
                    modalAction,
                    modalFolderIds,
                    coOwnerGroups
                  )
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                {modalBusy && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                )}
                影響をプレビュー
              </button>
            )}

            {modalPreview && !modalResult && (
              <BulkResultTable
                response={modalPreview}
                captionId={`${baseId}-bulk-preview-caption`}
              />
            )}
            {modalResult && (
              <BulkResultTable
                response={modalResult}
                captionId={`${baseId}-bulk-result-caption`}
              />
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                data-autofocus
                disabled={modalBusy}
                onClick={closeModal}
                className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                {modalResult ? '閉じる' : 'キャンセル'}
              </button>
              {!modalResult && (
                <button
                  type="button"
                  disabled={!modalPreview || modalBusy}
                  onClick={() => void executeBulk()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3.5 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {modalBusy && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
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
