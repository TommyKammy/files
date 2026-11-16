'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildDestinationRows } from '@/lib/build-destination-rows';
import {
  type DragWorkspaceItem,
  evaluateDropTarget,
} from '@/lib/drag-drop-controller';
import { isImeComposingEvent, keyboardScopes } from '@/lib/keyboard-shortcuts';
import {
  type WorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import {
  evaluateCopyDestination,
  isRootCreationRestricted,
  loadRecentDestinations,
  ROOT_CREATION_RESTRICTED_REASON,
  type RecentDestinationEntry,
  recordRecentDestination,
} from '@/lib/workspace-actions';
import type { AuthUser, FolderStructureMode } from '@/types/files';
import type { DestinationRow } from '@/components/DestinationRowButton';

export function useMoveCopyTree({
  items,
  modeHint,
  currentFolderId,
  user,
  isSysAdmin,
  folderStructureMode = 'open',
  syncStore,
  onClose,
  onSuccess,
}: {
  items: DragWorkspaceItem[];
  modeHint: 'move' | 'copy';
  currentFolderId: string | null;
  user: AuthUser;
  isSysAdmin: boolean;
  folderStructureMode?: FolderStructureMode;
  syncStore: WorkspaceSyncStore;
  onClose: () => void;
  onSuccess: (action: 'move' | 'copy', targetFolderId: string | null) => void;
}) {
  const snapshot = useWorkspaceSyncSnapshot();
  const scopeTokenRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [recentList] = useState<RecentDestinationEntry[]>(() =>
    loadRecentDestinations(user.tenantId, user.id)
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (currentFolderId) {
      const dir = syncStore.getDirectoryView(currentFolderId);
      for (const crumb of dir.breadcrumbs) {
        initial.add(crumb.id);
      }
      initial.add(currentFolderId);
    }
    return initial;
  });
  const [highlightedKey, setHighlightedKey] = useState<string>(() =>
    currentFolderId ? `tree:${currentFolderId}` : 'tree:__ROOT__'
  );
  const [inlineNewFolderOpen, setInlineNewFolderOpen] = useState(false);
  const [inlineNewFolderName, setInlineNewFolderName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const token = keyboardScopes.pushScope('moveCopyModal');
    scopeTokenRef.current = token;
    void syncStore
      .ensureDirectoryLoaded(null, { isPrefetch: true })
      .catch(() => {});
    return () => {
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) {
        scopeTokenRef.current = null;
      }
    };
  }, [syncStore]);

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

  const visibleRows = useMemo<DestinationRow[]>(() => {
    void snapshot.revision;
    return buildDestinationRows({
      query,
      recentList,
      expandedIds,
      source: syncStore,
    });
  }, [snapshot.revision, query, recentList, syncStore, expandedIds]);

  const highlightedIndex = useMemo(() => {
    const idx = visibleRows.findIndex((r) => r.rowKey === highlightedKey);
    return idx >= 0 ? idx : 0;
  }, [visibleRows, highlightedKey]);

  const selectedRow = visibleRows[highlightedIndex] ?? visibleRows[0] ?? null;

  const evalForRow = useCallback(
    (row: DestinationRow) => {
      const targetAncestorClassifications =
        syncStore.getAncestorClassifications(row.folderId);
      const isAncestorOf = (
        ancestorId: string,
        candidateId: string | null
      ) => syncStore.isFolderAncestorOf(ancestorId, candidateId);
      const resolveItemRole = (item: DragWorkspaceItem) =>
        item.effectiveRole ??
        syncStore.getDirectoryView(item.parentId).effectiveRole;

      const moveEval = evaluateDropTarget({
        dragItems: items,
        targetFolderId: row.folderId,
        targetClassification: row.classification,
        targetAncestorClassifications,
        targetEffectiveRole: row.effectiveRole,
        isSysAdmin,
        folderStructureMode,
        isAncestorOf,
        resolveItemRole,
      });

      const copyEval = evaluateCopyDestination({
        items,
        targetFolderId: row.folderId,
        targetClassification: row.classification,
        targetAncestorClassifications,
        targetEffectiveRole: row.effectiveRole,
        isSysAdmin,
        folderStructureMode,
        isAncestorOf,
        resolveItemRole,
      });

      return { moveEval, copyEval };
    },
    [syncStore, items, isSysAdmin, folderStructureMode]
  );

  const selectedEval = useMemo(
    () => (selectedRow ? evalForRow(selectedRow) : null),
    [selectedRow, evalForRow]
  );

  const executeAction = useCallback(
    (action: 'move' | 'copy') => {
      if (!selectedRow) return;
      setActionError(null);
      const targetId = selectedRow.folderId;
      const refs = items.map((it) => ({ type: it.type, id: it.id }));

      if (action === 'move') {
        const res = syncStore.optimisticMoveItems({
          items: refs,
          targetParentId: targetId,
        });
        if (!res.ok) {
          setActionError(res.error ?? '移動に失敗しました');
          return;
        }
      } else {
        const res = syncStore.optimisticCopyItems({
          items: refs,
          targetParentId: targetId,
          mode: 'copy',
        });
        if (!res.ok) {
          setActionError(res.error ?? 'コピーに失敗しました');
          return;
        }
      }

      recordRecentDestination(user.tenantId, user.id, {
        id: targetId,
        name: targetId === null ? 'マイファイル' : selectedRow.name,
        classification: selectedRow.classification,
      });
      onSuccess(action, targetId);
      onClose();
    },
    [selectedRow, items, syncStore, user.tenantId, user.id, onSuccess, onClose]
  );

  const handleCreateInlineFolder = useCallback(() => {
    const trimmed = inlineNewFolderName.trim();
    if (!trimmed) return;
    const parentId = selectedRow?.folderId ?? null;
    if (
      parentId === null &&
      isRootCreationRestricted(folderStructureMode, isSysAdmin)
    ) {
      setActionError(ROOT_CREATION_RESTRICTED_REASON);
      return;
    }
    const parentClass = selectedRow?.classification ?? 'internal';
    const res = syncStore.optimisticCreateFolder({
      parentId,
      name: trimmed,
      classification:
        parentClass === 'confidential' ? 'confidential' : 'internal',
    });
    if (!res.ok || !res.tempId) {
      setActionError(res.error ?? '新規フォルダを作成できませんでした');
      return;
    }
    if (parentId) {
      toggleExpand(parentId, true);
    }
    setHighlightedKey(`tree:${res.tempId}`);
    setInlineNewFolderName('');
    setInlineNewFolderOpen(false);
    setActionError(null);
  }, [
    inlineNewFolderName,
    selectedRow,
    syncStore,
    toggleExpand,
    folderStructureMode,
    isSysAdmin,
  ]);

  const inlineRootCreationBlocked =
    (selectedRow?.folderId ?? null) === null &&
    isRootCreationRestricted(folderStructureMode, isSysAdmin);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;
      if (
        scopeTokenRef.current &&
        !keyboardScopes.isTopToken(scopeTokenRef.current)
      ) {
        return;
      }

      if (e.key === 'Escape') {
        if (inlineNewFolderOpen) {
          e.preventDefault();
          e.stopPropagation();
          setInlineNewFolderOpen(false);
          setInlineNewFolderName('');
          return;
        }
        return;
      }

      if (inlineNewFolderOpen) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = Math.min(
          visibleRows.length - 1,
          highlightedIndex + 1
        );
        const row = visibleRows[nextIdx];
        if (row) setHighlightedKey(row.rowKey);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = Math.max(0, highlightedIndex - 1);
        const row = visibleRows[prevIdx];
        if (row) setHighlightedKey(row.rowKey);
        return;
      }

      const activeInSearch =
        document.activeElement === searchInputRef.current;

      if (
        e.key === 'ArrowRight' &&
        selectedRow?.folderId &&
        selectedRow.canExpand
      ) {
        if (!activeInSearch) {
          e.preventDefault();
          toggleExpand(selectedRow.folderId, true);
          return;
        }
      }

      if (
        e.key === 'ArrowLeft' &&
        selectedRow?.folderId &&
        selectedRow.canExpand
      ) {
        if (!activeInSearch) {
          e.preventDefault();
          toggleExpand(selectedRow.folderId, false);
          return;
        }
      }

      if (e.key === 'Enter' && selectedRow && selectedEval) {
        e.preventDefault();
        if (modeHint === 'copy') {
          if (selectedEval.copyEval.allowed) executeAction('copy');
        } else if (selectedEval.moveEval.allowed) {
          executeAction('move');
        } else if (selectedEval.copyEval.allowed) {
          executeAction('copy');
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [
    inlineNewFolderOpen,
    visibleRows,
    highlightedIndex,
    selectedRow,
    selectedEval,
    modeHint,
    toggleExpand,
    executeAction,
    onClose,
  ]);

  return {
    searchInputRef,
    query,
    setQuery,
    visibleRows,
    selectedRow,
    selectedEval,
    evalForRow,
    highlightedKey,
    setHighlightedKey,
    inlineNewFolderOpen,
    setInlineNewFolderOpen,
    inlineNewFolderName,
    setInlineNewFolderName,
    actionError,
    handleCreateInlineFolder,
    executeAction,
    toggleExpand,
    inlineRootCreationBlocked,
  };
}
