'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShellRail } from '@/components/AppShellRail';
import { FileDropzoneUploader } from '@/components/FileDropzoneUploader';
import { TosAcceptanceModal } from '@/components/TosAcceptanceModal';
import { useWorkspaceRowRenderers } from '@/components/use-workspace-row-renderers';
import { WorkspaceBannersAndTrash } from '@/components/WorkspaceBannersAndTrash';
import { WorkspaceDragProvider } from '@/components/WorkspaceDragPortal';
import { WorkspaceFileListSection } from '@/components/WorkspaceFileListSection';
import { WorkspaceMainHeader } from '@/components/WorkspaceMainHeader';
import { WorkspaceOverlays } from '@/components/WorkspaceOverlays';
import { WorkspacePinnedFolders } from '@/components/WorkspacePinnedFolders';
import {
  WorkspaceAuthGate,
  WorkspaceSpecialViewShell,
} from '@/components/WorkspaceSubViews';
import type { DragWorkspaceItem } from '@/lib/drag-drop-controller';
import type { InspectorTab } from '@/lib/files-api/comments-activity';
import type { OfficeDocumentKind } from '@/lib/files-api/create-office';
import { IntentPrefetcher } from '@/lib/intent-prefetch';
import {
  getWorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import {
  getTrashEmptyState,
  trashSortToTableSort,
} from '@/lib/trash-view';
import { useMarqueeSelection } from '@/lib/use-marquee-selection';
import { useTosAcceptance } from '@/lib/use-tos-acceptance';
import { useWorkspaceActions } from '@/lib/use-workspace-actions';
import { useWorkspaceContextMenuActions } from '@/lib/use-workspace-context-menu-actions';
import { useWorkspaceData } from '@/lib/use-workspace-data';
import { useWorkspaceDialogs } from '@/lib/use-workspace-dialogs';
import { useWorkspaceFavorites } from '@/lib/use-workspace-favorites';
import { useWorkspaceInlineRename } from '@/lib/use-workspace-inline-rename';
import { useWorkspaceInspectorActions } from '@/lib/use-workspace-inspector-actions';
import { useWorkspaceKeyboard } from '@/lib/use-workspace-keyboard';
import {
  useWorkspaceListModel,
  useWorkspaceSelectionCapabilities,
} from '@/lib/use-workspace-list-model';
import { useWorkspaceLocksAndAi } from '@/lib/use-workspace-locks-and-ai';
import { useWorkspaceNavigation } from '@/lib/use-workspace-navigation';
import { useWorkspacePaletteActions } from '@/lib/use-workspace-palette-actions';
import {
  collectRowCapabilities,
  useWorkspaceRowAccess,
} from '@/lib/use-workspace-row-access';
import { useWorkspaceSelection } from '@/lib/use-workspace-selection';
import { useWorkspaceSessionEffects } from '@/lib/use-workspace-session-effects';
import { useWorkspaceTrashRestore } from '@/lib/use-workspace-trash-restore';
import { useWorkspaceUploads } from '@/lib/use-workspace-uploads';
import { useWorkspaceViewPrefs } from '@/lib/use-workspace-view-prefs';
import { useWorkspaceVirtualization } from '@/lib/use-workspace-virtualization';
import { useWorkspaceZipDownload } from '@/lib/use-workspace-zip-download';
import {
  isRootCreationRestricted,
  readFolderStructureMode,
} from '@/lib/workspace-actions';
import {
  getWorkspaceClipboardStore,
  useWorkspaceClipboard,
} from '@/lib/workspace-clipboard';
import {
  DEFAULT_WORKSPACE_QUICK_FILTER,
  type WorkspaceQuickFilter,
} from '@/lib/workspace-filter';
import type { WorkspaceTableRow } from '@/lib/workspace-table-row';
import type { ResourceRole } from '@/types/files';

export function WorkspaceFileBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderId = searchParams.get('folderId');
  const previewFileId = searchParams.get('preview');
  const viewParam = searchParams.get('view');
  const isTrashView = viewParam === 'trash';

  const syncStore = getWorkspaceSyncStore();
  const { user: syncUser } = useWorkspaceSyncSnapshot();
  const {
    sortBy,
    sortDir,
    viewMode,
    handleSortHeaderClick,
    handleToggleViewMode,
  } = useWorkspaceViewPrefs(syncUser);
  const {
    snapshot,
    directory,
    pinnedFolders,
    user,
    authChecked,
    trash,
    trashError,
    error,
    setError,
    errorCode,
    loadingMore,
    isInitialLoading,
    nextCursor,
    loadActiveView,
    handleLoadMore,
  } = useWorkspaceData({ folderId, isTrashView, syncStore, sortBy, sortDir });

  const tosGate = useTosAcceptance({
    bootstrapStatus: snapshot.tosStatus ?? null,
    apiErrorCode: errorCode,
  });

  const prefetcher = useMemo(
    () => new IntentPrefetcher(syncStore),
    [syncStore]
  );

  const isGuestUser = user?.userType === 'guest';
  /**
   * Guests land on the shared-items view when they open /workspace without a
   * folder. Members keep the existing "My Files" default.
   */
  const isSharedView =
    viewParam === 'shared' || (isGuestUser && !folderId && !isTrashView);
  const isRecentsView = !isGuestUser && viewParam === 'recents';
  const isFavoritesView = !isGuestUser && viewParam === 'favorites';
  const isTasksView = !isGuestUser && viewParam === 'tasks';
  const [inspectorInitialTab, setInspectorInitialTab] =
    useState<InspectorTab>('details');

  const { handleToggleFavorite, isRowFavorited, touchRecentFile } =
    useWorkspaceFavorites({
      user,
      isGuestUser,
      folderId,
      isTrashView,
      isSharedView,
      isRecentsView,
      isFavoritesView,
      isTasksView,
      syncStore,
      setError,
    });

  const currentFolder = isTrashView ? null : directory.folder;
  const effectiveRole: ResourceRole = isTrashView
    ? 'editor'
    : directory.effectiveRole ?? 'previewer';
  const accessMode = isTrashView ? null : directory.accessMode ?? null;
  const isPathOnly = accessMode === 'path';
  const breadcrumbs = isTrashView ? [] : directory.breadcrumbs;
  const folders = isTrashView ? trash.folders : directory.folders;
  const files = isTrashView
    ? trash.files
    : isPathOnly
      ? []
      : directory.files;
  const folderStructureMode = readFolderStructureMode(snapshot.policy);
  const isSysAdminUser = user?.role === 'sys_admin';
  const rootCreationRestricted =
    !isTrashView &&
    folderId === null &&
    (isGuestUser || isRootCreationRestricted(folderStructureMode, isSysAdminUser));
  const trashFilterActive =
    isTrashView &&
    getTrashEmptyState(trash.filters, trash.items.length) ===
      'filtered-empty';

  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null);
  const [quickFilter, setQuickFilter] = useState<WorkspaceQuickFilter>(
    DEFAULT_WORKSPACE_QUICK_FILTER
  );
  const [createOfficeKind, setCreateOfficeKind] =
    useState<OfficeDocumentKind | null>(null);

  useEffect(() => () => prefetcher.cancel(), [prefetcher]);

  useEffect(() => {
    setFocusedRowKey(null);
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
    setQuickFilter(DEFAULT_WORKSPACE_QUICK_FILTER);
    setInlineRename(null);
    setClassificationPicker(null);
    setContextMenu(null);
    setBackgroundMenu(null);
  }, [folderId, isTrashView]);

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

  const trashTableSort = trashSortToTableSort(trash.filters.sort);
  const listSortBy = isTrashView ? trashTableSort.sortBy : sortBy;
  const listSortDir = isTrashView ? trashTableSort.sortDir : sortDir;

  const {
    currentCapabilities,
    canPreviewCurrentFolder,
    canDownloadCurrentFolder,
    canCreateFolder,
    canRenameCurrentFolder,
    canManageCurrentFolderPerms,
    canInviteCurrentFolder,
    canShareCurrentFolder,
    canManageCurrentFolderLinks,
    canUploadNew,
    canUploadVersion,
    canClassifyCurrentFolder,
    canInspectCurrentFolder,
    canRenameRow,
    canDeleteRow,
    canShareRow,
    canManageLinksRow,
    canClassifyRow,
    canEditRow,
  } = useWorkspaceRowAccess({
    currentFolder,
    directoryCapabilities: directory.capabilities,
    effectiveRole,
    isPathOnly,
    isTrashView,
    user,
  });

  const showRoleBanner =
    !isTrashView &&
    !isPathOnly &&
    Boolean(currentFolder) &&
    (isGuestUser ||
      effectiveRole === 'uploader' ||
      effectiveRole === 'previewer_uploader' ||
      effectiveRole === 'viewer_uploader' ||
      effectiveRole === 'previewer');

  /**
   * Upload-only roles never receive file rows from `/children`, but an
   * optimistic upload briefly inserts one locally. Filter again so the UI can
   * never expose a file the server intentionally hides.
   */
  const visibleFiles =
    isTrashView || canPreviewCurrentFolder ? files : [];
  const isPrivilegedAdmin =
    user?.userType !== 'guest' &&
    (user?.role === 'sys_admin' || user?.role === 'sec_admin');
  const showTrashDeleterFilter =
    isTrashView &&
    (isPrivilegedAdmin ||
      trash.deleters.length + (trash.hasUnknownDeleter ? 1 : 0) > 1);

  const { handleListSort, sortedFiles, rows } = useWorkspaceListModel({
    isTrashView,
    folders,
    visibleFiles,
    sortBy,
    sortDir,
    quickFilter,
    trashItems: trash.items,
    trashSort: trash.filters.sort,
    applyTrashFilters: trash.applyFilters,
    handleSortHeaderClick,
  });

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
    trashConflictPolicy,
    setTrashConflictPolicy,
    trashRestoreTarget,
    setTrashRestoreTarget,
    selectedTrashCapabilities,
    currentTrashCapabilities,
    trashBulk,
    requestRestoreTrashFolder,
    requestRestoreTrashFile,
    handleTrashRestoreSuccess,
  } = useWorkspaceTrashRestore({
    isTrashView,
    selectedRows,
    trash,
    user,
    syncStore,
    setSelectedKeys,
    setSelectionAnchorKey,
    setError,
  });

  const {
    GRID_COLUMNS,
    virtualWindow,
    visibleRows,
    visibleGridRows,
    scrollLinearRowIntoView,
  } = useWorkspaceVirtualization({
    rows,
    viewMode,
    rowHeightOverride: isTrashView
      ? viewMode === 'grid'
        ? 200
        : 64
      : undefined,
  });

  const {
    previewTarget,
    setPreviewTarget,
    previewableFiles,
    previewFileIndex,
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
    files: visibleFiles,
    isTrashView,
    canPreviewCurrentFolder,
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
    files: visibleFiles,
    effectiveRole,
    setFocusedRowKey,
    setError,
  });

  const { columnVisibility, handleToggleColumn } = useWorkspaceSessionEffects({
    authStatus: snapshot.authStatus,
    user,
    prefetcher,
    syncStore,
    clipboardStore,
    setInspectorOpen,
    setContextMenu,
    setBackgroundMenu,
    setMoveCopyModal,
    setPreviewTarget,
    setActiveModal,
    setInlineRename,
    setClassificationPicker,
    setShortcutsHelpOpen,
    setSelectedKeys,
    setError,
  });

  const {
    inspectorTarget,
    handleOpenInspectorShare,
    handleOpenInspectorPermissions,
  } = useWorkspaceInspectorActions({
    isTrashView,
    focusedRow,
    selectedRows,
    currentFolder,
    effectiveRole,
    currentCapabilities,
    policy: snapshot.policy,
    setActiveModal,
  });

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
    isPrivilegedAdmin,
    folderStructureMode,
    selectedRows,
    focusedRow,
    error,
    canDeleteRow,
    canShareRow,
    canManageLinksRow,
    canClassifyRow,
    policy: snapshot.policy,
    setError,
    setSelectedKeys,
    setSelectionAnchorKey,
    setActiveModal,
    setClassificationPicker,
    setMoveCopyModal,
    onRequestRestoreFolder: requestRestoreTrashFolder,
    onRequestRestoreFile: requestRestoreTrashFile,
  });

  const selectionCapabilities = useWorkspaceSelectionCapabilities({
    selectedRows,
    folderId,
    effectiveRole,
    directoryCapabilities: directory.capabilities,
    isPrivilegedAdmin,
    isSysAdmin,
    folderStructureMode,
    clipboardItems: clipboardState?.items,
    resolveRowRole,
    collectRowCapabilities,
  });

  const { downloadingZip, canDownloadSelection, handleDownloadZip } =
    useWorkspaceZipDownload({
      selectedRows,
      directoryCapabilities: directory.capabilities,
      resolveRowRole,
      collectRowCapabilities,
      setError,
    });

  const {
    handleDownloadFile,
    openFileOrEditor,
    handleSearchSelect,
    openRow,
    openRowContextMenu,
    clearSelection,
    navigateToParentFolder,
    openCreateFolderModal,
    handleBackgroundContextMenu,
    handleBackgroundEmptyClick,
  } = useWorkspaceNavigation({
    router,
    folderId,
    isTrashView,
    currentFolder,
    breadcrumbs,
    directoryCapabilities: directory.capabilities,
    effectiveRole,
    rootCreationRestricted,
    selectedKeys,
    touchRecentFile,
    setSelectedKeys,
    setSelectionAnchorKey,
    setFocusedRowKey,
    setContextMenu,
    setBackgroundMenu,
    setFolderNameInput,
    setFolderClassInput,
    setActiveModal,
    setError,
  });

  const contextMenuFile =
    contextMenu?.row?.kind === 'file' ? contextMenu.row.file : null;

  const {
    handleLockChanged,
    getEffectiveFileLock,
    contextMenuFileLock,
    toggleContextMenuFileLock,
    handleApproveSingleAi,
    handleBulkApproveAi,
  } = useWorkspaceLocksAndAi({
    syncStore,
    contextMenuFile,
    canClassifyCurrentFolder,
    isPrivilegedAdmin,
    effectiveRole,
    selectedRows,
    setSelectedKeys,
    setError,
  });

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
    canUploadNew,
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
      canRenameRow,
      canDeleteRow,
      canShareRow,
      canManageLinksRow,
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
    canInspectCurrentFolder,
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
    onRedo: () => {
      void syncStore.redoLatest();
    },
  });

  const workspaceActions = useWorkspacePaletteActions({
    focusedRow,
    selectedRows,
    isTrashView,
    isPrivilegedAdmin,
    isSysAdmin,
    folderId,
    folderStructureMode,
    effectiveRole,
    folderCapabilities: directory.capabilities,
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

  const { createRenderers } = useWorkspaceRowRenderers({
    isTrashView,
    effectiveRole,
    focusedRowKey,
    selectedKeys,
    selectedRows,
    clipboardState,
    isCutPending: (kind, id) => clipboardStore.isCutPending(kind, id),
    inlineRename,
    inlineInputRef,
    inlineCommittedRef,
    contextMenuRow: contextMenu?.row ?? null,
    prefetcher,
    canClassifyCurrentFolder,
    canDownloadCurrentFolder,
    isPrivilegedAdmin,
    columnVisibility,
    getEffectiveFileLock,
    selectRowCheckbox,
    selectRowFromPointer,
    openRow,
    openRowContextMenu,
    handleRestoreFolder,
    handleRestoreFile,
    handleDownloadFile,
    setInlineRename,
    commitInlineRename,
    setFocusedRowKey,
    onFileUpdated: trash.updateFile,
    setError,
  });

  if (!authChecked || !user) {
    return (
      <WorkspaceAuthGate
        authChecked={authChecked}
        user={user}
        sessionError={snapshot.sessionError}
        syncStore={syncStore}
      />
    );
  }

  const openFolderRoute = (targetFolderId: string) =>
    router.push(`/workspace?folderId=${encodeURIComponent(targetFolderId)}`);

  if (isRecentsView || isFavoritesView || isTasksView) {
    return (
      <WorkspaceSpecialViewShell
        user={user}
        viewKind={
          isTasksView ? 'tasks' : isRecentsView ? 'recents' : 'favorites'
        }
        isGuestUser={isGuestUser}
        onSelectResult={handleSearchSelect}
        onOpenFolder={openFolderRoute}
        onTouchRecentFile={touchRecentFile}
      />
    );
  }

  if (isSharedView) {
    return (
      <WorkspaceSpecialViewShell
        user={user}
        viewKind="shared"
        isGuestUser={isGuestUser}
        onSelectResult={handleSearchSelect}
        onOpenFolder={openFolderRoute}
        onTouchRecentFile={touchRecentFile}
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
        const { renderGridRowCard, renderTableRow } = createRenderers(dragCtx);

        return (
          <div className="flex min-h-screen bg-[#efeff1] text-[#111214]">
            {tosGate.blocked && (
              <TosAcceptanceModal
                tos={tosGate.status}
                branding={tosGate.branding}
                accepting={tosGate.accepting}
                error={tosGate.error}
                onAccept={() => void tosGate.accept()}
              />
            )}
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
              onSelectFolder={openFolderRoute}
              workspaceActions={workspaceActions}
            />

            <main
              id="workspace-main"
              tabIndex={-1}
              className="mb-2 mr-2 mt-2 min-w-0 flex-1 space-y-4 rounded-2xl border border-[#e7e7ea] bg-[#f9f9fa] px-5 py-4 lg:px-7"
            >
              {!isTrashView && (
                <h1 className="sr-only">
                  {currentFolder?.name ?? 'マイファイル'}
                </h1>
              )}
              <WorkspaceMainHeader
                isTrashView={isTrashView}
                accessMode={accessMode}
                folderId={folderId}
                breadcrumbs={breadcrumbs}
                currentFolder={currentFolder}
                effectiveRole={effectiveRole}
                nextCursor={nextCursor}
                sortBy={listSortBy}
                sortDir={listSortDir}
                sortDrainStatus="idle"
                selectedRows={selectedRows}
                canCreateFolder={canCreateFolder && !rootCreationRestricted}
                canCreateOfficeDoc={
                  Boolean(folderId) && (canCreateFolder || canUploadNew)
                }
                canRenameCurrentFolder={canRenameCurrentFolder}
                canShareCurrentFolder={canShareCurrentFolder}
                canManageCurrentFolderPerms={canManageCurrentFolderPerms}
                canInviteCurrentFolder={canInviteCurrentFolder}
                canInspectCurrentFolder={canInspectCurrentFolder}
                isPrivilegedAdmin={isPrivilegedAdmin}
                canCopySelection={selectionCapabilities.canCopy}
                canCutSelection={selectionCapabilities.canCut}
                canDuplicateSelection={selectionCapabilities.canDuplicate}
                canMoveCopySelection={selectionCapabilities.canMoveCopy}
                canClassifySelection={selectionCapabilities.canClassify}
                canTrashSelection={selectionCapabilities.canTrash}
                canDownloadSelection={canDownloadSelection}
                downloadingZip={downloadingZip}
                viewMode={viewMode}
                inspectorOpen={inspectorOpen}
                rootCreationRestricted={rootCreationRestricted}
                quickFilter={quickFilter}
                onQuickFilterChange={setQuickFilter}
                onClearQuickFilter={() =>
                  setQuickFilter(DEFAULT_WORKSPACE_QUICK_FILTER)
                }
                onNewFolder={openCreateFolderModal}
                onCreateOfficeDoc={(kind) => setCreateOfficeKind(kind)}
                onTogglePin={handleTogglePin}
                onOpenFileRequest={() => {
                  if (!currentFolder) return;
                  setActiveModal({
                    kind: 'fileRequest',
                    folderId: currentFolder.id,
                    folderName: currentFolder.name,
                    canEdit: canRenameCurrentFolder,
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
                    canEdit: canShareCurrentFolder,
                    canManageLinks: canManageCurrentFolderLinks,
                    policy: snapshot.policy,
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
                    targetCapabilities: currentCapabilities,
                  });
                }}
                onToggleViewMode={handleToggleViewMode}
                onToggleInspector={() => setInspectorOpen((prev) => !prev)}
                onOpenShortcuts={() => setShortcutsHelpOpen(true)}
                onCopy={() => handleCopyTargets(selectedRows)}
                onCut={() => handleCutTargets(selectedRows)}
                onDuplicate={() => handleDuplicateTargets(selectedRows)}
                onMoveCopy={() =>
                  handleOpenMoveCopyModal(selectedRows, 'move')
                }
                onBulkApproveAi={handleBulkApproveAi}
                onClassify={openClassificationPickerFromTarget}
                onTrash={trashSelectedOrFocused}
                onDownloadZip={() => {
                  void handleDownloadZip();
                }}
                onClearSelection={() => setSelectedKeys(new Set())}
              />

              <WorkspaceBannersAndTrash
                isTrashView={isTrashView}
                isPathOnly={isPathOnly}
                showRoleBanner={showRoleBanner}
                effectiveRole={effectiveRole}
                directoryCapabilities={directory.capabilities}
                guestInfo={
                  isGuestUser
                    ? {
                        externalOrg: user.externalOrg ?? null,
                        expiresAt: user.expiresAt ?? null,
                      }
                    : null
                }
                trashBulkBar={{
                  selectedCount: selectedRows.length,
                  restorableCount: selectedTrashCapabilities.restorableCount,
                  purgableCount: selectedTrashCapabilities.purgableCount,
                  hasTrashItems:
                    trash.loaded &&
                    (trash.items.length > 0 ||
                      trash.hasMore ||
                      trashFilterActive),
                  busyAction: trashBulk.busyAction,
                  conflictPolicy: trashConflictPolicy,
                  onConflictPolicyChange: setTrashConflictPolicy,
                  onRestore: () => {
                    void trashBulk.requestRestore(trashConflictPolicy);
                  },
                  onPurge: trashBulk.requestPurge,
                  onEmpty: () =>
                    trashBulk.requestEmpty(
                      currentTrashCapabilities.purgableCount
                    ),
                  onClearSelection: () => {
                    setSelectedKeys(new Set());
                    setSelectionAnchorKey(null);
                  },
                }}
                trashFilters={{
                  filters: trash.filters,
                  deleters: trash.deleters,
                  hasUnknownDeleter: trash.hasUnknownDeleter,
                  showDeleterFilter: showTrashDeleterFilter,
                  loading: trash.loading,
                  onChange: (patch) => {
                    void trash.applyFilters(patch);
                  },
                  onClear: () => {
                    void trash.clearFilters();
                  },
                }}
                notices={{
                  activeDirectoryNotice: snapshot.activeDirectoryNotice,
                  error,
                  onDismissNotice: () => syncStore.clearActiveDirectoryNotice(),
                }}
              />

              <WorkspacePinnedFolders
                isTrashView={isTrashView}
                folderId={folderId}
                pinnedFolders={pinnedFolders}
                revalidating={snapshot.revalidating}
                dragCtx={dragCtx}
                prefetcher={prefetcher}
                onOpenFolder={openFolderRoute}
              />

              {!isTrashView && currentFolder && canUploadNew && (
                <FileDropzoneUploader
                  folderId={currentFolder.id}
                  canUploadVersion={canUploadVersion}
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
                pathOnly={isPathOnly}
                folderId={folderId}
                uploadOnly={!isTrashView && effectiveRole === 'uploader'}
                rowCount={rows.length}
                visibleRows={visibleRows}
                visibleGridRows={visibleGridRows}
                virtualWindow={virtualWindow}
                gridColumns={GRID_COLUMNS}
                selectableRowKeys={selectableRowKeys}
                selectedRowCount={selectedRows.length}
                sortBy={listSortBy}
                sortDir={listSortDir}
                columnVisibility={columnVisibility}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                trashError={trashError}
                trashFilterActive={trashFilterActive}
                rootCreationRestricted={rootCreationRestricted}
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
                onSort={handleListSort}
                onToggleColumn={handleToggleColumn}
                onLoadMore={handleLoadMore}
                onRetryTrash={() => {
                  void trash.retry();
                }}
                onClearTrashFilters={() => {
                  void trash.clearFilters();
                }}
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

            <WorkspaceOverlays
              syncStore={syncStore}
              inspector={{
                lock:
                  inspectorTarget?.kind === 'file'
                    ? getEffectiveFileLock(inspectorTarget.file.id)
                    : null,
                currentUserId: user?.id ?? null,
                isPrivilegedAdmin,
                initialTab: inspectorInitialTab,
                open: inspectorOpen,
                isTrashView,
                target: inspectorTarget,
                breadcrumbs,
                effectiveRole,
                capabilities: directory.capabilities,
                syncStore,
                onLockChanged: handleLockChanged,
                onClose: () => {
                  setInspectorOpen(false);
                  setInspectorInitialTab('details');
                },
                onPreview: openFileOrEditor,
                onDownload: handleDownloadFile,
                onOpenVersionHistory: openVersionHistoryForFile,
                onOpenClassification: (file) =>
                  setClassificationPicker({ mode: 'single', file }),
                onOpenShare: handleOpenInspectorShare,
                onOpenPermissions: handleOpenInspectorPermissions,
                onApproveAi: handleApproveSingleAi,
              }}
              utility={{
                previewTarget,
                previewCanNavigatePrev: previewFileIndex > 0,
                previewCanNavigateNext:
                  previewFileIndex >= 0 &&
                  previewFileIndex < previewableFiles.length - 1,
                classificationPicker,
                shortcutsHelpOpen,
                onNavigatePreview: handleNavigatePreview,
                onClosePreview: () => setPreviewTarget(null),
                onSelectClassification: handleApplyPickedClassification,
                onCloseClassification: () => setClassificationPicker(null),
                onCloseShortcuts: () => setShortcutsHelpOpen(false),
              }}
              actions={{
                contextMenu: contextMenu?.row
                  ? {
                      row: contextMenu.row,
                      x: contextMenu.x,
                      y: contextMenu.y,
                      trigger: contextMenu.trigger,
                    }
                  : null,
                backgroundMenu,
                moveCopyModal,
                isTrashView,
                selectedRows,
                folderId: folderId ?? null,
                effectiveRole,
                folderCapabilities: directory.capabilities,
                currentFolder,
                viewMode,
                canCreateFolder: canCreateFolder && !rootCreationRestricted,
                canUploadNew,
                canPaste: selectionCapabilities.canPaste,
                isPrivilegedAdmin,
                isSysAdmin,
                folderStructureMode,
                clipboardState,
                resolveRowRole,
                user,
                syncStore,
                isTargetLocked: Boolean(contextMenuFileLock),
                isTargetFavorited: isRowFavorited(contextMenu?.row),
                onToggleLock: (row) => {
                  if (row.kind === 'file') {
                    void toggleContextMenuFileLock();
                  }
                },
                onToggleFavorite: (row) => {
                  void handleToggleFavorite(row);
                },
                onOpenActivity: (row) => {
                  const key =
                    row.kind === 'folder'
                      ? `folder:${row.folder.id}`
                      : `file:${row.file.id}`;
                  setSelectedKeys(new Set([key]));
                  setFocusedRowKey(key);
                  setInspectorInitialTab('activity');
                  setInspectorOpen(true);
                },
                onContextAction: handleContextMenuAction,
                onCloseContextMenu: () => setContextMenu(null),
                onBackgroundAction: handleBackgroundMenuAction,
                onCloseBackgroundMenu: () => setBackgroundMenu(null),
                onCloseMoveCopy: () => setMoveCopyModal(null),
                onMoveCopySuccess: () => {
                  setSelectedKeys(new Set());
                  setSelectionAnchorKey(null);
                },
              }}
              clipboardBar={
                !isTrashView &&
                clipboardState &&
                clipboardState.items.length > 0
                  ? {
                      mode: clipboardState.mode,
                      itemCount: clipboardState.items.length,
                      onPaste: () => handlePasteClipboard(),
                      onClear: () => clipboardStore.clear(),
                    }
                  : null
              }
              trashBulkDialogs={{
                confirmState: trashBulk.confirmState,
                resultState: trashBulk.resultState,
                busy: trashBulk.isBusy,
                onConfirm: () => {
                  void trashBulk.confirmPendingAction();
                },
                onCancel: trashBulk.cancelConfirm,
                onCloseResult: trashBulk.closeResult,
              }}
              trashRestoreModal={
                trashRestoreTarget
                  ? {
                      item: trashRestoreTarget,
                      isSysAdmin,
                      folderStructureMode,
                      syncStore,
                      onClose: () => setTrashRestoreTarget(null),
                      onSuccess: handleTrashRestoreSuccess,
                    }
                  : null
              }
              managementModals={{
                activeModal,
                folderNameInput,
                folderClassInput,
                modalSubmitting,
                onClose: () => setActiveModal(null),
                onSubmit: handleCreateOrRenameSubmit,
                onFolderNameChange: setFolderNameInput,
                onFolderClassChange: setFolderClassInput,
              }}
              versionHistory={
                versionHistoryTarget
                  ? {
                      file: versionHistoryTarget.target,
                      effectiveRole,
                      capabilities: directory.capabilities,
                      canDownload: canDownloadCurrentFolder,
                      returnFocus: versionHistoryTarget.returnFocus,
                      onClose: () => setVersionHistoryTarget(null),
                    }
                  : null
              }
              toastStack={{
                toasts: snapshot.toasts,
                canUndo: snapshot.canUndo,
                onUndo: () => void syncStore.undoLatest(),
                onDismiss: (id) => syncStore.dismissToast(id),
              }}
              createOffice={{
                kind: createOfficeKind,
                folderId,
                onClose: () => setCreateOfficeKind(null),
              }}
            />
          </div>
        );
      }}
    </WorkspaceDragProvider>
  );
}
