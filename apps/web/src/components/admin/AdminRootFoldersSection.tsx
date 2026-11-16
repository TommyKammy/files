'use client';

import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  FolderPlus,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import { ModalError } from '@/components/ui/ModalError';
import { ModalHeader } from '@/components/ui/ModalHeader';
import { isImeComposingEvent } from '@/lib/keyboard-shortcuts';
import { formatAuditDateTime, formatBytes } from '@/lib/formatters';
import {
  ApiClientError,
  archiveAdminRootFolder,
  createAdminRootFolder,
  fetchAdminRootFolders,
  grantAdminRootFolderCoOwners,
  restoreAdminRootFolder,
  searchPrincipals,
  transferAdminRootFolderOwner,
} from '@/lib/files-api';
import type {
  AdminRootFolderListResponse,
  AdminRootFolderRecord,
  AuthUser,
  ClassificationLabel,
  PrincipalCandidate,
} from '@/types/files';

const FIELD_CLASS =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40';

const CREATE_DIALOG_LABEL = '新規ルートフォルダを作成';
const TRANSFER_DIALOG_LABEL = 'ルートフォルダの所有者を移管';
const CO_OWNER_DIALOG_LABEL = '共同所有者を一括付与';
const ARCHIVE_DIALOG_LABEL = 'ルートフォルダをアーカイブ';
const RESTORE_DIALOG_LABEL = 'ルートフォルダを復元';

interface ModalState {
  kind: 'create' | 'transfer' | 'coowners' | 'archive' | 'restore';
  root: AdminRootFolderRecord | null;
}

function principalLabel(principal: PrincipalCandidate): string {
  return principal.email ? `${principal.name} (${principal.email})` : principal.name;
}

