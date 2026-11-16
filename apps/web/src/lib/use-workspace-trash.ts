'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, listTrash } from '@/lib/files-api';
import {
  buildTrashRequestParams,
  DEFAULT_TRASH_FILTERS,
  mergeTrashItems,
  removeTrashItem,
  updateTrashItem,
} from '@/lib/trash-view';
import type {
  FileItem,
  TrashDeleter,
  TrashFilters,
  TrashFolderItem,
  TrashFileItem,
  TrashItem,
  TrashItemType,
} from '@/types/files';

const TRASH_LOAD_ERROR = 'ゴミ箱の取得に失敗しました';

function isTrashFolder(item: TrashItem): item is TrashFolderItem {
  return item.type === 'folder';
}

function isTrashFile(item: TrashItem): item is TrashFileItem {
  return item.type === 'file';
}

export function useWorkspaceTrash() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [filters, setFilters] = useState<TrashFilters>(DEFAULT_TRASH_FILTERS);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [trashRetentionDays, setTrashRetentionDays] = useState(30);
  const [deleters, setDeleters] = useState<TrashDeleter[]>([]);
  const [hasUnknownDeleter, setHasUnknownDeleter] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtersRef = useRef(filters);
  const nextCursorRef = useRef<string | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const fetchPage = useCallback(
    async (
      activeFilters: TrashFilters,
      cursor: string | null,
      mode: 'replace' | 'append'
    ) => {
      const seq = requestSeqRef.current + 1;
      requestSeqRef.current = seq;
      if (mode === 'replace') {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      try {
        const response = await listTrash(
          buildTrashRequestParams(activeFilters, { cursor })
        );
        if (requestSeqRef.current !== seq) return;

        setItems((prev) =>
          mode === 'replace'
            ? response.items
            : mergeTrashItems(prev, response.items)
        );
        setNextCursor(response.nextCursor);
        nextCursorRef.current = response.nextCursor;
        setTrashRetentionDays(response.trashRetentionDays);
        setDeleters(response.deleters);
        setHasUnknownDeleter(response.hasUnknownDeleter);
        setLoaded(true);
        setError(null);
      } catch (err) {
        if (requestSeqRef.current !== seq) return;
        setError(
          err instanceof ApiClientError ? err.message : TRASH_LOAD_ERROR
        );
      } finally {
        if (requestSeqRef.current === seq) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  /** Loads the first page, optionally applying a filter patch atomically. */
  const loadTrash = useCallback(
    async (overrides?: Partial<TrashFilters>) => {
      const activeFilters: TrashFilters = overrides
        ? { ...filtersRef.current, ...overrides }
        : filtersRef.current;
      filtersRef.current = activeFilters;
      setFilters(activeFilters);
      await fetchPage(activeFilters, null, 'replace');
    },
    [fetchPage]
  );

  const loadMore = useCallback(async () => {
    if (!nextCursorRef.current || loading || loadingMore) return;
    await fetchPage(filtersRef.current, nextCursorRef.current, 'append');
  }, [fetchPage, loading, loadingMore]);

  const applyFilters = useCallback(
    async (patch: Partial<TrashFilters>) => {
      await loadTrash(patch);
    },
    [loadTrash]
  );

  const clearFilters = useCallback(async () => {
    await loadTrash(DEFAULT_TRASH_FILTERS);
  }, [loadTrash]);

  const retry = useCallback(async () => {
    await loadTrash();
  }, [loadTrash]);

  const updateFile = useCallback((updated: FileItem) => {
    setItems((prev) => {
      const existing = prev.find(
        (item): item is TrashFileItem =>
          item.type === 'file' && item.id === updated.id
      );
      if (!existing) return prev;
      return updateTrashItem(prev, {
        ...existing,
        ...updated,
        type: 'file',
        deleted_at: existing.deleted_at,
        deleted_by: existing.deleted_by,
        deleted_by_name: existing.deleted_by_name,
        deletedAt: existing.deletedAt,
        deletedBy: existing.deletedBy,
        deletedByName: existing.deletedByName,
        purgeAt: existing.purgeAt,
        daysRemaining: existing.daysRemaining,
      });
    });
  }, []);

  const removeItem = useCallback((type: TrashItemType, id: string) => {
    setItems((prev) => removeTrashItem(prev, type, id));
  }, []);

  const removeFolder = useCallback(
    (folderId: string) => removeItem('folder', folderId),
    [removeItem]
  );
  const removeFile = useCallback(
    (fileId: string) => removeItem('file', fileId),
    [removeItem]
  );

  const folders = useMemo(() => items.filter(isTrashFolder), [items]);
  const files = useMemo(() => items.filter(isTrashFile), [items]);

  return {
    items,
    folders,
    files,
    filters,
    nextCursor,
    hasMore: nextCursor !== null,
    trashRetentionDays,
    deleters,
    hasUnknownDeleter,
    loading,
    loadingMore,
    loaded,
    error,
    loadTrash,
    loadMore,
    applyFilters,
    clearFilters,
    retry,
    updateFile,
    removeItem,
    removeFolder,
    removeFile,
  };
}
