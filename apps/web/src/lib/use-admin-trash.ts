'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiClientError,
  emptyAdminTrash,
  fetchAdminTrash,
  fetchAuditLogs,
  purgeAdminTrashItems,
  restoreAdminTrash,
} from '@/lib/files-api';
import {
  ADMIN_TRASH_AUDIT_ACTIONS,
  ADMIN_TRASH_PAGE_SIZE,
  adminTrashItemKey,
  buildAdminTrashRequestParams,
  DEFAULT_ADMIN_TRASH_FILTERS,
  mergeAdminTrashItems,
  removeAdminTrashItems,
} from '@/lib/admin-trash';
import type {
  AdminCapability,
  AdminTrashFiltersState,
  AdminTrashItem,
  AdminTrashPerson,
  AuditLogEntry,
  TrashBulkItemRef,
  TrashBulkItemResult,
  UserRole,
  UserType,
} from '@/types/files';

export interface AdminTrashRestoreFormOptions {
  target: 'original' | 'root';
  restoreParentChain: boolean;
  renameOnConflict: boolean;
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof ApiClientError ? err.message : fallback;
}

function summarizeBulkOutcome(
  actionLabel: string,
  results: readonly TrashBulkItemResult[],
  succeededCount: number,
  failedCount: number,
  skippedCount = 0
): string {
  const parts = [`${actionLabel}: 成功 ${succeededCount} 件`];
  if (failedCount > 0) parts.push(`失敗 ${failedCount} 件`);
  if (skippedCount > 0) parts.push(`スキップ ${skippedCount} 件`);
  const firstFailure = results.find((result) => !result.ok);
  if (firstFailure) {
    parts.push(
      `${firstFailure.name ?? firstFailure.id}: ${
        firstFailure.error ?? firstFailure.code ?? '不明なエラー'
      }`
    );
  }
  return parts.join(' / ');
}

