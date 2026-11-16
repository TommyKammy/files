'use client';

import {
  AlertTriangle,
  ArchiveRestore,
  Download,
  FileText,
  Folder,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import { TrashRetentionBadge } from '@/components/TrashRetentionBadge';
import {
  ADMIN_TRASH_RETENTION_OPTIONS,
  ADMIN_TRASH_SORT_OPTIONS,
  buildAdminTrashAuditCsvHref,
  formatAdminTrashAuditEntry,
  formatAdminTrashPermissionSummary,
  formatAdminTrashPerson,
  getAdminTrashEmptyState,
  isAdminTrashFilterActive,
} from '@/lib/admin-trash';
import { useAdminTrash } from '@/lib/use-admin-trash';
import { formatAuditDateTime, formatBytes } from '@/lib/formatters';
import type { AdminTrashItem, AuthUser } from '@/types/files';

const EMPTY_TENANT_TRASH_CONFIRMATION = 'EMPTY_TENANT_TRASH';

interface RestoreFormOptions {
  target: 'original' | 'root';
  restoreParentChain: boolean;
  renameOnConflict: boolean;
}

const DEFAULT_RESTORE_OPTIONS: RestoreFormOptions = {
  target: 'original',
  restoreParentChain: true,
  renameOnConflict: false,
};

const FIELD_CLASS =
  'h-7 rounded-md border border-[#e1e1e4] bg-white px-2 text-[0.75rem] text-[#111214] focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]/40';

function TrashIcon({ type }: { type: AdminTrashItem['type'] }) {
  return type === 'folder' ? (
    <Folder className="h-3.5 w-3.5 shrink-0 text-[#8a8c91]" aria-hidden="true" />
  ) : (
    <FileText className="h-3.5 w-3.5 shrink-0 text-[#8a8c91]" aria-hidden="true" />
  );
}

export function AdminTrashSection({ user }: { user: AuthUser | null }) {
  const isPrivilegedAdmin =
    user?.role === 'sys_admin' || user?.role === 'sec_admin';
  const trash = useAdminTrash(user, Boolean(isPrivilegedAdmin));
  const {
    filters,
    items,
    owners,
    deleters,
    hasUnknownDeleter,
    trashRetentionDays,
    hasMore,
    loading,
    loadingMore,
    error,
    notice,
    selectedKeys,
    selectedItems,
    busy,
    auditLogs,
    auditHasMore,
    auditLoading,
    auditLoadingMore,
    canPurge,
    updateFilters,
    resetFilters,
    refresh,
    loadMore,
    loadTimeline,
    toggleSelection,
    selectAll,
    clearSelection,
    runRestore,
    runPurge,
    runEmpty,
  } = trash;

  const [restoreTargets, setRestoreTargets] = useState<AdminTrashItem[] | null>(
    null
  );
  const [restoreOptions, setRestoreOptions] = useState<RestoreFormOptions>(
    DEFAULT_RESTORE_OPTIONS
  );
  const [purgeTargets, setPurgeTargets] = useState<AdminTrashItem[] | null>(
    null
  );
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyConfirm, setEmptyConfirm] = useState('');

  const emptyState = getAdminTrashEmptyState(filters, items.length);
  const timelineEntries = useMemo(
    () => auditLogs.map((log) => formatAdminTrashAuditEntry(log)),
    [auditLogs]
  );

  function openRestore(targets: AdminTrashItem[]) {
    if (targets.length === 0) return;
    setRestoreOptions(DEFAULT_RESTORE_OPTIONS);
    setRestoreTargets(targets);
  }

  function openPurge(targets: AdminTrashItem[]) {
    if (targets.length === 0) return;
    setPurgeTargets(targets);
  }

  function openEmpty() {
    setEmptyConfirm('');
    setEmptyOpen(true);
  }

  async function submitRestore() {
    if (!restoreTargets) return;
    await runRestore(restoreTargets, restoreOptions);
    setRestoreTargets(null);
  }

  async function submitPurge() {
    if (!purgeTargets) return;
    await runPurge(purgeTargets);
    setPurgeTargets(null);
  }

  async function submitEmpty() {
    if (emptyConfirm !== EMPTY_TENANT_TRASH_CONFIRMATION) return;
    const ok = await runEmpty(emptyConfirm);
    if (ok) {
      setEmptyOpen(false);
      setEmptyConfirm('');
    }
  }

  return (
    <section
      aria-labelledby="admin-trash-heading"
      className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
        <div className="min-w-0">
          <h2
            id="admin-trash-heading"
            className="text-sm font-semibold text-slate-900"
          >
            ゴミ箱管理
          </h2>
          <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
            テナント全体の削除済みアイテムを代理復元・完全削除します。保持期限は{' '}
            {trashRetentionDays} 日です。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canPurge ? (
            <button
              type="button"
              onClick={openEmpty}
              disabled={busy || loading}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 text-[0.75rem] font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>テナント全体のゴミ箱を空にする</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />
            <span>再読み込み</span>
          </button>
        </div>
      </div>

      {!canPurge ? (
        <p
          role="note"
          className="flex items-start gap-2 border-b border-amber-100 bg-amber-50/70 px-5 py-2.5 text-[0.6875rem] text-amber-900"
        >
          <ShieldAlert
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600"
            aria-hidden="true"
          />
          <span>
            完全削除・空にする操作は sys_admin のみ許可されています。sec_admin
            は代理復元と監査タイムラインの確認ができます。
          </span>
        </p>
      ) : null}

      <div className="space-y-3 border-b border-slate-100 px-5 py-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[15rem] flex-1 flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
            <span>検索</span>
            <input
              type="search"
              aria-label="管理者ゴミ箱を検索"
              value={filters.query}
              onChange={(event) =>
                updateFilters({ query: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void refresh();
                }
              }}
              placeholder="ファイル名・フォルダ名"
              className={FIELD_CLASS}
            />
          </label>

          <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
            <span>種別</span>
            <select
              aria-label="種別で絞り込む"
              value={filters.type}
              onChange={(event) =>
                updateFilters({
                  type: event.target.value as typeof filters.type,
                })
              }
              className={FIELD_CLASS}
            >
              <option value="all">すべて</option>
              <option value="file">ファイル</option>
              <option value="folder">フォルダ</option>
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
            <span>所有者</span>
            <select
              aria-label="所有者で絞り込む"
              value={filters.ownerId ?? ''}
              onChange={(event) =>
                updateFilters({ ownerId: event.target.value || null })
              }
              className={FIELD_CLASS}
            >
              <option value="">すべての所有者</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
            <span>削除者</span>
            <select
              aria-label="削除者で絞り込む"
              value={filters.deletedById ?? ''}
              onChange={(event) =>
                updateFilters({ deletedById: event.target.value || null })
              }
              className={FIELD_CLASS}
            >
              <option value="">すべての削除者</option>
              {deleters.map((deleter) => (
                <option key={deleter.id} value={deleter.id}>
                  {deleter.name}
                </option>
              ))}
              {hasUnknownDeleter ? (
                <option value="unknown">不明（旧データ）</option>
              ) : null}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
            <span>保持期限</span>
            <select
              aria-label="保持期限で絞り込む"
              value={filters.retention}
              onChange={(event) =>
                updateFilters({
                  retention: event.target.value as typeof filters.retention,
                })
              }
              className={FIELD_CLASS}
            >
              {ADMIN_TRASH_RETENTION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[#55565a]">
            <span>並び順</span>
            <select
              aria-label="並び順"
              value={filters.sort}
              onChange={(event) =>
                updateFilters({
                  sort: event.target.value as typeof filters.sort,
                })
              }
              className={FIELD_CLASS}
            >
              {ADMIN_TRASH_SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {isAdminTrashFilterActive(filters) ? (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex h-7 items-center rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#55565a] hover:bg-[#f2f2f4]"
            >
              フィルタを解除
            </button>
          ) : null}

          {loading ? (
            <span className="inline-flex h-7 items-center gap-1.5 text-[0.6875rem] text-[#8a8c91]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              読み込み中
            </span>
          ) : null}
        </div>

        {selectedKeys.size > 0 ? (
          <div
            data-admin-trash-selected-count={selectedKeys.size}
            className="flex flex-wrap items-center gap-2 rounded-md border border-[#dfe2f5] bg-[#eef0fb] px-3 py-1.5 text-[0.75rem] text-[#3c3f46]"
          >
            <span className="font-medium">{selectedKeys.size} 件選択中</span>
            <button
              type="button"
              onClick={() => openRestore(selectedItems)}
              disabled={busy}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-2.5 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
            >
              <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
              選択項目を代理復元
            </button>
            {canPurge ? (
              <button
                type="button"
                onClick={() => openPurge(selectedItems)}
                disabled={busy}
                className="inline-flex h-7 items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 text-[0.75rem] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                選択項目を完全削除
              </button>
            ) : null}
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex h-7 items-center rounded-md px-2 text-[0.75rem] text-[#55565a] hover:bg-white/70"
            >
              選択を解除
            </button>
          </div>
        ) : null}
      </div>

      {(error || notice) && (
        <div className="space-y-2 px-5 pt-3">
          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[0.6875rem] text-red-700"
            >
              <AlertTriangle
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                aria-hidden="true"
              />
              <span>{error}</span>
            </div>
          ) : null}
          {notice ? (
            <div
              role="status"
              className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[0.6875rem] font-medium text-emerald-800"
            >
              {notice}
            </div>
          ) : null}
        </div>
      )}

      <div
        role="region"
        aria-label="管理者ゴミ箱一覧"
        tabIndex={0}
        className="overflow-x-auto"
      >
        <table className="w-full min-w-[78rem] text-left text-xs">
          <caption className="sr-only">
            テナント全体の削除済みファイルとフォルダ
          </caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
            <tr>
              <th scope="col" className="w-9 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="表示中の項目をすべて選択"
                  checked={items.length > 0 && selectedKeys.size === items.length}
                  onChange={(event) =>
                    event.target.checked ? selectAll() : clearSelection()
                  }
                  className="h-3.5 w-3.5 rounded border-slate-300"
                />
              </th>
              <th scope="col" className="px-3 py-2">
                対象名
              </th>
              <th scope="col" className="px-3 py-2">
                種別
              </th>
              <th scope="col" className="px-3 py-2">
                機密区分
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                サイズ
              </th>
              <th scope="col" className="px-3 py-2">
                元の親フォルダ
              </th>
              <th scope="col" className="px-3 py-2">
                所有者
              </th>
              <th scope="col" className="px-3 py-2">
                削除者
              </th>
              <th scope="col" className="px-3 py-2">
                削除日時 (JST)
              </th>
              <th scope="col" className="px-3 py-2">
                保持期限
              </th>
              <th scope="col" className="px-3 py-2">
                権限要約
              </th>
              <th scope="col" className="px-3 py-2 text-right">
                操作
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => {
              const key = `${item.type}:${item.id}`;
              return (
                <tr
                  key={key}
                  className={
                    selectedKeys.has(key)
                      ? 'bg-[#eef0fb] hover:bg-[#eef0fb]'
                      : 'hover:bg-slate-50/70'
                  }
                >
                  <td className="px-3 py-2 align-top">
                    <input
                      type="checkbox"
                      aria-label={`「${item.name}」を選択`}
                      checked={selectedKeys.has(key)}
                      onChange={() => toggleSelection(key)}
                      className="h-3.5 w-3.5 rounded border-slate-300"
                    />
                  </td>
                  <td className="max-w-[16rem] px-3 py-2 align-top">
                    <div className="flex items-center gap-1.5">
                      <TrashIcon type={item.type} />
                      <span
                        className="truncate font-medium text-slate-900"
                        title={item.name}
                      >
                        {item.name}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[0.625rem] text-slate-400">
                      {item.id.slice(0, 12)}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top text-[#55565a]">
                    {item.type === 'folder' ? 'フォルダ' : 'ファイル'}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <ClassificationBadge
                      classification={item.classification}
                      compact
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums text-[#55565a]">
                    {item.type === 'file' && item.sizeBytes !== null
                      ? formatBytes(item.sizeBytes)
                      : '—'}
                  </td>
                  <td className="max-w-[12rem] px-3 py-2 align-top text-[0.6875rem] text-[#55565a]">
                    <span className="line-clamp-2" title={item.parentFolder?.name}>
                      {item.parentFolder?.name ?? 'マイファイル (ルート)'}
                    </span>
                  </td>
                  <td className="max-w-[13rem] px-3 py-2 align-top text-[0.6875rem] text-[#55565a]">
                    <div className="truncate" title={formatAdminTrashPerson(item.owner)}>
                      {item.owner?.name ?? '不明'}
                    </div>
                    <div className="truncate text-[0.625rem] text-slate-400">
                      {item.owner?.email ?? '—'}
                    </div>
                  </td>
                  <td className="max-w-[13rem] px-3 py-2 align-top text-[0.6875rem] text-[#55565a]">
                    <div className="truncate" title={formatAdminTrashPerson(item.deletedBy)}>
                      {item.deletedBy?.name ?? '不明'}
                    </div>
                    <div className="truncate text-[0.625rem] text-slate-400">
                      {item.deletedBy?.email ?? '—'}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top font-mono text-[0.625rem] text-slate-500">
                    <time dateTime={item.deletedAt}>
                      {formatAuditDateTime(item.deletedAt)}
                    </time>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 align-top">
                    <TrashRetentionBadge daysRemaining={item.daysRemaining} />
                  </td>
                  <td
                    className="max-w-[13rem] px-3 py-2 align-top text-[0.625rem] leading-snug text-[#55565a]"
                    title={formatAdminTrashPermissionSummary(
                      item.permissionSummary
                    )}
                  >
                    <span className="line-clamp-2">
                      {formatAdminTrashPermissionSummary(item.permissionSummary)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right align-top">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => openRestore([item])}
                        disabled={busy}
                        aria-label={`「${item.name}」を代理復元`}
                        className="inline-flex h-6 items-center gap-1 rounded border border-[#e1e1e4] bg-white px-1.5 text-[0.6875rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
                      >
                        <ArchiveRestore
                          className="h-3 w-3"
                          aria-hidden="true"
                        />
                        代理復元
                      </button>
                      {canPurge ? (
                        <button
                          type="button"
                          onClick={() => openPurge([item])}
                          disabled={busy}
                          aria-label={`「${item.name}」を完全削除`}
                          className="inline-flex h-6 items-center gap-1 rounded border border-red-200 bg-white px-1.5 text-[0.6875rem] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                          完全削除
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!loading && items.length === 0 ? (
        <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-8 text-center text-[0.75rem] text-[#55565a]">
          {emptyState === 'empty' ? (
            <p>ゴミ箱は空です</p>
          ) : (
            <div className="space-y-2">
              <p>条件に一致するアイテムがありません</p>
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex h-7 items-center rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
              >
                フィルタを解除
              </button>
            </div>
          )}
        </div>
      ) : null}

      {hasMore ? (
        <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="inline-flex h-7 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loadingMore ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            <span>さらに読み込む</span>
          </button>
        </div>
      ) : null}

      <div className="border-t border-slate-200 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-[0.8125rem] font-semibold text-slate-900">
              復元・完全削除監査タイムライン
            </h3>
            <p className="mt-0.5 text-[0.6875rem] text-[#55565a]">
              復元・完全削除の 7 アクションを JST で表示します。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadTimeline('reset')}
              disabled={auditLoading}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${auditLoading ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              監査を更新
            </button>
            <a
              href={buildAdminTrashAuditCsvHref()}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4]"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              CSV 出力
            </a>
          </div>
        </div>

        <div
          role="region"
          aria-label="復元・完全削除監査タイムライン"
          tabIndex={0}
          className="mt-3 overflow-x-auto rounded-md border border-slate-200"
        >
          <table className="w-full min-w-[62rem] text-left text-xs">
            <caption className="sr-only">
              復元・完全削除監査タイムライン
            </caption>
            <thead className="border-b border-slate-200 bg-slate-50 text-[0.6875rem] font-semibold text-slate-500">
              <tr>
                <th scope="col" className="px-3 py-2">
                  日時 (JST)
                </th>
                <th scope="col" className="px-3 py-2">
                  アクション
                </th>
                <th scope="col" className="px-3 py-2">
                  対象名
                </th>
                <th scope="col" className="px-3 py-2">
                  バージョン
                </th>
                <th scope="col" className="px-3 py-2">
                  復元先
                </th>
                <th scope="col" className="px-3 py-2">
                  実行者
                </th>
                <th scope="col" className="px-3 py-2">
                  代理対象 / 所有者
                </th>
                <th scope="col" className="px-3 py-2">
                  詳細
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {timelineEntries.map((entry, index) => (
                <tr
                  key={`${auditLogs[index]?.id ?? entry.action}-${index}`}
                  className="hover:bg-slate-50/70"
                >
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[0.625rem] text-slate-500">
                    <time dateTime={auditLogs[index]?.createdAt}>
                      {entry.dateLabel}
                    </time>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-[0.6875rem] font-medium text-slate-900">
                    {entry.actionLabel}
                  </td>
                  <td className="max-w-[14rem] px-3 py-2 align-top text-[0.6875rem] text-slate-700">
                    <span className="line-clamp-2" title={entry.targetName}>
                      {entry.targetName}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[0.625rem] text-slate-500">
                    {entry.sourceVersion}
                  </td>
                  <td className="max-w-[14rem] px-3 py-2 align-top text-[0.6875rem] text-slate-600">
                    <span className="line-clamp-2" title={entry.restoredTo}>
                      {entry.restoredTo}
                    </span>
                  </td>
                  <td className="max-w-[13rem] px-3 py-2 align-top text-[0.6875rem] text-slate-600">
                    <span className="line-clamp-2" title={entry.actorEmail}>
                      {entry.actorEmail}
                    </span>
                  </td>
                  <td className="max-w-[14rem] px-3 py-2 align-top text-[0.6875rem] text-slate-600">
                    <span className="line-clamp-2" title={entry.onBehalfOf}>
                      {entry.onBehalfOf}
                    </span>
                  </td>
                  <td className="max-w-[12rem] px-3 py-2 align-top text-[0.625rem] text-slate-500">
                    {entry.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!auditLoading && timelineEntries.length === 0 ? (
          <p className="mt-3 rounded-md border border-slate-200 bg-slate-50/60 px-3 py-4 text-center text-[0.75rem] text-[#55565a]">
            復元・完全削除の監査ログはまだありません。
          </p>
        ) : null}

        {auditHasMore ? (
          <div className="mt-3 text-center">
            <button
              type="button"
              onClick={() => void loadTimeline('more')}
              disabled={auditLoadingMore}
              className="inline-flex h-7 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-[0.75rem] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {auditLoadingMore ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin"
                  aria-hidden="true"
                />
              ) : null}
              監査ログをさらに読み込む
            </button>
          </div>
        ) : null}
      </div>

      {restoreTargets ? (
        <ModalShell
          label="代理復元の確認"
          labelledBy="admin-trash-restore-title"
          onClose={() => setRestoreTargets(null)}
          backdrop="deep"
          className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
        >
          <div className="space-y-4">
            <div>
              <h2
                id="admin-trash-restore-title"
                className="text-sm font-semibold text-slate-900"
              >
                代理復元の確認
              </h2>
              <p className="mt-1 text-[0.6875rem] text-[#55565a]">
                {restoreTargets.length} 件を、所有者の代理として復元します。
              </p>
            </div>

            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2 text-[0.6875rem]">
              {restoreTargets.map((item) => (
                <li
                  key={`${item.type}:${item.id}`}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <TrashIcon type={item.type} />
                    <span className="truncate font-medium text-slate-800">
                      {item.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-slate-500">
                    {item.owner?.name ?? '所有者不明'}
                  </span>
                </li>
              ))}
            </ul>

            <fieldset className="space-y-2">
              <legend className="text-[0.6875rem] font-medium text-[#55565a]">
                復元先
              </legend>
              <label className="flex items-start gap-2 text-[0.75rem] text-slate-700">
                <input
                  type="radio"
                  name="admin-trash-restore-target"
                  value="original"
                  checked={restoreOptions.target === 'original'}
                  onChange={() =>
                    setRestoreOptions((prev) => ({
                      ...prev,
                      target: 'original',
                    }))
                  }
                  className="mt-0.5"
                />
                <span>
                  元の場所に戻す
                  <span className="block text-[0.6875rem] text-[#8a8c91]">
                    親フォルダが削除済みの場合は下の自動復元を有効にしてください。
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-[0.75rem] text-slate-700">
                <input
                  type="radio"
                  name="admin-trash-restore-target"
                  value="root"
                  checked={restoreOptions.target === 'root'}
                  onChange={() =>
                    setRestoreOptions((prev) => ({ ...prev, target: 'root' }))
                  }
                  className="mt-0.5"
                />
                <span>マイファイル (ルート) に戻す</span>
              </label>
            </fieldset>

            <label className="flex items-start gap-2 text-[0.75rem] text-slate-700">
              <input
                type="checkbox"
                checked={restoreOptions.restoreParentChain}
                onChange={(event) =>
                  setRestoreOptions((prev) => ({
                    ...prev,
                    restoreParentChain: event.target.checked,
                  }))
                }
                className="mt-0.5"
              />
              <span>
                親フォルダが削除済みの場合は自動復元する
                <span className="block text-[0.6875rem] text-[#8a8c91]">
                  対象アイテムの祖先フォルダだけを復元します。
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-[0.75rem] text-slate-700">
              <input
                type="checkbox"
                checked={restoreOptions.renameOnConflict}
                onChange={(event) =>
                  setRestoreOptions((prev) => ({
                    ...prev,
                    renameOnConflict: event.target.checked,
                  }))
                }
                className="mt-0.5"
              />
              <span>
                名前が衝突した場合は自動リネームする
                <span className="block text-[0.6875rem] text-[#8a8c91]">
                  既存ファイルは上書きされません。
                </span>
              </span>
            </label>

            <p className="rounded-md border border-[#dfe2f5] bg-[#eef0fb] px-3 py-2 text-[0.6875rem] text-[#3c3f46]">
              復元は管理者の代理操作として監査ログに記録され、所有者のワークスペースにも通知されます。
            </p>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRestoreTargets(null)}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void submitRestore()}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3 text-[0.75rem] font-medium text-white hover:bg-[#4f5ac2] disabled:opacity-50"
              >
                {busy ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                復元を実行
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {purgeTargets ? (
        <ModalShell
          label="選択項目の完全削除"
          labelledBy="admin-trash-purge-title"
          onClose={() => setPurgeTargets(null)}
          backdrop="deep"
          className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
        >
          <div className="space-y-4">
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
                aria-hidden="true"
              />
              <div>
                <h2
                  id="admin-trash-purge-title"
                  className="text-sm font-semibold text-slate-900"
                >
                  選択項目の完全削除
                </h2>
                <p className="mt-1 text-[0.6875rem] text-[#55565a]">
                  {purgeTargets.length} 件を完全削除します。この操作は取り消せません。ロック中のファイルは安全のためスキップされます。
                </p>
              </div>
            </div>
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-red-100 bg-red-50/50 px-3 py-2 text-[0.6875rem]">
              {purgeTargets.map((item) => (
                <li
                  key={`${item.type}:${item.id}`}
                  className="flex items-center gap-1.5"
                >
                  <TrashIcon type={item.type} />
                  <span className="truncate font-medium text-slate-800">
                    {item.name}
                  </span>
                  <span className="shrink-0 text-slate-500">
                    {item.owner?.name ?? '所有者不明'}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPurgeTargets(null)}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void submitPurge()}
                disabled={busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-[0.75rem] font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                完全削除を実行
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}

      {emptyOpen ? (
        <ModalShell
          label="テナント全体のゴミ箱を空にする確認"
          labelledBy="admin-trash-empty-title"
          onClose={() => setEmptyOpen(false)}
          backdrop="deep"
          className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
        >
          <div className="space-y-4">
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="mt-0.5 h-5 w-5 shrink-0 text-red-600"
                aria-hidden="true"
              />
              <div>
                <h2
                  id="admin-trash-empty-title"
                  className="text-sm font-semibold text-slate-900"
                >
                  テナント全体のゴミ箱を空にする
                </h2>
                <p className="mt-1 text-[0.6875rem] text-[#55565a]">
                  他ユーザーが削除したものを含む、テナント内のすべてのゴミ箱アイテムを完全削除します。この操作は取り消せません。ロック中のファイルはスキップされ、後で再実行できます。
                </p>
              </div>
            </div>

            <label className="flex flex-col gap-1 text-[0.75rem] font-medium text-slate-700">
              <span>確認文字列</span>
              <input
                type="text"
                aria-label="確認文字列"
                data-autofocus
                autoComplete="off"
                spellCheck={false}
                value={emptyConfirm}
                onChange={(event) => setEmptyConfirm(event.target.value)}
                placeholder={EMPTY_TENANT_TRASH_CONFIRMATION}
                className="h-8 rounded-md border border-slate-300 bg-white px-2 font-mono text-[0.8125rem] text-slate-900 focus:outline-none focus:ring-2 focus:ring-red-400/50"
              />
              <span className="text-[0.6875rem] text-[#8a8c91]">
                続行するには {EMPTY_TENANT_TRASH_CONFIRMATION} と入力してください。
              </span>
            </label>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEmptyOpen(false)}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] hover:bg-[#f2f2f4] disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void submitEmpty()}
                disabled={
                  busy || emptyConfirm !== EMPTY_TENANT_TRASH_CONFIRMATION
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-[0.75rem] font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? (
                  <Loader2
                    className="h-3.5 w-3.5 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                空にする
              </button>
            </div>
          </div>
        </ModalShell>
      ) : null}
    </section>
  );
}
