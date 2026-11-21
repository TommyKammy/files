'use client';

import {
  AlertTriangle,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  formatAdminTrashAuditEntry,
  getAdminTrashEmptyState,
} from '@/lib/admin-trash';
import { useAdminTrash } from '@/lib/use-admin-trash';
import type { AdminTrashItem, AuthUser } from '@/types/files';
import {
  DEFAULT_RESTORE_OPTIONS,
  EMPTY_TENANT_TRASH_CONFIRMATION,
  type RestoreFormOptions,
} from './trash/shared';
import { TrashAuditTimeline } from './trash/TrashAuditTimeline';
import { TrashFilterBar } from './trash/TrashFilterBar';
import { TrashItemsTable } from './trash/TrashItemsTable';
import {
  TrashEmptyModal,
  TrashPurgeModal,
  TrashRestoreModal,
} from './trash/TrashModals';

/** Tenant-wide admin trash management section with proxy restore, purge, and audit timeline. */
export function AdminTrashSection({ user }: { user: AuthUser | null }) {
  const isPrivilegedAdmin =
    user?.role === 'sys_admin' ||
    user?.role === 'sec_admin' ||
    (user?.role === 'member' &&
      (user?.adminCapabilities ?? []).includes('admin.trash.manage'));
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

      <TrashFilterBar
        filters={filters}
        owners={owners}
        deleters={deleters}
        hasUnknownDeleter={hasUnknownDeleter}
        loading={loading}
        busy={busy}
        canPurge={canPurge}
        selectedCount={selectedKeys.size}
        selectedItems={selectedItems}
        onUpdateFilters={updateFilters}
        onResetFilters={resetFilters}
        onRefresh={() => void refresh()}
        onOpenRestore={openRestore}
        onOpenPurge={openPurge}
        onClearSelection={clearSelection}
      />

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

      <TrashItemsTable
        items={items}
        selectedKeys={selectedKeys}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={hasMore}
        busy={busy}
        canPurge={canPurge}
        emptyState={emptyState}
        onSelectAll={selectAll}
        onClearSelection={clearSelection}
        onToggleSelection={toggleSelection}
        onOpenRestore={openRestore}
        onOpenPurge={openPurge}
        onResetFilters={resetFilters}
        onLoadMore={() => void loadMore()}
      />

      <TrashAuditTimeline
        auditLogs={auditLogs}
        timelineEntries={timelineEntries}
        auditHasMore={auditHasMore}
        auditLoading={auditLoading}
        auditLoadingMore={auditLoadingMore}
        onRefresh={() => void loadTimeline('reset')}
        onLoadMore={() => void loadTimeline('more')}
      />

      {restoreTargets ? (
        <TrashRestoreModal
          targets={restoreTargets}
          options={restoreOptions}
          busy={busy}
          onOptionsChange={setRestoreOptions}
          onClose={() => setRestoreTargets(null)}
          onSubmit={() => void submitRestore()}
        />
      ) : null}

      {purgeTargets ? (
        <TrashPurgeModal
          targets={purgeTargets}
          busy={busy}
          onClose={() => setPurgeTargets(null)}
          onSubmit={() => void submitPurge()}
        />
      ) : null}

      {emptyOpen ? (
        <TrashEmptyModal
          confirmText={emptyConfirm}
          busy={busy}
          onConfirmTextChange={setEmptyConfirm}
          onClose={() => setEmptyOpen(false)}
          onSubmit={() => void submitEmpty()}
        />
      ) : null}
    </section>
  );
}