function PrincipalPicker({
  label,
  description,
  inputId,
  principals,
  allowGroups,
  single = false,
  onChange,
}: {
  label: string;
  description: string;
  inputId: string;
  principals: PrincipalCandidate[];
  allowGroups: boolean;
  single?: boolean;
  onChange: (next: PrincipalCandidate[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PrincipalCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const selectedKeys = useMemo(
    () => new Set(principals.map((item) => `${item.type}:${item.id}`)),
    [principals]
  );
  const resultListId = `${inputId}-results`;
  const descriptionId = `${inputId}-description`;

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      setLoading(false);
      setSearchError(null);
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
          setSearchError(null);
        })
        .catch((err) => {
          if (requestIdRef.current !== requestId) return;
          setResults([]);
          setSearchError(
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
    const next = single ? [principal] : [...principals, principal];
    onChange(next);
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
          aria-controls={resultListId}
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
      {searchError && (
        <p role="alert" className="text-[0.6875rem] text-red-700">
          {searchError}
        </p>
      )}
      <ul
        id={resultListId}
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
      {principals.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label}の選択済み`}>
          {principals.map((principal) => (
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
                    principals.filter(
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

export function AdminRootFoldersSection({
  user,
  onShowAuditLogs,
}: {
  user: AuthUser | null;
  onShowAuditLogs: () => void;
}) {
  const canMutate = user?.role === 'sys_admin';
  const isPrivilegedAdmin =
    user?.role === 'sys_admin' || user?.role === 'sec_admin';
  const [data, setData] = useState<AdminRootFolderListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [ownerMissingOnly, setOwnerMissingOnly] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(true);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const [createName, setCreateName] = useState('');
  const [createClassification, setCreateClassification] =
    useState<ClassificationLabel>('internal');
  const [createOwner, setCreateOwner] = useState<PrincipalCandidate[]>([]);
  const [createCoOwners, setCreateCoOwners] = useState<PrincipalCandidate[]>(
    []
  );
  const [transferOwner, setTransferOwner] = useState<PrincipalCandidate[]>([]);
  const [demotePreviousOwnersTo, setDemotePreviousOwnersTo] = useState<
    'co_owner' | 'editor' | 'revoke'
  >('co_owner');
  const [coOwnerGrants, setCoOwnerGrants] = useState<PrincipalCandidate[]>([]);

  const searchId = useId();
  const refresh = useCallback(async () => {
    if (!isPrivilegedAdmin) return;
    setLoading(true);
    try {
      const response = await fetchAdminRootFolders({
        search: query,
        status: includeArchived ? 'all' : 'active',
      });
      setData(response);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ルートフォルダの読み込みに失敗しました'
      );
    } finally {
      setLoading(false);
    }
  }, [includeArchived, isPrivilegedAdmin, query]);

  useEffect(() => {
    if (!isPrivilegedAdmin) return;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [isPrivilegedAdmin, refresh]);

  function openModal(next: ModalState) {
    setModalError(null);
    setNotice(null);
    if (next.kind === 'create') {
      setCreateName('');
      setCreateClassification('internal');
      setCreateOwner([]);
      setCreateCoOwners([]);
    }
    if (next.kind === 'transfer') {
      setTransferOwner([]);
      setDemotePreviousOwnersTo('co_owner');
    }
    if (next.kind === 'coowners') {
      setCoOwnerGrants([]);
    }
    setModal(next);
  }

  const summary = data?.summary;
  const roots = useMemo(
    () =>
      (data?.roots ?? []).filter(
        (root) =>
          !ownerMissingOnly || root.ownerMissing || root.hasSuspendedOwner
      ),
    [data?.roots, ownerMissingOnly]
  );
  const warningCount =
    (summary?.missingOwnerCount ?? 0) + (summary?.suspendedOwnerCount ?? 0);

  async function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canMutate) return;
    const name = createName.trim();
    if (!name) {
      setModalError('フォルダ名を入力してください');
      return;
    }
    if (createOwner.length === 0) {
      setModalError('所有者 (Owner) を1名選択してください');
      return;
    }
    setBusy(true);
    setModalError(null);
    try {
      const created = await createAdminRootFolder({
        name,
        classification: createClassification,
        ownerUserId: createOwner[0]!.id,
        coOwnerUserIds: createCoOwners
          .filter((principal) => principal.type === 'user')
          .map((principal) => principal.id),
        coOwnerGroupIds: createCoOwners
          .filter((principal) => principal.type === 'group')
          .map((principal) => principal.id),
      });
      setModal(null);
      setNotice(
        `ルートフォルダ「${created.root.name}」を作成し、所有者と共同所有者を設定しました。`
      );
      await refresh();
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : 'ルートフォルダの作成に失敗しました'
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitTransfer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canMutate || !modal?.root) return;
    if (transferOwner.length === 0) {
      setModalError('新しい所有者を選択してください');
      return;
    }
    setBusy(true);
    setModalError(null);
    try {
      const updated = await transferAdminRootFolderOwner(modal.root.id, {
        newOwnerUserId: transferOwner[0]!.id,
        demotePreviousOwnersTo,
      });
      setModal(null);
      setNotice(
        `「${updated.root.name}」の所有者を ${transferOwner[0]!.name} へ移管しました。`
      );
      await refresh();
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : '所有者の移管に失敗しました'
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitCoOwners(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canMutate || !modal?.root) return;
    if (coOwnerGrants.length === 0) {
      setModalError('共同所有者にするユーザーまたはグループを選択してください');
      return;
    }
    setBusy(true);
    setModalError(null);
    try {
      const updated = await grantAdminRootFolderCoOwners(modal.root.id, {
        userIds: coOwnerGrants
          .filter((principal) => principal.type === 'user')
          .map((principal) => principal.id),
        groupIds: coOwnerGrants
          .filter((principal) => principal.type === 'group')
          .map((principal) => principal.id),
      });
      setModal(null);
      setNotice(`「${updated.root.name}」に共同所有者を一括付与しました。`);
      await refresh();
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : '共同所有者の付与に失敗しました'
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitArchiveOrRestore() {
    if (busy || !canMutate || !modal?.root) return;
    const isArchive = modal.kind === 'archive';
    setBusy(true);
    setModalError(null);
    try {
      if (isArchive) {
        await archiveAdminRootFolder(modal.root.id);
        setNotice(`「${modal.root.name}」をアーカイブしました。`);
      } else {
        const restored = await restoreAdminRootFolder(modal.root.id);
        setNotice(`「${restored.root.name}」を復元しました。`);
      }
      setModal(null);
      await refresh();
    } catch (err) {
      setModalError(
        err instanceof ApiClientError
          ? err.message
          : isArchive
            ? 'アーカイブに失敗しました'
            : '復元に失敗しました'
      );
    } finally {
      setBusy(false);
    }
  }

  const dialogLabel =
    modal?.kind === 'create'
      ? CREATE_DIALOG_LABEL
      : modal?.kind === 'transfer'
        ? TRANSFER_DIALOG_LABEL
        : modal?.kind === 'coowners'
          ? CO_OWNER_DIALOG_LABEL
          : modal?.kind === 'archive'
            ? ARCHIVE_DIALOG_LABEL
            : modal?.kind === 'restore'
              ? RESTORE_DIALOG_LABEL
              : 'ルートフォルダ操作';

  return (
    <section
      id="admin-root-folders"
      aria-labelledby="admin-root-folders-heading"
      className="scroll-mt-6 overflow-hidden rounded-lg border border-[#e7e7ea] bg-white"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="min-w-0">
          <h2
            id="admin-root-folders-heading"
            className="text-sm font-semibold text-slate-900"
          >
            ルートフォルダ管理
          </h2>
          <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
            ルート直下の所有者・共同所有者・容量・アーカイブ状態を一覧管理します。
            {canMutate
              ? ' 作成・所有者移管・アーカイブは sys_admin のみ実行できます。'
              : ' sec_admin は読み取り・監査のみ可能です。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onShowAuditLogs}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50"
          >
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            <span>監査ログを表示</span>
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>再読み込み</span>
          </button>
          {canMutate && (
            <button
              type="button"
              onClick={() => openModal({ kind: 'create', root: null })}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2]"
            >
              <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>新規ルートフォルダ作成</span>
            </button>
          )}
        </div>
      </div>

      <div className="space-y-4 px-5 py-4">
        {summary && (
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {[
              { label: 'ルート総数', value: summary.totalRootFolders },
              { label: '有効', value: summary.activeRootFolders },
              { label: 'アーカイブ済み', value: summary.archivedRootFolders },
              { label: '所有者不在', value: summary.missingOwnerCount },
              { label: '停止ユーザー所有', value: summary.suspendedOwnerCount },
              { label: '合計容量', value: formatBytes(summary.totalBytes) },
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
        )}

        {warningCount > 0 && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[0.6875rem] leading-relaxed text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              所有者不在のルートが {summary?.missingOwnerCount ?? 0} 件、停止ユーザーが所有者のルートが{' '}
              {summary?.suspendedOwnerCount ?? 0} 件あります。Closed
              構成では作成・移動が sys_admin に限定されるため、所有者の移管を確認してください。
            </span>
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            role="status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] text-emerald-800"
          >
            {notice}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              id={`${searchId}-search`}
              name="rootFolderSearch"
              type="search"
              aria-label="ルートフォルダ・所有者名・メールで検索"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="フォルダ名 / 所有者名 / メールで検索"
              className={`${FIELD_CLASS} pl-8`}
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-[0.6875rem] text-slate-700">
            <input
              type="checkbox"
              checked={ownerMissingOnly}
              onChange={(event) => setOwnerMissingOnly(event.target.checked)}
              className="h-3.5 w-3.5 accent-[#5e6ad2]"
            />
            所有者不在・停止のみ
          </label>
          <label className="inline-flex items-center gap-1.5 text-[0.6875rem] text-slate-700">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
              className="h-3.5 w-3.5 accent-[#5e6ad2]"
            />
            アーカイブ済みを表示
          </label>
        </div>

        <div
          role="region"
          aria-labelledby="admin-root-folders-table-caption"
          tabIndex={0}
          className="overflow-x-auto rounded-lg border border-slate-200"
        >
          <table className="w-full min-w-[980px] text-left text-xs">
            <caption
              id="admin-root-folders-table-caption"
              className="sr-only"
            >
              ルートフォルダ一覧（所有者・共同所有者・容量・状態）
            </caption>
            <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2.5">
                  フォルダ
                </th>
                <th scope="col" className="px-3 py-2.5">
                  所有者
                </th>
                <th scope="col" className="px-3 py-2.5">
                  共同所有者
                </th>
                <th scope="col" className="px-3 py-2.5">
                  作成者
                </th>
                <th scope="col" className="px-3 py-2.5">
                  アイテム / 容量
                </th>
                <th scope="col" className="px-3 py-2.5">
                  更新日
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
              {roots.map((root) => (
                <tr
                  key={root.id}
                  data-testid="admin-root-folder-row"
                  className={root.deletedAt ? 'bg-slate-50/70' : undefined}
                >
                  <th
                    scope="row"
                    className="px-3 py-2.5 text-left align-top font-medium text-slate-900"
                  >
                    <span className="flex min-w-0 items-center gap-2">
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
                    {root.owners.length === 0 ? (
                      <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[0.625rem] font-semibold text-red-700">
                        所有者不在
                      </span>
                    ) : (
                      <ul className="space-y-1">
                        {root.owners.map((owner) => (
                          <li
                            key={`owner:${owner.granteeType}:${owner.granteeId}`}
                            className="flex flex-wrap items-center gap-1"
                          >
                            <span className="font-medium text-slate-800">
                              {owner.name}
                            </span>
                            {owner.email && (
                              <span className="text-[0.625rem] text-slate-500">
                                {owner.email}
                              </span>
                            )}
                            {owner.status === 'suspended' && (
                              <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[0.625rem] font-semibold text-red-700">
                                停止ユーザー
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {root.ownerMissing && root.owners.length > 0 && (
                      <span className="mt-1 inline-flex rounded-full bg-red-100 px-2 py-0.5 text-[0.625rem] font-semibold text-red-700">
                        所有者不在
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-top text-slate-700">
                    {root.coOwners.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <ul className="space-y-1">
                        {root.coOwners.map((coOwner) => (
                          <li
                            key={`coowner:${coOwner.granteeType}:${coOwner.granteeId}`}
                            className="flex items-center gap-1"
                          >
                            <span>{coOwner.name}</span>
                            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[0.625rem] text-slate-600">
                              {coOwner.granteeType === 'group'
                                ? 'グループ'
                                : 'ユーザー'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2.5 align-top text-[0.6875rem] text-slate-600">
                    <span className="block">{root.createdByName}</span>
                    <span className="block text-[0.625rem] text-slate-500">
                      {root.createdByEmail}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-top text-[0.6875rem] text-slate-600">
                    <span className="block">
                      {root.itemCount.toLocaleString('ja-JP')} 件
                    </span>
                    <span className="block text-[0.625rem] text-slate-500">
                      {formatBytes(root.totalBytes)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-top whitespace-nowrap text-[0.6875rem] text-slate-600">
                    <time dateTime={root.updatedAt}>
                      {formatAuditDateTime(root.updatedAt)}
                    </time>
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${
                        root.deletedAt
                          ? 'bg-slate-200 text-slate-700'
                          : 'bg-emerald-50 text-emerald-700'
                      }`}
                    >
                      {root.deletedAt ? 'アーカイブ済み' : '有効'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 align-top">
                    {canMutate ? (
                      <div className="flex flex-wrap gap-1">
                        {root.deletedAt === null ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                openModal({ kind: 'transfer', root })
                              }
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-50"
                            >
                              <UserCog className="h-3 w-3" />
                              所有者移管
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                openModal({ kind: 'coowners', root })
                              }
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-slate-700 hover:bg-slate-50"
                            >
                              <Users className="h-3 w-3" />
                              グループ/共同所有者
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                openModal({ kind: 'archive', root })
                              }
                              className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-amber-800 hover:bg-amber-50"
                            >
                              <Archive className="h-3 w-3" />
                              アーカイブ
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openModal({ kind: 'restore', root })}
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-white px-2 py-1 text-[0.625rem] font-medium text-emerald-800 hover:bg-emerald-50"
                          >
                            <ArchiveRestore className="h-3 w-3" />
                            復元
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-[0.625rem] text-slate-500">
                        読み取りのみ
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {!loading && roots.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-10 text-center text-[0.6875rem] text-slate-500"
                  >
                    条件に一致するルートフォルダがありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {loading && (
          <p className="flex items-center gap-1.5 text-[0.6875rem] text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ルートフォルダを読み込み中...
          </p>
        )}
      </div>

      {modal && (
        <ModalShell
          label={
            modal.root && modal.kind !== 'create'
              ? `${dialogLabel}: ${modal.root.name}`
              : dialogLabel
          }
          onClose={() => {
            if (busy) return;
            setModal(null);
          }}
          className="w-full max-w-lg overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
        >
          <ModalHeader
            icon={
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
                {modal.kind === 'archive' ? (
                  <Archive className="h-4 w-4" />
                ) : modal.kind === 'restore' ? (
                  <ArchiveRestore className="h-4 w-4" />
                ) : modal.kind === 'coowners' ? (
                  <Users className="h-4 w-4" />
                ) : modal.kind === 'transfer' ? (
                  <UserCog className="h-4 w-4" />
                ) : (
                  <FolderPlus className="h-4 w-4" />
                )}
              </span>
            }
            title={
              modal.kind === 'create'
                ? CREATE_DIALOG_LABEL
                : modal.kind === 'transfer'
                  ? `${TRANSFER_DIALOG_LABEL}: ${modal.root?.name ?? ''}`
                  : modal.kind === 'coowners'
                    ? `${CO_OWNER_DIALOG_LABEL}: ${modal.root?.name ?? ''}`
                    : modal.kind === 'archive'
                      ? `${ARCHIVE_DIALOG_LABEL}: ${modal.root?.name ?? ''}`
                      : `${RESTORE_DIALOG_LABEL}: ${modal.root?.name ?? ''}`
            }
            subtitle={
              modal.kind === 'create'
                ? '所有者と共同所有者を同時に設定します。'
                : modal.kind === 'archive'
                  ? '配下のフォルダ・ファイルもまとめてアーカイブされます。'
                  : modal.kind === 'restore'
                    ? 'アーカイブされていた配下のフォルダ・ファイルも復元されます。'
                    : undefined
            }
            onClose={() => {
              if (busy) return;
              setModal(null);
            }}
          />

          {(modal.kind === 'archive' || modal.kind === 'restore') && (
            <div className="space-y-3 px-5 py-4 text-xs">
              <ModalError message={modalError} />
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-amber-900">
                {modal.kind === 'archive'
                  ? 'アーカイブすると、このルート配下のアイテムはワークスペースから非表示になります。削除ではなく復元可能です。'
                  : '復元すると、アーカイブ時に非表示になった配下のフォルダ・ファイルが再び表示されます。'}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setModal(null)}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  data-autofocus
                  disabled={busy}
                  onClick={() => void submitArchiveOrRestore()}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3.5 text-xs font-semibold text-white disabled:opacity-50 ${
                    modal.kind === 'archive'
                      ? 'bg-amber-600 hover:bg-amber-700'
                      : 'bg-emerald-600 hover:bg-emerald-700'
                  }`}
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {modal.kind === 'archive' ? 'アーカイブする' : '復元する'}
                </button>
              </div>
            </div>
          )}

          {modal.kind === 'create' && (
            <form
              onSubmit={submitCreate}
              onKeyDown={(event) => {
                if (isImeComposingEvent(event.nativeEvent) && event.key === 'Enter') {
                  event.preventDefault();
                }
              }}
              className="space-y-3 px-5 py-4 text-xs"
            >
              <ModalError message={modalError} />
              <div>
                <label
                  htmlFor="root-folder-name"
                  className="block text-xs font-medium text-slate-700"
                >
                  フォルダ名
                </label>
                <input
                  id="root-folder-name"
                  name="rootFolderName"
                  type="text"
                  required
                  maxLength={255}
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  className={`${FIELD_CLASS} mt-1`}
                />
              </div>
              <div>
                <label
                  htmlFor="root-folder-classification"
                  className="block text-xs font-medium text-slate-700"
                >
                  機密区分
                </label>
                <select
                  id="root-folder-classification"
                  name="rootFolderClassification"
                  value={createClassification}
                  onChange={(event) =>
                    setCreateClassification(
                      event.target.value as ClassificationLabel
                    )
                  }
                  className={`${FIELD_CLASS} mt-1`}
                >
                  <option value="unset">未設定</option>
                  <option value="public">公開</option>
                  <option value="internal">社内</option>
                  <option value="confidential">極秘</option>
                </select>
              </div>
              <PrincipalPicker
                label="所有者 (Owner)"
                description="テナント内のアクティブユーザーを1名選択します。"
                inputId="root-folder-owner-search"
                principals={createOwner}
                allowGroups={false}
                single
                onChange={setCreateOwner}
              />
              <PrincipalPicker
                label="共同所有者 (Co-Owner)"
                description="任意のユーザーまたは SCIM グループを複数選択できます。"
                inputId="root-folder-coowner-search"
                principals={createCoOwners}
                allowGroups
                onChange={setCreateCoOwners}
              />
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setModal(null)}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  作成する
                </button>
              </div>
            </form>
          )}

          {modal.kind === 'transfer' && (
            <form
              onSubmit={submitTransfer}
              onKeyDown={(event) => {
                if (isImeComposingEvent(event.nativeEvent) && event.key === 'Enter') {
                  event.preventDefault();
                }
              }}
              className="space-y-3 px-5 py-4 text-xs"
            >
              <ModalError message={modalError} />
              <PrincipalPicker
                label="新しい所有者"
                description="テナント内のアクティブユーザーを選択します。"
                inputId="root-folder-transfer-owner-search"
                principals={transferOwner}
                allowGroups={false}
                single
                onChange={setTransferOwner}
              />
              <div>
                <label
                  htmlFor="root-folder-demote"
                  className="block text-xs font-medium text-slate-700"
                >
                  以前の所有者の扱い
                </label>
                <select
                  id="root-folder-demote"
                  name="demotePreviousOwnersTo"
                  value={demotePreviousOwnersTo}
                  onChange={(event) =>
                    setDemotePreviousOwnersTo(
                      event.target.value as 'co_owner' | 'editor' | 'revoke'
                    )
                  }
                  className={`${FIELD_CLASS} mt-1`}
                >
                  <option value="co_owner">共同所有者 (co_owner) へ降格</option>
                  <option value="editor">編集者 (editor) へ降格</option>
                  <option value="revoke">権限を削除</option>
                </select>
                <p className="mt-1 text-[0.6875rem] leading-relaxed text-slate-500">
                  新しい所有者は常に有効な owner として残るため、所有者が 0
                  名になることはありません（最終所有者ガード）。
                </p>
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setModal(null)}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  所有者を移管する
                </button>
              </div>
            </form>
          )}

          {modal.kind === 'coowners' && (
            <form
              onSubmit={submitCoOwners}
              onKeyDown={(event) => {
                if (isImeComposingEvent(event.nativeEvent) && event.key === 'Enter') {
                  event.preventDefault();
                }
              }}
              className="space-y-3 px-5 py-4 text-xs"
            >
              <ModalError message={modalError} />
              <PrincipalPicker
                label="共同所有者 (Co-Owner)"
                description="ユーザーまたは SCIM グループを複数選択します。既存の owner は降格されません。"
                inputId="root-folder-bulk-coowner-search"
                principals={coOwnerGrants}
                allowGroups
                onChange={setCoOwnerGrants}
              />
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setModal(null)}
                  className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white hover:bg-[#4f5ac2] disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  一括付与する
                </button>
              </div>
            </form>
          )}
        </ModalShell>
      )}
    </section>
  );
}
