'use client';

import {
  AlertTriangle,
  FolderPlus,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ROOT_FOLDER_FIELD_CLASS } from '@/components/admin/root-folders/PrincipalPicker';
import { RootFolderActionModal } from '@/components/admin/root-folders/RootFolderActionModal';
import {
  RootFoldersTable,
  type RootFolderModalState,
} from '@/components/admin/root-folders/RootFoldersTable';
import {
  ApiClientError,
  archiveAdminRootFolder,
  createAdminRootFolder,
  fetchAdminRootFolders,
  grantAdminRootFolderCoOwners,
  restoreAdminRootFolder,
  transferAdminRootFolderOwner,
} from '@/lib/files-api';
import { formatBytes } from '@/lib/formatters';
import type {
  AdminRootFolderListResponse,
  AuthUser,
  ClassificationLabel,
  PrincipalCandidate,
} from '@/types/files';

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
  const [modal, setModal] = useState<RootFolderModalState | null>(null);
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

  function openModal(next: RootFolderModalState) {
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
              className={`${ROOT_FOLDER_FIELD_CLASS} pl-8`}
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

        <RootFoldersTable
          roots={roots}
          loading={loading}
          canMutate={canMutate}
          onOpenModal={openModal}
        />
      </div>

      {modal && (
        <RootFolderActionModal
          modal={modal}
          busy={busy}
          modalError={modalError}
          createName={createName}
          createClassification={createClassification}
          createOwner={createOwner}
          createCoOwners={createCoOwners}
          transferOwner={transferOwner}
          demotePreviousOwnersTo={demotePreviousOwnersTo}
          coOwnerGrants={coOwnerGrants}
          onClose={() => {
            if (busy) return;
            setModal(null);
          }}
          onChangeCreateName={setCreateName}
          onChangeCreateClassification={setCreateClassification}
          onChangeCreateOwner={setCreateOwner}
          onChangeCreateCoOwners={setCreateCoOwners}
          onChangeTransferOwner={setTransferOwner}
          onChangeDemotePreviousOwnersTo={setDemotePreviousOwnersTo}
          onChangeCoOwnerGrants={setCoOwnerGrants}
          onSubmitCreate={submitCreate}
          onSubmitTransfer={submitTransfer}
          onSubmitCoOwners={submitCoOwners}
          onSubmitArchiveOrRestore={() => void submitArchiveOrRestore()}
        />
      )}
    </section>
  );
}