export function useAdminTrash(
  user:
    | {
        role: UserRole;
        userType?: UserType;
        adminCapabilities?: AdminCapability[];
      }
    | null
    | undefined,
  enabled: boolean
) {
  const role = user?.role;
  const canRestore =
    role === 'sys_admin' ||
    role === 'sec_admin' ||
    (role === 'member' &&
      (user?.adminCapabilities ?? []).includes('admin.trash.manage'));
  const canPurge = role === 'sys_admin';
  // The restore/purge timeline is an audit-log projection. Do not mount its
  // fetch for a Co-Admin who was not delegated `admin.audit.read`.
  const canViewTimeline =
    role === 'sys_admin' ||
    role === 'sec_admin' ||
    (user?.adminCapabilities ?? []).includes('admin.audit.read');

  const [filters, setFilters] = useState<AdminTrashFiltersState>(
    DEFAULT_ADMIN_TRASH_FILTERS
  );
  const [items, setItems] = useState<AdminTrashItem[]>([]);
  const [owners, setOwners] = useState<AdminTrashPerson[]>([]);
  const [deleters, setDeleters] = useState<AdminTrashPerson[]>([]);
  const [hasUnknownDeleter, setHasUnknownDeleter] = useState(false);
  const [trashRetentionDays, setTrashRetentionDays] = useState(30);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);

  const listRequestRef = useRef(0);
  const auditCursorRef = useRef<{ createdAt: string; id: string } | null>(null);
  const auditRequestRef = useRef(0);

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!enabled) return;
      const requestId = ++listRequestRef.current;
      if (!options?.silent) setLoading(true);
      setError(null);
      try {
        const params = buildAdminTrashRequestParams(filters, {
          limit: ADMIN_TRASH_PAGE_SIZE,
        });
        const response = await fetchAdminTrash({
          query: params.query,
          type: params.type,
          ownerId: params.ownerId,
          deletedById: params.deletedById,
          daysRemainingMax: params.daysRemainingMax,
          sort: params.sort,
          limit: params.limit,
        });
        if (requestId !== listRequestRef.current) return;
        setItems(response.items);
        setOwners(response.owners);
        setDeleters(response.deleters);
        setHasUnknownDeleter(response.hasUnknownDeleter);
        setTrashRetentionDays(response.trashRetentionDays);
        setNextCursor(response.nextCursor);
        setHasMore(response.hasMore);
        setSelectedKeys(new Set());
      } catch (err) {
        if (requestId !== listRequestRef.current) return;
        setError(describeError(err, '管理者ゴミ箱の読み込みに失敗しました'));
      } finally {
        if (requestId === listRequestRef.current) setLoading(false);
      }
    },
    [enabled, filters]
  );

  const loadTimeline = useCallback(
    async (mode: 'reset' | 'more' = 'reset') => {
      if (!enabled || !canViewTimeline) return;
      const requestId = ++auditRequestRef.current;
      if (mode === 'reset') {
        setAuditLoading(true);
      } else {
        setAuditLoadingMore(true);
      }
      try {
        const cursor = mode === 'more' ? auditCursorRef.current : null;
        const response = await fetchAuditLogs({
          actions: [...ADMIN_TRASH_AUDIT_ACTIONS],
          cursorCreatedAt: cursor?.createdAt,
          cursorId: cursor?.id,
          limit: 50,
        });
        if (requestId !== auditRequestRef.current) return;
        setAuditLogs((prev) =>
          mode === 'more' ? [...prev, ...response.logs] : response.logs
        );
        auditCursorRef.current = response.nextCursor;
        setAuditHasMore(Boolean(response.nextCursor));
      } catch (err) {
        if (requestId !== auditRequestRef.current) return;
        setError(describeError(err, '復元・削除監査ログの読み込みに失敗しました'));
      } finally {
        if (requestId === auditRequestRef.current) {
          setAuditLoading(false);
          setAuditLoadingMore(false);
        }
      }
    },
    [canViewTimeline, enabled]
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      void refresh();
    }, 180);
    return () => window.clearTimeout(timer);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || !canViewTimeline) return;
    void loadTimeline('reset');
  }, [canViewTimeline, enabled, loadTimeline]);

  const loadMore = useCallback(async () => {
    if (!enabled || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const params = buildAdminTrashRequestParams(filters, {
        limit: ADMIN_TRASH_PAGE_SIZE,
        cursor: nextCursor,
      });
      const response = await fetchAdminTrash({
        query: params.query,
        type: params.type,
        ownerId: params.ownerId,
        deletedById: params.deletedById,
        daysRemainingMax: params.daysRemainingMax,
        sort: params.sort,
        limit: params.limit,
        cursor: params.cursor,
      });
      setItems((prev) => mergeAdminTrashItems(prev, response.items));
      setNextCursor(response.nextCursor);
      setHasMore(response.hasMore);
    } catch (err) {
      setError(describeError(err, '追加読み込みに失敗しました'));
    } finally {
      setLoadingMore(false);
    }
  }, [enabled, filters, loadingMore, nextCursor]);

  const selectedItems = useMemo(
    () => items.filter((item) => selectedKeys.has(adminTrashItemKey(item))),
    [items, selectedKeys]
  );

  const toggleSelection = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedKeys(new Set(items.map(adminTrashItemKey)));
  }, [items]);

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), []);

  const runRestore = useCallback(
    async (
      targets: readonly AdminTrashItem[],
      options: AdminTrashRestoreFormOptions
    ) => {
      if (!canRestore || busy || targets.length === 0) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const response = await restoreAdminTrash({
          items: targets.map<TrashBulkItemRef>((item) => ({
            type: item.type,
            id: item.id,
          })),
          conflictPolicy: options.renameOnConflict ? 'rename' : 'fail',
          restoreParentChain: options.restoreParentChain,
          ...(options.target === 'root' ? { targetFolderId: null } : {}),
        });
        const succeededKeys = response.results
          .filter((result) => result.ok)
          .map((result) => `${result.type}:${result.id}`);
        setItems((prev) =>
          removeAdminTrashItems(
            prev,
            response.results
              .filter((result) => result.ok)
              .map((result) => ({ type: result.type, id: result.id }))
          )
        );
        setSelectedKeys((prev) => {
          const next = new Set(prev);
          for (const key of succeededKeys) next.delete(key);
          return next;
        });
        setNotice(
          summarizeBulkOutcome(
            '代理復元',
            response.results,
            response.succeededCount,
            response.failedCount
          )
        );
        if (response.failedCount > 0) {
          const failed = response.results.filter((result) => !result.ok);
          setError(
            failed
              .map(
                (result) =>
                  `${result.name ?? result.id}: ${
                    result.error ?? result.code ?? '復元に失敗しました'
                  }`
              )
              .join(' / ')
          );
        }
        await loadTimeline('reset');
        if (response.failedCount === 0) {
          await refresh({ silent: true });
        }
        return response.failedCount === 0;
      } catch (err) {
        setError(describeError(err, '代理復元に失敗しました'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, canRestore, loadTimeline, refresh]
  );

  const runPurge = useCallback(
    async (targets: readonly AdminTrashItem[]) => {
      if (!canPurge || busy || targets.length === 0) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const response = await purgeAdminTrashItems(
          targets.map<TrashBulkItemRef>((item) => ({
            type: item.type,
            id: item.id,
          }))
        );
        setItems((prev) =>
          removeAdminTrashItems(
            prev,
            response.results
              .filter((result) => result.ok)
              .map((result) => ({ type: result.type, id: result.id }))
          )
        );
        setSelectedKeys((prev) => {
          const next = new Set(prev);
          for (const result of response.results) {
            if (result.ok) next.delete(`${result.type}:${result.id}`);
          }
          return next;
        });
        setNotice(
          summarizeBulkOutcome(
            '完全削除',
            response.results,
            response.succeededCount,
            response.failedCount,
            response.skippedCount ?? 0
          )
        );
        const problems = response.results.filter((result) => !result.ok);
        if (problems.length > 0) {
          setError(
            problems
              .map(
                (result) =>
                  `${result.name ?? result.id}: ${
                    result.error ?? result.code ?? '完全削除に失敗しました'
                  }`
              )
              .join(' / ')
          );
        }
        await loadTimeline('reset');
        return problems.length === 0;
      } catch (err) {
        setError(describeError(err, '完全削除に失敗しました'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, canPurge, loadTimeline]
  );

  const runEmpty = useCallback(
    async (confirm: string) => {
      if (!canPurge || busy) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const response = await emptyAdminTrash(confirm);
        setNotice(
          summarizeBulkOutcome(
            'テナント全体のゴミ箱を空にする',
            response.results,
            response.deletedCount,
            response.failedCount,
            response.skippedCount
          )
        );
        const problems = response.results.filter((result) => !result.ok);
        if (problems.length > 0) {
          setError(
            problems
              .map(
                (result) =>
                  `${result.name ?? result.id}: ${
                    result.error ?? result.code ?? '完全削除に失敗しました'
                  }`
              )
              .join(' / ')
          );
        }
        await refresh({ silent: true });
        await loadTimeline('reset');
        return problems.length === 0;
      } catch (err) {
        setError(describeError(err, 'テナント全体のゴミ箱を空にできませんでした'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, canPurge, loadTimeline, refresh]
  );

  const updateFilters = useCallback(
    (patch: Partial<AdminTrashFiltersState>) => {
      setFilters((prev) => ({ ...prev, ...patch }));
    },
    []
  );

  const resetFilters = useCallback(() => {
    setFilters({ ...DEFAULT_ADMIN_TRASH_FILTERS });
  }, []);

  return {
    filters,
    items,
    owners,
    deleters,
    hasUnknownDeleter,
    trashRetentionDays,
    nextCursor,
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
    canRestore,
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
  };
}
