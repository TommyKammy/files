'use client';

import { Keyboard, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShellRail } from '@/components/AppShellRail';
import { FileDropzoneUploader } from '@/components/FileDropzoneUploader';
import { SignInCard } from '@/components/SignInCard';
import type { InspectorTarget } from '@/components/WorkspaceInspectorDrawer';
import { WorkspaceInspectorOverlay } from '@/components/WorkspaceInspectorOverlay';
import { WorkspaceFileListSection } from '@/components/WorkspaceFileListSection';
import { WorkspaceItemCard } from '@/components/WorkspaceItemCard';
import { WorkspaceItemRow } from '@/components/WorkspaceItemRow';
import { WorkspaceActionOverlays } from '@/components/WorkspaceActionOverlays';
import { WorkspaceClipboardBar } from '@/components/WorkspaceClipboardBar';
import { WorkspaceManagementModals } from '@/components/WorkspaceManagementModals';
import { WorkspaceMainHeader } from '@/components/WorkspaceMainHeader';
import { WorkspaceNotices } from '@/components/WorkspaceNotices';
import { WorkspacePinnedFolders } from '@/components/WorkspacePinnedFolders';
import { WorkspaceUtilityOverlays } from '@/components/WorkspaceUtilityOverlays';
import { VersionHistoryModal } from '@/components/VersionHistoryModal';
import { WorkspaceToastStack } from '@/components/WorkspaceToastStack';
import { useWorkspaceContextMenuActions } from '@/lib/use-workspace-context-menu-actions';
import { useWorkspacePaletteActions } from '@/lib/use-workspace-palette-actions';
import { useFileLocks } from '@/lib/use-file-locks';
import {
  getDropTargetClassName,
  WorkspaceDragProvider,
} from '@/components/WorkspaceDragPortal';
import { type DragWorkspaceItem } from '@/lib/drag-drop-controller';
import { ApiClientError, getFileContentUrl } from '@/lib/files-api';
import { hasRoleAtLeast } from '@/lib/formatters';
import { IntentPrefetcher } from '@/lib/intent-prefetch';
import { getWorkspaceSyncStore } from '@/lib/sync-store';
import { useMarqueeSelection } from '@/lib/use-marquee-selection';
import { useWorkspaceActions } from '@/lib/use-workspace-actions';
import { useWorkspaceData } from '@/lib/use-workspace-data';
import { useWorkspaceDialogs } from '@/lib/use-workspace-dialogs';
import { useWorkspaceInlineRename } from '@/lib/use-workspace-inline-rename';
import { useWorkspaceKeyboard } from '@/lib/use-workspace-keyboard';
import { useWorkspaceSelection } from '@/lib/use-workspace-selection';
import { useWorkspaceUploads } from '@/lib/use-workspace-uploads';
import { useWorkspaceVirtualization } from '@/lib/use-workspace-virtualization';
import { describeWorkspaceRow } from '@/lib/workspace-row-presentation';
import { getWorkspaceRowKey, isRowSelectable, toDragWorkspaceItem, type WorkspaceTableRow } from '@/lib/workspace-table-row';
import { useWorkspaceViewPrefs } from '@/lib/use-workspace-view-prefs';
import {
  getWorkspaceClipboardStore,
  useWorkspaceClipboard,
} from '@/lib/workspace-clipboard';
import { resolveContextSelection } from '@/lib/workspace-actions';
import { sortWorkspaceFoldersAndFiles } from '@/lib/workspace-sort-and-view';
import type { FileItem, ResourceRole, SearchResultItem } from '@/types/files';

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
  const {
    snapshot,
    directory,
    pinnedFolders,
    user,
    authChecked,
    trash,
    error,
    setError,
    loadingMore,
    isInitialLoading,
    nextCursor,
    loadActiveView,
    handleLoadMore,
  } = useWorkspaceData({ folderId, isTrashView, syncStore });

  const prefetcher = useMemo(
    () => new IntentPrefetcher(syncStore),
    [syncStore]
  );


  const currentFolder = isTrashView ? null : directory.folder;
  const effectiveRole: ResourceRole = isTrashView ? 'editor' : directory.effectiveRole;
  const breadcrumbs = isTrashView ? [] : directory.breadcrumbs;
  const folders = isTrashView ? trash.folders : directory.folders;
  const files = isTrashView ? trash.files : directory.files;

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
  const fileLocks = useFileLocks(syncStore);
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
    openFileOrEditor({ id: item.id });
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
    versionHistoryTarget,
    setVersionHistoryTarget,
    openVersionHistoryForFile,
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

  const {
    resolveRowRole,
    isSysAdmin,
    getShortcutTargets,
    handleCopyTargets,
    handleCutTargets,
    handlePasteClipboard,
    handleDuplicateTargets,
    handleOpenMoveCopyModal,
    openShareFromTarget,
    openClassificationPickerFromTarget,
    trashSelectedOrFocused,
    handleTogglePin,
    handleRestoreFolder,
    handleRestoreFile,
    handleDragDropMove,
  } = useWorkspaceActions({
    syncStore,
    clipboardStore,
    user,
    isTrashView,
    folderId,
    effectiveRole,
    canEditCurrentFolder,
    isPrivilegedAdmin,
    selectedRows,
    focusedRow,
    error,
    canEditRow,
    setError,
    setSelectedKeys,
    setSelectionAnchorKey,
    setActiveModal,
    setClassificationPicker,
    setMoveCopyModal,
    removeTrashFolder: trash.removeFolder,
    removeTrashFile: trash.removeFile,
  });

  const openFileOrEditor = useCallback((file: { id: string }) => {
    window.open(
      `/workspace/file/${encodeURIComponent(file.id)}`,
      '_blank'
    );
  }, []);

  const openRow = useCallback(
    (row: WorkspaceTableRow) => {
      if (isTrashView) return;
      if (row.kind === 'folder') {
        router.push(`/workspace?folderId=${encodeURIComponent(row.folder.id)}`);
        return;
      }
      openFileOrEditor(row.file);
    },
    [isTrashView, router, openFileOrEditor]
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

  const openCreateFolderModal = useCallback(() => {
    setFolderNameInput('');
    setFolderClassInput(
      currentFolder?.classification === 'confidential'
        ? 'confidential'
        : 'internal'
    );
    setActiveModal({ kind: 'createFolder', parentId: folderId ?? null });
  }, [currentFolder?.classification, folderId]);

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

  const { handleBackgroundMenuAction, handleContextMenuAction } =
    useWorkspaceContextMenuActions({
      syncStore,
      folderId,
      effectiveRole,
      selectedRows,
      canEditRow,
      resolveRowRole,
      handleTogglePin,
      setActiveModal,
      setClassificationPicker,
      setFocusedRowKey,
      setInspectorOpen,
      setSelectedKeys,
      setSelectionAnchorKey,
      openRow,
      orderedRowKeys,
      startInlineRename,
      handleDownloadFile,
      handleCopyTargets,
      handleCutTargets,
      handlePasteClipboard,
      handleDuplicateTargets,
      handleOpenMoveCopyModal,
      onOpenWopiEditor: openFileOrEditor,
      onOpenVersionHistory: openVersionHistoryForFile,
      openCreateFolderModal,
      backgroundFileInputRef,
      backgroundFolderInputRef,
      selectableRowKeys,
      loadActiveView,
      handleToggleViewMode,
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
    openPreviewForFile: openFileOrEditor,
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

  const workspaceActions = useWorkspacePaletteActions({
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
    openCreateFolderModal,
    openClassificationPickerFromTarget,
    openShareFromTarget,
    trashSelectedOrFocused,
    handleOpenMoveCopyModal,
    handleCopyTargets,
    handleCutTargets,
    handlePasteClipboard,
    handleDuplicateTargets,
    handleToggleViewMode,
    setInspectorOpen,
    setShortcutsHelpOpen,
  });

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
              lock={file ? fileLocks[file.id] ?? null : null}
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
                        lock={file ? fileLocks[file.id] ?? null : null}
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
        <WorkspaceMainHeader
          isTrashView={isTrashView}
          folderId={folderId}
          breadcrumbs={breadcrumbs}
          currentFolder={currentFolder}
          effectiveRole={effectiveRole}
          nextCursor={nextCursor}
          sortBy={sortBy}
          sortDir={sortDir}
          selectedRows={selectedRows}
          canEditCurrentFolder={canEditCurrentFolder}
          canManageCurrentFolderPerms={canManageCurrentFolderPerms}
          isPrivilegedAdmin={isPrivilegedAdmin}
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
          onCopy={() => handleCopyTargets(selectedRows)}
          onCut={() => handleCutTargets(selectedRows)}
          onDuplicate={() => handleDuplicateTargets(selectedRows)}
          onMoveCopy={() => handleOpenMoveCopyModal(selectedRows, 'move')}
          onBulkApproveAi={handleBulkApproveAi}
          onClassify={openClassificationPickerFromTarget}
          onTrash={trashSelectedOrFocused}
          onClearSelection={() => setSelectedKeys(new Set())}
        />

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

        <WorkspaceFileListSection
          viewMode={viewMode}
          isInitialLoading={isInitialLoading}
          isTrashView={isTrashView}
          folderId={folderId}
          rowCount={rows.length}
          visibleRows={visibleRows}
          visibleGridRows={visibleGridRows}
          virtualWindow={virtualWindow}
          gridColumns={GRID_COLUMNS}
          selectableRowKeys={selectableRowKeys}
          selectedRowCount={selectedRows.length}
          sortBy={sortBy}
          sortDir={sortDir}
          nextCursor={nextCursor}
          loadingMore={loadingMore}
          marqueeSurfaceRef={marqueeSurfaceRef}
          containerRef={virtualWindow.containerRef}
          onMarqueePointerDown={marquee.onPointerDown}
          onBackgroundContextMenu={handleBackgroundContextMenu}
          onBackgroundEmptyClick={handleBackgroundEmptyClick}
          onToggleSelectAll={() => {
            if (selectedRows.length === selectableRowKeys.length) {
              setSelectedKeys(new Set());
            } else {
              setSelectedKeys(new Set(selectableRowKeys));
            }
          }}
          onSort={handleSortHeaderClick}
          onLoadMore={handleLoadMore}
          registerScrollContainer={dragCtx.registerScrollContainer}
          renderCard={renderGridRowCard}
          renderRow={renderTableRow}
        />
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
        lock={
          inspectorTarget?.kind === 'file'
            ? fileLocks[inspectorTarget.file.id] ?? null
            : null
        }
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
        onPreview={openFileOrEditor}
        onDownload={handleDownloadFile}
        onOpenVersionHistory={openVersionHistoryForFile}
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

      {versionHistoryTarget && (
        <VersionHistoryModal
          file={versionHistoryTarget.target}
          effectiveRole={effectiveRole}
          canDownload={canDownloadCurrentFolder}
          returnFocus={versionHistoryTarget.returnFocus}
          onFileUpdated={(file) => syncStore.upsertFileInCache(file)}
          onRestored={(result) => {
            const nextLabel = result.version
              ? `v${result.version.versionNum}`
              : result.file?.current_version_num
                ? `v${result.file.current_version_num}`
                : '新しいバージョン';
            syncStore.pushToast(
              {
                kind: 'info',
                message: `v${result.restoredFromVersionNum} を復元しました。${nextLabel} として現在版を更新しました。`,
              },
              10_000
            );
          }}
          onClose={() => setVersionHistoryTarget(null)}
        />
      )}

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
