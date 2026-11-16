'use client';

import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  Info,
  Keyboard,
  LayoutGrid,
  Link2,
  List,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Scissors,
  Shield,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppShellRail,
  type WorkspacePaletteActions,
} from '@/components/AppShellRail';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ClassificationCell } from '@/components/ClassificationCell';
import { FileDropzoneUploader } from '@/components/FileDropzoneUploader';
import { ModalShell } from '@/components/ModalShell';
import { MoveCopyTreeModal } from '@/components/MoveCopyTreeModal';
import {
  type PreviewTargetFile,
  SecurePreviewModal,
} from '@/components/SecurePreviewModal';
import { SignInCard } from '@/components/SignInCard';
import { WorkspaceBackgroundMenu } from '@/components/WorkspaceBackgroundMenu';
import {
  type ContextMenuActionId,
  WorkspaceContextMenu,
} from '@/components/WorkspaceContextMenu';
import type { InspectorTarget } from '@/components/WorkspaceInspectorDrawer';
import { WorkspaceInspectorOverlay } from '@/components/WorkspaceInspectorOverlay';
import { WorkspaceEmptyState } from '@/components/WorkspaceEmptyState';
import { WorkspaceGridBody } from '@/components/WorkspaceGridBody';
import { WorkspaceItemCard } from '@/components/WorkspaceItemCard';
import { WorkspaceItemRow } from '@/components/WorkspaceItemRow';
import { WorkspaceActionOverlays } from '@/components/WorkspaceActionOverlays';
import { WorkspaceBreadcrumbs } from '@/components/WorkspaceBreadcrumbs';
import { WorkspaceClipboardBar } from '@/components/WorkspaceClipboardBar';
import {
  WorkspaceManagementModals,
  type ActiveModal,
} from '@/components/WorkspaceManagementModals';
import { WorkspaceNotices } from '@/components/WorkspaceNotices';
import { WorkspacePinnedFolders } from '@/components/WorkspacePinnedFolders';
import {
  WorkspaceUtilityOverlays,
  type ClassificationPickerState,
} from '@/components/WorkspaceUtilityOverlays';
import { WorkspaceSelectionBar } from '@/components/WorkspaceSelectionBar';
import { WorkspaceSelectionCheckbox } from '@/components/WorkspaceSelectionCheckbox';
import { WorkspaceToastStack } from '@/components/WorkspaceToastStack';
import { WorkspaceTableBody } from '@/components/WorkspaceTableBody';
import { WorkspaceToolbar } from '@/components/WorkspaceToolbar';
import {
  getDropTargetClassName,
  WorkspaceDragProvider,
} from '@/components/WorkspaceDragPortal';
import {
  type DragWorkspaceItem,
  ROOT_DROP_ID,
} from '@/lib/drag-drop-controller';
import {
  ApiClientError,
  getFileContentUrl,
  listTrash,
} from '@/lib/files-api';
import {
  formatBytes,
  formatDateTime,
  hasRoleAtLeast,
  isPdfFile,
} from '@/lib/formatters';
import { IntentPrefetcher } from '@/lib/intent-prefetch';
import {
  isEditableTarget,
  isImeComposingEvent,
  isInteractiveNonRowTarget,
  isTrashShortcut,
  keyboardScopes,
  selectKeyRange,
  shouldHandleWorkspaceKey,
  toggleKeySelection,
} from '@/lib/keyboard-shortcuts';
import {
  getWorkspaceSyncStore,
  useWorkspaceDirectory,
} from '@/lib/sync-store';
import { useMarqueeSelection } from '@/lib/use-marquee-selection';
import { useTableVirtualWindow } from '@/lib/use-virtual-window';
import { useWorkspaceDialogs } from '@/lib/use-workspace-dialogs';
import { useWorkspaceInlineRename } from '@/lib/use-workspace-inline-rename';
import { useWorkspaceKeyboard } from '@/lib/use-workspace-keyboard';
import { useWorkspaceSelection } from '@/lib/use-workspace-selection';
import { useWorkspaceTrash } from '@/lib/use-workspace-trash';
import { useWorkspaceUploads } from '@/lib/use-workspace-uploads';
import { useWorkspaceVirtualization } from '@/lib/use-workspace-virtualization';
import { describeWorkspaceRow } from '@/lib/workspace-row-presentation';
import {
  getWorkspaceRowKey,
  isRowControlTarget,
  isRowSelectable,
  type InlineRenameState,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import { useWorkspaceViewPrefs } from '@/lib/use-workspace-view-prefs';
import {
  getWorkspaceClipboardStore,
  useWorkspaceClipboard,
} from '@/lib/workspace-clipboard';
import {
  buildContextMenuCapabilities,
  resolveContextSelection,
  resolvePointerSelection,
  resolveTargetRows,
} from '@/lib/workspace-actions';
import {
  chunkItemsIntoGridRows,
  getAriaSortValue,
  sortWorkspaceFoldersAndFiles,
} from '@/lib/workspace-sort-and-view';
import type {
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
  SearchResultItem,
} from '@/types/files';

function toDragWorkspaceItem(
  row: WorkspaceTableRow,
  fallbackRole: ResourceRole
): DragWorkspaceItem {
  if (row.kind === 'folder') {
    return {
      type: 'folder',
      id: row.folder.id,
      name: row.folder.name,
      parentId: row.folder.parent_id,
      classification: row.folder.classification,
      effectiveRole: row.folder.effectiveRole ?? fallbackRole,
    };
  }
  return {
    type: 'file',
    id: row.file.id,
    name: row.file.name,
    parentId: row.file.folder_id,
    classification: row.file.classification,
    effectiveRole: fallbackRole,
  };
}

function collectDragItemsForRow(
  row: WorkspaceTableRow,
  selectedRows: WorkspaceTableRow[],
  selectedKeys: Set<string>,
  isTrashView: boolean,
  fallbackRole: ResourceRole
): DragWorkspaceItem[] {
  if (isTrashView || !isRowSelectable(row)) return [];
  const rowKey = getWorkspaceRowKey(row);
  if (selectedKeys.has(rowKey) && selectedRows.length > 0) {
    return selectedRows
      .filter((r) => isRowSelectable(r))
      .map((r) => toDragWorkspaceItem(r, fallbackRole));
  }
  return [toDragWorkspaceItem(row, fallbackRole)];
}

export function WorkspaceFileBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderId = searchParams.get('folderId');
  const previewFileId = searchParams.get('preview');
  const isTrashView = searchParams.get('view') === 'trash';

  const syncStore = getWorkspaceSyncStore();
  const { snapshot, directory, pinnedFolders } = useWorkspaceDirectory(
    isTrashView ? null : folderId
  );
  const user = snapshot.user;
  const authChecked = snapshot.authStatus !== 'unknown';

  const prefetcher = useMemo(
    () => new IntentPrefetcher(syncStore),
    [syncStore]
  );

  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trash = useWorkspaceTrash({ setError });

  const currentFolder = isTrashView ? null : directory.folder;
  const effectiveRole: ResourceRole = isTrashView ? 'editor' : directory.effectiveRole;
  const breadcrumbs = isTrashView ? [] : directory.breadcrumbs;
  const folders = isTrashView ? trash.folders : directory.folders;
  const files = isTrashView ? trash.files : directory.files;
  const nextCursor = isTrashView ? null : directory.nextCursor;

  const isInitialLoading = isTrashView
    ? trash.loading && !trash.loaded
    : !directory.existsInCache &&
      (!snapshot.bootstrapDone || snapshot.revalidating);

  // Keyboard navigation, selection, inline rename, picker, and help overlay state
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null);

  useEffect(() => () => prefetcher.cancel(), [prefetcher]);

  useEffect(() => {
    setFocusedRowKey(null);
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
    setInlineRename(null);
    setClassificationPicker(null);
    setContextMenu(null);
    setBackgroundMenu(null);
  }, [folderId, isTrashView]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hydrated = await syncStore.hydrateFromScopeHint();
      if (!cancelled && hydrated && !isTrashView) {
        void syncStore.ensureDirectoryLoaded(folderId).catch(() => undefined);
      }
      await syncStore.bootstrap();
    })();
    return () => {
      cancelled = true;
    };
    // Initial SWR hydration + bootstrap once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStore]);

  // Idle-time warm-up ONLY of static pdfjs-dist runtime chunk (NEVER calls /content-url)
  useEffect(() => {
    if (snapshot.authStatus !== 'authenticated' || !user) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === 'function') {
      const idleId = w.requestIdleCallback(
        () => prefetcher.warmPdfPreviewRuntime(),
        { timeout: 2500 }
      );
      return () => w.cancelIdleCallback?.(idleId);
    }
    const timer = window.setTimeout(
      () => prefetcher.warmPdfPreviewRuntime(),
      1200
    );
    return () => window.clearTimeout(timer);
  }, [snapshot.authStatus, user, prefetcher]);

  // Fail-closed handler for instant SCIM suspension, permission revocation, and share revocation
  const clipboardStore = getWorkspaceClipboardStore();
  const clipboardState = useWorkspaceClipboard();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    row: WorkspaceTableRow | null;
    trigger: HTMLElement | null;
  } | null>(null);
  const [backgroundMenu, setBackgroundMenu] = useState<{
    x: number;
    y: number;
    trigger: HTMLElement | null;
  } | null>(null);
  const marqueeSurfaceRef = useRef<HTMLDivElement>(null);
  const [moveCopyModal, setMoveCopyModal] = useState<{
    items: DragWorkspaceItem[];
    modeHint: 'move' | 'copy';
  } | null>(null);
  const {
    sortBy,
    sortDir,
    viewMode,
    setSortBy,
    setSortDir,
    setViewMode,
    handleSortHeaderClick,
    handleToggleViewMode,
  } = useWorkspaceViewPrefs(user);
  const sortDrainErrorKeyRef = useRef<string | null>(null);

  useEffect(() => {
    clipboardStore.setScope(
      user ? { tenantId: user.tenantId, id: user.id } : null
    );
  }, [clipboardStore, user]);

  useEffect(() => {
    return syncStore.subscribeSecurityRevocations((event) => {
      if (event.kind === 'user.suspended') {
        clipboardStore.purge();
        setInspectorOpen(false);
        setContextMenu(null);
        setBackgroundMenu(null);
        setMoveCopyModal(null);
        setPreviewTarget(null);
        setActiveModal(null);
        setInlineRename(null);
        setClassificationPicker(null);
        setShortcutsHelpOpen(false);
        setSelectedKeys(new Set());
        setError(
          'アカウント停止またはセッション失効のためワークスペースキャッシュを消去しました。'
        );
        return;
      }

      if (event.kind === 'permission.revoke') {
        setPreviewTarget((prev) => {
          if (!prev) return null;
          setError(
            'アクセス権限が取り消されたためプレビューを安全に閉じました。'
          );
          return null;
        });
        setActiveModal((prev) =>
          prev && (prev.kind === 'share' || prev.kind === 'permissions')
            ? null
            : prev
        );
        return;
      }

      if (event.kind === 'shared_link.revoke') {
        setActiveModal((prev) => (prev?.kind === 'share' ? null : prev));
      }
    });
  }, [syncStore, clipboardStore]);

  const loadActiveView = useCallback(
    async (options?: { force?: boolean }) => {
      if (snapshot.authStatus !== 'authenticated' || !user) return;
      setError(null);

      try {
        if (isTrashView) {
          await trash.loadTrash();
        } else {
          await syncStore.ensureDirectoryLoaded(folderId, {
            force: options?.force,
          });
        }
      } catch (err) {
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'フォルダ内容の取得に失敗しました'
        );
      }
    },
    [snapshot.authStatus, user, isTrashView, syncStore, folderId, trash.loadTrash]
  );

  useEffect(() => {
    if (snapshot.authStatus === 'authenticated' && user) {
      void loadActiveView();
    }
  }, [snapshot.authStatus, user, loadActiveView]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore || isTrashView) return;
    setLoadingMore(true);
    try {
      await syncStore.loadMoreDirectory(folderId);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : '追加読み込みに失敗しました'
      );
    } finally {
      setLoadingMore(false);
    }
  }

  function handleTogglePin(folder: FolderSummary) {
    setError(null);
    const res = syncStore.optimisticToggleFolderPin(folder);
    if (!res.ok) {
      setError(res.error ?? 'ピン留めの変更に失敗しました');
    }
  }

  function handleRestoreFolder(folder: FolderSummary) {
    setError(null);
    trash.removeFolder(folder.id);
    syncStore.optimisticRestoreFolder(folder, 'rename');
  }

  function handleRestoreFile(file: FileItem) {
    setError(null);
    trash.removeFile(file.id);
    syncStore.optimisticRestoreFile(file);
  }

  async function handleDownloadFile(fileId: string) {
    try {
      const res = await getFileContentUrl(fileId, 'download');
      window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'ダウンロードリンクの取得に失敗しました'
      );
    }
  }

  function handleSearchSelect(item: SearchResultItem) {
    if (item.folderId && item.folderId !== folderId) {
      router.push(`/workspace?folderId=${encodeURIComponent(item.folderId)}`);
    }
    setPreviewTarget({
      file: {
        id: item.id,
        folderId: item.folderId,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        classification: item.classification,
      },
      canDownload: true,
    });
  }

  const canEditCurrentFolder = currentFolder
    ? hasRoleAtLeast(effectiveRole, 'editor')
    : true;
  const canDownloadCurrentFolder = currentFolder
    ? hasRoleAtLeast(effectiveRole, 'viewer')
    : true;
  const canManageCurrentFolderPerms = currentFolder
    ? hasRoleAtLeast(effectiveRole, 'co_owner')
    : false;
  const isPrivilegedAdmin =
    user?.role === 'sys_admin' || user?.role === 'sec_admin';

  // Background catch-up when sorting an incomplete multi-page folder off default name ASC
  useEffect(() => {
    if (isTrashView || !user || snapshot.authStatus !== 'authenticated') return;
    if (!nextCursor || (sortBy === 'name' && sortDir === 'asc')) return;
    const drainKey = `${folderId ?? '__ROOT__'}:${nextCursor}`;
    if (sortDrainErrorKeyRef.current === drainKey) return;
    let cancelled = false;
    void syncStore.loadMoreDirectory(folderId).catch(() => {
      if (!cancelled) {
        sortDrainErrorKeyRef.current = drainKey;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    isTrashView,
    user,
    snapshot.authStatus,
    folderId,
    nextCursor,
    sortBy,
    sortDir,
    syncStore,
  ]);

  const { folders: sortedFolders, files: sortedFiles } = useMemo(
    () =>
      sortWorkspaceFoldersAndFiles({
        folders,
        files,
        sortBy,
        sortDir,
        isTrashView,
      }),
    [folders, files, sortBy, sortDir, isTrashView]
  );

  const rows = useMemo<WorkspaceTableRow[]>(
    () => [
      ...sortedFolders.map((folder) => ({ kind: 'folder' as const, folder })),
      ...sortedFiles.map((file) => ({ kind: 'file' as const, file })),
    ],
    [sortedFolders, sortedFiles]
  );

  const {
    orderedRowKeys,
    focusedRowIndex,
    focusedRow,
    selectedRows,
    selectableRowKeys,
    selectRowFromPointer,
    selectRowCheckbox,
  } = useWorkspaceSelection({
    rows,
    isTrashView,
    focusedRowKey,
    setFocusedRowKey,
    selectedKeys,
    setSelectedKeys,
    selectionAnchorKey,
    setSelectionAnchorKey,
  });

  const {
    GRID_COLUMNS,
    gridRows,
    virtualWindow,
    visibleRows,
    visibleGridRows,
    scrollLinearRowIntoView,
  } = useWorkspaceVirtualization({ rows, viewMode });

  const {
    previewTarget,
    setPreviewTarget,
    previewableFiles,
    previewFileIndex,
    openPreviewForFile,
    handleNavigatePreview,
    activeModal,
    setActiveModal,
    folderNameInput,
    setFolderNameInput,
    folderClassInput,
    setFolderClassInput,
    modalSubmitting,
    handleCreateOrRenameSubmit,
    classificationPicker,
    setClassificationPicker,
    handleApplyPickedClassification,
    shortcutsHelpOpen,
    setShortcutsHelpOpen,
    inspectorOpen,
    setInspectorOpen,
  } = useWorkspaceDialogs({
    sortedFiles,
    files,
    isTrashView,
    canDownloadCurrentFolder,
    effectiveRole,
    isPrivilegedAdmin,
    syncStore,
    setError,
    setSelectedKeys,
    setFocusedRowKey,
    previewFileId,
    orderedRowKeys,
    virtualWindow,
  });

  const inspectorTarget = useMemo<InspectorTarget | null>(() => {
    if (isTrashView) return null;
    const candidate = focusedRow ?? selectedRows[0] ?? null;
    if (candidate) {
      return candidate.kind === 'folder'
        ? { kind: 'folder', folder: candidate.folder }
        : { kind: 'file', file: candidate.file };
    }
    return currentFolder ? { kind: 'folder', folder: currentFolder } : null;
  }, [isTrashView, focusedRow, selectedRows, currentFolder]);

  function handleOpenInspectorShare(target: InspectorTarget) {
    const targetIsFolder = target.kind === 'folder';
    const targetEffectiveRole = targetIsFolder
      ? target.folder.effectiveRole ?? effectiveRole
      : effectiveRole;
    setActiveModal({
      kind: 'share',
      targetType: target.kind,
      targetId: targetIsFolder ? target.folder.id : target.file.id,
      targetName: targetIsFolder ? target.folder.name : target.file.name,
      classification: targetIsFolder
        ? target.folder.classification
        : target.file.classification,
      canEdit: hasRoleAtLeast(targetEffectiveRole, 'editor'),
    });
  }

  function handleOpenInspectorPermissions(target: InspectorTarget) {
    const targetIsFolder = target.kind === 'folder';
    const targetEffectiveRole = targetIsFolder
      ? target.folder.effectiveRole ?? effectiveRole
      : effectiveRole;
    setActiveModal({
      kind: 'permissions',
      targetType: target.kind,
      targetId: targetIsFolder ? target.folder.id : target.file.id,
      targetName: targetIsFolder ? target.folder.name : target.file.name,
      effectiveRole: targetEffectiveRole,
    });
  }

  const canEditRow = useCallback(
    (row: WorkspaceTableRow): boolean => {
      if (isTrashView) return false;
      if (row.kind === 'folder') {
        return row.folder.effectiveRole
          ? hasRoleAtLeast(row.folder.effectiveRole, 'editor')
          : canEditCurrentFolder;
      }
      return isRowSelectable(row) && canEditCurrentFolder;
    },
    [isTrashView, canEditCurrentFolder]
  );

  const openRow = useCallback(
    (row: WorkspaceTableRow) => {
      if (isTrashView) return;
      if (row.kind === 'folder') {
        router.push(`/workspace?folderId=${encodeURIComponent(row.folder.id)}`);
        return;
      }
      openPreviewForFile(row.file);
    },
    [isTrashView, router, openPreviewForFile]
  );

  /**
   * Google Drive-compatible right-click normalization: right-clicking outside the
   * current selection selects that row first so the menu target and the visible
   * selection never disagree.
   */
  const openRowContextMenu = useCallback(
    (event: React.MouseEvent, row: WorkspaceTableRow) => {
      if (isTrashView) return;
      event.preventDefault();
      const rowKey = getWorkspaceRowKey(row);
      setFocusedRowKey(rowKey);
      const resolved = resolveContextSelection(selectedKeys, rowKey);
      if (resolved.changed) {
        setSelectedKeys(resolved.selectedKeys);
        setSelectionAnchorKey(resolved.anchorKey);
      }
      setBackgroundMenu(null);
      const current = event.currentTarget;
      const trigger =
        current instanceof HTMLElement
          ? current.matches('button')
            ? current
            : current.querySelector<HTMLElement>('[data-row-name-trigger="true"]') ??
              current
          : null;
      setContextMenu({ x: event.clientX, y: event.clientY, row, trigger });
    },
    [isTrashView, selectedKeys]
  );

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
    setFocusedRowKey(null);
  }, []);

  const {
    inlineRename,
    setInlineRename,
    inlineInputRef,
    inlineCommittedRef,
    startInlineRename,
    commitInlineRename,
  } = useWorkspaceInlineRename({
    isTrashView,
    canEditRow,
    syncStore,
    virtualWindow,
    folders,
    files,
    effectiveRole,
    setFocusedRowKey,
    setError,
  });

  const openClassificationPickerFromTarget = useCallback(() => {
    if (isTrashView) return;
    const selectedFiles = selectedRows
      .filter((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
      .map((r) => r.file);

    const targetFiles =
      selectedFiles.length > 0
        ? selectedFiles
        : focusedRow?.kind === 'file' && isRowSelectable(focusedRow)
          ? [focusedRow.file]
          : [];

    if (targetFiles.length === 0) {
      syncStore.pushToast({
        kind: 'info',
        message: '機密区分の変更はファイルを選択またはフォーカスして実行してください',
      });
      return;
    }

    if (!canEditCurrentFolder && !isPrivilegedAdmin) {
      syncStore.pushToast({
        kind: 'error',
        message: '機密区分を変更する権限がありません',
      });
      return;
    }

    if (targetFiles.length === 1) {
      setClassificationPicker({ mode: 'single', file: targetFiles[0]! });
    } else {
      setClassificationPicker({ mode: 'bulk', files: targetFiles });
    }
  }, [
    isTrashView,
    selectedRows,
    focusedRow,
    syncStore,
    canEditCurrentFolder,
    isPrivilegedAdmin,
  ]);

  const handleApproveSingleAi = useCallback(
    (file: FileItem): { ok: boolean; error?: string } => {
      if (!canEditCurrentFolder && !isPrivilegedAdmin) {
        const message = 'AI分類提案を承認する権限がありません';
        setError(message);
        return { ok: false, error: message };
      }
      const res = syncStore.optimisticUpdateFileClassification(
        file,
        { acceptSuggestion: true },
        { effectiveRole, isPrivilegedAdmin }
      );
      if (!res.ok) {
        setError(res.error ?? 'AI分類を承認できませんでした');
      }
      return res;
    },
    [canEditCurrentFolder, isPrivilegedAdmin, syncStore, effectiveRole]
  );

  const handleBulkApproveAi = useCallback(() => {
    const candidates = selectedRows
      .filter((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
      .map((r) => r.file)
      .filter((f) => f.ai_suggested_label != null);
    if (candidates.length === 0) return;
    if (!canEditCurrentFolder && !isPrivilegedAdmin) {
      setError('AI分類提案を承認する権限がありません');
      return;
    }

    let firstError: string | null = null;
    for (const file of candidates) {
      if (!file.ai_suggested_label) continue;
      const res = syncStore.optimisticUpdateFileClassification(
        file,
        { acceptSuggestion: true },
        { effectiveRole, isPrivilegedAdmin }
      );
      if (!res.ok && !firstError) {
        firstError = res.error ?? '一部のAI分類を承認できませんでした';
      }
    }
    if (firstError) setError(firstError);
    setSelectedKeys(new Set());
  }, [
    selectedRows,
    canEditCurrentFolder,
    isPrivilegedAdmin,
    syncStore,
    effectiveRole,
  ]);

  const openShareFromTarget = useCallback(() => {
    if (isTrashView) return;
    const row = focusedRow ?? selectedRows[0] ?? null;
    if (!row) return;
    if (!canEditRow(row)) {
      syncStore.pushToast({
        kind: 'error',
        message: '共有リンクの作成には編集者以上の権限が必要です',
      });
      return;
    }
    if (row.kind === 'folder') {
      setActiveModal({
        kind: 'share',
        targetType: 'folder',
        targetId: row.folder.id,
        targetName: row.folder.name,
        classification: row.folder.classification,
        canEdit: true,
      });
    } else {
      setActiveModal({
        kind: 'share',
        targetType: 'file',
        targetId: row.file.id,
        targetName: row.file.name,
        classification: row.file.classification,
        canEdit: true,
      });
    }
  }, [isTrashView, focusedRow, selectedRows, canEditRow, syncStore]);

  const trashSelectedOrFocused = useCallback(() => {
    if (isTrashView) return;
    const targets =
      selectedRows.length > 0 ? selectedRows : focusedRow ? [focusedRow] : [];
    if (targets.length === 0) return;

    setError(null);
    let moved = 0;
    for (const row of targets) {
      if (!canEditRow(row)) continue;
      if (row.kind === 'folder') {
        const res = syncStore.optimisticSoftDeleteFolder(row.folder);
        if (res.ok) moved += 1;
        else if (!error) setError(res.error ?? 'フォルダの削除に失敗しました');
      } else {
        const res = syncStore.optimisticSoftDeleteFile(
          row.file,
          folderId,
          effectiveRole
        );
        if (res.ok) moved += 1;
        else if (!error) setError(res.error ?? 'ファイルの削除に失敗しました');
      }
    }
    if (moved === 0) {
      syncStore.pushToast({
        kind: 'error',
        message: '削除権限がないか、処理中のアイテムです',
      });
    }
    if (selectedRows.length > 0) {
      setSelectedKeys(new Set());
    }
  }, [
    isTrashView,
    selectedRows,
    focusedRow,
    canEditRow,
    syncStore,
    folderId,
    effectiveRole,
    error,
  ]);

  const navigateToParentFolder = useCallback(() => {
    if (isTrashView) return;
    if (currentFolder?.parent_id) {
      router.push(
        `/workspace?folderId=${encodeURIComponent(currentFolder.parent_id)}`
      );
      return;
    }
    if (breadcrumbs.length > 1) {
      const parentCrumb = breadcrumbs[breadcrumbs.length - 2];
      if (parentCrumb) {
        router.push(`/workspace?folderId=${encodeURIComponent(parentCrumb.id)}`);
        return;
      }
    }
    if (folderId) {
      router.push('/workspace');
    }
  }, [isTrashView, currentFolder, breadcrumbs, folderId, router]);

  const resolveRowRole = useCallback(
    (row: WorkspaceTableRow): ResourceRole => {
      if (row.kind === 'folder') {
        return row.folder.effectiveRole ?? effectiveRole;
      }
      return effectiveRole;
    },
    [effectiveRole]
  );

  const isSysAdmin = user?.role === 'sys_admin';

  const getShortcutTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]): WorkspaceTableRow[] => {
      if (explicitTargets && explicitTargets.length > 0) {
        return explicitTargets.filter(isRowSelectable);
      }
      if (selectedRows.length > 0) {
        return selectedRows.filter(isRowSelectable);
      }
      if (focusedRow && isRowSelectable(focusedRow)) {
        return [focusedRow];
      }
      return [];
    },
    [selectedRows, focusedRow]
  );

  const toClipboardItems = useCallback((targets: WorkspaceTableRow[]) => {
    return targets.map((row) =>
      row.kind === 'folder'
        ? {
            type: 'folder' as const,
            id: row.folder.id,
            name: row.folder.name,
            parentId: row.folder.parent_id,
            classification: row.folder.classification,
            version: row.folder.version,
          }
        : {
            type: 'file' as const,
            id: row.file.id,
            name: row.file.name,
            parentId: row.file.folder_id,
            classification: row.file.classification,
            version: row.file.meta_version ?? 1,
          }
    );
  }, []);

  const handleCopyTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView || !user) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      const blocked = targets.some(
        (r) => !isSysAdmin && !hasRoleAtLeast(resolveRowRole(r), 'viewer')
      );
      if (blocked) {
        syncStore.pushToast({
          kind: 'error',
          message: 'Previewer 権限のアイテムはコピーできません (DLP 保護)',
        });
        return;
      }
      clipboardStore.setClipboard(
        'copy',
        toClipboardItems(targets),
        { tenantId: user.tenantId, userId: user.id }
      );
      syncStore.pushToast({
        kind: 'info',
        message: `${targets.length} 件をコピーしました（移動先で ⌘V / Ctrl+V）`,
      });
    },
    [
      isTrashView,
      user,
      getShortcutTargets,
      isSysAdmin,
      resolveRowRole,
      clipboardStore,
      toClipboardItems,
      syncStore,
    ]
  );

  const handleCutTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView || !user) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      const blocked = targets.some(
        (r) => !isSysAdmin && !hasRoleAtLeast(resolveRowRole(r), 'editor')
      );
      if (blocked) {
        syncStore.pushToast({
          kind: 'error',
          message: '切り取り（移動）には Editor 以上の権限が必要です',
        });
        return;
      }
      clipboardStore.setClipboard(
        'cut',
        toClipboardItems(targets),
        { tenantId: user.tenantId, userId: user.id }
      );
      syncStore.pushToast({
        kind: 'info',
        message: `${targets.length} 件を切り取りました（移動先で ⌘V / Ctrl+V）`,
      });
    },
    [
      isTrashView,
      user,
      getShortcutTargets,
      isSysAdmin,
      resolveRowRole,
      clipboardStore,
      toClipboardItems,
      syncStore,
    ]
  );

  const handlePasteClipboard = useCallback(
    (targetParentOverride?: string | null) => {
      if (isTrashView) return;
      const clip = clipboardStore.getState();
      if (!clip || clip.items.length === 0) return;

      const destId =
        targetParentOverride !== undefined ? targetParentOverride : folderId ?? null;
      const refs = clip.items.map((it) => ({ type: it.type, id: it.id }));

      setError(null);
      if (clip.mode === 'cut') {
        const res = syncStore.optimisticMoveItems({
          items: refs,
          targetParentId: destId,
        });
        if (!res.ok) {
          setError(res.error ?? '貼り付け移動に失敗しました');
          syncStore.pushToast({
            kind: 'error',
            message: res.error ?? '貼り付け移動に失敗しました',
          });
          return;
        }
        clipboardStore.completePaste();
        setSelectedKeys(new Set());
        return;
      }

      const res = syncStore.optimisticCopyItems({
        items: refs,
        targetParentId: destId,
        mode: 'copy',
        conflictPolicy: 'rename',
      });
      if (!res.ok) {
        setError(res.error ?? '貼り付けコピーに失敗しました');
        syncStore.pushToast({
          kind: 'error',
          message: res.error ?? '貼り付けコピーに失敗しました',
        });
        return;
      }
      setSelectedKeys(new Set());
    },
    [isTrashView, clipboardStore, folderId, syncStore]
  );

  const handleDuplicateTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      setError(null);
      const res = syncStore.optimisticCopyItems({
        items: targets.map((r) =>
          r.kind === 'folder'
            ? { type: 'folder', id: r.folder.id }
            : { type: 'file', id: r.file.id }
        ),
        targetParentId: folderId ?? null,
        mode: 'duplicate',
      });
      if (!res.ok) {
        setError(res.error ?? '複製に失敗しました');
        syncStore.pushToast({
          kind: 'error',
          message: res.error ?? '複製に失敗しました',
        });
      }
    },
    [isTrashView, getShortcutTargets, syncStore, folderId]
  );

  const handleOpenMoveCopyModal = useCallback(
    (explicitTargets?: WorkspaceTableRow[], modeHint: 'move' | 'copy' = 'move') => {
      if (isTrashView) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) {
        syncStore.pushToast({
          kind: 'info',
          message: '移動・コピーするアイテムを選択またはフォーカスしてください',
        });
        return;
      }
      setMoveCopyModal({
        items: targets.map((r) => toDragWorkspaceItem(r, effectiveRole)),
        modeHint,
      });
    },
    [isTrashView, getShortcutTargets, syncStore, effectiveRole]
  );

  const openCreateFolderModal = useCallback(() => {
    setFolderNameInput('');
    setFolderClassInput(
      currentFolder?.classification === 'confidential'
        ? 'confidential'
        : 'internal'
    );
    setActiveModal({ kind: 'createFolder', parentId: folderId ?? null });
  }, [currentFolder?.classification, folderId]);

  const handleBackgroundMenuAction = useCallback(
    (action: string) => {
      switch (action) {
        case 'newFolder':
          openCreateFolderModal();
          break;
        case 'uploadFiles':
          backgroundFileInputRef.current?.click();
          break;
        case 'uploadFolder':
          backgroundFolderInputRef.current?.click();
          break;
        case 'paste':
          handlePasteClipboard(folderId ?? null);
          break;
        case 'selectAll':
          setSelectedKeys(new Set(selectableRowKeys));
          setSelectionAnchorKey(selectableRowKeys[0] ?? null);
          break;
        case 'refresh':
          void loadActiveView({ force: true });
          break;
        case 'toggleView':
          handleToggleViewMode();
          break;
      }
    },
    [
      openCreateFolderModal,
      handlePasteClipboard,
      folderId,
      selectableRowKeys,
      loadActiveView,
      handleToggleViewMode,
    ]
  );

  const handleBackgroundContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (isTrashView) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-row-index], thead, th, button, a, input, select, textarea, [role="menu"], [role="checkbox"], [data-marquee-ignore="true"]'
        )
      ) {
        return;
      }
      event.preventDefault();
      setContextMenu(null);
      setBackgroundMenu({
        x: event.clientX,
        y: event.clientY,
        trigger:
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-workspace-table="true"]')
            : null,
      });
    },
    [isTrashView]
  );

  const handleBackgroundEmptyClick = useCallback(
    (event: React.MouseEvent) => {
      if (isTrashView) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-row-index], thead, th, button, a, input, select, textarea, [role="menu"], [data-marquee-ignore="true"]'
        )
      ) {
        return;
      }
      clearSelection();
    },
    [isTrashView, clearSelection]
  );

  const marquee = useMarqueeSelection({
    containerRef: virtualWindow.containerRef,
    surfaceRef: marqueeSurfaceRef,
    orderedRowKeys,
    selectedKeys,
    setSelectedKeys,
    setSelectionAnchorKey,
    enabled: !isTrashView && rows.length > 0 && Boolean(user),
    onBackgroundClick: clearSelection,
  });

  const {
    backgroundFileInputRef,
    backgroundFolderInputRef,
    pasteEnqueueFilesRef,
    lastOsPasteAtRef,
    lastVirtualPasteAtRef,
    enqueueBackgroundUpload,
  } = useWorkspaceUploads({
    authChecked,
    user,
    isTrashView,
    currentFolder,
    canEditCurrentFolder,
    clipboardStore,
    syncStore,
    handlePasteClipboard,
  });

  useWorkspaceKeyboard({
    authChecked,
    user,
    isTrashView,
    syncStore,
    selectableRowKeys,
    selectedKeys,
    inspectorOpen,
    selectionAnchorKey,
    focusedRowKey,
    rows,
    focusedRowIndex,
    orderedRowKeys,
    focusedRow,
    selectedRows,
    virtualWindow,
    router,
    clipboardStore,
    canDownloadCurrentFolder,
    lastOsPasteAtRef,
    lastVirtualPasteAtRef,
    setShortcutsHelpOpen,
    setInspectorOpen,
    setSelectedKeys,
    setFocusedRowKey,
    setSelectionAnchorKey,
    setContextMenu,
    scrollLinearRowIntoView,
    navigateToParentFolder,
    openPreviewForFile,
    startInlineRename,
    openClassificationPickerFromTarget,
    openShareFromTarget,
    trashSelectedOrFocused,
    getShortcutTargets,
    handleCopyTargets,
    handleCutTargets,
    handlePasteClipboard,
    handleDuplicateTargets,
    handleOpenMoveCopyModal,
    handleToggleViewMode,
    handleDownloadFile,
  });

  const handleContextMenuAction = useCallback(
    (
      action: ContextMenuActionId,
      primary: WorkspaceTableRow | null,
      targets: WorkspaceTableRow[],
      pasteDestId: string | null | undefined
    ) => {
      switch (action) {
        case 'open':
          if (!primary) return;
          openRow(primary);
          break;
        case 'openInNewTab':
          if (primary?.kind === 'folder') {
            window.open(
              `/workspace?folderId=${encodeURIComponent(primary.folder.id)}`,
              '_blank',
              'noopener,noreferrer'
            );
          } else if (primary?.kind === 'file') {
            const parentQuery = primary.file.folder_id
              ? `folderId=${encodeURIComponent(primary.file.folder_id)}&`
              : '';
            window.open(
              `/workspace?${parentQuery}preview=${encodeURIComponent(primary.file.id)}`,
              '_blank',
              'noopener,noreferrer'
            );
          }
          break;
        case 'copyLink': {
          if (!primary) return;
          const fileParentQuery =
            primary.kind === 'file' && primary.file.folder_id
              ? `folderId=${encodeURIComponent(primary.file.folder_id)}&`
              : '';
          const url =
            primary.kind === 'folder'
              ? `${window.location.origin}/workspace?folderId=${encodeURIComponent(primary.folder.id)}`
              : `${window.location.origin}/workspace?${fileParentQuery}preview=${encodeURIComponent(primary.file.id)}`;
          void navigator.clipboard
            .writeText(url)
            .then(() =>
              syncStore.pushToast({
                kind: 'info',
                message: '内部リンクをコピーしました',
              })
            )
            .catch(() =>
              syncStore.pushToast({
                kind: 'error',
                message: 'リンクをコピーできませんでした',
              })
            );
          break;
        }
        case 'download':
          if (primary?.kind === 'file') {
            handleDownloadFile(primary.file.id);
          }
          break;
        case 'rename':
          if (primary) {
            const idx = orderedRowKeys.indexOf(getWorkspaceRowKey(primary));
            if (idx >= 0) startInlineRename(primary, idx);
          }
          break;
        case 'copy':
          handleCopyTargets(targets);
          break;
        case 'cut':
          handleCutTargets(targets);
          break;
        case 'paste':
          handlePasteClipboard(pasteDestId);
          break;
        case 'duplicate':
          handleDuplicateTargets(targets);
          break;
        case 'moveCopy':
          handleOpenMoveCopyModal(targets, 'move');
          break;
        case 'classify': {
          const targetFiles = targets
            .filter((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
            .map((r) => r.file);
          if (targetFiles.length === 1) {
            setClassificationPicker({ mode: 'single', file: targetFiles[0]! });
          } else if (targetFiles.length > 1) {
            setClassificationPicker({ mode: 'bulk', files: targetFiles });
          }
          break;
        }
        case 'share':
          if (!primary) return;
          setActiveModal({
            kind: 'share',
            targetType: primary.kind,
            targetId: primary.kind === 'folder' ? primary.folder.id : primary.file.id,
            targetName:
              primary.kind === 'folder' ? primary.folder.name : primary.file.name,
            classification:
              primary.kind === 'folder'
                ? primary.folder.classification
                : primary.file.classification,
            canEdit: canEditRow(primary),
          });
          break;
        case 'pin':
          if (primary?.kind === 'folder') {
            handleTogglePin(primary.folder);
          }
          break;
        case 'permissions':
          if (primary) {
            setActiveModal({
              kind: 'permissions',
              targetType: primary.kind,
              targetId: primary.kind === 'folder' ? primary.folder.id : primary.file.id,
              targetName:
                primary.kind === 'folder' ? primary.folder.name : primary.file.name,
              effectiveRole: resolveRowRole(primary),
            });
          }
          break;
        case 'inspector':
          if (primary) {
            setFocusedRowKey(getWorkspaceRowKey(primary));
            setInspectorOpen(true);
          }
          break;
        case 'trash':
          for (const r of targets) {
            if (!canEditRow(r)) continue;
            if (r.kind === 'folder') {
              syncStore.optimisticSoftDeleteFolder(r.folder);
            } else {
              syncStore.optimisticSoftDeleteFile(r.file, folderId, effectiveRole);
            }
          }
          if (selectedRows.length > 0) {
            setSelectedKeys(new Set());
          }
          break;
      }
    },
    [
      router,
      openRow,
      openPreviewForFile,
      handleDownloadFile,
      orderedRowKeys,
      startInlineRename,
      handleCopyTargets,
      handleCutTargets,
      handlePasteClipboard,
      handleDuplicateTargets,
      handleOpenMoveCopyModal,
      canEditRow,
      handleTogglePin,
      resolveRowRole,
      syncStore,
      folderId,
      effectiveRole,
      selectedRows.length,
    ]
  );

  const handleDragDropMove = useCallback(
    (items: DragWorkspaceItem[], targetFolderId: string | null) => {
      setError(null);
      const res = syncStore.optimisticMoveItems({
        items: items.map((it) => ({ type: it.type, id: it.id })),
        targetParentId: targetFolderId,
      });
      if (!res.ok) {
        setError(res.error ?? 'アイテムの移動に失敗しました');
        return;
      }
      setSelectedKeys(new Set());
      setSelectionAnchorKey(null);
    },
    [syncStore]
  );

  const workspaceActions = useMemo<WorkspacePaletteActions>(
    () => ({
      hasTargetItem: Boolean(focusedRow || selectedRows.length > 0),
      canClassifyTarget:
        !isTrashView && (canEditCurrentFolder || isPrivilegedAdmin),
      canShareTarget:
        !isTrashView &&
        Boolean((focusedRow && canEditRow(focusedRow)) || selectedRows[0]),
      canTrashTarget:
        !isTrashView &&
        (selectedRows.length > 0 || (focusedRow !== null && canEditRow(focusedRow))),
      canCopyTarget:
        !isTrashView &&
        getShortcutTargets().some(
          (r) => isSysAdmin || hasRoleAtLeast(resolveRowRole(r), 'viewer')
        ),
      canCutTarget:
        !isTrashView &&
        getShortcutTargets().some(
          (r) => isSysAdmin || hasRoleAtLeast(resolveRowRole(r), 'editor')
        ),
      canPasteClipboard:
        !isTrashView && Boolean(clipboardState && clipboardState.items.length > 0),
      canDuplicateTarget:
        !isTrashView &&
        getShortcutTargets().length > 0 &&
        (isSysAdmin ||
          hasRoleAtLeast(effectiveRole, 'viewer')),
      onCommand: (cmdId) => {
        switch (cmdId) {
          case 'cmd:new-folder':
            setFolderNameInput('');
            setFolderClassInput(
              currentFolder?.classification === 'confidential'
                ? 'confidential'
                : 'internal'
            );
            setActiveModal({ kind: 'createFolder', parentId: folderId ?? null });
            break;
          case 'cmd:move-copy':
            handleOpenMoveCopyModal();
            break;
          case 'cmd:copy':
            handleCopyTargets();
            break;
          case 'cmd:cut':
            handleCutTargets();
            break;
          case 'cmd:paste':
            handlePasteClipboard();
            break;
          case 'cmd:duplicate':
            handleDuplicateTargets();
            break;
          case 'cmd:toggle-inspector':
            setInspectorOpen((prev) => !prev);
            break;
          case 'cmd:toggle-view':
            handleToggleViewMode();
            break;
          case 'cmd:change-classification':
            openClassificationPickerFromTarget();
            break;
          case 'cmd:share':
            openShareFromTarget();
            break;
          case 'cmd:trash':
            trashSelectedOrFocused();
            break;
          case 'cmd:shortcuts':
            setShortcutsHelpOpen(true);
            break;
        }
      },
    }),
    [
      focusedRow,
      selectedRows,
      isTrashView,
      canEditCurrentFolder,
      isPrivilegedAdmin,
      isSysAdmin,
      effectiveRole,
      canEditRow,
      resolveRowRole,
      getShortcutTargets,
      clipboardState,
      currentFolder?.classification,
      folderId,
      openClassificationPickerFromTarget,
      openShareFromTarget,
      trashSelectedOrFocused,
      handleOpenMoveCopyModal,
      handleCopyTargets,
      handleCutTargets,
      handlePasteClipboard,
      handleDuplicateTargets,
      handleToggleViewMode,
    ]
  );

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
        セッションを確認中...
      </div>
    );
  }

  if (!user) {
    return (
      <SignInCard
        title="Files ワークスペースへサインイン"
        description="組織の SSO (OIDC) セッションが必要です。認証後、自動的にワークスペースへ戻ります。"
        returnTo="/workspace"
        onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
      />
    );
  }

  return (
    <WorkspaceDragProvider
      syncStore={syncStore}
      currentFolderId={isTrashView ? null : folderId}
      isSysAdmin={isSysAdmin}
      onPrefetchFolder={(targetId) => prefetcher.scheduleHoverPrefetch(targetId)}
      onDropMove={handleDragDropMove}
    >
      {(dragCtx) => {
        function handleCardCheckboxClick(
          row: WorkspaceTableRow,
          rowKey: string,
          e: React.MouseEvent<HTMLButtonElement>
        ) {
          selectRowCheckbox(e, row, rowKey);
        }

        function handleCardPointerDown(
          row: WorkspaceTableRow,
          e: React.PointerEvent<HTMLElement>
        ) {
          const dragItems = collectDragItemsForRow(
            row,
            selectedRows,
            selectedKeys,
            isTrashView,
            effectiveRole
          );
          if (dragItems.length > 0) {
            dragCtx.startPointerDragCandidate(e, dragItems);
          }
        }

        function renderGridRowCard(row: WorkspaceTableRow, globalIdx: number) {
          const {
            rowKey,
            file,
            folder,
            isPendingUpload,
            isCut,
            isDropEligible,
          } = describeWorkspaceRow({
            row,
            isTrashView,
            clipboardState,
            isCutPending: (kind, id) => clipboardStore.isCutPending(kind, id),
          });
          const dropClass =
            folder && dragCtx.isDragging && isDropEligible
              ? getDropTargetClassName(folder.id, dragCtx.hoveredTarget)
              : '';

          return (
            <WorkspaceItemCard
              key={rowKey}
              row={row}
              globalIdx={globalIdx}
              isFocused={focusedRowKey === rowKey}
              isSelected={selectedKeys.has(rowKey)}
              rowSelectable={!isTrashView && isRowSelectable(row)}
              isTrashView={isTrashView}
              isInlineRenaming={inlineRename?.rowKey === rowKey}
              isPendingUpload={isPendingUpload}
              isCut={isCut}
              isContextMenuOpen={
                contextMenu?.row
                  ? getWorkspaceRowKey(contextMenu.row) === rowKey
                  : false
              }
              dropClass={dropClass}
              inlineRename={inlineRename}
              inlineInputRef={inlineInputRef}
              inlineCommittedRef={inlineCommittedRef}
              prefetcher={prefetcher}
              onCheckboxClick={(e) =>
                handleCardCheckboxClick(row, rowKey, e)
              }
              onPointerDown={(e) => handleCardPointerDown(row, e)}
              onSelectRow={selectRowFromPointer}
              onOpenRow={openRow}
              onOpenContextMenu={openRowContextMenu}
              onRestoreFolder={handleRestoreFolder}
              onRestoreFile={handleRestoreFile}
              onSetInlineRename={setInlineRename}
              onCommitInlineRename={commitInlineRename}
              onFocusRow={setFocusedRowKey}
            />
          );
        }

        function renderTableRow(
          row: WorkspaceTableRow,
          globalIdx: number
        ) {

                    const {
                      rowKey,
                      file,
                      folder,
                      isPendingUpload,
                      isCut,
                      isDropEligible,
                    } = describeWorkspaceRow({
                      row,
                      isTrashView,
                      clipboardState,
                      isCutPending: (kind, id) =>
                        clipboardStore.isCutPending(kind, id),
                    });
                    const dropClass =
                      folder && dragCtx.isDragging && isDropEligible
                        ? getDropTargetClassName(
                            folder.id,
                            dragCtx.hoveredTarget
                          )
                        : '';

                    return (
                      <WorkspaceItemRow
                        key={rowKey}
                        row={row}
                        globalIdx={globalIdx}
                        isFocused={focusedRowKey === rowKey}
                        isSelected={selectedKeys.has(rowKey)}
                        rowSelectable={!isTrashView && isRowSelectable(row)}
                        isTrashView={isTrashView}
                        isInlineRenaming={inlineRename?.rowKey === rowKey}
                        isContextMenuOpen={
                          contextMenu?.row
                            ? getWorkspaceRowKey(contextMenu.row) === rowKey
                            : false
                        }
                        isCut={isCut}
                        dropClass={dropClass}
                        inlineRename={inlineRename}
                        inlineInputRef={inlineInputRef}
                        inlineCommittedRef={inlineCommittedRef}
                        prefetcher={prefetcher}
                        effectiveRole={effectiveRole}
                        canEditCurrentFolder={canEditCurrentFolder}
                        canDownloadCurrentFolder={canDownloadCurrentFolder}
                        isPrivilegedAdmin={isPrivilegedAdmin}
                        onCheckboxClick={(e) =>
                          handleCardCheckboxClick(row, rowKey, e)
                        }
                        onPointerDown={(e) =>
                          handleCardPointerDown(row, e)
                        }
                        onSelectRow={selectRowFromPointer}
                        onOpenRow={openRow}
                        onOpenContextMenu={openRowContextMenu}
                        onRestoreFolder={handleRestoreFolder}
                        onRestoreFile={handleRestoreFile}
                        onDownloadFile={handleDownloadFile}
                        onSetInlineRename={setInlineRename}
                        onCommitInlineRename={commitInlineRename}
                        onFocusRow={setFocusedRowKey}
                        onFileUpdated={trash.updateFile}
                        onError={setError}
                      />
                    );
        }

        return (
          <div className="flex min-h-screen bg-[#efeff1] text-[#111214]">
          <a
            href="#workspace-main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#111214] focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]"
          >
            メインコンテンツへスキップ
          </a>
          <AppShellRail
            user={user}
            activeView={isTrashView ? 'trash' : 'workspace'}
            activeFolderId={isTrashView ? null : folderId}
            onSelectResult={handleSearchSelect}
            onSelectFolder={(targetFolderId) =>
              router.push(`/workspace?folderId=${encodeURIComponent(targetFolderId)}`)
            }
            workspaceActions={workspaceActions}
          />

          <main
            id="workspace-main"
            tabIndex={-1}
            className="mb-2 mr-2 mt-2 min-w-0 flex-1 space-y-4 rounded-2xl border border-[#e7e7ea] bg-[#f9f9fa] px-5 py-4 lg:px-7"
          >
        {!isTrashView && (
          <h1 className="sr-only">{currentFolder?.name ?? 'マイファイル'}</h1>
        )}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {isTrashView ? (
              <div className="flex items-center gap-2">
                <Trash2 className="h-5 w-5 text-slate-600" />
                <h1 className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-[#111214]">ゴミ箱</h1>
              </div>
            ) : (
              <WorkspaceBreadcrumbs
                folderId={folderId ?? null}
                breadcrumbs={breadcrumbs}
              />
            )}

            {!isTrashView &&
              (currentFolder ||
                (nextCursor && (sortBy !== 'name' || sortDir !== 'asc'))) && (
                <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-[#6b6f76]">
                  {currentFolder && (
                    <>
                      <ClassificationBadge
                        classification={currentFolder.classification}
                        compact
                      />
                      <span>実効ロール: {effectiveRole}</span>
                    </>
                  )}
                  {nextCursor && (sortBy !== 'name' || sortDir !== 'asc') && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[0.6875rem] font-medium text-amber-700">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>ソート全件同期中...</span>
                    </span>
                  )}
                </div>
              )}
          </div>

          <div className="relative flex w-full flex-wrap items-center gap-1.5">
            <WorkspaceToolbar
              isTrashView={isTrashView}
              hasSelection={!isTrashView && selectedRows.length > 0}
              canEditCurrentFolder={canEditCurrentFolder}
              canManageCurrentFolderPerms={canManageCurrentFolderPerms}
              currentFolder={currentFolder}
              viewMode={viewMode}
              inspectorOpen={inspectorOpen}
              onNewFolder={() => {
                setFolderNameInput('');
                setFolderClassInput(
                  currentFolder?.classification === 'confidential'
                    ? 'confidential'
                    : 'internal'
                );
                setActiveModal({
                  kind: 'createFolder',
                  parentId: folderId ?? null,
                });
              }}
              onTogglePin={handleTogglePin}
              onOpenFileRequest={() => {
                if (!currentFolder) return;
                setActiveModal({
                  kind: 'fileRequest',
                  folderId: currentFolder.id,
                  folderName: currentFolder.name,
                  canEdit: canEditCurrentFolder,
                });
              }}
              onOpenShare={() => {
                if (!currentFolder) return;
                setActiveModal({
                  kind: 'share',
                  targetType: 'folder',
                  targetId: currentFolder.id,
                  targetName: currentFolder.name,
                  classification: currentFolder.classification,
                  canEdit: canEditCurrentFolder,
                });
              }}
              onOpenPermissions={() => {
                if (!currentFolder) return;
                setActiveModal({
                  kind: 'permissions',
                  targetType: 'folder',
                  targetId: currentFolder.id,
                  targetName: currentFolder.name,
                  effectiveRole,
                });
              }}
              onToggleViewMode={handleToggleViewMode}
              onToggleInspector={() => setInspectorOpen((prev) => !prev)}
              onOpenShortcuts={() => setShortcutsHelpOpen(true)}
            />

            {!isTrashView && selectedRows.length > 0 && (
              <WorkspaceSelectionBar
                selectedRows={selectedRows}
                canEditCurrentFolder={canEditCurrentFolder}
                isPrivilegedAdmin={isPrivilegedAdmin}
                onCopy={() => handleCopyTargets(selectedRows)}
                onCut={() => handleCutTargets(selectedRows)}
                onDuplicate={() => handleDuplicateTargets(selectedRows)}
                onMoveCopy={() => handleOpenMoveCopyModal(selectedRows, 'move')}
                onBulkApproveAi={handleBulkApproveAi}
                onClassify={openClassificationPickerFromTarget}
                onTrash={trashSelectedOrFocused}
                onClear={() => setSelectedKeys(new Set())}
              />
            )}
          </div>
        </header>

        <WorkspaceNotices
          activeDirectoryNotice={snapshot.activeDirectoryNotice}
          error={error}
          onDismissNotice={() => syncStore.clearActiveDirectoryNotice()}
        />

        <WorkspacePinnedFolders
          isTrashView={isTrashView}
          folderId={folderId}
          pinnedFolders={pinnedFolders}
          revalidating={snapshot.revalidating}
          dragCtx={dragCtx}
          prefetcher={prefetcher}
          onOpenFolder={(targetFolderId) =>
            router.push(
              `/workspace?folderId=${encodeURIComponent(targetFolderId)}`
            )
          }
        />

        {!isTrashView && currentFolder && canEditCurrentFolder && (
          <FileDropzoneUploader
            folderId={currentFolder.id}
            onRegisterEnqueueFiles={(fn) => {
              pasteEnqueueFilesRef.current = fn;
            }}
          />
        )}

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {selectedRows.length > 0
            ? `${selectedRows.length} 件選択中`
            : '選択なし'}
        </div>

        <div
          ref={marqueeSurfaceRef}
          data-marquee-surface="true"
          onPointerDown={marquee.onPointerDown}
          onContextMenu={handleBackgroundContextMenu}
          className="-mx-6 px-6 lg:-mx-8 lg:px-8"
        >
        <section className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
          {isInitialLoading ? (
            <div className="flex h-48 items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
              読み込み中...
            </div>
          ) : rows.length === 0 ? (
            <WorkspaceEmptyState
              isTrashView={isTrashView}
              folderId={folderId}
              onContextMenu={handleBackgroundContextMenu}
              onClick={handleBackgroundEmptyClick}
            />
          ) : (
            <div
              ref={(el) => {
                (virtualWindow.containerRef as { current: HTMLDivElement | null }).current =
                  el;
                dragCtx.registerScrollContainer(el);
              }}
              onScroll={virtualWindow.onScroll}
              onContextMenu={handleBackgroundContextMenu}
              role="region"
              aria-label="ファイルとフォルダの一覧"
              tabIndex={0}
              data-workspace-table="true"
              className={`min-h-[420px] overflow-x-auto ${
                virtualWindow.virtualized ? 'max-h-[68vh] overflow-y-auto' : ''
              }`}
            >
              {viewMode === 'grid' ? (
                <WorkspaceGridBody
                  visibleRows={visibleGridRows}
                  startIndex={virtualWindow.startIndex}
                  columns={GRID_COLUMNS}
                  topSpacerPx={virtualWindow.topSpacerPx}
                  bottomSpacerPx={virtualWindow.bottomSpacerPx}
                  renderCard={renderGridRowCard}
                />
              ) : (
                <WorkspaceTableBody
                  rowCount={rows.length}
                  visibleRows={visibleRows}
                  startIndex={virtualWindow.startIndex}
                  topSpacerPx={virtualWindow.topSpacerPx}
                  bottomSpacerPx={virtualWindow.bottomSpacerPx}
                  isTrashView={isTrashView}
                  selectableRowKeys={selectableRowKeys}
                  selectedRowCount={selectedRows.length}
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onToggleSelectAll={() => {
                    if (selectedRows.length === selectableRowKeys.length) {
                      setSelectedKeys(new Set());
                    } else {
                      setSelectedKeys(new Set(selectableRowKeys));
                    }
                  }}
                  onSort={handleSortHeaderClick}
                  renderRow={renderTableRow}
                />
              )}
            </div>
          )}

          {nextCursor && (
            <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={handleLoadMore}
                className="inline-flex items-center gap-2 h-7 rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>さらに読み込む</span>
              </button>
            </div>
          )}
        </section>
        <div
          aria-hidden="true"
          data-background-surface="true"
          className="min-h-[96px]"
          onClick={handleBackgroundEmptyClick}
          onContextMenu={handleBackgroundContextMenu}
        />
        </div>
      </main>

      <input
        ref={backgroundFileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          enqueueBackgroundUpload(e.target.files, 'files');
          e.target.value = '';
        }}
      />
      <input
        ref={backgroundFolderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          enqueueBackgroundUpload(e.target.files, 'folder');
          e.target.value = '';
        }}
      />

      {marquee.overlay}

      <WorkspaceInspectorOverlay
        open={inspectorOpen}
        isTrashView={isTrashView}
        target={inspectorTarget}
        breadcrumbs={breadcrumbs}
        effectiveRole={effectiveRole}
        canEditCurrentFolder={canEditCurrentFolder}
        canDownloadCurrentFolder={canDownloadCurrentFolder}
        canManageCurrentFolderPerms={canManageCurrentFolderPerms}
        isPrivilegedAdmin={isPrivilegedAdmin}
        syncStore={syncStore}
        onClose={() => setInspectorOpen(false)}
        onPreview={openPreviewForFile}
        onDownload={handleDownloadFile}
        onOpenClassification={(file) =>
          setClassificationPicker({ mode: 'single', file })
        }
        onOpenShare={handleOpenInspectorShare}
        onOpenPermissions={handleOpenInspectorPermissions}
        onApproveAi={handleApproveSingleAi}
      />

      <WorkspaceUtilityOverlays
        previewTarget={previewTarget}
        previewCanNavigatePrev={previewFileIndex > 0}
        previewCanNavigateNext={
          previewFileIndex >= 0 &&
          previewFileIndex < previewableFiles.length - 1
        }
        classificationPicker={classificationPicker}
        shortcutsHelpOpen={shortcutsHelpOpen}
        onNavigatePreview={handleNavigatePreview}
        onClosePreview={() => setPreviewTarget(null)}
        onSelectClassification={handleApplyPickedClassification}
        onCloseClassification={() => setClassificationPicker(null)}
        onCloseShortcuts={() => setShortcutsHelpOpen(false)}
      />

      <WorkspaceActionOverlays
        contextMenu={
          contextMenu?.row
            ? {
                row: contextMenu.row,
                x: contextMenu.x,
                y: contextMenu.y,
                trigger: contextMenu.trigger,
              }
            : null
        }
        backgroundMenu={backgroundMenu}
        moveCopyModal={moveCopyModal}
        isTrashView={isTrashView}
        selectedRows={selectedRows}
        folderId={folderId ?? null}
        effectiveRole={effectiveRole}
        currentFolder={currentFolder}
        viewMode={viewMode}
        canEditCurrentFolder={canEditCurrentFolder}
        isPrivilegedAdmin={isPrivilegedAdmin}
        isSysAdmin={isSysAdmin}
        clipboardState={clipboardState}
        resolveRowRole={resolveRowRole}
        user={user}
        syncStore={syncStore}
        onContextAction={handleContextMenuAction}
        onCloseContextMenu={() => setContextMenu(null)}
        onBackgroundAction={handleBackgroundMenuAction}
        onCloseBackgroundMenu={() => setBackgroundMenu(null)}
        onCloseMoveCopy={() => setMoveCopyModal(null)}
        onMoveCopySuccess={() => {
          setSelectedKeys(new Set());
          setSelectionAnchorKey(null);
        }}
      />

      {!isTrashView &&
        clipboardState &&
        clipboardState.items.length > 0 && (
          <WorkspaceClipboardBar
            mode={clipboardState.mode}
            itemCount={clipboardState.items.length}
            onPaste={() => handlePasteClipboard()}
            onClear={() => clipboardStore.clear()}
          />
        )}

      <WorkspaceManagementModals
        activeModal={activeModal}
        folderNameInput={folderNameInput}
        folderClassInput={folderClassInput}
        modalSubmitting={modalSubmitting}
        onClose={() => setActiveModal(null)}
        onSubmit={handleCreateOrRenameSubmit}
        onFolderNameChange={setFolderNameInput}
        onFolderClassChange={setFolderClassInput}
      />

      <WorkspaceToastStack
        toasts={snapshot.toasts}
        canUndo={snapshot.canUndo}
        onUndo={() => void syncStore.undoLatest()}
        onDismiss={(id) => syncStore.dismissToast(id)}
      />

        </div>
        );
      }}
    </WorkspaceDragProvider>
  );
}
