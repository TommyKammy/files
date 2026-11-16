'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DestinationRow } from '@/components/DestinationRowButton';
import { buildDestinationRows } from '@/lib/build-destination-rows';
import {
  type WorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';

/**
 * Folder tree selector for the Trash restore dialog. Reuses the shared
 * `buildDestinationRows` projection and the same expansion/search interaction
 * as `MoveCopyTreeModal`, without the move/copy execution surface.
 */
export function useTrashRestoreDestinationTree({
  syncStore,
}: {
  syncStore: WorkspaceSyncStore;
}) {
  const snapshot = useWorkspaceSyncSnapshot();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string>('tree:__ROOT__');

  useEffect(() => {
    void syncStore
      .ensureDirectoryLoaded(null, { isPrefetch: true })
      .catch(() => {});
  }, [syncStore]);

  const visibleRows = useMemo<DestinationRow[]>(() => {
    void snapshot.revision;
    return buildDestinationRows({
      query,
      recentList: [],
      expandedIds,
      source: syncStore,
    });
  }, [snapshot.revision, query, syncStore, expandedIds]);

  const selectedRow =
    visibleRows.find((row) => row.rowKey === selectedKey) ??
    visibleRows[0] ??
    null;

  const toggleExpand = useCallback(
    (folderId: string, forceExpand?: boolean) => {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        const expand = forceExpand ?? !next.has(folderId);
        if (expand) {
          next.add(folderId);
          if (!syncStore.isDirectoryFresh(folderId)) {
            void syncStore
              .ensureDirectoryLoaded(folderId, { isPrefetch: true })
              .catch(() => {});
          }
        } else {
          next.delete(folderId);
        }
        return next;
      });
    },
    [syncStore]
  );

  return {
    searchInputRef,
    query,
    setQuery,
    visibleRows,
    selectedRow,
    selectedKey,
    setSelectedKey,
    toggleExpand,
  };
}
