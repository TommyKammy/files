'use client';

import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Lock,
  MoveRight,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import {
  type DragWorkspaceItem,
  evaluateDropTarget,
} from '@/lib/drag-drop-controller';
import { isImeComposingEvent, keyboardScopes } from '@/lib/keyboard-shortcuts';
import { type WorkspaceSyncStore, useWorkspaceSyncSnapshot } from '@/lib/sync-store';
import {
  evaluateCopyDestination,
  loadRecentDestinations,
  type RecentDestinationEntry,
  recordRecentDestination,
} from '@/lib/workspace-actions';
import type { AuthUser, ClassificationLabel, ResourceRole } from '@/types/files';

interface DestinationRow {
  rowKey: string;
  section: 'recent' | 'tree';
  folderId: string | null;
  name: string;
  depth: number;
  classification: ClassificationLabel;
  effectiveRole: ResourceRole;
  isExpanded: boolean;
  canExpand: boolean;
}

export function MoveCopyTreeModal({
  items,
  modeHint = 'move',
  currentFolderId,
  user,
  isSysAdmin,
  syncStore,
  onClose,
  onSuccess,
}: {
  items: DragWorkspaceItem[];
  modeHint?: 'move' | 'copy';
  currentFolderId: string | null;
  user: AuthUser;
  isSysAdmin: boolean;
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
    void syncStore.ensureDirectoryLoaded(null, { isPrefetch: true }).catch(() => {});
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

  // Build visible flat destination list (touches snapshot.revision cleanly)
  const visibleRows = useMemo<DestinationRow[]>(() => {
    void snapshot.revision;
    const rows: DestinationRow[] = [];
    const trimmedQuery = query.trim().toLowerCase();

    if (trimmedQuery) {
      const matches = syncStore.searchCachedWorkspaceItems(trimmedQuery, 40).folders;
      rows.push({
        rowKey: 'tree:__ROOT__',
        section: 'tree',
        folderId: null,
        name: 'マイファイル (ルート)',
        depth: 0,
        classification: 'unset',
        effectiveRole: 'editor',
        isExpanded: false,
        canExpand: false,
      });
      for (const entry of matches) {
        rows.push({
          rowKey: `tree:${entry.folder.id}`,
          section: 'tree',
          folderId: entry.folder.id,
          name: `${entry.folder.name} (${entry.pathHint})`,
          depth: 1,
          classification: entry.folder.classification,
          effectiveRole: entry.folder.effectiveRole ?? 'viewer',
          isExpanded: false,
          canExpand: false,
        });
      }
      return rows;
    }

    // Recent destinations section
    for (const recent of recentList) {
      if (recent.id === null) {
        rows.push({
          rowKey: 'recent:__ROOT__',
          section: 'recent',
          folderId: null,
          name: 'マイファイル (ルート)',
          depth: 0,
          classification: 'unset',
          effectiveRole: 'editor',
          isExpanded: false,
          canExpand: false,
        });
      } else {
        const cached = syncStore.getDirectoryView(recent.id);
        if (!cached.folder || cached.folder.deleted_at != null) continue;
        rows.push({
          rowKey: `recent:${recent.id}`,
          section: 'recent',
          folderId: recent.id,
          name: cached.folder.name,
          depth: 0,
          classification: cached.folder.classification,
          effectiveRole: cached.effectiveRole,
          isExpanded: false,
          canExpand: false,
        });
      }
    }

    // Root node
    rows.push({
      rowKey: 'tree:__ROOT__',
      section: 'tree',
      folderId: null,
      name: 'マイファイル (ルート)',
      depth: 0,
      classification: 'unset',
      effectiveRole: 'editor',
      isExpanded: true,
      canExpand: false,
    });

    const walk = (parentId: string | null, depth: number, visited: Set<string>) => {
      if (depth > 6) return;
      const view = syncStore.getDirectoryView(parentId);
      const sorted = [...view.folders].sort((a, b) =>
        a.name.localeCompare(b.name, 'ja')
      );
      for (const folder of sorted) {
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);
        const isExp = expandedIds.has(folder.id);
        rows.push({
          rowKey: `tree:${folder.id}`,
          section: 'tree',
          folderId: folder.id,
          name: folder.name,
          depth,
          classification: folder.classification,
          effectiveRole:
            folder.effectiveRole ??
            syncStore.getDirectoryView(folder.id).effectiveRole,
          isExpanded: isExp,
          canExpand: true,
        });
        if (isExp) {
          walk(folder.id, depth + 1, visited);
        }
      }
    };

    walk(null, 1, new Set());
    return rows;
  }, [snapshot.revision, query, recentList, syncStore, expandedIds]);

  const highlightedIndex = useMemo(() => {
    const idx = visibleRows.findIndex((r) => r.rowKey === highlightedKey);
    return idx >= 0 ? idx : 0;
  }, [visibleRows, highlightedKey]);

  const selectedRow = visibleRows[highlightedIndex] ?? visibleRows[0] ?? null;

  const evalForRow = useCallback(
    (row: DestinationRow) => {
      const targetAncestorClassifications = syncStore.getAncestorClassifications(
        row.folderId
      );
      const isAncestorOf = (ancestorId: string, candidateId: string | null) =>
        syncStore.isFolderAncestorOf(ancestorId, candidateId);
      const resolveItemRole = (item: DragWorkspaceItem) =>
        item.effectiveRole ?? syncStore.getDirectoryView(item.parentId).effectiveRole;

      const moveEval = evaluateDropTarget({
        dragItems: items,
        targetFolderId: row.folderId,
        targetClassification: row.classification,
        targetAncestorClassifications,
        targetEffectiveRole: row.effectiveRole,
        isSysAdmin,
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
        isAncestorOf,
        resolveItemRole,
      });

      return { moveEval, copyEval };
    },
    [syncStore, items, isSysAdmin]
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
    const parentClass = selectedRow?.classification ?? 'internal';
    const res = syncStore.optimisticCreateFolder({
      parentId,
      name: trimmed,
      classification: parentClass === 'confidential' ? 'confidential' : 'internal',
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
  }, [inlineNewFolderName, selectedRow, syncStore, toggleExpand]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;
      if (scopeTokenRef.current && !keyboardScopes.isTopToken(scopeTokenRef.current)) {
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
        // Let the native <dialog> cancel event close the modal and restore focus.
        return;
      }

      if (inlineNewFolderOpen) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = Math.min(visibleRows.length - 1, highlightedIndex + 1);
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

      const activeInSearch = document.activeElement === searchInputRef.current;

      if (e.key === 'ArrowRight' && selectedRow?.folderId && selectedRow.canExpand) {
        if (!activeInSearch) {
          e.preventDefault();
          toggleExpand(selectedRow.folderId, true);
          return;
        }
      }

      if (e.key === 'ArrowLeft' && selectedRow?.folderId && selectedRow.canExpand) {
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
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
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

  const recentRows = visibleRows.filter((r) => r.section === 'recent');
  const treeRows = visibleRows.filter((r) => r.section === 'tree');

  const renderDestinationButton = (row: DestinationRow) => {
    const { moveEval, copyEval } = evalForRow(row);
    const isHighlighted = selectedRow?.rowKey === row.rowKey;
    const locked =
      modeHint === 'copy' ? !copyEval.allowed : !moveEval.allowed && !copyEval.allowed;
    const lockReason =
      modeHint === 'copy'
        ? copyEval.reason
        : moveEval.reason ?? copyEval.reason;

    return (
      <div
        key={row.rowKey}
        style={{ paddingLeft: `${10 + row.depth * 16}px` }}
        onClick={() => setHighlightedKey(row.rowKey)}
        onDoubleClick={() => {
          if (row.folderId && row.canExpand) {
            toggleExpand(row.folderId);
          }
        }}
        className={`flex cursor-pointer items-center justify-between gap-2 rounded-lg pr-3 py-2 text-xs transition ${
          isHighlighted
            ? 'bg-blue-50 text-blue-900 ring-1 ring-inset ring-blue-300'
            : locked
              ? 'text-slate-400 hover:bg-slate-50'
              : 'text-slate-700 hover:bg-slate-50'
        }`}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {row.canExpand && row.folderId ? (
            <button
              type="button"
              aria-label={row.isExpanded ? '折りたたむ' : '展開する'}
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(row.folderId!);
              }}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-200/70 hover:text-slate-700"
            >
              {row.isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <span className="w-5 shrink-0" />
          )}

          {row.folderId === null ? (
            <Home className="h-4 w-4 shrink-0 text-blue-500" />
          ) : row.isExpanded ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-amber-500" />
          )}

          <span className="truncate font-medium">{row.name}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {row.classification !== 'unset' && (
            <ClassificationBadge classification={row.classification} compact />
          )}
          {locked && lockReason && (
            <span title={lockReason} className="text-slate-500">
              <Lock className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <ModalShell
      label="移動またはコピー先を選択"
      onClose={onClose}
      className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900">
              移動 / コピー先を選択 ({items.length} 件)
            </h2>
            <p className="truncate text-[0.6875rem] text-slate-500">
              {items.length === 1
                ? items[0]!.name
                : `${items[0]!.name} ほか ${items.length - 1} 件`}
            </p>
          </div>
          <button
            type="button"
            aria-label="閉じる"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-2.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
            <input
              ref={searchInputRef}
              id="move-copy-destination-search"
              name="destinationSearch"
              aria-label="移動先フォルダを検索"
              autoComplete="off"
              spellCheck={false}
              data-autofocus
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="フォルダ名で絞り込み..."
              className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
          </div>
          <button
            type="button"
            onClick={() => setInlineNewFolderOpen((prev) => !prev)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            <FolderPlus className="h-3.5 w-3.5 text-blue-600" />
            <span>新規フォルダ</span>
          </button>
        </div>

        {inlineNewFolderOpen && (
          <div className="flex items-center gap-2 border-b border-blue-100 bg-blue-50/60 px-4 py-2 text-xs">
            <input
              autoFocus
              id="move-copy-new-folder-name"
              name="newFolderName"
              aria-label={`「${selectedRow?.name ?? 'マイファイル'}」内に作成するフォルダ名`}
              type="text"
              value={inlineNewFolderName}
              onChange={(e) => setInlineNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposingEvent(e)) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCreateInlineFolder();
                }
              }}
              placeholder={`「${selectedRow?.name ?? 'マイファイル'}」内に作成するフォルダ名`}
              className="flex-1 rounded-md border border-blue-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            />
            <button
              type="button"
              onClick={handleCreateInlineFolder}
              className="rounded-md bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700"
            >
              作成
            </button>
            <button
              type="button"
              onClick={() => {
                setInlineNewFolderOpen(false);
                setInlineNewFolderName('');
              }}
              className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
          {recentRows.length > 0 && (
            <div>
              <div className="mb-1 flex items-center gap-1.5 px-2 text-[0.625rem] font-semibold uppercase tracking-wide text-slate-500">
                <Clock className="h-3 w-3" />
                <span>最近の移動先</span>
              </div>
              <div className="space-y-0.5">
                {recentRows.map(renderDestinationButton)}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1 px-2 text-[0.625rem] font-semibold uppercase tracking-wide text-slate-500">
              ワークスペースフォルダ
            </div>
            <div className="space-y-0.5">
              {treeRows.map(renderDestinationButton)}
            </div>
          </div>
        </div>

        {(selectedEval?.moveEval.promotesToConfidential ||
          selectedEval?.copyEval.promotesToConfidential) && (
          <div className="flex items-center gap-2 border-t border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              このフォルダへ移動またはコピーすると、対象アイテムの機密区分は「極秘 (Confidential)」へ自動昇格します。
            </span>
          </div>
        )}

        {(actionError ||
          (!selectedEval?.moveEval.allowed && selectedEval?.moveEval.reason) ||
          (!selectedEval?.copyEval.allowed && selectedEval?.copyEval.reason)) && (
          <div
            role="alert"
            className="border-t border-slate-100 bg-slate-50 px-5 py-1.5 text-[0.6875rem] text-slate-600"
          >
            {actionError ? (
              <span className="font-medium text-red-700">{actionError}</span>
            ) : (
              <span>
                {!selectedEval?.moveEval.allowed && selectedEval?.moveEval.reason
                  ? `移動不可: ${selectedEval.moveEval.reason}`
                  : ''}
                {!selectedEval?.moveEval.allowed &&
                selectedEval?.moveEval.reason &&
                !selectedEval?.copyEval.allowed &&
                selectedEval?.copyEval.reason
                  ? ' ／ '
                  : ''}
                {!selectedEval?.copyEval.allowed && selectedEval?.copyEval.reason
                  ? `コピー不可: ${selectedEval.copyEval.reason}`
                  : ''}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs">
          <span className="text-[0.6875rem] text-slate-500">
            ↑↓ 移動 • ←→ 展開/折畳 • Enter 決定
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 font-medium text-slate-600 hover:bg-slate-100"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={!selectedEval?.copyEval.allowed}
              onClick={() => executeAction('copy')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 font-semibold text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <Copy className="h-3.5 w-3.5" />
              <span>ここにコピー</span>
            </button>
            <button
              type="button"
              disabled={!selectedEval?.moveEval.allowed}
              onClick={() => executeAction('move')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <MoveRight className="h-3.5 w-3.5" />
              <span>ここへ移動</span>
            </button>
          </div>
        </div>
    </ModalShell>
  );
}
